/**
 * The activity log: every backend and UI event, filterable by channel.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useStore } from '../../state/store'
import { Empty, formatTime } from '../../ui'
import { CHANNEL_LABELS } from './labels'

export function ActivityTab(): JSX.Element {
  const logs = useStore((s) => s.logs)
  const clearLogs = useStore((s) => s.clearLogs)
  const [showDebug, setShowDebug] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  const visible = useMemo(
    () => (showDebug ? logs : logs.filter((l) => l.level !== 'debug')),
    [logs, showDebug]
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [visible.length])

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px 6px'
        }}
      >
        <label className="checkbox" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={showDebug}
            onChange={(event) => setShowDebug(event.target.checked)}
          />
          <span className="checkbox-text">Show detail</span>
        </label>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn btn--ghost btn--sm" onClick={clearLogs}>
          Clear
        </button>
      </div>
      {visible.length === 0 ? (
        <Empty>Nothing has run yet.</Empty>
      ) : (
        <div>
          {visible.map((log) => (
            <div key={log.id} className={`log-line level-${log.level}`}>
              <span className="log-time">{formatTime(log.at)}</span>
              <span className="log-chan">{CHANNEL_LABELS[log.channel]}</span>
              <span className="log-msg">
                {log.message}
                {log.detail ? (
                  <span className="log-detail">{`  ${log.detail}`}</span>
                ) : null}
              </span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </>
  )
}
