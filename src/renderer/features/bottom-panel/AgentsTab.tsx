/**
 * The agent session panel.
 *
 * A session belongs to the project, so this shows every agent on the project —
 * not only the ones this machine started. Two developers opening the same
 * session see the same timeline once they have both synchronized, which is the
 * shared-session guarantee.
 *
 * It is explicit about the one thing Git-only synchronization cannot do: if the
 * machine running an agent is unreachable, nobody else can resume it. The
 * worktree is on that machine. Pending instructions are kept for when it comes
 * back.
 */

import { useState } from 'react'

import { useStore } from '../../state/store'
import { Badge, Banner, Empty, formatTime } from '../../ui'
import { useLocalWorktrees, useMyDeveloperId, useSessionViews } from '../collab'

export function AgentsTab(): JSX.Element {
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const selectTask = useStore((s) => s.selectTask)
  const sendInstruction = useStore((s) => s.sendInstruction)
  const cancelAgent = useStore((s) => s.cancelAgent)
  const startAgent = useStore((s) => s.startAgent)
  const openDialog = useStore((s) => s.openDialog)
  const locallyRunning = useLocalWorktrees()

  const sessions = useSessionViews()
  const myId = useMyDeveloperId()
  const [instruction, setInstruction] = useState('')

  if (sessions.length === 0) {
    return (
      <div className="panel-body">
        <Empty>
          No agent sessions yet. Create a task from a module and start an agent.
        </Empty>
      </div>
    )
  }

  const current =
    sessions.find((view) => view.session.taskId === selectedTaskId) ?? sessions[0]
  const session = current.session
  const isMyHost = session.host?.developerId === myId
  const hasWorktreeHere = locallyRunning.some(
    (worktree) => worktree.taskId === session.taskId
  )

  return (
    <div className="agents-tab">
      {/* --- session list ----------------------------------------------- */}
      <div className="list agents-list">
        {sessions.map((view) => (
          <button
            key={view.session.id}
            className={
              view.session.id === session.id ? 'row is-selected' : 'row'
            }
            onClick={() => selectTask(view.session.taskId)}
          >
            <span className="row-main">
              <span className="row-title">
                {view.task?.title ?? view.session.taskId}
              </span>
              <span className="row-sub">
                {view.hostStale && view.session.status === 'running'
                  ? 'host silent'
                  : view.session.status}
                {view.session.host
                  ? ` · ${view.session.host.developerId === myId ? 'this machine' : view.session.host.developerId}`
                  : ''}
              </span>
            </span>
            {view.pendingInstructions > 0 ? (
              <Badge kind="pending">{view.pendingInstructions}</Badge>
            ) : null}
          </button>
        ))}
      </div>

      {/* --- the selected session --------------------------------------- */}
      <div className="agents-detail">
        <div className="file-change-head">
          <Badge
            kind={
              session.status === 'running'
                ? 'ai'
                : session.status === 'failed'
                  ? 'danger'
                  : session.status === 'awaiting_review'
                    ? 'ok'
                    : 'info'
            }
          >
            {session.status.replace('_', ' ')}
          </Badge>
          <span className="path">{current.task?.title ?? session.taskId}</span>
          {session.branch ? (
            <span className="faint mono" style={{ fontSize: 11 }}>
              {session.branch}
            </span>
          ) : null}
        </div>

        {current.task?.description ? (
          <p className="faint" style={{ fontSize: 11.5, marginTop: 0 }}>
            {current.task.description}
          </p>
        ) : null}

        {current.hostStale && session.status === 'running' ? (
          <Banner kind="warn">
            This session says it is running, but{' '}
            {session.host
              ? `${session.host.developerId}'s machine`
              : 'its execution host'}{' '}
            has not checked in recently.
            {isMyHost
              ? ' It may have been interrupted here.'
              : ' Its worktree is on that machine, so it cannot be resumed from here — a limitation of coordinating through Git alone. Any instructions you queue will be processed if it comes back.'}
          </Banner>
        ) : null}

        {session.status === 'offline' && !isMyHost ? (
          <Banner kind="info">
            The machine running this agent went away. The work it committed is on{' '}
            <span className="mono">{session.branch}</span> and can still be
            integrated; the agent itself cannot be resumed from here.
          </Banner>
        ) : null}

        {/* --- timeline ------------------------------------------------- */}
        <div className="section-title">Activity</div>
        <div className="agents-timeline">
          {session.activity.length === 0 ? (
            <Empty>Nothing reported yet.</Empty>
          ) : (
            [...session.activity].reverse().map((entry) => (
              <div key={entry.id} className="agents-timeline-row">
                <span className="faint mono">{formatTime(entry.at)}</span>
                <Badge kind={entry.kind === 'error' ? 'danger' : 'info'}>
                  {entry.kind.replace('_', ' ')}
                </Badge>
                <div>
                  <div>{entry.message}</div>
                  {entry.detail ? (
                    <div className="faint" style={{ fontSize: 11 }}>
                      {entry.detail}
                    </div>
                  ) : null}
                  {entry.paths && entry.paths.length > 0 ? (
                    <div className="faint mono" style={{ fontSize: 11 }}>
                      {entry.paths.slice(0, 6).join(', ')}
                      {entry.paths.length > 6
                        ? ` and ${entry.paths.length - 6} more`
                        : ''}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        {/* --- instructions -------------------------------------------- */}
        {session.instructions.length > 0 ? (
          <>
            <div className="section-title">Instructions from the team</div>
            <div className="list">
              {session.instructions.map((entry) => (
                <div key={entry.id} className="row">
                  <span className="row-main">
                    <span className="row-title">{entry.text}</span>
                    <span className="row-sub">
                      {entry.fromDeveloper === myId ? 'you' : entry.fromDeveloper} ·{' '}
                      {formatTime(entry.at)}
                      {entry.note ? ` · ${entry.note}` : ''}
                    </span>
                  </span>
                  <Badge
                    kind={
                      entry.status === 'applied'
                        ? 'ok'
                        : entry.status === 'rejected'
                          ? 'danger'
                          : 'pending'
                    }
                  >
                    {entry.status}
                  </Badge>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <label className="field">
          <span className="label">Add an instruction</span>
          <textarea
            rows={2}
            value={instruction}
            placeholder="Keep the existing validateToken signature"
            onChange={(event) => setInstruction(event.target.value)}
          />
          <span className="hint">
            Queued on the shared session, so the whole team sees it. The agent's
            host applies it between turns — never mid-edit.
          </span>
        </label>

        <div className="collab-actions">
          <button
            className="btn btn--small"
            disabled={instruction.trim() === ''}
            onClick={() => {
              void sendInstruction(session.id, instruction)
              setInstruction('')
            }}
          >
            Queue instruction
          </button>

          {session.status === 'running' && hasWorktreeHere ? (
            <button
              className="btn btn--small btn--danger"
              onClick={() => void cancelAgent(session.taskId)}
            >
              Cancel this agent
            </button>
          ) : null}

          {session.status !== 'running' && current.task ? (
            <button
              className="btn btn--small"
              onClick={() => void startAgent(session.taskId)}
            >
              {session.status === 'failed' ? 'Retry agent' : 'Start agent'}
            </button>
          ) : null}

          {session.commits.length > 0 ? (
            <button
              className="btn btn--small btn--primary"
              onClick={() => {
                selectTask(session.taskId)
                openDialog('integration')
              }}
            >
              Review and integrate…
            </button>
          ) : null}
        </div>

        {session.commits.length > 0 ? (
          <p className="faint mono" style={{ fontSize: 11 }}>
            commits: {session.commits.map((c) => c.slice(0, 8)).join(', ')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
