/**
 * The application shell.
 *
 * Wires the pending edits, architecture map and review panel together, installs
 * keyboard and menu commands, and surfaces errors and notices above the map.
 */

import { useEffect } from 'react'

import { BottomPanel } from './components/BottomPanel'
import { Dialogs } from './components/dialogs'
import { GraphCanvas } from './components/GraphCanvas'
import { ReviewSidebar } from './components/ReviewDesk'
import { StatusBar, Toolbar } from './components/Toolbar'
import { Banner } from './components/common'
import { useStore } from './state/store'

/** Menu command -> store action. Registered once, on mount. */
function useMenuCommands(): void {
  const openProject = useStore((s) => s.openProject)
  const saveDocument = useStore((s) => s.saveDocument)
  const analyze = useStore((s) => s.analyze)
  const relayout = useStore((s) => s.relayout)
  const openDialog = useStore((s) => s.openDialog)
  const plan = useStore((s) => s.plan)
  const settings = useStore((s) => s.settings)

  useEffect(() => {
    const commands: Record<string, () => void> = {
      'menu:open-project': () => void openProject(),
      'menu:save-graph': () => void saveDocument(),
      'menu:analyze': () => void analyze(),
      'menu:add-module': () => openDialog('add-module'),
      'menu:relayout': () => relayout(),
      'menu:generate': () => void plan(settings?.hasApiKey === true),
      'menu:settings': () => openDialog('settings')
    }

    const listeners = Object.entries(commands).map(([event, handler]) => {
      const wrapped = (): void => handler()
      window.addEventListener(event, wrapped)
      return () => window.removeEventListener(event, wrapped)
    })
    return () => {
      for (const off of listeners) off()
    }
  }, [openProject, saveDocument, analyze, relayout, openDialog, plan, settings])
}

export function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const error = useStore((s) => s.error)
  const notice = useStore((s) => s.notice)
  const setError = useStore((s) => s.setError)
  const setNotice = useStore((s) => s.setNotice)
  const graph = useStore((s) => s.desired)
  const deskMode = useStore((s) => s.deskMode)
  const busy = useStore((s) => s.busy)
  const openDialog = useStore((s) => s.openDialog)
  const analyze = useStore((s) => s.analyze)
  const relayout = useStore((s) => s.relayout)

  useEffect(() => {
    void init()
  }, [init])

  useMenuCommands()

  return (
    <div className={`app review-desk mode-${deskMode}`}>
      <Toolbar />

      <div className="workspace">
        <ReviewSidebar />

        <main className="pane pane--center">
          {error || notice ? (
            <div style={{ padding: '10px 12px 0' }}>
              {error ? (
                <Banner kind="error" onClose={() => setError(null)}>
                  {error}
                </Banner>
              ) : null}
              {notice ? (
                <Banner kind="ok" onClose={() => setNotice(null)}>
                  {notice}
                </Banner>
              ) : null}
            </div>
          ) : null}
          <div className="desk-heading">
            <div>
              <div className="eyebrow">YOUR ARCHITECTURE, IN REVIEW</div>
              <h1>{graph ? 'Shape the change. Review the impact.' : 'A clearer view of your codebase.'}</h1>
              <p>{graph ? 'Edit the map, inspect each change, then generate a source plan.' : 'Open a TypeScript or JavaScript project to get started.'}</p>
            </div>
            <span className="desk-label">Review desk</span>
          </div>
          <section className="map-panel" aria-label="Architecture map">
            <div className="map-heading">
              <strong>Architecture map</strong>
              <span className="dim map-count">{graph ? `${graph.modules.length} modules · ${graph.edges.length} connections` : 'No project open'}</span>
              <div className="spacer" />
              <button className="btn btn--ghost btn--sm" disabled={!graph || busy !== 'idle'} onClick={() => void analyze()} title="Re-read the source. Unapplied edits will require confirmation.">Analyze</button>
              <button className="btn btn--ghost btn--sm" disabled={!graph} onClick={relayout}>Auto Layout</button>
              <button className="btn btn--sm" disabled={!graph || busy !== 'idle'} onClick={() => openDialog('add-module')}>Add Module</button>
            </div>
            <GraphCanvas />
          </section>
          <BottomPanel />
        </main>
      </div>
      <StatusBar />
      <Dialogs />
    </div>
  )
}
