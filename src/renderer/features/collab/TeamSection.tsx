/**
 * The team panel in the left sidebar.
 *
 * Who is on this project, what is being worked on, and — prominently — how
 * current the information is. The sync line is not decoration: everything below
 * it is only as true as the last successful fetch, and the panel says so rather
 * than implying presence it cannot verify.
 */

import { useStore } from '../../state/store'
import { Badge, Empty } from '../../ui'
import {
  useActiveTasks,
  useIntegrations,
  useCollabEnabled,
  useDevelopers,
  useMyDeveloperId,
  useSessionViews
} from './use-collab'

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'unknown'
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

export function TeamSection(): JSX.Element {
  const enabled = useCollabEnabled()
  const openDialog = useStore((s) => s.openDialog)
  const sync = useStore((s) => s.collab?.sync ?? null)
  const syncNow = useStore((s) => s.syncCollaboration)
  const busy = useStore((s) => s.collabBusy)
  const selectTask = useStore((s) => s.selectTask)
  const setBottomTab = useStore((s) => s.setBottomTab)
  const select = useStore((s) => s.select)
  const integrations = useIntegrations()

  const developers = useDevelopers()
  const tasks = useActiveTasks()
  const sessions = useSessionViews()
  const myId = useMyDeveloperId()

  if (!enabled) {
    return (
      <div className="sidebar-section">
        <div className="section-title">Team</div>
        <Empty>This project is not set up for collaboration.</Empty>
        <button className="btn btn--small" onClick={() => openDialog('collab-setup')}>
          Set up collaboration…
        </button>
      </div>
    )
  }

  const pendingIntegrations = integrations.filter(
    (request) => request.status === 'queued' || request.status === 'conflicted'
  )
  const running = sessions.filter((view) => view.session.status === 'running')

  return (
    <div className="sidebar-section">
      <div className="section-title">Team</div>

      {/* --- honesty about freshness, first ---------------------------- */}
      <div className={sync?.stale ? 'sync-line is-stale' : 'sync-line'}>
        <span
          className="collab-dot"
          style={{
            background: !sync?.online
              ? 'var(--text-faint)'
              : sync.stale
                ? 'var(--warn)'
                : 'var(--success)'
          }}
        />
        <span>
          {!sync?.online
            ? 'Offline — showing cached state'
            : sync.stale
              ? `Last synced ${relativeTime(sync.lastSyncAt)} — may be out of date`
              : `Synced ${relativeTime(sync.lastSyncAt)}`}
        </span>
        <button
          className="btn btn--small"
          disabled={busy}
          onClick={() => void syncNow()}
          title="Fetch the coordination branch and publish anything queued."
        >
          {busy ? '…' : 'Sync now'}
        </button>
      </div>

      {sync && sync.queued > 0 ? (
        <p className="faint" style={{ fontSize: 11 }}>
          {sync.queued} change(s) made here are not on the remote yet.
        </p>
      ) : null}
      {sync?.error ? (
        <p style={{ fontSize: 11, color: 'var(--warn)' }}>{sync.error}</p>
      ) : null}

      {/* --- developers ------------------------------------------------- */}
      <div className="section-title">Developers</div>
      {developers.length === 0 ? (
        <Empty>Nobody has announced themselves yet.</Empty>
      ) : (
        <div className="list">
          {developers.map((developer) => (
            <div key={developer.id} className="row">
              <span className="row-main">
                <span className="row-title">
                  {developer.displayName}
                  {developer.id === myId ? ' (you)' : ''}
                </span>
                <span className="row-sub">
                  last seen {relativeTime(developer.lastSeenAt)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* --- agents ----------------------------------------------------- */}
      <div className="section-title">
        Agents{running.length > 0 ? ` (${running.length} running)` : ''}
      </div>
      {sessions.length === 0 ? (
        <Empty>No agent sessions.</Empty>
      ) : (
        <div className="list">
          {sessions.map((view) => (
            <button
              key={view.session.id}
              className="row"
              onClick={() => {
                selectTask(view.session.taskId)
                setBottomTab('agents')
              }}
            >
              <span className="row-main">
                <span className="row-title">
                  {view.task?.title ?? view.session.taskId}
                </span>
                <span className="row-sub">
                  {view.hostStale && view.session.status === 'running'
                    ? 'unknown — host silent'
                    : view.session.status}
                  {view.pendingInstructions > 0
                    ? ` · ${view.pendingInstructions} queued instruction(s)`
                    : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* --- tasks ------------------------------------------------------ */}
      <div className="section-title">Tasks</div>
      {tasks.length === 0 ? (
        <Empty>No active tasks.</Empty>
      ) : (
        <div className="list">
          {tasks.map((task) => (
            <button
              key={task.id}
              className="row"
              onClick={() => {
                selectTask(task.id)
                if (task.moduleIds[0]) select(task.moduleIds[0])
              }}
            >
              <span className="row-main">
                <span className="row-title">{task.title}</span>
                <span className="row-sub">
                  {task.status}
                  {task.assignedDeveloper
                    ? ` · ${task.assignedDeveloper === myId ? 'you' : task.assignedDeveloper}`
                    : ''}
                </span>
              </span>
              {task.status === 'conflict' ? <Badge kind="danger">!</Badge> : null}
            </button>
          ))}
        </div>
      )}

      {pendingIntegrations.length > 0 ? (
        <>
          <div className="section-title">Pending integration</div>
          <div className="list">
            {pendingIntegrations.map((request) => (
              <button
                key={request.id}
                className="row"
                onClick={() => {
                  selectTask(request.taskId)
                  openDialog('integration')
                }}
              >
                <span className="row-main">
                  <span className="row-title mono" style={{ fontSize: 11.5 }}>
                    {request.sourceBranch}
                  </span>
                  <span className="row-sub">
                    {request.status}
                    {request.conflicts.length > 0
                      ? ` · ${request.conflicts.length} conflict(s)`
                      : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <button className="btn btn--small" onClick={() => openDialog('create-task')}>
        New task…
      </button>
    </div>
  )
}
