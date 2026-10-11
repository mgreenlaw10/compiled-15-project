/**
 * The application shell.
 *
 * Wires the four regions of the IDE layout together, installs the keyboard and
 * menu commands, and surfaces errors and notices as banners over the canvas.
 */

import { useEffect } from 'react'

import { BottomPanel } from './components/BottomPanel'
import { Dialogs } from './components/dialogs'
import { GraphCanvas } from './components/GraphCanvas'
import { Inspector } from './components/Inspector'
import { LeftSidebar } from './components/LeftSidebar'
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

  useEffect(() => {
    void init()
  }, [init])

  useMenuCommands()

  return (
    <div className="app">
      <Toolbar />

      <div className={graph ? 'workspace' : 'workspace no-right'}>
        <LeftSidebar />

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
          <GraphCanvas />
        </main>

        {graph ? <Inspector /> : null}
      </div>

      <BottomPanel />
      <StatusBar />
      <Dialogs />
    </div>
  )
}
