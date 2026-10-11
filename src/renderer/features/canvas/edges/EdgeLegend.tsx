/**
 * The canvas legend.
 *
 * Rendered from `EDGE_LEGEND`, which is derived from the same table that draws
 * the arrows, so the swatches cannot disagree with the canvas. The one entry
 * not about edges — a module with a pending change — is appended here because
 * it is node styling rather than edge styling.
 */

import { EDGE_LEGEND, type LegendEntry } from './edge-style'

/** Legend entries for things that are not edges. */
const NODE_LEGEND: readonly LegendEntry[] = [
  { label: 'module with pending change', color: 'var(--warn)', dash: '5 4' }
]

function Swatch({ entry }: { entry: LegendEntry }): JSX.Element {
  return (
    <span
      className={entry.dash ? 'swatch dashed' : 'swatch'}
      style={{ borderTopColor: entry.color }}
    />
  )
}

export function EdgeLegend(): JSX.Element {
  return (
    <div className="canvas-legend">
      {[...EDGE_LEGEND, ...NODE_LEGEND].map((entry) => (
        <div key={`${entry.label}:${entry.color}`}>
          <Swatch entry={entry} />
          {entry.label}
        </div>
      ))}
    </div>
  )
}
