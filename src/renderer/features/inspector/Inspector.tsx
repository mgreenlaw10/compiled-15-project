/**
 * Right sidebar: the module property editor and source inspector.
 *
 * Everything that changes the architecture happens through operations. Which
 * edits are documentation (name, description, responsibilities) and which
 * rewrite code (directory, file and symbol moves) is reported by the status
 * bar's pending-change summary rather than explained inline here.
 */

import { useEffect, useMemo, useState } from 'react'

import { useModulesWithPendingChanges, useStore } from '../../state/store'
import { Badge, Empty, SectionTitle } from '../../ui'
import { ProgramInspector } from './ProgramInspector'
import { NodeInspector } from './NodeInspector'

export function Inspector(): JSX.Element {
  const graph = useStore((s) => s.desired)
  const selectedId = useStore((s) => s.selectedModuleId)
  const selectedFile = useStore((s) => s.selectedFile)
  const selectedSymbolId = useStore((s) => s.selectedSymbolId)
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

  if (selectedSymbolId || selectedFile) return <NodeInspector module={module} />

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
        </label>

        <label className="field">
          <span className="label">Description</span>
          <textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={commitDescription}
          />
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
        </label>

        <ProgramInspector key={module.id} module={module} />

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
