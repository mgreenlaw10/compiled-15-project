/**
 * The application shell.
 *
 * Wires the pending edits, architecture map and review panel together, installs
 * keyboard and menu commands, and surfaces errors and notices above the map.
 */

import { useEffect } from 'react'
import { supportedLanguagesSentence } from '../../shared/languages'

import { BottomPanel } from '../features/bottom-panel'
import { Dialogs } from '../features/dialogs'
import { GraphCanvas } from '../features/canvas'
import { ReviewPreview, ReviewSidebar } from '../features/review'
import { StatusBar, Toolbar } from '../features/toolbar'
import { Banner } from '../ui'
import { useStore } from '../state/store'

import { Inspector } from '../features/inspector'
import { LeftSidebar } from '../features/sidebar'
import { useCommands } from './commands'

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

  useCommands()

  return (
    <div className={`app review-desk mode-${deskMode}`}>
      <Toolbar />

      <div className="workspace">
        <ReviewSidebar projectContent={<LeftSidebar />} />

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
              <p>{graph ? 'Edit the map, inspect each change, then generate a source plan.' : `Open a project using ${supportedLanguagesSentence()} to get started.`}</p>
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
          <BottomPanel preview={<ReviewPreview />} moduleDetails={<Inspector />} />
        </main>
      </div>
      <StatusBar />
      <Dialogs />
    </div>
  )
}
