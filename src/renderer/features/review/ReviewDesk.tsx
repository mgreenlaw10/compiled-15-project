import { useMemo, useState, type ReactNode } from 'react'

import { applyOperation, projectedMoveTarget } from '../../../shared/graph/apply-operation'
import type { ArchitectureGraph } from '../../../shared/types/architecture'
import type { FileChange } from '../../../shared/types/generation'
import { describeOperation, OPERATION_LABELS, requiresAi, type GraphOperation } from '../../../shared/types/operations'
import { usePendingOperations, useStore } from '../../state/store'
import { Badge, Empty, plural } from '../../ui'

/** Replay the same reducer as the editor, so every preview reflects its place in the edit log. */
function reviewFacts(original: ArchitectureGraph, operations: GraphOperation[], selected: GraphOperation): { before: string; after: string } {
  let before = original
  for (const op of operations) {
    if (op.id === selected.id) break
    const result = applyOperation(before, op)
    if (result.ok) before = result.graph
  }
  const module = (id: string): string => before.modules.find((m) => m.id === id)?.name ?? id
  const snapshot = (id: string): string => {
    const node = before.modules.find((m) => m.id === id)
    return node ? `${node.name}\n${node.directory ?? 'No backing directory'}\n${plural(node.files.length, 'source file')}` : 'No module'
  }
  switch (selected.type) {
    case 'add_module':
      return { before: 'Module does not exist', after: `${selected.module.name}\n${selected.module.directory ?? 'No backing directory'}\n${selected.module.description || 'No description yet'}` }
    case 'move_file': {
      const target = before.modules.find((m) => m.id === selected.toModuleId)
      return { before: `${selected.file}\nOwned by ${module(selected.fromModuleId)}`, after: `${target ? projectedMoveTarget(selected.file, target, selected.toPath) : selected.toPath ?? selected.file}\nOwned by ${module(selected.toModuleId)}` }
    }
    case 'rename_module':
      return { before: snapshot(selected.moduleId), after: `${selected.name}\n${selected.directory === undefined ? before.modules.find((m) => m.id === selected.moduleId)?.directory ?? 'No backing directory' : selected.directory ?? 'No backing directory'}` }
    case 'delete_module':
      return { before: snapshot(selected.moduleId), after: selected.fileDisposition === 'reassign' && selected.reassignTo ? `Module removed\nFiles reassigned to ${module(selected.reassignTo)}` : `Module removed\nFiles ${selected.fileDisposition === 'delete' ? 'deleted' : 'left in place, unassigned'}` }
    case 'update_module': {
      const current = before.modules.find((m) => m.id === selected.moduleId)
      const fields = ['description', 'responsibilities', 'publicInterface', 'tags'] as const
      const format = (value: string | string[] | undefined): string => Array.isArray(value) ? value.join('\n') || '(empty)' : value || '(empty)'
      return { before: fields.filter((key) => selected[key] !== undefined).map((key) => `${key}: ${format(key === 'tags' ? current?.metadata.tags : current?.[key])}`).join('\n'), after: fields.filter((key) => selected[key] !== undefined).map((key) => `${key}: ${format(selected[key])}`).join('\n') }
    }
    case 'move_symbol':
      return { before: `${selected.symbol}\n${selected.fromFile}\n${module(selected.fromModuleId)}`, after: `${selected.symbol}\n${selected.toFile ?? `Destination resolved during planning`}\n${module(selected.toModuleId)}${selected.leaveReExport ? '\nKeep a re-export at the original location' : ''}` }
    case 'move_responsibility':
      return { before: `${selected.responsibility}\n${module(selected.fromModuleId)}`, after: `${selected.responsibility}\n${module(selected.toModuleId)}\nImplementation requires a model` }
    case 'add_dependency': {
      const existing = before.edges.find((edge) => edge.from === selected.from && edge.to === selected.to)
      return {
        before: `${module(selected.from)} → ${module(selected.to)}\n${existing ? `${existing.kind} dependency (${existing.verified ? 'verified' : 'declared'})` : 'No dependency'}`,
        after: `${module(selected.from)} → ${module(selected.to)}\nSet dependency kind to ${selected.kind}\nSource impact is checked during planning`
      }
    }
    case 'remove_dependency':
      return { before: `${module(selected.from)} → ${module(selected.to)}\nDependency in the architecture`, after: 'Dependency removed from the graph\nSource impact is checked during planning' }
    case 'scaffold_module':
      return { before: snapshot(selected.moduleId), after: `${selected.instructions || 'Implement the module’s public interface'}\nImplementation requires a model` }
  }
}

