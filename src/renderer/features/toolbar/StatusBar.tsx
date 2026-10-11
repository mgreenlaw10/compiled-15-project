/**
 * The status bar.
 *
 * Where the application states, in one line, whether the graph currently
 * matches the code. That is the single most important piece of information in
 * the tool, so it is always on screen.
 */

import {
  useArchitectureDiffText,
  usePendingSummary,
  useStore
} from '../../state/store'
import { plural } from '../../ui'

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
