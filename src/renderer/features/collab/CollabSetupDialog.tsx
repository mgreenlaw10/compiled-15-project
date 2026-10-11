/**
 * Turning collaboration on for a project.
 *
 * Three situations, and the dialog says which one it is rather than offering
 * every button at once: the repository already has a collaborative project
 * (join it), it is a Git repository that does not (initialize it), or it is not
 * a Git repository at all (nothing we can do — Git *is* the synchronization
 * mechanism here, so that is stated plainly rather than hidden behind a
 * disabled button).
 */

import { useEffect, useState } from 'react'

import { useStore } from '../../state/store'
import { Banner, Modal, TextField } from '../../ui'

export function CollabSetupDialog(): JSX.Element {
  const openDialog = useStore((s) => s.openDialog)
  const project = useStore((s) => s.project)
  const workspace = useStore((s) => s.collabWorkspace)
  const busy = useStore((s) => s.collabBusy)
  const error = useStore((s) => s.collabError)
  const inspect = useStore((s) => s.inspectWorkspace)
  const initialize = useStore((s) => s.initializeCollaboration)
  const join = useStore((s) => s.joinCollaboration)
  const connect = useStore((s) => s.connectCollaboration)
  const setError = useStore((s) => s.setCollabError)

  const [remoteUrl, setRemoteUrl] = useState('')

  useEffect(() => {
    void inspect()
  }, [inspect])

  const close = (): void => {
    setError(null)
    openDialog(null)
  }

  if (!project) {
    return (
      <Modal title="Collaboration" onClose={close}>
        <p>Open a project first.</p>
      </Modal>
    )
  }

  const notGit = workspace !== null && !workspace.isGitRepository
  const canJoin = workspace?.collaborationInitialized === true
  const connected = workspace?.connected === true

  return (
    <Modal
      title="Collaborate on this project"
      onClose={close}
      footer={
        <>
          <span className="faint">
            Coordination happens on a <span className="mono">collab-state</span>{' '}
            branch. Your source branches are untouched.
          </span>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
          {connected ? null : canJoin ? (
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void join()}
            >
              {busy ? 'Joining…' : 'Join this project'}
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={busy || notGit}
              onClick={() => void initialize(remoteUrl.trim() || undefined)}
            >
              {busy ? 'Initializing…' : 'Initialize collaboration'}
            </button>
          )}
        </>
      }
    >
      {error ? (
        <Banner kind="error" onClose={() => setError(null)}>
          {error}
        </Banner>
      ) : null}

      {notGit ? (
        <Banner kind="warn">
          <strong>This project is not a Git repository.</strong> Collaboration
          uses Git itself to synchronize — a shared remote, branches and
          worktrees — so there is nothing to coordinate through. Run{' '}
          <span className="mono">git init</span>, add a remote your team can
          reach, and reopen the project.
        </Banner>
      ) : null}

      {connected ? (
        <Banner kind="ok">
          Collaborating as <strong>{workspace?.identity.name}</strong>. Other
          developers who clone{' '}
          <span className="mono">{workspace?.remoteUrl ?? 'this repository'}</span>{' '}
          and join will see your tasks after they synchronize.
        </Banner>
      ) : canJoin ? (
        <Banner kind="info">
          This repository already has a collaborative project. Joining attaches
          this instance to it — no existing task, reservation or session is
          disturbed.
        </Banner>
      ) : workspace?.isGitRepository ? (
        <Banner kind="info">
          Initializing creates an orphan <span className="mono">collab-state</span>{' '}
          branch holding coordination metadata only — no source code, and no
          change to your working tree.
        </Banner>
      ) : null}

      <dl className="kv">
        <dt>Repository</dt>
        <dd className="mono">{workspace?.root ?? project.root}</dd>
        <dt>Branch</dt>
        <dd className="mono">{workspace?.currentBranch ?? '(unknown)'}</dd>
        <dt>Remote</dt>
        <dd className="mono">{workspace?.remoteUrl ?? 'none'}</dd>
        <dt>Git identity</dt>
        <dd>
          {workspace ? `${workspace.identity.name} <${workspace.identity.email}>` : '—'}
        </dd>
        <dt>Uncommitted files</dt>
        <dd>{workspace?.dirtyFileCount ?? 0}</dd>
      </dl>

      {!canJoin && workspace?.isGitRepository && !workspace.remoteUrl ? (
        <>
          <TextField
            label="Remote URL (optional)"
            value={remoteUrl}
            onChange={setRemoteUrl}
            placeholder="https://github.com/you/project.git"
            hint="Added as `origin`. Without a remote, collaboration works locally only — nothing is shared until one exists."
          />
          <Banner kind="warn">
            With no remote, coordination stays on this machine. Teammates cannot
            see anything until the repository has somewhere shared to push to.
          </Banner>
        </>
      ) : null}

      {connected ? (
        <p className="faint" style={{ fontSize: 11.5 }}>
          Synchronization is periodic, not instant: the application fetches the
          coordination branch every few seconds and publishes your changes when
          you make them. What you see is always as of the last successful sync,
          and the status bar says when that was.
        </p>
      ) : null}

      {canJoin && !connected ? (
        <button className="btn" onClick={() => void connect()} disabled={busy}>
          Reconnect without re-joining
        </button>
      ) : null}
    </Modal>
  )
}
