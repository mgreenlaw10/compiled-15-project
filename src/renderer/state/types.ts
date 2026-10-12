/**
 * The shape of the renderer's store, assembled from slices.
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
 *
 * ---------------------------------------------------------------------------
 * Adding state
 * ---------------------------------------------------------------------------
 * State is split into slices under `./slices`, one per concern, and `AppState`
 * below is their intersection. To add some:
 *
 * 1. Add the fields and actions to the slice they belong to, or write a new
 *    slice file and a new interface here.
 * 2. Spread its creator in `./store.ts`.
 *
 * Slices are plain `StateCreator`s over the whole `AppState`, so one slice can
 * call another's actions through `get()`. They are separate files so that two
 * people adding unrelated state do not edit the same one.
 */

import type { StateCreator } from 'zustand'

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
  DiffPreview,
  LogEvent,
  SettingsPatch,
  SettingsView
} from '../../shared/ipc'
import type {
  ArchitectureDocument,
  FileTreeNode,
  ProjectInfo
} from '../../shared/types/project'
import type { Actor, Participant, Task } from '../../shared/collab'
import type {
  CollabSnapshot,
  CreateTaskRequest,
  IntegrationReport,
  WorkspaceStatus
} from '../../shared/ipc'

export type Busy =
  | 'idle'
  | 'opening'
  | 'analyzing'
  | 'planning'
  | 'applying'
  | 'validating'
  | 'saving'

/**
 * Which modal is open. Dialogs register themselves in
 * `features/dialogs/registry.ts`; this is the union of their names.
 */
export type DialogName =
  | null
  | 'collab-setup'
  | 'create-task'
  | 'integration'
  | 'generate'
  | 'settings'
  | 'add-module'
  | 'diff'
  | 'delete-module'

export type BottomTab =
  | 'activity'
  | 'changes'
  | 'results'
  | 'agents'
  | 'git'
  | 'validation'

export interface ProjectSlice {
  project: ProjectInfo | null
  fileTree: FileTreeNode | null

  openProject(): Promise<void>
  openProjectAt(root: string): Promise<void>
  analyze(options?: {
    useAi?: boolean
    restoreSaved?: boolean
    /** Skip the "discard unapplied edits?" prompt. */
    force?: boolean
  }): Promise<void>
  cancel(): Promise<void>
}

export interface GraphSlice {
  original: ArchitectureGraph | null
  desired: ArchitectureGraph | null
  operations: GraphOperation[]
  appliedOperationIds: string[]

  /** Applies an edit to `desired` and records it. `false` if it was rejected. */
  dispatchOperation(body: GraphOperationBody): boolean
}

export interface LayoutSlice {
  layout: GraphLayout
  /** Visual only: records no operation and can never produce a code change. */
  setPosition(id: ModuleId, position: NodePosition): void
  setExpanded(id: ModuleId, expanded: boolean): void
  relayout(): void
}

export interface SelectionSlice {
  viewScope: { moduleId: ModuleId; file?: string } | null
  selectedSymbolId: string | null
  selectedRelationshipId: string | null
  openModule(id: ModuleId): void
  openFile(moduleId: ModuleId, file: string): void
  backToProject(): void
  selectSymbol(id: string | null): void
  selectRelationship(id: string | null): void
  selectedModuleId: ModuleId | null
  selectedFile: string | null
  select(id: ModuleId | null): void
  selectFile(path: string | null): void
}

export interface DocumentSlice {
  /** `true` when the document differs from what is on disk. */
  dirty: boolean
  saveDocument(): Promise<void>
  restoreDocument(document: ArchitectureDocument): void
}

export interface GenerationSlice {
  changeSet: ChangeSet | null
  diffs: DiffPreview[] | null
  applyResult: ApplyResult | null
  validation: ValidationReport | null

