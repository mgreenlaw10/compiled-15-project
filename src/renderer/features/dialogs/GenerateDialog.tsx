/**
 * Write the generated changes.
 *
 * The most consequential screen in the application, so it puts the summary of
 * what is about to happen *above* the choice of where to write it, names the
 * two modes plainly, and requires an explicit confirmation before overwriting
 * the project.
 */

import { useMemo, useState } from 'react'

import type { WriteMode } from '../../../shared/types/generation'
import { useStore } from '../../state/store'
import { Banner, Checkbox, Modal, plural } from '../../ui'

export function GenerateDialog(): JSX.Element {
  const project = useStore((s) => s.project)
  const changeSet = useStore((s) => s.changeSet)
  const openDialog = useStore((s) => s.openDialog)
  const apply = useStore((s) => s.apply)
  const busy = useStore((s) => s.busy)

  const [mode, setMode] = useState<WriteMode>('new-directory')
  const [outputDirectory, setOutputDirectory] = useState('')
  const [createBackup, setCreateBackup] = useState(true)
  const [validate, setValidate] = useState(true)
  const [confirmed, setConfirmed] = useState(false)

  const counts = useMemo(() => {
    const c = { create: 0, modify: 0, rename: 0, delete: 0 }
    for (const change of changeSet?.changes ?? []) c[change.kind] += 1
    return c
  }, [changeSet])

  if (!changeSet || !project) {
    return (
      <Modal title="Generate project" onClose={() => openDialog(null)}>
        <p>There is no plan to write. Make a graph edit and generate first.</p>
      </Modal>
    )
  }

  const canWrite =
    busy === 'idle' &&
    (mode === 'new-directory' ? outputDirectory.trim() !== '' : confirmed)

  return (
    <Modal
      title="Write the generated changes"
      onClose={() => openDialog(null)}
      wide={false}
      footer={
        <>
          <button className="btn" onClick={() => openDialog('diff')}>
            Review diffs
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!canWrite}
            onClick={() =>
              void apply({
                mode,
                outputDirectory:
                  mode === 'new-directory' ? outputDirectory.trim() : undefined,
                createBackup,
                validate
              })
            }
          >
            {busy === 'applying' ? 'Writing…' : 'Write changes'}
          </button>
        </>
      }
    >
      <div className="banner banner--info">
        <div>
          <strong>About to write</strong>
          <div style={{ marginTop: 4 }}>
            {counts.create} created · {counts.modify} modified · {counts.rename}{' '}
            moved · {counts.delete} deleted
          </div>
          {changeSet.modulesAdded.length > 0 ? (
            <div>Modules added: {changeSet.modulesAdded.join(', ')}</div>
          ) : null}
          {changeSet.modulesRemoved.length > 0 ? (
            <div>Modules removed: {changeSet.modulesRemoved.join(', ')}</div>
          ) : null}
          {changeSet.modulesRenamed.length > 0 ? (
            <div>
              Modules renamed:{' '}
              {changeSet.modulesRenamed
                .map((r) => `${r.from} → ${r.to}`)
                .join(', ')}
            </div>
          ) : null}
        </div>
      </div>

      {changeSet.breakingChanges.length > 0 ? (
        <Banner kind="warn">
          <strong>
            {plural(changeSet.breakingChanges.length, 'potentially breaking change')}
          </strong>
          <ul className="plain" style={{ marginTop: 4 }}>
            {changeSet.breakingChanges.slice(0, 6).map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <label className="checkbox">
        <input
          type="radio"
          checked={mode === 'new-directory'}
          onChange={() => setMode('new-directory')}
        />
        <span className="checkbox-text">
          Generate into a new directory
          <small>
            Copies the project (minus node_modules and build output), applies the
            changes there, and leaves the original untouched.
          </small>
        </span>
      </label>

      {mode === 'new-directory' ? (
        <div style={{ display: 'flex', gap: 6, margin: '0 0 12px 26px' }}>
          <input
            type="text"
            className="mono"
            value={outputDirectory}
            placeholder="choose an empty or new directory"
            onChange={(event) => setOutputDirectory(event.target.value)}
          />
          <button
            className="btn"
            onClick={async () => {
              const picked = await window.cartograph.chooseOutputDirectory()
              if (!picked.canceled && picked.path) setOutputDirectory(picked.path)
            }}
          >
            Browse…
          </button>
        </div>
      ) : null}

      <label className="checkbox">
        <input
          type="radio"
          checked={mode === 'in-place'}
          onChange={() => setMode('in-place')}
        />
        <span className="checkbox-text">
          Overwrite the project
          <small>
            Applies the changes to {project.root} directly, then re-analyzes it.
          </small>
        </span>
      </label>

      {mode === 'in-place' ? (
        <div style={{ margin: '0 0 12px 26px' }}>
          <Checkbox
            checked={createBackup}
            onChange={setCreateBackup}
            label="Back up every file this touches first"
            hint="Copies the originals into .cartograph/backups/ with a manifest, and records the git HEAD if the project is a repository."
          />
          <Checkbox
            checked={confirmed}
            onChange={setConfirmed}
            label="I understand this modifies the project in place"
          />
        </div>
      ) : null}

      <Checkbox
        checked={validate}
        onChange={setValidate}
        label="Check the result afterwards"
        hint="Runs the project's type check and its npm test script, and reports exactly what passed, failed or could not run."
      />
    </Modal>
  )
}
