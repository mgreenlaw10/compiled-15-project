/**
 * The modal dialogs: add a module, delete a module, settings, the diff viewer,
 * and the generate/write dialog.
 *
 * The generate dialog is the most consequential screen in the application, so
 * it puts the summary of what is about to happen *above* the choice of where to
 * write it, names the two modes plainly, and requires an explicit confirmation
 * before overwriting the project.
 */

import { useEffect, useMemo, useState } from 'react'

import type { WriteMode } from '../../shared/types/generation'
import { EFFORT_LEVELS, SUGGESTED_MODELS } from '../../shared/types/ai'
import { slugify } from '../../shared/util/id'
import { join } from '../../shared/util/paths'
import { useStore } from '../state/store'
import {
  Badge,
  Banner,
  Checkbox,
  DiffBlock,
  Modal,
  TextAreaField,
  TextField,
  plural
} from './common'

// ---------------------------------------------------------------- add module

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

// ------------------------------------------------------------- delete module

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

// ------------------------------------------------------------------ settings

export function SettingsDialog(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const openDialog = useStore((s) => s.openDialog)

  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings?.model ?? '')
  const [effort, setEffort] = useState(settings?.effort ?? 'high')
  const [assist, setAssist] = useState(settings?.aiAssistAnalysis ?? true)
  const [maxReads, setMaxReads] = useState(settings?.maxAiFileReads ?? 40)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const save = async (): Promise<void> => {
    await updateSettings({
      ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
      model,
      effort,
      aiAssistAnalysis: assist,
      maxAiFileReads: maxReads
    })
    setApiKey('')
  }

  return (
    <Modal
      title="Settings"
      onClose={() => openDialog(null)}
      footer={
        <>
          <button
            className="btn"
            disabled={testing || settings?.hasApiKey !== true}
            onClick={async () => {
              setTesting(true)
              setTest(null)
              await save()
              setTest(await window.cartograph.testApiKey())
              setTesting(false)
            }}
          >
            {testing ? 'Testing…' : 'Test key'}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Close
          </button>
          <button
            className="btn btn--primary"
            onClick={() => {
              void save().then(() => openDialog(null))
            }}
          >
            Save
          </button>
        </>
      }
    >
      <Banner kind="info">
        Cartograph works without a key: scanning, the module graph, file and
        symbol moves, import rewriting, generation and validation are all
        deterministic. A key adds model-written descriptions and the two
        operations that need interpretation — moving a responsibility and
        generating a module's implementation.
      </Banner>

      {test ? (
        <Banner kind={test.ok ? 'ok' : 'error'} onClose={() => setTest(null)}>
          {test.message}
        </Banner>
      ) : null}

      <TextField
        label="Anthropic API key"
        type="password"
        value={apiKey}
        onChange={setApiKey}
        placeholder={
          settings?.hasApiKey ? `stored (${settings.apiKeyHint})` : 'sk-ant-…'
        }
        hint={
          settings?.hasApiKey
            ? 'A key is stored. Type a new one to replace it; leave it blank to keep it. Stored in your user data directory, encrypted with the OS keychain where one is available — never inside the project.'
            : 'Stored in your user data directory, encrypted with the OS keychain where one is available — never inside the analyzed project.'
        }
      />

      <label className="field">
        <span className="label">Model</span>
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {[...new Set([model, ...SUGGESTED_MODELS])]
            .filter((m) => m !== '')
            .map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
        </select>
        <span className="hint">
          Claude Opus 5.5 is the default and the most capable of these.
        </span>
      </label>

      <label className="field">
        <span className="label">Effort</span>
        <select value={effort} onChange={(event) => setEffort(event.target.value)}>
          {EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <span className="hint">
          How hard the model works per request. Higher costs more and takes
          longer; refactoring usually wants “high”.
        </span>
      </label>

      <label className="field">
        <span className="label">File reads per task</span>
        <input
          type="number"
          min={1}
          max={500}
          value={maxReads}
          onChange={(event) => setMaxReads(Number(event.target.value))}
        />
        <span className="hint">
          A ceiling on how much of the codebase the agent may read while
          carrying out one operation.
        </span>
      </label>

      <Checkbox
        checked={assist}
        onChange={setAssist}
        label="Use the model to describe modules when analyzing"
        hint="Static analysis still decides which files belong to which module; the model only writes descriptions and responsibilities, and they are labelled as model-written."
      />
    </Modal>
  )
}

// --------------------------------------------------------------- diff viewer

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

// ------------------------------------------------------------------ generate

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

export function Dialogs(): JSX.Element | null {
  const dialog = useStore((s) => s.dialog)
  switch (dialog) {
    case 'add-module':
      return <AddModuleDialog />
    case 'delete-module':
      return <DeleteModuleDialog />
    case 'settings':
      return <SettingsDialog />
    case 'diff':
      return <DiffViewerDialog />
    case 'generate':
      return <GenerateDialog />
    default:
      return null
  }
}
