/**
 * Arrow side selection: every arrow attaches to the pair of module sides that
 * makes it shortest.
 */

import { describe, expect, it } from 'vitest'
import { Position } from '@xyflow/react'

import {
  anchorOf,
  pickSides,
  selfLoopSides,
  type Rect
} from '../../src/renderer/features/canvas/edges/edge-sides'

const W = 240
const H = 112
const at = (x: number, y: number): Rect => ({ x, y, width: W, height: H })

function sides(source: Rect, target: Rect): [Position, Position] {
  const pair = pickSides(source, target)
  return [pair.source.position, pair.target.position]
}

describe('pickSides', () => {
  it('connects side-by-side modules right to left', () => {
    expect(sides(at(0, 0), at(400, 0))).toEqual([Position.Right, Position.Left])
  })

  it('connects left to right when the target is to the left', () => {
    expect(sides(at(400, 0), at(0, 0))).toEqual([Position.Left, Position.Right])
  })

  it('connects stacked modules bottom to top', () => {
    expect(sides(at(0, 0), at(0, 300))).toEqual([Position.Bottom, Position.Top])
  })

  it('connects top to bottom when the target is above', () => {
    expect(sides(at(0, 300), at(0, 0))).toEqual([Position.Top, Position.Bottom])
  })

  it('uses vertical sides for a mostly-vertical diagonal', () => {
    // Slightly offset horizontally, far apart vertically.
    expect(sides(at(0, 0), at(60, 500))).toEqual([Position.Bottom, Position.Top])
  })

  it('uses horizontal sides for a mostly-horizontal diagonal', () => {
    expect(sides(at(0, 0), at(600, 60))).toEqual([Position.Right, Position.Left])
  })

  it('returns the true minimum over all sixteen pairings', () => {
    const cases: [Rect, Rect][] = [
      [at(0, 0), at(300, 250)],
      [at(500, 40), at(0, 400)],
      [at(0, 0), at(260, -200)],
      [at(120, 600), at(0, 0)]
    ]
    const all = [Position.Top, Position.Right, Position.Bottom, Position.Left]
    for (const [source, target] of cases) {
      const chosen = pickSides(source, target)
      const chosenLength = Math.hypot(
        chosen.target.x - chosen.source.x,
        chosen.target.y - chosen.source.y
      )
      for (const s of all) {
        for (const t of all) {
          const a = anchorOf(source, s)
          const b = anchorOf(target, t)
          expect(chosenLength).toBeLessThanOrEqual(Math.hypot(b.x - a.x, b.y - a.y) + 1e-9)
        }
      }
    }
  })

  it('anchors at the midpoint of the chosen side', () => {
    const pair = pickSides(at(0, 0), at(400, 0))
    expect(pair.source).toMatchObject({ x: W, y: H / 2 })
    expect(pair.target).toMatchObject({ x: 400, y: H / 2 })
  })

  it('breaks an exact tie towards the horizontal side, following the reading direction', () => {
    // Equal squares on a perfect diagonal: right->top and bottom->left are
    // mirror images, so exactly equally short. The source side must come out
    // as Right, not Bottom.
    const source = { x: 0, y: 0, width: 100, height: 100 }
    const target = { x: 200, y: 200, width: 100, height: 100 }
    const length = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.hypot(b.x - a.x, b.y - a.y)

    const rightTop = length(anchorOf(source, Position.Right), anchorOf(target, Position.Top))
    const bottomLeft = length(anchorOf(source, Position.Bottom), anchorOf(target, Position.Left))
    expect(rightTop).toBeCloseTo(bottomLeft)

    const pair = pickSides(source, target)
    expect([pair.source.position, pair.target.position]).toEqual([Position.Right, Position.Top])
  })

  it('is stable: the same geometry always gives the same sides', () => {
    const a = at(37, 91)
    const b = at(512, 230)
    expect(pickSides(a, b)).toEqual(pickSides(a, b))
  })
})

describe('selfLoopSides', () => {
  it('leaves on the right and returns on the left so the loop can arc over', () => {
    const pair = selfLoopSides(at(0, 0))
    expect(pair.source.position).toBe(Position.Right)
    expect(pair.target.position).toBe(Position.Left)
  })
})
