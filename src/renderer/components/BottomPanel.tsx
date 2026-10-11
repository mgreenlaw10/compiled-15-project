/**
 * Bottom panel: analysis progress, AI activity, pending changes, and results.
 *
 * The "Changes" tab is where the honesty guarantees become visible: every
 * operation shows its own outcome — applied, metadata only, partial,
 * unsupported or failed — next to the files it actually touched. An operation
 * that produced no file changes says so.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { OperationOutcome } from '../../shared/types/generation'
import type { LogChannel } from '../../shared/types/ipc'
import { OPERATION_LABELS } from '../../shared/types/operations'
import { usePendingOperations, useStore } from '../state/store'
import { Badge, DiffBlock, Empty, plural, formatTime } from './common'

const CHANNEL_LABELS: Record<LogChannel, string> = {
  analysis: 'analysis',
  ai: 'ai',
  generation: 'generate',
  validation: 'validate',
  app: 'app'
}

function outcomeBadge(status: OperationOutcome['status']): JSX.Element {
  switch (status) {
    case 'applied':
      return <Badge kind="ok">applied</Badge>
    case 'metadata_only':
      return <Badge kind="info">graph only</Badge>
    case 'partial':
      return <Badge kind="pending">partial</Badge>
    case 'unsupported':
      return <Badge kind="pending">not supported</Badge>
    case 'failed':
      return <Badge kind="danger">failed</Badge>
    case 'skipped':
    default:
      return <Badge>skipped</Badge>
  }
}

function ActivityTab(): JSX.Element {
  const logs = useStore((s) => s.logs)
  const clearLogs = useStore((s) => s.clearLogs)
  const [showDebug, setShowDebug] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  const visible = useMemo(
    () => (showDebug ? logs : logs.filter((l) => l.level !== 'debug')),
    [logs, showDebug]
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [visible.length])

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px 6px'
        }}
      >
        <label className="checkbox" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={showDebug}
            onChange={(event) => setShowDebug(event.target.checked)}
          />
          <span className="checkbox-text">Show detail</span>
        </label>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn btn--ghost btn--sm" onClick={clearLogs}>
          Clear
        </button>
      </div>
      {visible.length === 0 ? (
        <Empty>Nothing has run yet.</Empty>
      ) : (
        <div>
          {visible.map((log) => (
            <div key={log.id} className={`log-line level-${log.level}`}>
              <span className="log-time">{formatTime(log.at)}</span>
              <span className="log-chan">{CHANNEL_LABELS[log.channel]}</span>
              <span className="log-msg">
                {log.message}
                {log.detail ? (
                  <span className="log-detail">{`  ${log.detail}`}</span>
                ) : null}
              </span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </>
  )
}

function ChangesTab(): JSX.Element {
  const changeSet = useStore((s) => s.changeSet)
  const diffs = useStore((s) => s.diffs)
  const pending = usePendingOperations()
  const openDialog = useStore((s) => s.openDialog)
  const plan = useStore((s) => s.plan)
  const busy = useStore((s) => s.busy)
  const settings = useStore((s) => s.settings)
  const [expanded, setExpanded] = useState<string | null>(null)

  if (!changeSet) {
    return (
      <div style={{ padding: '8px 12px' }}>
        {pending.length === 0 ? (
          <p className="faint" style={{ margin: 0 }}>
            No architectural edits are waiting. Change the graph — add a module,
            move a file, rename a directory — and the plan will appear here.
          </p>
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              {plural(pending.length, 'edit')} waiting to be turned into code:
            </p>
            <ul className="plain">
              {pending.map((op) => (
                <li key={op.id}>
                  <span className="dim">{OPERATION_LABELS[op.type]}</span>
                </li>
              ))}
            </ul>
            <button
              className="btn btn--primary"
              disabled={busy !== 'idle'}
              onClick={() => void plan(settings?.hasApiKey === true)}
            >
              Plan the changes
            </button>
          </>
        )}
      </div>
    )
  }

  const counts = { create: 0, modify: 0, rename: 0, delete: 0 }
  for (const change of changeSet.changes) counts[change.kind] += 1

  return (
    <div style={{ padding: '4px 12px 12px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 10
        }}
      >
        <strong>
          {changeSet.changes.length === 0
            ? 'No file changes'
            : `${plural(changeSet.changes.length, 'file change')}`}
        </strong>
        {counts.create ? <Badge kind="ok">{counts.create} new</Badge> : null}
        {counts.modify ? <Badge kind="info">{counts.modify} edited</Badge> : null}
        {counts.rename ? <Badge kind="info">{counts.rename} moved</Badge> : null}
        {counts.delete ? <Badge kind="danger">{counts.delete} deleted</Badge> : null}
        <span style={{ flex: 1 }} />
        <button
          className="btn btn--sm"
          onClick={() => openDialog('diff')}
          disabled={changeSet.changes.length === 0}
        >
          Open diff viewer
        </button>
        <button
          className="btn btn--primary btn--sm"
          onClick={() => openDialog('generate')}
          disabled={changeSet.changes.length === 0}
        >
          Write the changes…
        </button>
      </div>

      {changeSet.breakingChanges.length > 0 ? (
        <div className="banner banner--warn">
          <div>
            <strong>Potentially breaking:</strong>
            <ul className="plain" style={{ marginTop: 4 }}>
              {changeSet.breakingChanges.slice(0, 12).map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {changeSet.aiSkipped ? (
        <div className="banner banner--info">
          At least one operation needed a model and was not attempted. Add an
          Anthropic API key in Settings to run it.
        </div>
      ) : null}

      <div style={{ marginBottom: 14 }}>
        {changeSet.outcomes.map((outcome) => (
          <div key={outcome.operationId} className="outcome">
            <div style={{ flex: 'none', paddingTop: 2 }}>
              {outcomeBadge(outcome.status)}
            </div>
            <div className="outcome-body">
              <div className="outcome-msg">
                <strong>{OPERATION_LABELS[outcome.operationType]}</strong>{' '}
                <span className="dim">{outcome.message}</span>
              </div>
              {outcome.executor === 'ai' ? (
                <div style={{ marginTop: 3 }}>
                  <Badge kind="ai">model</Badge>
                </div>
              ) : null}
              {outcome.touchedPaths.length > 0 ? (
                <div className="row-sub mono" style={{ whiteSpace: 'normal' }}>
                  {outcome.touchedPaths.join(', ')}
                </div>
              ) : (
                <div className="row-sub">no files changed</div>
              )}
              {outcome.warnings.map((warning, index) => (
                <div key={index} className="outcome-warn">
                  ⚠ {warning}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {changeSet.changes.map((change) => {
        const diff = diffs?.find((d) => d.path === change.path)
        const isOpen = expanded === change.path
        return (
          <div key={`${change.kind}:${change.path}`} className="file-change">
            <div className="file-change-head">
              <Badge
                kind={
                  change.kind === 'create'
                    ? 'ok'
                    : change.kind === 'delete'
                      ? 'danger'
                      : 'info'
                }
              >
                {change.kind}
              </Badge>
              <span className="path">
                {change.kind === 'rename' && change.previousPath
                  ? `${change.previousPath} → ${change.path}`
                  : change.path}
              </span>
              {diff ? (
                <span className="faint" style={{ fontSize: 11 }}>
                  +{diff.additions} −{diff.deletions}
                </span>
              ) : null}
              <span style={{ flex: 1 }} />
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setExpanded(isOpen ? null : change.path)}
              >
                {isOpen ? 'Hide diff' : 'Show diff'}
              </button>
            </div>
            <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>
              {change.reason}
            </div>
            {isOpen && diff ? <DiffBlock patch={diff.patch} /> : null}
          </div>
        )
      })}
    </div>
  )
}

function ResultsTab(): JSX.Element {
  const result = useStore((s) => s.applyResult)
  const validation = useStore((s) => s.validation)
  const validateCurrent = useStore((s) => s.validateCurrent)
  const busy = useStore((s) => s.busy)

  if (!result && !validation) {
    return (
      <div style={{ padding: '8px 12px' }}>
        <p className="faint" style={{ marginTop: 0 }}>
          Nothing has been generated yet. Results, and the output of the
          project's own checks, appear here.
        </p>
        <button
          className="btn btn--sm"
          disabled={busy !== 'idle'}
          onClick={() => void validateCurrent()}
        >
          Check the project as it is now
        </button>
      </div>
    )
  }

  return (
    <div style={{ padding: '4px 12px 12px' }}>
      {result ? (
        <>
          <div
            className={
              result.errors.length > 0 ? 'banner banner--error' : 'banner banner--ok'
            }
          >
            <div>
              <strong>
                {result.errors.length > 0
                  ? 'Writing finished with errors'
                  : result.mode === 'in-place'
                    ? 'Applied to the project'
                    : 'Generated into a new directory'}
              </strong>
              <div className="mono" style={{ marginTop: 3, fontSize: 11.5 }}>
                {result.outputDirectory}
              </div>
            </div>
            <button
              className="btn btn--sm"
              onClick={() => void window.cartograph.revealInFolder(result.outputDirectory)}
            >
              Reveal
            </button>
          </div>

          <dl className="kv" style={{ marginBottom: 10 }}>
            <dt>Created</dt>
            <dd>{result.created.length}</dd>
            <dt>Modified</dt>
            <dd>{result.modified.length}</dd>
            <dt>Moved</dt>
            <dd>{result.renamed.length}</dd>
            <dt>Deleted</dt>
            <dd>{result.deleted.length}</dd>
            <dt>Operations</dt>
            <dd>{plural(result.appliedOperationIds.length, 'operation')} written</dd>
            {result.backup ? (
              <>
                <dt>Backup</dt>
                <dd>
                  <span className="mono">{result.backup.directory}</span>
                  <div className="faint">
                    {plural(result.backup.fileCount, 'file')} copied
                    {result.backup.gitHead
                      ? ` · git HEAD ${result.backup.gitHead.slice(0, 8)}`
                      : ''}
                    {result.backup.gitDirty
                      ? ' · the working tree had uncommitted changes'
                      : ''}
                  </div>
                </dd>
              </>
            ) : null}
          </dl>

          {result.errors.length > 0 ? (
            <ul className="plain" style={{ color: 'var(--danger)' }}>
              {result.errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {validation ? (
        <>
          <div
            className={
              validation.passed
                ? 'banner banner--ok'
                : validation.checks.every((c) => c.status === 'skipped')
                  ? 'banner banner--warn'
                  : 'banner banner--error'
            }
          >
            <div>
              <strong>Validation</strong>
              <div style={{ marginTop: 2 }}>{validation.summary}</div>
            </div>
          </div>
          {validation.checks.map((check) => (
            <div key={check.name} style={{ marginBottom: 12 }}>
              <div className="file-change-head">
                <Badge
                  kind={
                    check.status === 'passed'
                      ? 'ok'
                      : check.status === 'skipped'
                        ? 'default'
                        : 'danger'
                  }
                >
                  {check.status}
                </Badge>
                <strong>{check.name}</strong>
                <span className="faint mono" style={{ fontSize: 11 }}>
                  {check.command}
                </span>
                <span style={{ flex: 1 }} />
                {check.durationMs > 0 ? (
                  <span className="faint" style={{ fontSize: 11 }}>
                    {(check.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </div>
              {check.note ? (
                <div className="faint" style={{ fontSize: 11.5, marginBottom: 4 }}>
                  {check.note}
                </div>
              ) : null}
              {check.output ? (
                <pre className="diff" style={{ maxHeight: 220 }}>
                  {check.output}
                </pre>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </div>
  )
}

export function BottomPanel(): JSX.Element {
  const tab = useStore((s) => s.bottomTab)
  const setTab = useStore((s) => s.setBottomTab)
  const pending = usePendingOperations()
  const changeSet = useStore((s) => s.changeSet)
  const logs = useStore((s) => s.logs)
  const [collapsed, setCollapsed] = useState(false)

  const problems = logs.filter((l) => l.level === 'error').length

  return (
    <div className={collapsed ? 'bottom is-collapsed' : 'bottom'}>
      <div className="tabs">
        <button
          className={tab === 'activity' ? 'tab is-active' : 'tab'}
          onClick={() => {
            setTab('activity')
            setCollapsed(false)
          }}
        >
          Activity
          {problems > 0 ? (
            <span style={{ marginLeft: 6 }}>
              <Badge kind="danger">{problems}</Badge>
            </span>
          ) : null}
        </button>
        <button
          className={tab === 'changes' ? 'tab is-active' : 'tab'}
          onClick={() => {
            setTab('changes')
            setCollapsed(false)
          }}
        >
          Changes
          {changeSet ? (
            <span style={{ marginLeft: 6 }}>
              <Badge kind="info">{changeSet.changes.length}</Badge>
            </span>
          ) : pending.length > 0 ? (
            <span style={{ marginLeft: 6 }}>
              <Badge kind="pending">{pending.length}</Badge>
            </span>
          ) : null}
        </button>
        <button
          className={tab === 'results' ? 'tab is-active' : 'tab'}
          onClick={() => {
            setTab('results')
            setCollapsed(false)
          }}
        >
          Results
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="bottom-body">
          {tab === 'activity' ? <ActivityTab /> : null}
          {tab === 'changes' ? <ChangesTab /> : null}
          {tab === 'results' ? <ResultsTab /> : null}
        </div>
      )}
    </div>
  )
}
