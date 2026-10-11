/**
 * The proposed changes, file by file.
 *
 * Read-only: nothing here writes. The only way out towards the filesystem is
 * the generate dialog.
 */

import { useState } from 'react'

import { useStore } from '../../state/store'
import { Badge, DiffBlock, Modal, plural } from '../../ui'

export function DiffViewerDialog(): JSX.Element {
  const changeSet = useStore((s) => s.changeSet)
  const diffs = useStore((s) => s.diffs)
  const openDialog = useStore((s) => s.openDialog)
  const [selected, setSelected] = useState(0)

  const changes = changeSet?.changes ?? []
  const current = changes[selected]
  const diff = diffs?.find((d) => d.path === current?.path)

  return (
    <Modal
      title={`Proposed changes — ${plural(changes.length, 'file')}`}
      onClose={() => openDialog(null)}
      wide
      footer={
        <>
          <span className="faint">
            Nothing has been written yet. Choose “Write the changes” to apply
            them.
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Close
          </button>
          <button
            className="btn btn--primary"
            onClick={() => openDialog('generate')}
            disabled={changes.length === 0}
          >
            Write the changes…
          </button>
        </>
      }
    >
      {changes.length === 0 ? (
        <p>This plan produced no file changes.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14 }}>
          <div className="list" style={{ maxHeight: 460, overflow: 'auto' }}>
            {changes.map((change, index) => (
              <button
                key={`${change.kind}:${change.path}`}
                className={index === selected ? 'row is-selected' : 'row'}
                onClick={() => setSelected(index)}
              >
                <span className="row-main">
                  <span className="row-title mono" style={{ fontSize: 11.5 }}>
                    {change.path}
                  </span>
                  <span className="row-sub">{change.kind}</span>
                </span>
              </button>
            ))}
          </div>
          <div style={{ minWidth: 0 }}>
            {current ? (
              <>
                <div className="file-change-head">
                  <Badge
                    kind={
                      current.kind === 'create'
                        ? 'ok'
                        : current.kind === 'delete'
                          ? 'danger'
                          : 'info'
                    }
                  >
                    {current.kind}
                  </Badge>
                  <span className="path">
                    {current.kind === 'rename' && current.previousPath
                      ? `${current.previousPath} → ${current.path}`
                      : current.path}
                  </span>
                </div>
                <p className="faint" style={{ marginTop: 0, fontSize: 11.5 }}>
                  {current.reason}
                </p>
                {diff ? (
                  <div style={{ maxHeight: 400, overflow: 'auto' }}>
                    <DiffBlock patch={diff.patch} />
                  </div>
                ) : (
                  <p className="faint">No diff available for this file.</p>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  )
}
