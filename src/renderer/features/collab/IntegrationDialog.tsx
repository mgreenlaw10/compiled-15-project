/**
 * Reviewing and integrating a task's work.
 *
 * The screen is built around one distinction: what we *know* versus what we
 * *suspect*. Blocking conflicts are facts (Git cannot merge these files; this
 * symbol no longer exists). Warnings are inferences from the dependency graph
 * (this signature changed and three modules call it). Both are shown, labelled
 * differently, and a blocking conflict disables the merge rather than hiding
 * behind a confirmation.
 */

import { useEffect, useState } from 'react'

import type { IntegrationConflict } from '../../../shared/collab'
import { useStore } from '../../state/store'
import { Badge, Banner, DiffBlock, Modal, plural } from '../../ui'
import { useTasks } from './use-collab'

function ConflictCard({
  conflict,
  moduleName
}: {
  conflict: IntegrationConflict
  moduleName: (id: string) => string
}): JSX.Element {
  return (
    <div className="outcome">
      <div className="file-change-head">
        <Badge kind={conflict.severity === 'blocking' ? 'danger' : 'pending'}>
          {conflict.severity === 'blocking' ? 'blocking' : 'warning'}
        </Badge>
        <Badge kind="info">{conflict.kind.replace('_', ' ')}</Badge>
        <span className="path">{conflict.summary}</span>
      </div>
      <div className="outcome-body">
        <div className="outcome-msg">{conflict.explanation}</div>
        {conflict.affectedModuleIds.length > 0 ? (
          <div className="chips" style={{ marginTop: 4 }}>
            {conflict.affectedModuleIds.slice(0, 8).map((id) => (
              <span key={id} className="badge">
                {moduleName(id)}
              </span>
            ))}
          </div>
        ) : null}
        {conflict.paths.length > 0 ? (
          <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>
            {conflict.paths.slice(0, 6).join(', ')}
            {conflict.paths.length > 6 ? ` and ${conflict.paths.length - 6} more` : ''}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function IntegrationDialog(): JSX.Element {
  const openDialog = useStore((s) => s.openDialog)
  const graph = useStore((s) => s.desired)
  const taskId = useStore((s) => s.selectedTaskId)
  const reports = useStore((s) => s.integrationReports)
  const assess = useStore((s) => s.assessIntegration)
  const integrate = useStore((s) => s.integrateTask)
  const submit = useStore((s) => s.submitIntegration)
  const busy = useStore((s) => s.collabBusy)
  const tasks = useTasks()

  const [diff, setDiff] = useState<{ patch: string; changedPaths: string[] } | null>(
    null
  )
  const [showDiff, setShowDiff] = useState(false)

  const task = tasks.find((t) => t.id === taskId) ?? null
  const report = taskId ? reports[taskId] : undefined

  useEffect(() => {
    if (taskId && !report) void assess(taskId)
  }, [taskId, report, assess])

  const moduleName = (id: string): string =>
    graph?.modules.find((m) => m.id === id)?.name ?? id

  if (!task) {
    return (
      <Modal title="Integration" onClose={() => openDialog(null)}>
        <p>No task is selected.</p>
      </Modal>
    )
  }

  const blocking = (report?.conflicts ?? []).filter((c) => c.severity === 'blocking')
  const warnings = (report?.conflicts ?? []).filter((c) => c.severity === 'warning')
  const merged = report?.status === 'merged'

  return (
    <Modal
      title={`Integrate "${task.title}"`}
      onClose={() => openDialog(null)}
      wide
      footer={
        <>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              const result = await window.cartograph.taskDiff(task.id)
              setDiff(result)
              setShowDiff(true)
            }}
          >
            View diff
          </button>
          <button className="btn" disabled={busy} onClick={() => void assess(task.id)}>
            Re-check
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Close
          </button>
          <button
            className="btn"
            disabled={busy || merged}
            onClick={() => void submit(task.id)}
            title="Publish this assessment so other developers see it, without merging."
          >
            Submit for review
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || blocking.length > 0 || merged}
            onClick={() => void integrate(task.id)}
            title={
              blocking.length > 0
                ? 'Blocking conflicts must be resolved first'
                : 'Merge into the shared branch'
            }
          >
            {busy ? 'Working…' : merged ? 'Integrated' : 'Merge and publish'}
          </button>
        </>
      }
    >
      {!report ? (
        <p>Assessing…</p>
      ) : (
        <>
          {merged ? (
            <Banner kind="ok">{report.note ?? 'Integrated.'}</Banner>
          ) : blocking.length > 0 ? (
            <Banner kind="error">
              <strong>{plural(blocking.length, 'blocking conflict')}</strong> — these
              must be resolved before this task can be merged.
            </Banner>
          ) : (
            <Banner kind="ok">
              Git can merge this branch cleanly.
              {warnings.length > 0
                ? ` ${plural(warnings.length, 'possible incompatibility')} worth reading first — a clean merge does not mean the result is correct.`
                : ' No architectural incompatibilities were detected.'}
            </Banner>
          )}

          <dl className="kv">
            <dt>Branch</dt>
            <dd className="mono">{task.branch ?? '(none yet)'}</dd>
            <dt>Files changed</dt>
            <dd>{report.changedPaths.length}</dd>
            <dt>Scope</dt>
            <dd>{report.scopeSummary || '—'}</dd>
            <dt>Git merge</dt>
            <dd>{report.mergesCleanly ? 'clean' : 'conflicts'}</dd>
          </dl>

          {report.outOfScopePaths.length > 0 ? (
            <Banner kind="warn">
              <strong>
                {plural(report.outOfScopePaths.length, 'file')} changed outside the
                task's modules
              </strong>
              <div className="mono" style={{ fontSize: 11, marginTop: 4 }}>
                {report.outOfScopePaths.slice(0, 8).join(', ')}
              </div>
              <div style={{ marginTop: 4 }}>
                Reservations are advisory, so this was not blocked. It is shown
                because the agent went outside what it was given.
              </div>
            </Banner>
          ) : null}

          {report.validations.length > 0 ? (
            <>
              <div className="section-title">Validation</div>
              {report.validations.map((validation) => (
                <div key={validation.name} className="outcome">
                  <div className="file-change-head">
                    <Badge
                      kind={
                        validation.status === 'passed'
                          ? 'ok'
                          : validation.status === 'failed'
                            ? 'danger'
                            : 'info'
                      }
                    >
                      {validation.status.replace('_', ' ')}
                    </Badge>
                    <span className="path">{validation.name}</span>
                  </div>
                  <div className="outcome-body">
                    <div className="outcome-msg mono" style={{ fontSize: 11 }}>
                      {validation.message}
                    </div>
                  </div>
                </div>
              ))}
            </>
          ) : null}

          {blocking.length > 0 ? (
            <>
              <div className="section-title">Blocking conflicts</div>
              {blocking.map((conflict, index) => (
                <ConflictCard
                  key={`${conflict.kind}-${index}`}
                  conflict={conflict}
                  moduleName={moduleName}
                />
              ))}
            </>
          ) : null}

          {warnings.length > 0 ? (
            <>
              <div className="section-title">
                Possible incompatibilities (suspected, not proven)
              </div>
              {warnings.map((conflict, index) => (
                <ConflictCard
                  key={`${conflict.kind}-w-${index}`}
                  conflict={conflict}
                  moduleName={moduleName}
                />
              ))}
            </>
          ) : null}

          {showDiff && diff ? (
            <>
              <div className="section-title">
                Diff — {plural(diff.changedPaths.length, 'file')}
              </div>
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {diff.patch ? (
                  <DiffBlock patch={diff.patch} />
                ) : (
                  <p className="faint">This branch has no committed changes yet.</p>
                )}
              </div>
            </>
          ) : null}
        </>
      )}
    </Modal>
  )
}
