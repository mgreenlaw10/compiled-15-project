import { useEffect, useState, type ReactNode } from 'react'
import { usePendingOperations, useStore } from '../../state/store'
import { Badge } from '../../ui'
import { ActivityTab } from './ActivityTab'
import { ChangesTab } from './ChangesTab'
import { ResultsTab } from './ResultsTab'

export function BottomPanel({ preview, moduleDetails }: { preview: ReactNode; moduleDetails: ReactNode }): JSX.Element {
  const tab = useStore((s) => s.bottomTab)
  const setTab = useStore((s) => s.setBottomTab)
  const pending = usePendingOperations()
  const changeSet = useStore((s) => s.changeSet)
  const logs = useStore((s) => s.logs)
  const [collapsed, setCollapsed] = useState(false)
  const selectedModuleId = useStore((s) => s.selectedModuleId)
  const selectedOperationId = useStore((s) => s.selectedOperationId)
  const selectedFile = useStore((s) => s.selectedFile)

  useEffect(() => { setCollapsed(false) }, [tab, selectedModuleId, selectedOperationId, selectedFile])

  const problems = logs.filter((l) => l.level === 'error').length

  return (
    <div className={collapsed ? 'bottom is-collapsed' : 'bottom'}>
      <div className="tabs">
        <button className={tab === 'preview' ? 'tab is-active' : 'tab'} aria-pressed={tab === 'preview'} onClick={() => { setTab('preview'); setCollapsed(false) }}>Change preview</button>
        <button className={tab === 'module' ? 'tab is-active' : 'tab'} aria-pressed={tab === 'module'} onClick={() => { setTab('module'); setCollapsed(false) }}>Module details</button>
        <button
          className={tab === 'activity' ? 'tab is-active' : 'tab'}
          aria-pressed={tab === 'activity'}
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
          aria-pressed={tab === 'changes'}
          onClick={() => {
            setTab('changes')
            setCollapsed(false)
          }}
        >
          Plan
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
          aria-pressed={tab === 'results'}
          onClick={() => {
            setTab('results')
            setCollapsed(false)
          }}
        >
          Results
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
          aria-label={collapsed ? 'Expand review panel' : 'Collapse review panel'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="bottom-body">
          {tab === 'preview' ? preview : null}
          {tab === 'module' ? moduleDetails : null}
          {tab === 'activity' ? <ActivityTab /> : null}
          {tab === 'changes' ? <ChangesTab /> : null}
          {tab === 'results' ? <ResultsTab /> : null}
        </div>
      )}
    </div>
  )
}
