/**
 * Right sidebar: the module property editor and source inspector.
 *
 * Everything that changes the architecture happens through operations, and the
 * UI is explicit about which edits are documentation (name, description,
 * responsibilities) and which rewrite code (directory, file moves, symbol
 * moves). The hints under the structural controls say so in words, not just
 * through styling.
 */

import { useEffect, useMemo, useState } from 'react'

import type { ModuleNode } from '../../shared/types/architecture'
import { dependenciesOf, dependentsOf, importantSymbols } from '../../shared/graph/selectors'
import { useModulesWithPendingChanges, useStore } from '../state/store'
import { Badge, Empty, SectionTitle, plural } from './common'
import { FILE_DRAG_MIME, type FileDragPayload } from './ModuleNodeView'

function MoveTarget({
  modules,
  exclude,
  label,
  onPick
}: {
  modules: ModuleNode[]
  exclude: string
  label: string
  onPick: (moduleId: string) => void
}): JSX.Element {
  const options = modules.filter((m) => m.id !== exclude)
  return (
    <select
      value=""
      style={{ width: 'auto', maxWidth: 140, padding: '2px 4px', fontSize: 11 }}
      onChange={(event) => {
        if (event.target.value) onPick(event.target.value)
      }}
      disabled={options.length === 0}
      title={label}
    >
      <option value="">{label}</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  )
}

