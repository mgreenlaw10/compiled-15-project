/**
 * Top toolbar and the status bar underneath the workspace.
 *
 * The status bar is where the application states, in one line, whether the
 * graph currently matches the code. That is the single most important piece of
 * information in the tool, so it is always on screen.
 */

import {
  useArchitectureDiffText,
  usePendingSummary,
  useStore
} from '../state/store'
import { Badge, plural } from './common'

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
  const plan = useStore((s) => s.plan)
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
        onClick={() => void plan(settings?.hasApiKey === true)}
        disabled={!idle || pending.structural + pending.metadata === 0}
        title={
          pending.structural + pending.metadata === 0
            ? 'Nothing is waiting to be generated'
            : 'Work out the source changes your graph edits imply'
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

export function StatusBar(): JSX.Element {
  const project = useStore((s) => s.project)
  const graph = useStore((s) => s.desired)
  const busy = useStore((s) => s.busy)
  const layout = useStore((s) => s.layout)
  const dirty = useStore((s) => s.dirty)
  const pending = usePendingSummary()
  const diffText = useArchitectureDiffText()

  const verified = graph?.edges.filter((e) => e.verified).length ?? 0
  const declared = (graph?.edges.length ?? 0) - verified

  const dotClass =
    busy !== 'idle'
      ? 'dot dot--busy'
      : pending.structural > 0
        ? 'dot dot--pending'
        : graph
          ? 'dot dot--ok'
          : 'dot'

  return (
    <footer className="statusbar">
      <span className="status-item">
        <span className={dotClass} />
        {busy !== 'idle' ? `${busy}…` : pending.text}
      </span>

      {graph ? (
        <>
          <span className="status-item">
            {plural(graph.modules.length, 'module')}
          </span>
          <span className="status-item" title="Edges backed by real imports">
            {verified} verified
          </span>
          {declared > 0 ? (
            <span
              className="status-item"
              title="Edges you declared that no import backs yet"
            >
              {declared} declared
            </span>
          ) : null}
          {diffText && diffText !== 'No architectural changes' ? (
            <span className="status-item" title="Difference from the analyzed architecture">
              Δ {diffText}
            </span>
          ) : null}
        </>
      ) : null}

      <span className="spacer" />

      {graph ? (
        <span
          className="status-item faint"
          title="Node positions are visual only and never change code"
        >
          layout: {layout.algorithm}
        </span>
      ) : null}
      {dirty ? <span className="status-item faint">unsaved graph</span> : null}
      {project ? (
        <span className="status-item faint mono" title={project.root}>
          {project.root}
        </span>
      ) : (
        <span className="status-item faint">no project open</span>
      )}
    </footer>
  )
}
