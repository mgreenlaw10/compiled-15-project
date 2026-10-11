/**
 * The canvas legend.
 *
 * Rendered from `EDGE_LEGEND`, which is derived from the same table that draws
 * the arrows, so the swatches cannot disagree with the canvas. The one entry
 * not about edges — a module with a pending change — is appended here because
 * it is node styling rather than edge styling.
 */

import { EDGE_LEGEND, type LegendEntry } from './edge-style'
import { OVERVIEW_EDGE_COLOR } from './module-edges'

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

export function EdgeLegend({ detailed = false }: { detailed?: boolean }): JSX.Element {
  return (
    <div className="canvas-legend">
      {[{ label: 'module dependency', color: OVERVIEW_EDGE_COLOR }, ...(detailed ? EDGE_LEGEND : [{ label: 'potential / user declared', color: OVERVIEW_EDGE_COLOR, dash: '5 4' }]), ...NODE_LEGEND].map((entry) => (
        <div key={`${entry.label}:${entry.color}`}>
          <Swatch entry={entry} />
          {entry.label}
        </div>
      ))}
      <p>{detailed ? 'Click the canvas to collapse details.' : 'Select a module to show dependency details.'}</p>
    </div>
  )
}
