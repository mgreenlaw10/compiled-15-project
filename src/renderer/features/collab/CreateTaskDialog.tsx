/**
 * Creating a task and handing it to an agent.
 *
 * The dialog is explicit about two consequences that are easy to miss: the
 * modules it will reserve (advisory, but other developers will see them taken),
 * and the fact that starting an agent creates a real Git worktree and branch
 * and begins editing real files.
 */

import { useMemo, useState } from 'react'

import { useStore } from '../../state/store'
import { Banner, Checkbox, Modal, TextAreaField, TextField } from '../../ui'
import { useModuleStates, useMyDeveloperId } from './use-collab'

export function CreateTaskDialog(): JSX.Element {
  const openDialog = useStore((s) => s.openDialog)
  const graph = useStore((s) => s.desired)
  const selectedModuleId = useStore((s) => s.selectedModuleId)
  const createTask = useStore((s) => s.createTask)
  const startAgent = useStore((s) => s.startAgent)
  const busy = useStore((s) => s.collabBusy)
  const error = useStore((s) => s.collabError)
  const hasApiKey = useStore((s) => s.settings?.hasApiKey === true)
  const moduleStates = useModuleStates()
  const myId = useMyDeveloperId()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [moduleIds, setModuleIds] = useState<string[]>(
    selectedModuleId ? [selectedModuleId] : []
  )
  const [startNow, setStartNow] = useState(hasApiKey)

  const modules = graph?.modules ?? []

  /** Modules already taken by somebody else, so the choice is informed. */
  const taken = useMemo(() => {
    const map = new Map<string, string>()
    for (const [moduleId, state] of moduleStates) {
      if (!state.claimable && state.developer && state.developer !== myId) {
        map.set(moduleId, `${state.developer} — ${state.status}`)
      }
    }
    return map
  }, [moduleStates, myId])

  const conflicts = moduleIds.filter((id) => taken.has(id))
  const canCreate = title.trim() !== '' && moduleIds.length > 0

  const submit = async (): Promise<void> => {
    const task = await createTask({
      title: title.trim(),
      description: description.trim(),
      moduleIds,
      assignedAgent: startNow ? 'agent' : null,
      claimModules: true
    })
    if (!task) return
    if (startNow) await startAgent(task.id)
    openDialog(null)
  }

  return (
    <Modal
      title="New task"
      onClose={() => openDialog(null)}
      footer={
        <>
          <span className="faint">
            {startNow
              ? 'Creates a Git worktree and branch, then starts editing real files.'
              : 'Reserves the modules; no code changes until an agent runs.'}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!canCreate || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Working…' : startNow ? 'Create and start agent' : 'Create task'}
          </button>
        </>
      }
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      <TextField
        label="Title"
        value={title}
        onChange={setTitle}
        autoFocus
        placeholder="Implement OAuth login"
      />
      <TextAreaField
        label="What should be done"
        value={description}
        onChange={setDescription}
        rows={4}
        placeholder="Add OAuth authentication support, keeping the existing validateToken signature."
        hint="This becomes the agent's brief, alongside the module's interfaces, data structures and contracts from the graph."
      />

      <label className="field">
        <span className="label">Modules</span>
        <div className="list" style={{ maxHeight: 180, overflow: 'auto' }}>
          {modules.map((module) => {
            const takenBy = taken.get(module.id)
            const checked = moduleIds.includes(module.id)
            return (
              <label
                key={module.id}
                className={checked ? 'row is-selected' : 'row'}
                style={{ cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    setModuleIds((current) =>
                      event.target.checked
                        ? [...current, module.id]
                        : current.filter((id) => id !== module.id)
                    )
                  }
                />
                <span className="row-main" style={{ marginLeft: 8 }}>
                  <span className="row-title">{module.name}</span>
                  <span className="row-sub">
                    {takenBy ? `taken: ${takenBy}` : (module.directory ?? 'no directory')}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
        <span className="hint">
          The task may only write inside these modules. Changes elsewhere are
          detected when it is submitted and reported for review.
        </span>
      </label>

      {conflicts.length > 0 ? (
        <Banner kind="warn">
          <strong>
            {conflicts.length === 1
              ? 'One module is already being worked on'
              : `${conflicts.length} modules are already being worked on`}
          </strong>
          <div style={{ marginTop: 4 }}>
            {conflicts.map((id) => (
              <div key={id}>
                {modules.find((m) => m.id === id)?.name ?? id} — {taken.get(id)}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 4 }}>
            Reservations are advisory, so this is allowed — but two agents
            editing the same module will collide at integration time.
          </div>
        </Banner>
      ) : null}

      <Checkbox
        checked={startNow}
        onChange={setStartNow}
        label="Start an agent immediately"
        hint={
          hasApiKey
            ? 'Creates an isolated Git worktree and branch for this task and begins working on real source files. Progress appears in the Agents tab.'
            : 'Unavailable: no model provider API key is configured. Add one in Settings.'
        }
      />
      {!hasApiKey && startNow ? (
        <Banner kind="warn">
          No API key is configured, so no agent can start. The task will be
          created and the modules reserved.
        </Banner>
      ) : null}
    </Modal>
  )
}
