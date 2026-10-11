/**
 * Renderer state.
 *
 * The architecture lives here as two graphs — `original` (what the analyzer
 * found) and `desired` (what the user has edited it into) — plus the ordered
 * log of operations that connects them. Every structural edit in the UI goes
 * through `dispatchOperation`, which runs the same pure reducer the backend
 * does, so the preview the user sees and the plan the engine builds come from
 * one implementation.
 *
 * Visual state (`layout`) is kept apart from architectural state on purpose:
 * `setPosition` can never produce a code change, and the status bar can say
 * truthfully whether there is anything pending that would.
 */

import { useMemo } from 'react'
import { create } from 'zustand'

import type {
  ArchitectureGraph,
  GraphLayout,
  ModuleId,
  NodePosition
} from '../../shared/types/architecture'
import type {
  ApplyResult,
  ChangeSet,
  ValidationReport,
  WriteMode
} from '../../shared/types/generation'
import type {
  GraphOperation,
  GraphOperationBody
} from '../../shared/types/operations'
import type {
  AppSettings,
  DiffPreview,
  LogEvent,
  SettingsView
} from '../../shared/types/ipc'
import type {
  ArchitectureDocument,
  FileTreeNode,
  ProjectInfo
} from '../../shared/types/project'
import { DOCUMENT_SCHEMA_VERSION } from '../../shared/types/project'
import { applyOperation, applyOperations } from '../../shared/graph/apply-operation'
import { diffArchitectures, summarizeDiff } from '../../shared/graph/diff'
import { fillMissingPositions, layoutGraph } from '../../shared/graph/layout'
import { createLayout } from '../../shared/graph/model'
import { isStructural } from '../../shared/types/operations'
import { operationId } from '../../shared/util/id'

const MAX_LOGS = 2000
const ACTOR = 'local-user'

export type Busy =
  | 'idle'
  | 'opening'
  | 'analyzing'
  | 'planning'
  | 'applying'
  | 'validating'
  | 'saving'

export type DialogName =
  | null
  | 'generate'
  | 'settings'
  | 'add-module'
  | 'diff'
  | 'delete-module'

export interface AppState {
  project: ProjectInfo | null
  fileTree: FileTreeNode | null
  original: ArchitectureGraph | null
  desired: ArchitectureGraph | null
  layout: GraphLayout
  operations: GraphOperation[]
  appliedOperationIds: string[]

  selectedModuleId: ModuleId | null
  selectedFile: string | null
  selectedOperationId: string | null
  deskMode: 'architecture' | 'review'
  dialog: DialogName
  addModulePosition: NodePosition | null
  busy: Busy
  error: string | null
  notice: string | null
  /** `true` when the document differs from what is on disk. */
  dirty: boolean

  logs: LogEvent[]
  bottomTab: 'preview' | 'module' | 'activity' | 'changes' | 'results'

  changeSet: ChangeSet | null
  diffs: DiffPreview[] | null
  applyResult: ApplyResult | null
  validation: ValidationReport | null
  settings: SettingsView | null

  // --- lifecycle -------------------------------------------------------
  init(): Promise<void>
  openProject(): Promise<void>
  openProjectAt(root: string): Promise<void>
  analyze(options?: {
    useAi?: boolean
    restoreSaved?: boolean
    /** Skip the "discard unapplied edits?" prompt. */
    force?: boolean
  }): Promise<void>
  cancel(): Promise<void>

  // --- editing ---------------------------------------------------------
  dispatchOperation(body: GraphOperationBody): boolean
  setPosition(id: ModuleId, position: NodePosition): void
  setExpanded(id: ModuleId, expanded: boolean): void
  relayout(): void
  select(id: ModuleId | null): void
  selectFile(path: string | null): void
  selectOperation(id: string): void
  setDeskMode(mode: AppState['deskMode']): void

  // --- persistence -----------------------------------------------------
  saveDocument(): Promise<void>
  restoreDocument(document: ArchitectureDocument): void

  // --- generation ------------------------------------------------------
  plan(useAi: boolean): Promise<void>
  loadDiffs(): Promise<void>
  apply(options: {
    mode: WriteMode
    outputDirectory?: string
    createBackup: boolean
    validate: boolean
  }): Promise<void>
  validateCurrent(): Promise<void>
  discardPlan(): void

