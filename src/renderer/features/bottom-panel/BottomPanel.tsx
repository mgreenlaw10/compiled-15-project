/**
 * The bottom panel: activity, pending changes, and results.
 *
 * One tab per question a user asks while work is running — what is happening,
 * what will change, what happened — each in its own file.
 */

import { useState } from 'react'

import {
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  usePendingOperations,
  useStore
} from '../../state/store'
import { Badge, useDragSize } from '../../ui'
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
  // Lives here rather than in ActivityTab, because the control sits in this
  // bar. Only shown while that tab is active: a toggle that changes nothing
  // on the tab you are looking at is worse than one you have to go find.
  const [showDebug, setShowDebug] = useState(false)
  const height = useStore((s) => s.bottomPanelHeight)
  const setHeight = useStore((s) => s.setBottomPanelHeight)

  const resize = useDragSize({
    value: height,
    onChange: setHeight,
    min: 90,
    // Keep the canvas usable: the panel may take at most two thirds.
    max: () => Math.max(90, Math.round(window.innerHeight * 0.66)),
    initial: DEFAULT_BOTTOM_PANEL_HEIGHT,
    from: 'start',
    axis: 'y'
  })
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
    <div
      className={[
        'console',
        collapsed ? 'is-collapsed' : '',
        resize.resizing ? 'is-resizing' : ''
      ]
        .filter((name) => name !== '')
        .join(' ')}
      style={collapsed ? undefined : { height }}
    >
      {/* Dragging the top edge resizes; collapsing hides the handle, since
          there is nothing to resize while the body is gone. */}
      {collapsed ? null : (
        <div
          className="console-resize-handle"
          aria-label="Resize the panel"
          aria-valuemax={Math.round(window.innerHeight * 0.66)}
          title="Drag to resize. Double-click to reset."
          {...resize.handleProps}
        />
      )}
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
        {tab === 'activity' && !collapsed ? (
          <button
            className={showDebug ? 'tab is-active' : 'tab'}
            onClick={() => setShowDebug(!showDebug)}
            aria-pressed={showDebug}
            title="Include debug-level events in the activity log"
          >
            Show detail
          </button>
        ) : null}
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="console-body">
          {tab === 'activity' ? <ActivityTab showDebug={showDebug} /> : null}
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