function operationTitle(op: GraphOperation, graph: ArchitectureGraph | null): string {
  if (op.type === 'add_module') return op.module.name
  if (op.type === 'move_file') return op.file.split('/').at(-1) ?? op.file
  if (op.type === 'rename_module') return op.name
  if (op.type === 'move_symbol') return op.symbol
  if (op.type === 'move_responsibility') return op.responsibility
  const name = (id: string): string => graph?.modules.find((module) => module.id === id)?.name ?? id
  return 'moduleId' in op ? name(op.moduleId) : `${name(op.from)} → ${name(op.to)}`
}

export function ReviewSidebar({ projectContent }: { projectContent: ReactNode }): JSX.Element {
  const [view, setView] = useState<'changes' | 'project'>('changes')
  const pending = usePendingOperations()
  const selectedId = useStore((s) => s.selectedOperationId)
  const selectOperation = useStore((s) => s.selectOperation)
  const graph = useStore((s) => s.desired)
  const project = useStore((s) => s.project)
  const openDialog = useStore((s) => s.openDialog)
  const busy = useStore((s) => s.busy)
  const activeId = pending.find((op) => op.id === selectedId)?.id ?? pending.at(-1)?.id

  return (
    <aside className="review-sidebar" aria-label="Project and pending changes">
      <div className="sidebar-project"><span className="project-symbol" aria-hidden="true">⌘</span><div><strong>{project?.name ?? 'Your workspace'}</strong><span>{project ? 'Architecture workspace' : 'No project open'}</span></div></div>
      <div className="sidebar-switch" aria-label="Sidebar views">
        <button aria-pressed={view === 'changes'} onClick={() => setView('changes')}>Changes <span className="count">{pending.length}</span></button>
        <button aria-pressed={view === 'project'} onClick={() => setView('project')}>Project</button>
      </div>
      {view === 'project' ? projectContent : <div className="pending-list">
        <div className="sidebar-caption">PENDING CHANGES <span>{String(pending.length).padStart(2, '0')}</span></div>
        {pending.length === 0 ? <div className="pending-empty"><span className="empty-symbol" aria-hidden="true">↗</span><strong>Room for your next change.</strong><p>{graph ? 'Add a module, move a file, or edit a module on the map. Each edit will appear here.' : 'Open a project to begin. Your architecture edits will appear here.'}</p></div> : pending.map((op, index) => (
          <button key={op.id} className={`pending-card${activeId === op.id ? ' is-selected' : ''}`} aria-label={`${String(index + 1).padStart(2, '0')} ${OPERATION_LABELS[op.type]} ${operationTitle(op, graph)}`} aria-pressed={activeId === op.id} onClick={() => selectOperation(op.id)}>
            <span className="operation-number">{String(index + 1).padStart(2, '0')}</span>
            <span className="operation-copy"><span className="operation-type">{OPERATION_LABELS[op.type]}</span><strong>{operationTitle(op, graph)}</strong><span className="operation-path">{op.type === 'add_module' ? op.module.directory ?? 'Graph module' : op.type === 'move_file' ? op.file : requiresAi(op) ? 'Model-assisted change' : 'Architecture edit'}</span></span>
          </button>
        ))}
      </div>}
      <div className="sidebar-footer"><p>Graph edits stay here until you review a plan and write the changes.</p><button className="btn" disabled={!graph || busy !== 'idle'} onClick={() => openDialog('add-module')}>+ Add a module</button></div>
    </aside>
  )
}