  // --- settings & chrome ----------------------------------------------
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  openDialog(name: DialogName, position?: NodePosition): void
  setBottomTab(tab: AppState['bottomTab']): void
  pushLog(event: LogEvent): void
  clearLogs(): void
  setError(message: string | null): void
  setNotice(message: string | null): void
}

let localLogSeq = 0

function localLog(
  level: LogEvent['level'],
  channel: LogEvent['channel'],
  message: string,
  detail?: string
): LogEvent {
  localLogSeq += 1
  return {
    id: `ui_${Date.now().toString(36)}_${localLogSeq}`,
    at: new Date().toISOString(),
    level,
    channel,
    message,
    ...(detail ? { detail } : {})
  }
}

export const useStore = create<AppState>((set, get) => ({
  project: null,
  fileTree: null,
  original: null,
  desired: null,
  layout: createLayout(),
  operations: [],
  appliedOperationIds: [],

  selectedModuleId: null,
  selectedFile: null,
  selectedOperationId: null,
  deskMode: 'review',
  dialog: null,
  addModulePosition: null,
  busy: 'idle',
  error: null,
  notice: null,
  dirty: false,

  logs: [],
  bottomTab: 'preview',

  changeSet: null,
  diffs: null,
  applyResult: null,
  validation: null,
  settings: null,

  async init() {
    window.cartograph.onLog((event) => get().pushLog(event))
    try {
      set({ settings: await window.cartograph.getSettings() })
    } catch (error) {
      set({ error: (error as Error).message })
    }
  },

  async openProject() {
    set({ busy: 'opening', error: null })
    try {
      const result = await window.cartograph.openProject()
      if (result.canceled || !result.project) {
        set({ busy: 'idle' })
        return
      }
      set({ project: result.project, busy: 'idle' })
      await get().analyze({ restoreSaved: true })
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async openProjectAt(root: string) {
    set({ busy: 'opening', error: null })
    try {
      const result = await window.cartograph.openProjectAt(root)
      if (!result.project) {
        set({ busy: 'idle' })
        return
      }
      set({ project: result.project, busy: 'idle' })
      await get().analyze({ restoreSaved: true })
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async analyze(options = {}) {
    const project = get().project
    if (!project) return

    // Re-analyzing rebuilds the graph from source, which drops any edit that
    // has not been written yet. Losing that silently would be the worst kind
    // of bug, so it is confirmed first.
    const unapplied = pendingOperations(get()).length
    if (unapplied > 0 && options.force !== true) {
      const proceed =
        typeof globalThis.confirm === 'function'
          ? globalThis.confirm(
              `Re-analyzing reads the architecture back from the source code, which discards ${unapplied} edit(s) you have not generated yet.

Continue?`
            )
          : false
      if (!proceed) return
    }
    const useAi =
      options.useAi ?? (get().settings?.aiAssistAnalysis === true &&
        get().settings?.hasApiKey === true)

    set({
      busy: 'analyzing',
      error: null,
      changeSet: null,
      diffs: null,
      applyResult: null,
      validation: null,
      bottomTab: 'activity'
    })

    try {
      const result = await window.cartograph.analyze(project.root, { useAi })
      set({
        project: result.project,
        fileTree: result.fileTree,
        original: result.graph,
        desired: result.graph,
        layout: result.layout,
        operations: [],
        appliedOperationIds: [],
        selectedModuleId: result.graph.modules[0]?.id ?? null,
        selectedFile: null,
        selectedOperationId: null,
        bottomTab: 'preview',
        dirty: false,
        busy: 'idle'
      })

      if (options.restoreSaved && result.savedDocument) {
        get().restoreDocument(result.savedDocument)
      }
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async cancel() {
    await window.cartograph.cancelWork()
    set({ busy: 'idle' })
  },

  dispatchOperation(body) {
    const { desired, operations, layout } = get()
    if (!desired) return false

    const result = applyOperation(desired, body)
    if (!result.ok) {
      set((state) => ({
        error: result.error,
        logs: [...state.logs, localLog('error', 'app', result.error)].slice(-MAX_LOGS)
      }))
      return false
    }

    const op: GraphOperation = {
      ...body,
      id: operationId(),
      actor: ACTOR,
      issuedAt: new Date().toISOString(),
      baseVersion: desired.version
    } as GraphOperation

    const nextLogs = [
      ...get().logs,
      localLog(
        isStructural(op) ? 'info' : 'debug',
        'app',
        `${isStructural(op) ? 'Structural' : 'Metadata'} edit: ${describe(body)}`
      ),
      ...result.warnings.map((w) => localLog('warn', 'app', w))
    ].slice(-MAX_LOGS)

    set({
      desired: result.graph,
      operations: [...operations, op],
      selectedOperationId: op.id,
      layout: {
        ...layout,
        positions: fillMissingPositions(result.graph, layout.positions),
        version: layout.version + 1
      },
      dirty: true,
      error: null,
      logs: nextLogs,
      // A new plan has to be built after any edit.
      changeSet: null,
      diffs: null,
      ...(body.type === 'add_module' ? { selectedModuleId: body.module.id } : {}),
      ...(body.type === 'delete_module' && get().selectedModuleId === body.moduleId
        ? { selectedModuleId: null }
        : {})
    })
    return true
  },

  setPosition(id, position) {
    // Visual only: no operation is recorded and no code change can result.
    set((state) => ({
      layout: {
        ...state.layout,
        algorithm: 'manual',
        positions: { ...state.layout.positions, [id]: position },
        version: state.layout.version + 1
      },
      dirty: true
    }))
  },

  setExpanded(id, expanded) {
    set((state) => ({
      layout: {
        ...state.layout,
        expanded: { ...state.layout.expanded, [id]: expanded },
        version: state.layout.version + 1
      }
    }))
  },

  relayout() {
    const graph = get().desired
    if (!graph) return
    set((state) => ({
      layout: {
        ...state.layout,
        algorithm: 'layered',
        positions: layoutGraph(graph),
        version: state.layout.version + 1
      },
      dirty: true,
      notice: 'Re-laid out the graph. Layout is visual only — no code changed.'
    }))
  },

  select(id) {
    set({ selectedModuleId: id, selectedFile: null, ...(id ? { bottomTab: 'module' as const } : {}) })
  },

  selectFile(path) {
    set({ selectedFile: path, bottomTab: 'module' })
  },

  selectOperation(id) {
    const op = get().operations.find((candidate) => candidate.id === id)
    if (!op) return
    const moduleId = op.type === 'add_module' ? op.module.id
      : 'toModuleId' in op ? op.toModuleId
        : 'moduleId' in op ? op.moduleId : op.to
    set({ selectedOperationId: id, selectedModuleId: moduleId, selectedFile: null,
      bottomTab: 'preview', deskMode: 'review' })
  },

  setDeskMode(mode) {
    set({ deskMode: mode, bottomTab: mode === 'review' ? 'preview' : 'module' })
  },

  async saveDocument() {
    const { project, original, desired, layout, operations, appliedOperationIds } =
      get()
    if (!project || !original || !desired) return
    set({ busy: 'saving', error: null })
    try {
      const document: ArchitectureDocument = {
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        projectRoot: project.root,
        original,
        desired,
        layout,
        operations,
        appliedOperationIds,
        savedAt: new Date().toISOString()
      }
      const saved = await window.cartograph.saveDocument({ document })
      set({
        busy: 'idle',
        dirty: false,
        notice: `Saved the architecture to ${saved.path}`
      })
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  restoreDocument(document) {
    // The saved document's `original` is a snapshot of how the code looked when
    // it was saved, and the code may have moved on since. So the freshly
    // analyzed graph stays authoritative and the saved *operation log* is
    // replayed onto it — which is the same mechanism a shared backend would use
    // to catch a client up. Operations that no longer apply are reported rather
    // than dropped in silence.
    const fresh = get().original
    if (!fresh) {
      set({
        original: document.original,
        desired: document.desired,
        layout: document.layout,
        operations: document.operations,
        appliedOperationIds: document.appliedOperationIds
      })
      return
    }

    const replay = applyOperations(fresh, document.operations)
    const stale = new Set(replay.failures.map((f) => f.operationId))
    const kept = document.operations.filter((op) => !stale.has(op.id))

    const logs: LogEvent[] = [
      localLog(
        'info',
        'app',
        `Restored the saved architecture: replayed ${kept.length} of ${document.operations.length} recorded edit(s) onto the current source (saved ${new Date(
          document.savedAt
        ).toLocaleString()})`
      ),
      ...replay.warnings.map((w) => localLog('warn', 'app', w)),
      ...replay.failures.map((f) =>
        localLog(
          'warn',
          'app',
          `A saved edit no longer applies and was dropped: ${f.error}`,
          f.operationId
        )
      )
    ]

    set((state) => ({
      desired: replay.graph,
      layout: {
        ...document.layout,
        positions: fillMissingPositions(replay.graph, document.layout.positions)
      },
      operations: kept,
      appliedOperationIds: document.appliedOperationIds,
      selectedModuleId: replay.graph.modules[0]?.id ?? null,
      dirty: replay.failures.length > 0,
      logs: [...state.logs, ...logs].slice(-MAX_LOGS)
    }))
  },

  async plan(useAi) {
    const { project, original, operations, appliedOperationIds } = get()
    if (!project || !original) return

    const pending = operations.filter((op) => !appliedOperationIds.includes(op.id))
    if (pending.length === 0) {
      set({
        notice:
          'There is nothing to generate: no architectural edits are waiting to be applied.'
      })
      return
    }

    set({ busy: 'planning', error: null, bottomTab: 'changes', deskMode: 'review', diffs: null })
    try {
      const changeSet = await window.cartograph.planChanges(project.root, {
        graph: original,
        operations: pending,
        useAi
      })
      set({ changeSet, busy: 'idle' })
      await get().loadDiffs()
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async loadDiffs() {
    const changeSet = get().changeSet
    if (!changeSet) return
    try {
      set({ diffs: await window.cartograph.previewDiff(changeSet) })
    } catch (error) {
      set({ error: (error as Error).message })
    }
  },

  async apply(options) {
    const { project, changeSet } = get()
    if (!project || !changeSet) return

    set({ busy: 'applying', error: null, bottomTab: 'results' })
    try {
      const result = await window.cartograph.applyChanges(project.root, {
        mode: options.mode,
        outputDirectory: options.outputDirectory,
        createBackup: options.createBackup,
        validate: options.validate,
        changeSet
      })
      set({
        applyResult: result,
        validation: result.validation,
        busy: 'idle',
        dialog: null,
        appliedOperationIds: [
          ...new Set([...get().appliedOperationIds, ...result.appliedOperationIds])
        ],
        dirty: true
      })

      // After writing over the project itself, the analyzed architecture is
      // stale; re-analyze so the graph reflects what is now on disk.
      if (options.mode === 'in-place' && result.errors.length === 0) {
        await get().analyze({ useAi: false })
        set({
          notice:
            'Applied the changes to the project and re-analyzed it from the new source.'
        })
      } else if (result.errors.length === 0) {
        set({
          notice: `Generated the project into ${result.outputDirectory}. The original project was not modified.`
        })
      }
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  async validateCurrent() {
    const project = get().project
    if (!project) return
    set({ busy: 'validating', error: null, bottomTab: 'results' })
    try {
      const validation = await window.cartograph.validateProject(project.root)
      set({ validation, busy: 'idle' })
    } catch (error) {
      set({ busy: 'idle', error: (error as Error).message })
    }
  },

  discardPlan() {
    set({ changeSet: null, diffs: null, dialog: null })
  },

  async updateSettings(patch) {
    try {
      set({ settings: await window.cartograph.setSettings(patch) })
    } catch (error) {
      set({ error: (error as Error).message })
    }
  },

  openDialog(name, position) {
    set({ dialog: name, addModulePosition: name === 'add-module' ? position ?? null : null })
  },

  setBottomTab(tab) {
    set({ bottomTab: tab })
  },

  pushLog(event) {
    set((state) => ({ logs: [...state.logs, event].slice(-MAX_LOGS) }))
  },

  clearLogs() {
    set({ logs: [] })
  },

  setError(message) {
    set({ error: message })
  },

  setNotice(message) {
    set({ notice: message })
  }
}))

function describe(body: GraphOperationBody): string {
  switch (body.type) {
    case 'add_module':
      return `created module "${body.module.name}"`
    case 'rename_module':
      return `renamed a module to "${body.name}"`
    case 'update_module':
      return 'edited module properties'
    case 'delete_module':
      return `deleted a module (${body.fileDisposition} its files)`
    case 'move_file':
      return `moved ${body.file}`
    case 'move_symbol':
      return `moved symbol ${body.symbol}`
    case 'move_responsibility':
      return `moved responsibility "${body.responsibility}"`
    case 'add_dependency':
      return `added a ${body.kind} dependency`
    case 'remove_dependency':
      return 'removed a dependency'
    case 'scaffold_module':
      return 'requested an implementation for a module'
    default:
      return 'edited the architecture'
  }
}

// ---------------------------------------------------------------------------
// Derived values.
//
// These are hooks rather than plain selectors on purpose. A zustand selector
// that builds a new object or array returns a fresh reference on every call,
// which under `useSyncExternalStore` re-renders forever ("maximum update depth
// exceeded"). Subscribing to the raw slices and deriving with `useMemo` keeps
// the reference stable for as long as the inputs are.
// ---------------------------------------------------------------------------

function pendingFrom(
  operations: GraphOperation[],
  applied: string[]
): GraphOperation[] {
  if (applied.length === 0) return operations
  const done = new Set(applied)
  return operations.filter((op) => !done.has(op.id))
}

export function usePendingOperations(): GraphOperation[] {
  const operations = useStore((s) => s.operations)
  const applied = useStore((s) => s.appliedOperationIds)
  return useMemo(() => pendingFrom(operations, applied), [operations, applied])
}

/** Modules affected by at least one operation that has not reached the code. */
export function useModulesWithPendingChanges(): Set<ModuleId> {
  const pending = usePendingOperations()
  return useMemo(() => {
    const ids = new Set<ModuleId>()
    for (const op of pending) {
      if (!isStructural(op)) continue
      switch (op.type) {
        case 'add_module':
          ids.add(op.module.id)
          break
        case 'rename_module':
        case 'delete_module':
        case 'scaffold_module':
          ids.add(op.moduleId)
          break
        case 'move_file':
        case 'move_symbol':
        case 'move_responsibility':
          ids.add(op.fromModuleId)
          ids.add(op.toModuleId)
          break
        default:
          break
      }
    }
    return ids
  }, [pending])
}

export interface PendingSummary {
  structural: number
  metadata: number
  text: string
}

export function usePendingSummary(): PendingSummary {
  const pending = usePendingOperations()
  const hasProject = useStore((s) => s.original !== null)
  return useMemo(() => {
    const structural = pending.filter(isStructural).length
    const metadata = pending.length - structural

    if (pending.length === 0) {
      return {
        structural,
        metadata,
        text: hasProject ? 'Graph matches the source code' : 'No project open'
      }
    }
    const parts: string[] = []
    if (structural > 0) {
      parts.push(
        `${structural} change${structural === 1 ? '' : 's'} not yet in the code`
      )
    }
    if (metadata > 0) {
      parts.push(`${metadata} documentation edit${metadata === 1 ? '' : 's'}`)
    }
    return { structural, metadata, text: parts.join(', ') }
  }, [pending, hasProject])
}

export function useArchitectureDiffText(): string {
  const original = useStore((s) => s.original)
  const desired = useStore((s) => s.desired)
  return useMemo(
    () =>
      original && desired
        ? summarizeDiff(diffArchitectures(original, desired))
        : '',
    [original, desired]
  )
}

/**
 * The non-hook forms, for tests and for any caller that already holds a state
 * snapshot rather than being inside a component.
 */
export function pendingOperations(state: AppState): GraphOperation[] {
  return pendingFrom(state.operations, state.appliedOperationIds)
}
