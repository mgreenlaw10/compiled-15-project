/**
 * Which side of each module an arrow leaves from and arrives at.
 *
 * Every arrow considers all sixteen pairings of the source's four sides with
 * the target's four sides, anchored at each side's midpoint, and takes the
 * pair whose anchors are closest. That one rule produces the obvious choices
 * without special cases: modules side by side connect right-to-left, modules
 * stacked vertically connect bottom-to-top, and diagonal neighbours pick
 * whichever pair of facing sides is nearer.
 *
 * Pure and DOM-free so it can be tested directly, and cheap — sixteen
 * distance comparisons — because it runs for every arrow on every frame of a
 * drag.
 */

import { Position } from '@xyflow/react'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Anchor {
  x: number
  y: number
  position: Position
}

export interface SidePair {
  source: Anchor
  target: Anchor
}

/**
 * Side order doubles as the tie-break. Horizontal sides come first so that,
 * when two pairings are equally short, the arrow follows the graph's
 * left-to-right reading direction.
 */
const SIDES: readonly Position[] = [
  Position.Right,
  Position.Left,
  Position.Bottom,
  Position.Top
]

/** Midpoint of one side of a rectangle. */
export function anchorOf(rect: Rect, side: Position): Anchor {
  switch (side) {
    case Position.Left:
      return { x: rect.x, y: rect.y + rect.height / 2, position: side }
    case Position.Right:
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2, position: side }
    case Position.Top:
      return { x: rect.x + rect.width / 2, y: rect.y, position: side }
    default:
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height, position: Position.Bottom }
  }
}

/** The side pairing that makes the arrow between two modules shortest. */
export function pickSides(source: Rect, target: Rect): SidePair {
  let best: SidePair | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const sourceSide of SIDES) {
    const from = anchorOf(source, sourceSide)
    for (const targetSide of SIDES) {
      const to = anchorOf(target, targetSide)
      const distance = Math.hypot(to.x - from.x, to.y - from.y)
      // Strictly less: equal distances keep the earlier pairing, so the
      // choice is stable and never flickers between two equal options.
      if (distance < bestDistance) {
        bestDistance = distance
        best = { source: from, target: to }
      }
    }
  }

  // SIDES is non-empty, so a pairing is always found.
  return best!
}

/**
 * Sides for an arrow from a module to itself. Leaving the right side and
 * re-entering on the left gives the loop room to arc over the module, which
 * a shortest-pair rule cannot do: every side is closest to itself.
 */
export function selfLoopSides(rect: Rect): SidePair {
  return {
    source: anchorOf(rect, Position.Right),
    target: anchorOf(rect, Position.Left)
  }
}
