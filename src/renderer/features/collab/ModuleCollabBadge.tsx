/**
 * The collaboration overlay on a graph node.
 *
 * Deliberately compact: a status dot, who holds it, and what their agent is
 * doing. The node already carries architectural information, and burying that
 * under a task-management card would defeat the point of the graph being the
 * shared interface.
 *
 * Nothing is drawn when collaboration is off, so single-player nodes look
 * exactly as they did.
 */

import { MODULE_STATUS_LABELS, type ModuleCollabState } from '../../../shared/collab'

export interface ModuleCollabBadgeProps {
  state: ModuleCollabState
  /** `true` when a neighbour's in-flight work could affect this module. */
  warning?: string | undefined
  /** This install's developer id, to mark the user's own work. */
  myDeveloperId?: string | null
}

export function ModuleCollabBadge({
  state,
  warning,
  myDeveloperId
}: ModuleCollabBadgeProps): JSX.Element | null {
  // An available module with nothing to say adds no row: the overlay should
  // appear where there is work, not on every node.
  if (state.status === 'available' && !warning) return null

  const label = MODULE_STATUS_LABELS[state.status]
  const mine = state.developer !== null && state.developer === myDeveloperId

  return (
    <div className="node-collab" title={label.meaning}>
      <div className="node-collab-row">
        <span className="collab-dot" style={{ background: label.color }} />
        <span className="node-collab-status" style={{ color: label.color }}>
          {label.label}
        </span>
        {state.hostStale ? (
          <span className="node-collab-warn" title="The machine running this has not checked in recently.">
            ?
          </span>
        ) : null}
        {warning ? (
          <span className="node-collab-warn" title={warning}>
            !
          </span>
        ) : null}
      </div>

      {state.developer || state.agent ? (
        <div className="node-collab-row node-collab-who">
          {state.agent ? <span className="node-collab-agent">{state.agent}</span> : null}
          {state.developer ? (
            <span>{mine ? 'you' : state.developer}</span>
          ) : null}
        </div>
      ) : null}

      {state.task ? (
        <div className="node-collab-task" title={state.task.description}>
          {state.task.title}
        </div>
      ) : null}
    </div>
  )
}
