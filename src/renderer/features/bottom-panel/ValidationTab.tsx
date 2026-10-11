/**
 * The Validation tab.
 *
 * Shows integration results across every task: whether each merged, what the
 * project's own checks said, and which incompatibilities were found. It keeps
 * `not_run` and `skipped` visually distinct from `failed`, because conflating
 * "we did not check" with "it is broken" is how a report stops being trusted.
 */

import { useStore } from '../../state/store'
import { Badge, Banner, Empty } from '../../ui'
import { useCollabEnabled, useTasks } from '../collab'

export function ValidationTab(): JSX.Element {
  const enabled = useCollabEnabled()
  const snapshot = useStore((s) => s.collab)
  const selectTask = useStore((s) => s.selectTask)
  const openDialog = useStore((s) => s.openDialog)
  const graph = useStore((s) => s.desired)
  const tasks = useTasks()

  if (!enabled || !snapshot) {
    return (
      <div className="panel-body">
        <Empty>Collaboration is not enabled.</Empty>
      </div>
    )
  }

  const integrations = snapshot.state.integrations
  const allowCommands = snapshot.state.project.settings.allowValidationCommands
  const nameOf = (id: string): string =>
    graph?.modules.find((m) => m.id === id)?.name ?? id

  return (
    <div className="panel-body">
      {!allowCommands ? (
        <Banner kind="info">
          Running the project&apos;s own build and test commands on
          agent-generated changes is switched off, so validation reports{' '}
          <strong>not run</strong> rather than a pass. Integration still checks
          Git merge-ability and architectural compatibility.
        </Banner>
      ) : null}

      {integrations.length === 0 ? (
        <Empty>No task has been submitted for integration yet.</Empty>
      ) : (
        integrations.map((request) => {
          const task = tasks.find((t) => t.id === request.taskId)
          const blocking = request.conflicts.filter((c) => c.severity === 'blocking')
          return (
            <div key={request.id} className="outcome">
              <div className="file-change-head">
                <Badge
                  kind={
                    request.status === 'merged'
                      ? 'ok'
                      : request.status === 'conflicted' || request.status === 'failed'
                        ? 'danger'
                        : 'info'
                  }
                >
                  {request.status}
                </Badge>
                <span className="path">{task?.title ?? request.taskId}</span>
                <span className="faint mono" style={{ fontSize: 11 }}>
                  {request.sourceBranch} → {request.targetBranch}
                </span>
              </div>
              <div className="outcome-body">
                {request.note ? (
                  <div className="outcome-msg">{request.note}</div>
                ) : null}

                {request.validations.length > 0 ? (
                  <div className="chips">
                    {request.validations.map((validation) => (
                      <span
                        key={validation.name}
                        className="badge"
                        title={validation.message}
                      >
                        {validation.name}: {validation.status.replace('_', ' ')}
                      </span>
                    ))}
                  </div>
                ) : null}

                {blocking.length > 0 ? (
                  <div className="outcome-warn">
                    {blocking.length} blocking conflict(s):{' '}
                    {blocking.map((c) => c.summary).join('; ')}
                  </div>
                ) : null}

                {request.conflicts
                  .filter((c) => c.severity === 'warning')
                  .slice(0, 4)
                  .map((conflict, index) => (
                    <div
                      key={index}
                      className="outcome-msg"
                      style={{ fontSize: 11.5 }}
                    >
                      <strong>{conflict.kind.replace('_', ' ')}:</strong>{' '}
                      {conflict.explanation}
                      {conflict.affectedModuleIds.length > 0
                        ? ` (${conflict.affectedModuleIds.map(nameOf).join(', ')})`
                        : ''}
                    </div>
                  ))}

                {request.outOfScopePaths.length > 0 ? (
                  <div className="outcome-warn">
                    {request.outOfScopePaths.length} file(s) changed outside the
                    task&apos;s modules
                  </div>
                ) : null}

                <button
                  className="btn btn--small"
                  onClick={() => {
                    selectTask(request.taskId)
                    openDialog('integration')
                  }}
                >
                  Open
                </button>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
