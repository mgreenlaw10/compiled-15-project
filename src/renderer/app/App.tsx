/**
 * The application shell.
 *
 * Wires the regions of the IDE layout together, installs the command handling,
 * and surfaces errors and notices as banners over the canvas. Everything it
 * renders comes from a feature folder, so a change to any one region does not
 * touch this file.
 */

import { useEffect } from 'react'

import { BottomPanel } from '../features/bottom-panel'
import { GraphCanvas } from '../features/canvas'
import { Dialogs } from '../features/dialogs'
import { Inspector } from '../features/inspector'
import { LeftSidebar } from '../features/sidebar'
import { StatusBar, Toolbar } from '../features/toolbar'
import { useStore } from '../state/store'
import { Banner } from '../ui'
import { useCommands } from './commands'

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

  useCommands()

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
