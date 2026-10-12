/**
 * Geometry for detail arrows: the fanned curve drawn by `FloatingEdge` when a
 * node is selected and its dependencies are shown one arrow per kind.
 */

import { Position } from '@xyflow/react'

const direction = (position: Position): [number, number] => position === Position.Left ? [-1, 0] : position === Position.Right ? [1, 0] : position === Position.Top ? [0, -1] : [0, 1]

export interface DetailEdgeGeometry {
  path: string
  labelX: number
  labelY: number
}

/**
 * The fanned cubic used for detail arrows: control points leave each end
 * along its side's normal, then bend by `offset` so parallel dependencies
 * between the same two nodes separate instead of drawing on top of each other.
 */
export function detailEdgeGeometry(
  sourceX: number, sourceY: number, sourcePosition: Position,
  targetX: number, targetY: number, targetPosition: Position,
  offset: number
): DetailEdgeGeometry {
  const length = Math.hypot(targetX - sourceX, targetY - sourceY)
  const distance = Math.max(length * 0.45, 60)
  const bend = offset * 4 / 3
  let normalX = length ? -(targetY - sourceY) / length : 0
  let normalY = length ? (targetX - sourceX) / length : 1
  // Opposite directions must use the same side convention to avoid overlapping labels.
  if (normalY < 0 || normalY === 0 && normalX < 0) { normalX = -normalX; normalY = -normalY }
  const [sx, sy] = direction(sourcePosition)
  const [tx, ty] = direction(targetPosition)
  const cx1 = sourceX + sx * distance + normalX * bend
  const cy1 = sourceY + sy * distance + normalY * bend
  const cx2 = targetX + tx * distance + normalX * bend
  const cy2 = targetY + ty * distance + normalY * bend
  return {
    path: `M ${sourceX},${sourceY} C ${cx1},${cy1} ${cx2},${cy2} ${targetX},${targetY}`,
    labelX: (sourceX + 3 * cx1 + 3 * cx2 + targetX) / 8,
    labelY: (sourceY + 3 * cy1 + 3 * cy2 + targetY) / 8
  }
}
