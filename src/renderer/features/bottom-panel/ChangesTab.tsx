/**
 * Pending edits, and the plan they produce.
 */

import { useState } from 'react'

import { OPERATION_LABELS } from '../../../shared/types/operations'
import { usePendingOperations, useStore } from '../../state/store'
import { Badge, DiffBlock, plural } from '../../ui'
import { outcomeBadge } from './labels'

export function ChangesTab(): JSX.Element {
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