  plan(useAi: boolean): Promise<void>
  generate(useAi: boolean): Promise<void>
  loadDiffs(): Promise<void>
  apply(options: {
    mode: WriteMode
    outputDirectory?: string
    createBackup: boolean
    validate: boolean
  }): Promise<void>
  validateCurrent(): Promise<void>
  discardPlan(): void
}

export interface SettingsSlice {
  settings: SettingsView | null
  loadSettings(): Promise<void>
  updateSettings(patch: SettingsPatch): Promise<void>
}

export interface UiSlice {
  dialog: DialogName
  busy: Busy
  error: string | null
  notice: string | null
  bottomTab: BottomTab
  /** Canvas overlays, toggled from the View menu. */
  showLegend: boolean
  showMinimap: boolean
  /** Panel sizes, in pixels. Dragged by the user; purely visual. */
  leftPaneWidth: number
  bottomPanelHeight: number

  toggleLegend(): void
  toggleMinimap(): void
  setLeftPaneWidth(width: number): void
  setBottomPanelHeight(height: number): void
  openDialog(name: DialogName): void
  setBottomTab(tab: BottomTab): void
  setError(message: string | null): void
  setNotice(message: string | null): void
}

export interface LogSlice {
  logs: LogEvent[]
  pushLog(event: LogEvent): void
  clearLogs(): void
}

/**
 * Who is editing. Single-writer today; see `shared/collab` for the shape a
 * second writer would take.
 */
export interface SessionSlice {
  actor: Actor
  /** Other participants, when a session is shared. Empty when running alone. */
  participants: Participant[]
  setParticipants(participants: Participant[]): void
}

/**
 * Git-backed collaboration.
 *
 * A cache of the backend's snapshot plus the actions that change it. Mutations
 * always go through the backend, never applied optimistically here, so there is
 * one implementation of the merge rules rather than two that can disagree.
 */
export interface CollabSlice {
  /** `null` when collaboration is not enabled for this project. */
  collab: CollabSnapshot | null
  collabWorkspace: WorkspaceStatus | null
  collabBusy: boolean
  collabError: string | null
  selectedTaskId: string | null
  /** Integration assessments by task id, so a report survives a dialog close. */
  integrationReports: Record<string, IntegrationReport>

  inspectWorkspace(): Promise<void>
  initializeCollaboration(remoteUrl?: string): Promise<void>
  joinCollaboration(): Promise<void>
  connectCollaboration(): Promise<void>
  disconnectCollaboration(): Promise<void>
  /** Applied when the backend pushes a change, rather than on a poll. */
  receiveSnapshot(snapshot: CollabSnapshot): void
  syncCollaboration(): Promise<void>

  createTask(
    request: Omit<CreateTaskRequest, 'graphVersion'>
  ): Promise<Task | null>
  claimModule(moduleId: ModuleId, taskId: string): Promise<void>
  releaseModule(moduleId: ModuleId): Promise<void>

  startAgent(taskId: string): Promise<void>
  cancelAgent(taskId: string): Promise<void>
  sendInstruction(sessionId: string, text: string): Promise<void>

  assessIntegration(taskId: string): Promise<IntegrationReport | null>
  submitIntegration(taskId: string): Promise<IntegrationReport | null>
  integrateTask(taskId: string): Promise<IntegrationReport | null>

  selectTask(taskId: string | null): void
  setCollabError(message: string | null): void
}

export interface LifecycleSlice {
  /** Subscribes to backend logs and loads settings. Called once, on mount. */
  init(): Promise<void>
}

export interface AppState
  extends ProjectSlice,
    GraphSlice,
    LayoutSlice,
    SelectionSlice,
    DocumentSlice,
    GenerationSlice,
    SettingsSlice,
    UiSlice,
    LogSlice,
    SessionSlice,
    CollabSlice,
    LifecycleSlice {}

/** The slice signature. Every slice sees the whole store through `get`. */
export type Slice<T> = StateCreator<AppState, [], [], T>
