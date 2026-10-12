/**
 * The activity log: every backend and UI event, filterable by channel.
 */

import { useEffect, useMemo, useRef } from 'react'

import { useStore } from '../../state/store'
import { Empty, formatTime } from '../../ui'
import { CHANNEL_LABELS } from './labels'

export function ActivityTab({
  showDebug
}: {
  /** Owned by the panel, because the toggle now lives in its tab bar. */
  showDebug: boolean
}): JSX.Element {
  const logs = useStore((s) => s.logs)
  const clearLogs = useStore((s) => s.clearLogs)
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
