/**
 * The Git tab.
 *
 * The point of this tab is that a user should *not* have to drop to a terminal
 * to understand what their team is doing — but when they want to, the branch
 * names and commits are right here. It reports what Git told the backend, with
 * no interpretation.
 */

import { useStore } from '../../state/store'
import { Badge, Empty, formatTime } from '../../ui'
import { useCollabEnabled, useTasks } from '../collab'

export function GitTab(): JSX.Element {
  const enabled = useCollabEnabled()
  const snapshot = useStore((s) => s.collab)
  const workspace = useStore((s) => s.collabWorkspace)
  const syncNow = useStore((s) => s.syncCollaboration)
  const busy = useStore((s) => s.collabBusy)
  const tasks = useTasks()

  if (!enabled || !snapshot) {
    return (
      <div className="panel-body">
        <Empty>Collaboration is not enabled, so there is no shared Git state.</Empty>
      </div>
    )
  }

  const sync = snapshot.sync

  return (
    <div className="panel-body">
      <div className="section-title">Synchronization</div>
      <dl className="kv">
        <dt>Remote</dt>
        <dd className="mono">{workspace?.remoteUrl ?? 'none'}</dd>
        <dt>Integrated branch</dt>
        <dd className="mono">{snapshot.state.project.integratedBranch}</dd>
        <dt>Coordination branch</dt>
        <dd className="mono">
          collab-state
          {sync.stateCommit ? ` @ ${sync.stateCommit.slice(0, 8)}` : ''}
        </dd>
        <dt>Last sync</dt>
        <dd>
          {sync.lastSyncAt ? formatTime(sync.lastSyncAt) : 'never'}
          {sync.stale ? ' (stale)' : ''}
        </dd>
        <dt>Connection</dt>
        <dd>{sync.online ? 'online' : 'offline — serving cached state'}</dd>
        <dt>Queued locally</dt>
        <dd>{sync.queued}</dd>
        <dt>Push retries</dt>
        <dd>{sync.retries}</dd>
      </dl>

      {sync.error ? (
        <p style={{ color: 'var(--warn)', fontSize: 11.5 }}>{sync.error}</p>
      ) : null}

      {sync.contested.length > 0 ? (
        <>
          <div className="section-title">Reconciled concurrent edits</div>
          <ul className="plain">
            {sync.contested.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                {item.kind} <span className="mono">{item.id}</span> was also changed
                elsewhere; your edit was applied on top.
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {sync.expiredReservations.length > 0 ? (
        <>
          <div className="section-title">Expired reservations</div>
          <ul className="plain">
            {sync.expiredReservations.map((moduleId) => (
              <li key={moduleId}>{moduleId} — lease ran out and was released</li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="section-title">Task branches</div>
      {tasks.length === 0 ? (
        <Empty>No task branches yet.</Empty>
      ) : (
        <div className="list">
          {tasks.map((task) => {
            const worktree = snapshot.worktrees.find((w) => w.taskId === task.id)
            return (
              <div key={task.id} className="row">
                <span className="row-main">
                  <span className="row-title mono" style={{ fontSize: 11.5 }}>
                    {task.branch ?? '(not started)'}
                  </span>
                  <span className="row-sub">
                    {task.title} · {task.status}
                    {task.baseCommit ? ` · from ${task.baseCommit.slice(0, 8)}` : ''}
                    {worktree ? ' · worktree on this machine' : ''}
                  </span>
                </span>
                {task.status === 'conflict' ? (
                  <Badge kind="danger">conflict</Badge>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {workspace && workspace.dirtyFileCount > 0 ? (
        <p className="faint" style={{ fontSize: 11.5 }}>
          Your own checkout has {workspace.dirtyFileCount} uncommitted file(s).
          Collaboration never touches these — coordination is written without
          checking anything out.
        </p>
      ) : null}

      <button className="btn btn--small" disabled={busy} onClick={() => void syncNow()}>
        {busy ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  )
}