function SourcePreview({ changes }: { changes: FileChange[] }): JSX.Element {
  const [path, setPath] = useState(changes[0]?.path)
  const change = changes.find((item) => item.path === path) ?? changes[0]
  if (!change) return <Empty>This operation produced no source file changes. Read its outcome in Plan.</Empty>
  return <div className="source-preview">
    <label className="source-picker"><span>Source preview</span><select aria-label="Preview file" value={change.path} onChange={(event) => setPath(event.target.value)}>{changes.map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}</select><Badge kind="info">{change.kind}</Badge></label>
    <div className="comparison source-comparison">
      <section aria-label="Source before"><div className="comparison-label">BEFORE <span>{change.previousPath ?? change.path}</span></div><pre>{change.before ?? 'File does not exist'}</pre></section>
      <section aria-label="Source after"><div className="comparison-label">AFTER <span>{change.path}</span></div><pre>{change.after ?? 'File removed'}</pre></section>
    </div><p className="hint">{change.reason}. File contents include all edits in this plan.</p>
  </div>
}

export function ReviewPreview(): JSX.Element {
  const pending = usePendingOperations()
  const selectedId = useStore((s) => s.selectedOperationId)
  const original = useStore((s) => s.original)
  const operations = useStore((s) => s.operations)
  const changeSet = useStore((s) => s.changeSet)
  const plan = useStore((s) => s.plan)
  const busy = useStore((s) => s.busy)
  const settings = useStore((s) => s.settings)
  const setTab = useStore((s) => s.setBottomTab)
  const selected = pending.find((op) => op.id === selectedId) ?? pending.at(-1)
  const facts = useMemo(() => original && selected ? reviewFacts(original, operations, selected) : null, [original, operations, selected])

  if (!selected || !facts) return <div className="review-empty"><div className="eyebrow">FROM ARCHITECTURE TO SOURCE</div><h2>Every change deserves a closer look.</h2><p>Select a module to edit its properties, or right-click the map to add one. Select a pending change to compare its current and desired state.</p><div className="review-empty-steps"><span><b>01</b> Edit the architecture</span><span><b>02</b> Review the source plan</span><span><b>03</b> Generate your project</span></div></div>
  const outcome = changeSet?.outcomes.find((item) => item.operationId === selected.id)
  const changes = changeSet?.changes.filter((item) => item.operationIds.includes(selected.id)) ?? []
  return <div className="review-preview">
    <div className="review-preview-heading"><div><div className="eyebrow">{OPERATION_LABELS[selected.type]}</div><h2>{describeOperation(selected)}</h2></div>{changeSet ? <button className="btn btn--sm" onClick={() => setTab('changes')}>Review full plan →</button> : <Badge kind="pending">Not yet generated</Badge>}</div>
    {!changeSet ? <div className="comparison architecture-comparison">
      <section aria-label="Architecture before"><div className="comparison-label"><span className="state-dot" />CURRENT STATE <span>Before this edit</span></div><pre>{facts.before}</pre></section>
      <section aria-label="Architecture after"><div className="comparison-label"><span className="state-dot desired" />DESIRED STATE <span>After this edit</span></div><pre>{facts.after}</pre></section>
    </div> : null}
    {changeSet ? (
      <>
        <div className="preview-outcome">
          <strong>{outcome?.status === 'applied' ? 'Planned' : outcome?.status.replaceAll('_', ' ') ?? 'No outcome'}</strong>
          <span>{outcome?.message ?? 'This operation has no recorded outcome in the current plan.'}</span>
        </div>
        {outcome?.warnings.length ? (
          <details className="preview-warnings">
            <summary>{plural(outcome.warnings.length, 'review note')}</summary>
            {outcome.warnings.map((warning, index) => <p key={index} className="banner banner--warn">{warning}</p>)}
          </details>
        ) : null}
        <SourcePreview key={selected.id} changes={changes} />
      </>
    ) : (
      <div className="preview-next">
        <p><strong>Ready to inspect the source impact?</strong><span>Generate a plan to see actual file contents, import rewrites, and operation outcomes.</span></p>
        <button className="btn" disabled={busy !== 'idle'} onClick={() => void plan(settings?.hasApiKey === true)}>Plan the changes</button>
      </div>
    )}
  </div>
}
