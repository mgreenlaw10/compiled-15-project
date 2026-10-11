import { useArchitectureDiffText, usePendingSummary, useStore } from '../../state/store'
import { plural } from '../../ui'

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
