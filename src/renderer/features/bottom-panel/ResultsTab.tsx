/**
 * What actually happened: per-operation outcomes, and the validation report.
 *
 * Reports honestly. An operation the engine could not carry out is listed as
 * such rather than folded into a success count, and a validation step that
 * could not run is distinguished from one that failed.
 */

import { useStore } from '../../state/store'
import { Badge, plural } from '../../ui'

export function ResultsTab(): JSX.Element {
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
