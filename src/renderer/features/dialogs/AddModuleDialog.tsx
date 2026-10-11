/**
 * Create a module.
 *
 * The suggested directory follows the name until the user edits it, and the
 * module id is shown as it is derived so a collision is visible before the
 * button is pressed rather than after.
 */

import { useEffect, useMemo, useState } from 'react'

import { slugify } from '../../../shared/util/id'
import { join } from '../../../shared/util/paths'
import { useStore } from '../../state/store'
import { Modal, TextAreaField, TextField } from '../../ui'

export function AddModuleDialog(): JSX.Element {
  const graph = useStore((s) => s.desired)
  const dispatchOperation = useStore((s) => s.dispatchOperation)
  const openDialog = useStore((s) => s.openDialog)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [responsibilities, setResponsibilities] = useState('')
  const [interfaceText, setInterfaceText] = useState('')
  const [directory, setDirectory] = useState('')
  const [directoryTouched, setDirectoryTouched] = useState(false)

  // The suggested directory follows the name until the user edits it.
  const suggested = useMemo(() => {
    const dirs = (graph?.modules ?? [])
      .map((m) => m.directory)
      .filter((d): d is string => d !== null && d !== '')
    const slug = slugify(name || 'new-module')
    if (dirs.length === 0) return join('src', slug)
    const parents = new Map<string, number>()
    for (const dir of dirs) {
      const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
      parents.set(parent, (parents.get(parent) ?? 0) + 1)
    }
    const best = [...parents.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0][0]
    return join(best, slug)
  }, [graph, name])

  useEffect(() => {
    if (!directoryTouched) setDirectory(suggested)
  }, [suggested, directoryTouched])

  const id = slugify(name || 'new-module')
  const idTaken = graph?.modules.some((m) => m.id === id) === true
  const canCreate = name.trim() !== '' && !idTaken

  const create = (): void => {
    const ok = dispatchOperation({
      type: 'add_module',
      module: {
        id,
        name: name.trim(),
        description: description.trim(),
        responsibilities: responsibilities
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
        directory: directory.trim() === '' ? null : directory.trim(),
        publicInterface: interfaceText
          .split(/[\n,]/)
          .map((part) => part.trim())
          .filter((part) => part !== '')
      }
    })
    if (ok) openDialog(null)
  }

  return (
    <Modal
      title="Add a module"
      onClose={() => openDialog(null)}
      footer={
        <>
          <span className="faint">
            Creates <span className="mono">{directory || '(no directory)'}/index.ts</span>{' '}
            when you generate.
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={create} disabled={!canCreate}>
            Add module
          </button>
        </>
      }
    >
      <TextField
        label="Name"
        value={name}
        onChange={setName}
        autoFocus
        placeholder="Session Management"
        hint={
          idTaken ? (
            <span style={{ color: 'var(--danger)' }}>
              A module with the id “{id}” already exists.
            </span>
          ) : (
            <>
              Module id will be <span className="mono">{id}</span>.
            </>
          )
        }
      />
      <TextField
        label="Directory"
        value={directory}
        onChange={(value) => {
          setDirectoryTouched(true)
          setDirectory(value)
        }}
        placeholder="src/session-management"
        hint="Where this module's source will live. Leave it empty to create a graph-only module that writes no files."
      />
      <TextAreaField
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="What is this module for?"
        hint="Used as the file header, and as the brief if you ask the model to implement it."
      />
      <TextAreaField
        label="Responsibilities"
        value={responsibilities}
        onChange={setResponsibilities}
        rows={3}
        placeholder={'Create sessions\nExpire and revoke sessions'}
        hint="One per line."
      />
      <TextAreaField
        label="Exports to declare"
        value={interfaceText}
        onChange={setInterfaceText}
        rows={2}
        placeholder="createSession, revokeSession"
        hint="Optional. Each becomes a placeholder export that throws when called, so the gap is impossible to miss. Comma- or newline-separated."
      />
    </Modal>
  )
}
