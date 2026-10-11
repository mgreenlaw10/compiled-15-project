/**
 * The Collaboration section of the module inspector.
 *
 * Answers "what is happening to this module, and what can I do about it" in one
 * place. Which actions appear depends on who holds the module: claiming a free
 * module is one click, while taking one somebody's agent is actively editing
 * requires an explicit, labelled confirmation — the brief asks for ownership
 * rules, and a disruptive action that looks like an ordinary button is not one.
 */

import { useState } from 'react'

import { MODULE_STATUS_LABELS, isBusyStatus } from '../../../shared/collab'
import { useStore } from '../../state/store'
import { Badge, Banner, Empty, formatTime, plural } from '../../ui'
import {
  useCollabEnabled,
  useDependencyWarnings,
  useModuleState,
  useMyDeveloperId
} from './use-collab'

export function CollaborationPanel(): JSX.Element | null {
  const enabled = useCollabEnabled()
  const moduleId = useStore((s) => s.selectedModuleId)
  const openDialog = useStore((s) => s.openDialog)
  const selectTask = useStore((s) => s.selectTask)
  const setBottomTab = useStore((s) => s.setBottomTab)
  const releaseModule = useStore((s) => s.releaseModule)
  const startAgent = useStore((s) => s.startAgent)
  const sendInstruction = useStore((s) => s.sendInstruction)
  const stale = useStore((s) => s.collab?.sync.stale ?? false)

  const state = useModuleState(moduleId)
  const warnings = useDependencyWarnings()
  const myId = useMyDeveloperId()
  const [instruction, setInstruction] = useState('')
  const [confirmTakeover, setConfirmTakeover] = useState(false)

  if (!enabled) {
    return (
      <div className="collab-panel">
        <div className="section-title">Collaboration</div>
        <p className="faint" style={{ fontSize: 11.5 }}>
          Not enabled for this project.
        </p>
        <button className="btn btn--small" onClick={() => openDialog('collab-setup')}>
          Set up collaboration…
        </button>
      </div>
    )
  }

  if (!moduleId || !state) return null

  const label = MODULE_STATUS_LABELS[state.status]
  const mine = state.developer !== null && state.developer === myId
  const warning = warnings.get(moduleId)
  const busy = isBusyStatus(state.status)

  return (
    <div className="collab-panel">
      <div className="section-title">Collaboration</div>

      {stale ? (
        <Banner kind="warn">
          This is as of the last successful sync and may be out of date.
        </Banner>
      ) : null}

      <div className="collab-status">
        <span className="collab-dot" style={{ background: label.color }} />
        <strong>{label.label}</strong>
        <span className="faint" style={{ fontSize: 11 }}>
          {label.meaning}
        </span>
      </div>

      {state.task ? (
        <dl className="kv">
          <dt>Task</dt>
          <dd>{state.task.title}</dd>
          <dt>Developer</dt>
          <dd>{state.developer ?? 'unassigned'}{mine ? ' (you)' : ''}</dd>
          <dt>Agent</dt>
          <dd>{state.agent ?? 'none'}</dd>
          <dt>Branch</dt>
          <dd className="mono">{state.task.branch ?? '(not started)'}</dd>
          {state.reservation ? (
            <>
              <dt>Lease</dt>
              <dd>
                {state.reservationExpired
                  ? 'expired'
                  : `until ${formatTime(state.reservation.expiresAt)}`}
              </dd>
            </>
          ) : null}
        </dl>
      ) : (
        <Empty>No task is assigned to this module.</Empty>
      )}

      {state.hostStale && busy ? (
        <Banner kind="warn">
          This task says it is running, but the machine driving it has not
          checked in recently. The agent may have stopped — its worktree is on
          that machine, so nobody else can resume it from here.
        </Banner>
      ) : null}

      {warning ? <Banner kind="info">{warning}</Banner> : null}

      {/* --- session activity ------------------------------------------- */}
      {state.session ? (
        <>
          <div className="section-title">Agent session</div>
          <div className="collab-activity">
            {state.session.activity.length === 0 ? (
              <Empty>Nothing reported yet.</Empty>
            ) : (
              state.session.activity
                .slice(-6)
                .reverse()
                .map((entry) => (
                  <div key={entry.id} className="collab-activity-row">
                    <span className="faint mono">{formatTime(entry.at)}</span>
                    <Badge kind={entry.kind === 'error' ? 'danger' : 'info'}>
                      {entry.kind.replace('_', ' ')}
                    </Badge>
                    <span>{entry.message}</span>
                  </div>
                ))
            )}
          </div>
          <button
            className="btn btn--small"
            onClick={() => {
              selectTask(state.task?.id ?? null)
              setBottomTab('agents')
            }}
          >
            Open full session
          </button>

          {/* Anyone may add an instruction — the session belongs to the
              project, not to whoever started it. */}
          <label className="field">
            <span className="label">Send an instruction</span>
            <textarea
              rows={2}
              value={instruction}
              placeholder="Also handle token refresh"
              onChange={(event) => setInstruction(event.target.value)}
            />
            <span className="hint">
              Queued on the shared session. The machine running the agent picks
              it up at its next safe checkpoint — between turns, never mid-edit.
            </span>
          </label>
          <button
            className="btn btn--small"
            disabled={instruction.trim() === ''}
            onClick={() => {
              void sendInstruction(state.session!.id, instruction)
              setInstruction('')
            }}
          >
            Queue instruction
          </button>
        </>
      ) : null}

      {/* --- actions ---------------------------------------------------- */}
      <div className="section-title">Actions</div>
      <div className="collab-actions">
        {state.claimable || mine ? (
          <>
            <button
              className="btn btn--small btn--primary"
              onClick={() => openDialog('create-task')}
            >
              New task for this module
            </button>
            {state.task && state.task.status !== 'completed' ? (
              <button
                className="btn btn--small"
                onClick={() => void startAgent(state.task!.id)}
                disabled={busy}
              >
                {busy ? 'Agent running' : 'Start agent'}
              </button>
            ) : null}
            {state.reservation && !state.reservationExpired && mine ? (
              <button
                className="btn btn--small"
                onClick={() => void releaseModule(moduleId)}
              >
                Release module
              </button>
            ) : null}
          </>
        ) : (
          <>
            <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
              {state.developer ?? 'Someone else'} holds this module
              {state.task ? ` for "${state.task.title}"` : ''}.
            </p>
            {busy ? (
              <>
                {/* Deliberately two steps: interrupting a running agent is
                    disruptive and should never be one stray click. */}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={confirmTakeover}
                    onChange={(event) => setConfirmTakeover(event.target.checked)}
                  />
                  <span className="checkbox-text">
                    I want to take this module anyway
                    <small>
                      Their agent keeps running on their machine. Both sets of
                      changes will have to be reconciled at integration time.
                    </small>
                  </span>
                </label>
                <button
                  className="btn btn--small btn--danger"
                  disabled={!confirmTakeover}
                  onClick={() => openDialog('create-task')}
                >
                  Create a competing task
                </button>
              </>
            ) : (
              <button
                className="btn btn--small"
                onClick={() => openDialog('create-task')}
              >
                Claim it for a new task
              </button>
            )}
          </>
        )}

        {state.task && (state.task.status === 'review' || state.task.status === 'conflict') ? (
          <button
            className="btn btn--small btn--primary"
            onClick={() => {
              selectTask(state.task!.id)
              openDialog('integration')
            }}
          >
            Review and integrate…
          </button>
        ) : null}
      </div>

      {state.task ? (
        <p className="faint" style={{ fontSize: 11 }}>
          {plural(state.task.moduleIds.length, 'module')} in this task.
        </p>
      ) : null}
    </div>
  )
}
