/**
 * The bottom panel: activity, pending changes, and results.
 *
 * One tab per question a user asks while work is running — what is happening,
 * what will change, what happened — each in its own file.
 */

import { useState } from 'react'

import { usePendingOperations, useStore } from '../../state/store'
import { Badge } from '../../ui'
import { useCollabEnabled, useSessionViews } from '../collab'
import { ActivityTab } from './ActivityTab'
import { AgentsTab } from './AgentsTab'
import { GitTab } from './GitTab'
import { ValidationTab } from './ValidationTab'
import { ChangesTab } from './ChangesTab'
import { ResultsTab } from './ResultsTab'

export function BottomPanel(): JSX.Element {
  const tab = useStore((s) => s.bottomTab)
  const setTab = useStore((s) => s.setBottomTab)
  const pending = usePendingOperations()
  const changeSet = useStore((s) => s.changeSet)
  const logs = useStore((s) => s.logs)
  const [collapsed, setCollapsed] = useState(false)
  const collabEnabled = useCollabEnabled()
  const sessions = useSessionViews()

  const problems = logs.filter((l) => l.level === 'error').length
  const runningAgents = sessions.filter((v) => v.session.status === 'running').length
  const queuedInstructions = sessions.reduce(
    (total, view) => total + view.pendingInstructions,
    0
  )

  /** One tab button, so adding a tab is a row rather than a block. */
  const tabButton = (
    name: typeof tab,
    label: string,
    badge?: JSX.Element | null
  ): JSX.Element => (
    <button
      className={tab === name ? 'tab is-active' : 'tab'}
      onClick={() => {
        setTab(name)
        setCollapsed(false)
      }}
    >
      {label}
      {badge ? <span style={{ marginLeft: 6 }}>{badge}</span> : null}
    </button>
  )

  return (
    <div className={collapsed ? 'bottom is-collapsed' : 'bottom'}>
      <div className="tabs">
        <button
          className={tab === 'activity' ? 'tab is-active' : 'tab'}
          onClick={() => {
            setTab('activity')
            setCollapsed(false)
          }}
        >
          Activity
          {problems > 0 ? (
            <span style={{ marginLeft: 6 }}>
              <Badge kind="danger">{problems}</Badge>
            </span>
          ) : null}
        </button>
        <button
          className={tab === 'changes' ? 'tab is-active' : 'tab'}
          onClick={() => {
            setTab('changes')
            setCollapsed(false)
          }}
        >
          Changes
          {changeSet ? (
            <span style={{ marginLeft: 6 }}>
              <Badge kind="info">{changeSet.changes.length}</Badge>
            </span>
          ) : pending.length > 0 ? (
            <span style={{ marginLeft: 6 }}>
              <Badge kind="pending">{pending.length}</Badge>
            </span>
          ) : null}
        </button>
        <button
          className={tab === 'results' ? 'tab is-active' : 'tab'}
          onClick={() => {
            setTab('results')
            setCollapsed(false)
          }}
        >
          Results
        </button>

        {/* Collaboration tabs appear only when the project has it enabled, so
            a single-player window looks exactly as it did. */}
        {collabEnabled ? (
          <>
            {tabButton(
              'agents',
              'Agents',
              runningAgents > 0 ? (
                <Badge kind="ai">{runningAgents}</Badge>
              ) : queuedInstructions > 0 ? (
                <Badge kind="pending">{queuedInstructions}</Badge>
              ) : null
            )}
            {tabButton('git', 'Git')}
            {tabButton('validation', 'Validation')}
          </>
        ) : null}

        <span style={{ flex: 1 }} />
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="bottom-body">
          {tab === 'activity' ? <ActivityTab /> : null}
          {tab === 'changes' ? <ChangesTab /> : null}
          {tab === 'results' ? <ResultsTab /> : null}
          {tab === 'agents' ? <AgentsTab /> : null}
          {tab === 'git' ? <GitTab /> : null}
          {tab === 'validation' ? <ValidationTab /> : null}
        </div>
      )}
    </div>
  )
}
