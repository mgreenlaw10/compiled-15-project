/**
 * Delete a module, and decide what happens to its files.
 *
 * The three dispositions differ enormously in consequence, so each one says
 * what it does to the code rather than only what it does to the graph.
 */

import { useState } from 'react'

import { useStore } from '../../state/store'
import { Modal, plural } from '../../ui'

export function DeleteModuleDialog(): JSX.Element {
  const graph = useStore((s) => s.desired)
  const selectedId = useStore((s) => s.selectedModuleId)
  const dispatchOperation = useStore((s) => s.dispatchOperation)
  const openDialog = useStore((s) => s.openDialog)

  const module = graph?.modules.find((m) => m.id === selectedId)
  const others = (graph?.modules ?? []).filter((m) => m.id !== selectedId)
  const [disposition, setDisposition] = useState<'orphan' | 'reassign' | 'delete'>(
    'orphan'
  )
  const [reassignTo, setReassignTo] = useState(others[0]?.id ?? '')

  if (!module) {
    return (
      <Modal title="Delete module" onClose={() => openDialog(null)}>
        <p>No module is selected.</p>
      </Modal>
    )
  }

  const confirm = (): void => {
    const ok = dispatchOperation({
      type: 'delete_module',
      moduleId: module.id,
      fileDisposition: disposition,
      ...(disposition === 'reassign' ? { reassignTo } : {})
    })
    if (ok) openDialog(null)
  }

  return (
    <Modal
      title={`Delete “${module.name}”`}
      onClose={() => openDialog(null)}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            onClick={confirm}
            disabled={disposition === 'reassign' && reassignTo === ''}
          >
            Delete module
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        This module owns {plural(module.files.length, 'file')}. Choose what should
        happen to them.
      </p>

      <label className="checkbox">
        <input
          type="radio"
          checked={disposition === 'orphan'}
          onChange={() => setDisposition('orphan')}
        />
        <span className="checkbox-text">
          Leave the files where they are
          <small>
            The module disappears from the graph; the files stay on disk and
            become unassigned. No code changes.
          </small>
        </span>
      </label>

      <label className="checkbox">
        <input
          type="radio"
          checked={disposition === 'reassign'}
          onChange={() => setDisposition('reassign')}
          disabled={others.length === 0}
        />
        <span className="checkbox-text">
          Move the files into another module
          <small>
            The files are moved into that module's directory and every import of
            them is rewritten.
          </small>
          {disposition === 'reassign' ? (
            <select
              value={reassignTo}
              onChange={(event) => setReassignTo(event.target.value)}
              style={{ marginTop: 6 }}
            >
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.directory ? ` — ${m.directory}` : ' — no directory'}
                </option>
              ))}
            </select>
          ) : null}
        </span>
      </label>

      <label className="checkbox">
        <input
          type="radio"
          checked={disposition === 'delete'}
          onChange={() => setDisposition('delete')}
        />
        <span className="checkbox-text">
          Delete the files
          <small style={{ color: 'var(--danger)' }}>
            Destructive. Anything that still imports these files will stop
            compiling; the plan will list those imports before you write
            anything.
          </small>
        </span>
      </label>
    </Modal>
  )
}
