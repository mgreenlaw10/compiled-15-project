import { useArchitectureDiffText, usePendingSummary, useStore } from '../state/store'
import { plural } from './common'

export function Toolbar(): JSX.Element {
  const project = useStore((s) => s.project)
  const graph = useStore((s) => s.desired)
  const busy = useStore((s) => s.busy)
  const dirty = useStore((s) => s.dirty)
  const settings = useStore((s) => s.settings)
  const mode = useStore((s) => s.deskMode)
  const tab = useStore((s) => s.bottomTab)
  const changeSet = useStore((s) => s.changeSet)
  const applyResult = useStore((s) => s.applyResult)
  const setMode = useStore((s) => s.setDeskMode)
  const setTab = useStore((s) => s.setBottomTab)
  const openProject = useStore((s) => s.openProject)
  const saveDocument = useStore((s) => s.saveDocument)
  const openDialog = useStore((s) => s.openDialog)
  const plan = useStore((s) => s.plan)
  const cancel = useStore((s) => s.cancel)
  const pending = usePendingSummary()
  const hasPending = pending.structural + pending.metadata > 0
  const idle = busy === 'idle'
  const generating = tab === 'results' || tab === 'changes'

  return (
    <header className="toolbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">C</span><strong>Cartograph</strong><span className="brand-slash">/</span><span className="project-breadcrumb" title={project?.root}>{project?.name ?? 'Workspace'}</span></div>
      <nav className="workflow" aria-label="Workspace stages">
        <button aria-current={mode === 'architecture' ? 'step' : undefined} onClick={() => setMode('architecture')}><span>01</span> Architecture</button>
        <span className="workflow-chevron" aria-hidden="true">›</span>
        <button aria-current={mode === 'review' && !generating ? 'step' : undefined} onClick={() => setMode('review')}><span>02</span> Review changes</button>
        <span className="workflow-chevron" aria-hidden="true">›</span>
        <button disabled={!changeSet && (!applyResult || hasPending)} aria-current={mode === 'review' && generating ? 'step' : undefined} onClick={() => { setMode('review'); setTab(applyResult && !hasPending ? 'results' : 'changes') }}><span>03</span> Generate</button>
      </nav>
      <div className="toolbar-actions">
        <button className="btn btn--ghost" onClick={() => void openProject()} disabled={!idle}>Open Project</button>
        <button className="btn btn--ghost save-action" onClick={() => void saveDocument()} disabled={!idle || !graph} title="Save architecture, layout and edit log">Save Graph{dirty ? ' •' : ''}</button>
        {!idle ? <button className="btn btn--danger btn--sm" onClick={() => void cancel()}>Cancel {busy}</button> : null}
        <button className="btn btn--primary" onClick={() => { setMode('review'); void plan(settings?.hasApiKey === true) }} disabled={!idle || !hasPending} title="Preview the source changes before writing files">{busy === 'planning' ? 'Planning…' : 'Generate plan'}<span aria-hidden="true">↗</span></button>
        <button className="btn btn--ghost settings-action" onClick={() => openDialog('settings')} title={settings?.hasApiKey ? `Settings · ${settings.model}` : 'Settings · no api key'}>Settings</button>
      </div>
    </header>
  )
}

export function StatusBar(): JSX.Element {
  const project = useStore((s) => s.project)
  const graph = useStore((s) => s.desired)
  const busy = useStore((s) => s.busy)
  const dirty = useStore((s) => s.dirty)
  const settings = useStore((s) => s.settings)
  const openDialog = useStore((s) => s.openDialog)
  const pending = usePendingSummary()
  const diffText = useArchitectureDiffText()
  const verified = graph?.edges.filter((e) => e.verified).length ?? 0
  const declared = (graph?.edges.length ?? 0) - verified
  const dotClass = busy !== 'idle' ? 'dot dot--busy' : pending.structural > 0 ? 'dot dot--pending' : graph ? 'dot dot--ok' : 'dot'

  return (
    <footer className="statusbar">
      <span className="status-item"><span className={dotClass} />{busy !== 'idle' ? `${busy}…` : pending.text}</span>
      {graph ? <><span className="status-item">{plural(graph.modules.length, 'module')}</span><span className="status-item" title="Edges backed by real imports">{verified} verified</span>{declared ? <span className="status-item" title="Declared dependencies without a source import">{declared} declared</span> : null}{diffText && diffText !== 'No architectural changes' ? <span className="status-item architecture-delta" title="Difference from analyzed architecture">Δ {diffText}</span> : null}</> : null}
      <span className="spacer" />
      {dirty ? <span className="status-item faint">unsaved graph</span> : null}
      <button className="status-settings" onClick={() => openDialog('settings')} title={settings?.hasApiKey ? `Model: ${settings.model}` : 'Deterministic analysis and refactors work without a key'}>{settings?.hasApiKey ? 'ai ready' : 'no api key'}</button>
      <span className="status-item faint mono project-status" title={project?.root}>{project?.root ?? 'no project open'}</span>
    </footer>
  )
}