export function Inspector(): JSX.Element {
  const graph = useStore((s) => s.desired)
  const original = useStore((s) => s.original)
  const selectedId = useStore((s) => s.selectedModuleId)
  const selectedFile = useStore((s) => s.selectedFile)
  const dispatchOperation = useStore((s) => s.dispatchOperation)
  const openDialog = useStore((s) => s.openDialog)
  const settings = useStore((s) => s.settings)
  const pending = useModulesWithPendingChanges()

  const module = useMemo(
    () => graph?.modules.find((m) => m.id === selectedId) ?? null,
    [graph, selectedId]
  )

  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [description, setDescription] = useState('')
  const [responsibilities, setResponsibilities] = useState('')

  useEffect(() => {
    setName(module?.name ?? '')
    setDirectory(module?.directory ?? '')
    setDescription(module?.description ?? '')
    setResponsibilities((module?.responsibilities ?? []).join('\n'))
  }, [module])

  if (!graph) {
    return (
      <aside className="pane pane--right">
        <div className="pane-header">
          <span>Inspector</span>
        </div>
        <Empty>Open a project to inspect its modules.</Empty>
      </aside>
    )
  }

  if (!module) {
    return (
      <aside className="pane pane--right">
        <div className="pane-header">
          <span>Inspector</span>
        </div>
        <Empty>
          Select a module in the graph or the module list to see and edit its
          properties.
        </Empty>
      </aside>
    )
  }

  const before = original?.modules.find((m) => m.id === module.id)
  const deps = dependenciesOf(graph, module.id)
  const dependents = dependentsOf(graph, module.id)
  const symbols = importantSymbols(module, 40)
  const others = graph.modules.filter((m) => m.id !== module.id)
  const hasKey = settings?.hasApiKey === true

  const commitName = (): void => {
    const trimmed = name.trim()
    if (trimmed === '' || trimmed === module.name) {
      setName(module.name)
      return
    }
    dispatchOperation({ type: 'rename_module', moduleId: module.id, name: trimmed })
  }

  const commitDirectory = (): void => {
    const trimmed = directory.trim()
    if (trimmed === (module.directory ?? '')) return
    if (trimmed === '') {
      setDirectory(module.directory ?? '')
      return
    }
    dispatchOperation({
      type: 'rename_module',
      moduleId: module.id,
      name: module.name,
      directory: trimmed
    })
  }

  const commitDescription = (): void => {
    if (description === module.description) return
    dispatchOperation({
      type: 'update_module',
      moduleId: module.id,
      description
    })
  }

  const commitResponsibilities = (): void => {
    const next = responsibilities
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    if (next.join('\n') === module.responsibilities.join('\n')) return
    dispatchOperation({
      type: 'update_module',
      moduleId: module.id,
      responsibilities: next
    })
  }

  return (
    <aside className="pane pane--right">
      <div className="pane-header">
        <span>Module</span>
        {pending.has(module.id) ? <Badge kind="pending">unapplied</Badge> : null}
      </div>

      <div className="pane-body">
        <label className="field">
          <span className="label">Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setName(module.name)
            }}
          />
          <span className="hint">
            Documentation only — renaming a module never changes code.
            {before && before.name !== module.name
              ? ` Was “${before.name}”.`
              : ''}
          </span>
        </label>

        <label className="field">
          <span className="label">Directory</span>
          <input
            type="text"
            className="mono"
            value={directory}
            placeholder="not backed by a directory"
            onChange={(event) => setDirectory(event.target.value)}
            onBlur={commitDirectory}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setDirectory(module.directory ?? '')
            }}
          />
          <span className="hint">
            Structural. Changing this moves {plural(module.files.length, 'file')} on
            disk and rewrites every import that points into them.
            {module.directory === null
              ? ' This module has no directory, so its files stay where they are until you give it one.'
              : ''}
          </span>
        </label>

        <label className="field">
          <span className="label">Description</span>
          <textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={commitDescription}
          />
          <span className="hint">
            {module.metadata.confidenceBasis === 'ai'
              ? 'Written by a language model — treat it as a suggestion.'
              : 'Derived from file names, exports and directory layout.'}
          </span>
        </label>

        <label className="field">
          <span className="label">Responsibilities</span>
          <textarea
            rows={Math.min(8, Math.max(3, module.responsibilities.length + 1))}
            value={responsibilities}
            onChange={(event) => setResponsibilities(event.target.value)}
            onBlur={commitResponsibilities}
            placeholder="One responsibility per line"
          />
          <span className="hint">One per line.</span>
        </label>

        {module.responsibilities.length > 0 ? (
          <>
            <SectionTitle>Move a responsibility</SectionTitle>
            <div className="list" style={{ marginBottom: 8 }}>
              {module.responsibilities.map((responsibility) => (
                <div
                  key={responsibility}
                  className="row"
                  style={{ cursor: 'default', paddingLeft: 0, paddingRight: 0 }}
                >
                  <span className="row-main">
                    <span className="row-title">{responsibility}</span>
                  </span>
                  <MoveTarget
                    modules={others}
                    exclude={module.id}
                    label={hasKey ? 'Move to…' : 'Needs AI key'}
                    onPick={(toModuleId) =>
                      dispatchOperation({
                        type: 'move_responsibility',
                        responsibility,
                        fromModuleId: module.id,
                        toModuleId
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <p className="hint faint" style={{ marginTop: 0 }}>
              Moving a responsibility needs a model: it means working out which
              declarations implement it.{' '}
              {hasKey
                ? 'It will run when you generate.'
                : 'Without an API key it will be reported as unsupported.'}
            </p>
          </>
        ) : null}

        <SectionTitle>Confidence</SectionTitle>
        <dl className="kv">
          <dt>Score</dt>
          <dd>
            {Math.round(module.metadata.confidence * 100)}%{' '}
            <span className="faint">({module.metadata.confidenceBasis})</span>
          </dd>
          <dt>Origin</dt>
          <dd>{module.origin}</dd>
          <dt>Lines</dt>
          <dd>{module.metadata.loc}</dd>
        </dl>
        {module.metadata.notes.length > 0 ? (
          <ul className="plain faint" style={{ marginTop: 6, fontSize: 11.5 }}>
            {module.metadata.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        ) : null}

        {module.metadata.tags.length > 0 ? (
          <>
            <SectionTitle>Tags</SectionTitle>
            <div className="chips">
              {module.metadata.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          </>
        ) : null}

        <SectionTitle>Files ({module.files.length})</SectionTitle>
        {module.files.length === 0 ? (
          <p className="faint" style={{ marginTop: 0 }}>
            This module has no files yet. Generating the project creates its
            entry file; drag files onto it in the graph to fill it.
          </p>
        ) : (
          <div className="list">
            {module.files.map((file) => (
              <div
                key={file}
                className={
                  selectedFile === file
                    ? 'row is-selected'
                    : 'row'
                }
                style={{ paddingLeft: 0, paddingRight: 0 }}
                draggable
                onDragStart={(event) => {
                  const payload: FileDragPayload = {
                    file,
                    fromModuleId: module.id
                  }
                  event.dataTransfer.setData(
                    FILE_DRAG_MIME,
                    JSON.stringify(payload)
                  )
                  event.dataTransfer.effectAllowed = 'move'
                }}
                title={`${file} — drag onto another module, or use the menu`}
              >
                <span className="row-main">
                  <span className="row-title mono" style={{ fontSize: 11.5 }}>
                    {file}
                  </span>
                </span>
                <MoveTarget
                  modules={others}
                  exclude={module.id}
                  label="Move to…"
                  onPick={(toModuleId) =>
                    dispatchOperation({
                      type: 'move_file',
                      file,
                      fromModuleId: module.id,
                      toModuleId
                    })
                  }
                />
              </div>
            ))}
          </div>
        )}

        <SectionTitle>Public interface ({module.publicInterface.length})</SectionTitle>
        {module.publicInterface.length === 0 ? (
          <p className="faint" style={{ marginTop: 0 }}>
            Nothing is exported from this module.
          </p>
        ) : (
          <div className="chips">
            {module.publicInterface.map((symbol) => (
              <span key={symbol} className="tag mono">
                {symbol}
              </span>
            ))}
          </div>
        )}

        <SectionTitle>Declarations ({symbols.length})</SectionTitle>
        {symbols.length === 0 ? (
          <p className="faint" style={{ marginTop: 0 }}>
            No declarations were found in this module's files.
          </p>
        ) : (
          <div className="list">
            {symbols.map((symbol) => (
              <div
                key={`${symbol.file}:${symbol.name}`}
                className="row"
                style={{ cursor: 'default', paddingLeft: 0, paddingRight: 0 }}
                title={symbol.signature}
              >
                <span className="row-main">
                  <span className="row-title mono" style={{ fontSize: 11.5 }}>
                    {symbol.exported ? '' : '· '}
                    {symbol.name}
                  </span>
                  <span className="row-sub">
                    {symbol.kind} — {symbol.file}:{symbol.line}
                  </span>
                </span>
                {symbol.exported ? (
                  <MoveTarget
                    modules={others}
                    exclude={module.id}
                    label="Move to…"
                    onPick={(toModuleId) =>
                      dispatchOperation({
                        type: 'move_symbol',
                        symbol: symbol.name,
                        fromFile: symbol.file,
                        fromModuleId: module.id,
                        toModuleId,
                        leaveReExport: false
                      })
                    }
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}

        <SectionTitle>Depends on ({deps.length})</SectionTitle>
        {deps.length === 0 ? (
          <p className="faint" style={{ marginTop: 0 }}>
            This module imports nothing else in the project.
          </p>
        ) : (
          <div className="list">
            {deps.map(({ edge, module: target }) => (
              <div
                key={edge.id}
                className="row"
                style={{ cursor: 'default', paddingLeft: 0, paddingRight: 0 }}
              >
                <span className="row-main">
                  <span className="row-title">{target.name}</span>
                  <span className="row-sub">
                    {edge.verified
                      ? `${plural(edge.weight, 'import')} — verified`
                      : `${edge.kind} — declared, not in the code`}
                  </span>
                </span>
                <button
                  className="btn btn--ghost btn--sm"
                  title={
                    edge.verified
                      ? 'Remove from the graph. Real imports exist, so generation will report this as unsupported.'
                      : 'Remove this declared dependency'
                  }
                  onClick={() =>
                    dispatchOperation({
                      type: 'remove_dependency',
                      from: module.id,
                      to: target.id
                    })
                  }
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <MoveTarget
            modules={others.filter(
              (m) => !deps.some((d) => d.module.id === m.id)
            )}
            exclude={module.id}
            label="Add dependency on…"
            onPick={(toModuleId) =>
              dispatchOperation({
                type: 'add_dependency',
                from: module.id,
                to: toModuleId,
                kind: 'depends_on'
              })
            }
          />
        </div>

        <SectionTitle>Depended on by ({dependents.length})</SectionTitle>
        {dependents.length === 0 ? (
          <p className="faint" style={{ marginTop: 0 }}>
            Nothing imports this module.
          </p>
        ) : (
          <div className="chips">
            {dependents.map(({ edge, module: source }) => (
              <span
                key={edge.id}
                className="tag"
                title={
                  edge.verified
                    ? `${plural(edge.weight, 'import')} — verified`
                    : 'declared only'
                }
              >
                {source.name}
                {edge.verified ? '' : ' (declared)'}
              </span>
            ))}
          </div>
        )}

        {module.externalDependencies.length > 0 ? (
          <>
            <SectionTitle>
              External packages ({module.externalDependencies.length})
            </SectionTitle>
            <div className="chips">
              {module.externalDependencies.map((pkg) => (
                <span key={pkg} className="tag mono">
                  {pkg}
                </span>
              ))}
            </div>
          </>
        ) : null}

        <SectionTitle>Actions</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            className="btn"
            disabled={!hasKey}
            title={
              hasKey
                ? 'Ask the model to write this module’s implementation when you generate'
                : 'Add an Anthropic API key in Settings to use this'
            }
            onClick={() =>
              dispatchOperation({
                type: 'scaffold_module',
                moduleId: module.id,
                instructions: ''
              })
            }
          >
            Generate implementation with AI
          </button>
          <button
            className="btn btn--danger"
            onClick={() => openDialog('delete-module')}
          >
            Delete module…
          </button>
        </div>
      </div>
    </aside>
  )
}
