/**
 * The top toolbar: the project's identity and the primary actions.
 */

import { usePendingSummary, useStore } from '../../state/store'
import { Badge } from '../../ui'

export function Toolbar(): JSX.Element {
  const project = useStore((s) => s.project)
  const graph = useStore((s) => s.desired)
  const busy = useStore((s) => s.busy)
  const dirty = useStore((s) => s.dirty)
  const settings = useStore((s) => s.settings)

  const openProject = useStore((s) => s.openProject)
  const analyze = useStore((s) => s.analyze)
  const saveDocument = useStore((s) => s.saveDocument)
  const relayout = useStore((s) => s.relayout)
  const openDialog = useStore((s) => s.openDialog)
  const generate = useStore((s) => s.generate)
  const cancel = useStore((s) => s.cancel)

  const pending = usePendingSummary()
  const idle = busy === 'idle'
  const hasProject = project !== null

  return (
    <header className="toolbar">
      <div className="brand">
        <strong>Cartograph</strong>
        <span>visual codebase editor</span>
      </div>

      <button className="btn" onClick={() => void openProject()} disabled={!idle}>
        Open Project
      </button>
      <button
        className="btn"
        onClick={() => void analyze()}
        disabled={!idle || !hasProject}
        title="Re-read the source and rebuild the graph. Unapplied graph edits are discarded."
      >
        Analyze
      </button>
      <button
        className="btn"
        onClick={() => void saveDocument()}
        disabled={!idle || !graph}
        title="Write the architecture, the layout and the edit log into the project"
      >
        Save Graph{dirty ? ' •' : ''}
      </button>

      <div className="divider-v" />

      <button
        className="btn"
        onClick={() => openDialog('add-module')}
        disabled={!graph}
      >
        Add Module
      </button>
      <button
        className="btn"
        onClick={relayout}
        disabled={!graph}
        title="Re-run the automatic layout. Visual only."
      >
        Auto Layout
      </button>

      <div className="divider-v" />

      <button
        className="btn btn--primary"
        onClick={() => void generate(settings?.hasApiKey === true)}
        disabled={!idle || pending.structural + pending.metadata === 0}
        title={
          pending.structural + pending.metadata === 0
            ? 'Nothing is waiting to be generated'
            : 'Generate and write changes directly to the source project'
        }
      >
        Generate Project
      </button>

      <div className="spacer" />

      {!idle ? (
        <button className="btn btn--danger btn--sm" onClick={() => void cancel()}>
          Cancel {busy}
        </button>
      ) : null}

      {settings?.hasApiKey ? (
        <Badge kind="ai" title={`Model: ${settings.model}, effort: ${settings.effort}`}>
          ai ready
        </Badge>
      ) : (
        <Badge title="Deterministic analysis and refactors work without a key">
          no api key
        </Badge>
      )}

      <button className="btn" onClick={() => openDialog('settings')}>
        Settings
      </button>
    </header>
  )
}
