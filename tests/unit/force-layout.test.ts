/**
 * Force-directed layout tests.
 *
 * Asserts the properties the rest of the app depends on rather than exact
 * coordinates, which would make every tuning change a test edit: the layout
 * is deterministic, no two boxes overlap, dependencies read left to right,
 * coupling pulls modules together, and degenerate graphs do not break it.
 */

import { describe, expect, it } from 'vitest'

import {
  NODE_HEIGHT,
  NODE_WIDTH,
  forceDirectedLayout,
  layeredLayout,
  layoutGraph
} from '../../src/shared/graph/layout'
import { createEdge, createGraph, createModule } from '../../src/shared/graph/model'
import type { ArchitectureGraph, NodePosition } from '../../src/shared/types/architecture'

function graphOf(
  ids: string[],
  edges: [string, string, number?][] = []
): ArchitectureGraph {
  return createGraph({
    projectRoot: '/tmp/project',
    name: 'demo',
    modules: ids.map((id) =>
      createModule({ id, name: id, directory: `src/${id}`, files: [], origin: 'analysis' })
    ),
    edges: edges.map(([from, to, weight]) =>
      createEdge({ from, to, weight: weight ?? 1, verified: true })
    )
  })
}

function overlaps(a: NodePosition, b: NodePosition): boolean {
  return (
    Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT
  )
}

function assertNoOverlaps(positions: Record<string, NodePosition>): void {
  const entries = Object.entries(positions)
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      expect(
        overlaps(entries[i][1], entries[j][1]),
        `${entries[i][0]} overlaps ${entries[j][0]}`
      ).toBe(false)
    }
  }
}

function centreDistance(a: NodePosition, b: NodePosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** A small, realistic architecture: two coupled clusters and a shared leaf. */
function realistic(): ArchitectureGraph {
  return graphOf(
    ['api', 'auth', 'session', 'billing', 'invoices', 'payments', 'db', 'logger'],
    [
      ['api', 'auth', 4],
      ['api', 'billing', 3],
      ['auth', 'session', 6],
      ['session', 'db', 2],
      ['billing', 'invoices', 5],
      ['billing', 'payments', 5],
      ['invoices', 'db', 2],
      ['payments', 'db', 2],
      ['auth', 'logger'],
      ['billing', 'logger']
    ]
  )
}

describe('force-directed layout', () => {
  it('is the default auto-layout', () => {
    const graph = realistic()
    expect(layoutGraph(graph)).toEqual(forceDirectedLayout(graph))
    expect(layoutGraph(graph, { algorithm: 'layered' })).toEqual(layeredLayout(graph))
  })

  it('places every module exactly once', () => {
    const graph = realistic()
    const positions = forceDirectedLayout(graph)
    expect(Object.keys(positions).sort()).toEqual(graph.modules.map((m) => m.id).sort())
    for (const p of Object.values(positions)) {
      expect(Number.isInteger(p.x)).toBe(true)
      expect(Number.isInteger(p.y)).toBe(true)
    }
  })

  it('is deterministic, including when modules arrive in a different order', () => {
    const graph = realistic()
    const shuffled: ArchitectureGraph = {
      ...graph,
      modules: [...graph.modules].reverse(),
      edges: [...graph.edges].reverse()
    }
    const first = forceDirectedLayout(graph)
    expect(forceDirectedLayout(graph)).toEqual(first)
    expect(forceDirectedLayout(shuffled)).toEqual(first)
  })

  it('never overlaps two modules', () => {
    assertNoOverlaps(forceDirectedLayout(realistic()))
  })

  it('anchors the layout at the origin', () => {
    const positions = Object.values(forceDirectedLayout(realistic()))
    expect(Math.min(...positions.map((p) => p.x))).toBe(0)
    expect(Math.min(...positions.map((p) => p.y))).toBe(0)
  })

  it('keeps dependencies reading left to right', () => {
    const positions = forceDirectedLayout(realistic())
    // Each module sits to the left of what it depends on.
    for (const [from, to] of [
      ['api', 'auth'],
      ['api', 'billing'],
      ['auth', 'session'],
      ['session', 'db'],
      ['billing', 'payments']
    ] as const) {
      expect(positions[from].x, `${from} should be left of ${to}`).toBeLessThan(
        positions[to].x
      )
    }
  })

  it('pulls heavily coupled modules closer than unrelated ones', () => {
    const positions = forceDirectedLayout(realistic())
    // auth↔session import heavily; auth and invoices share nothing directly.
    expect(centreDistance(positions.auth, positions.session)).toBeLessThan(
      centreDistance(positions.auth, positions.invoices)
    )
    expect(centreDistance(positions.billing, positions.payments)).toBeLessThan(
      centreDistance(positions.billing, positions.session)
    )
  })

  it('handles empty and single-module graphs', () => {
    expect(forceDirectedLayout(graphOf([]))).toEqual({})
    expect(forceDirectedLayout(graphOf(['only']))).toEqual({ only: { x: 0, y: 0 } })
  })

  it('settles a dependency cycle instead of fighting it', () => {
    const graph = graphOf(['a', 'b', 'c'], [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a']
    ])
    const positions = forceDirectedLayout(graph)
    expect(Object.keys(positions)).toHaveLength(3)
    for (const p of Object.values(positions)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    }
    assertNoOverlaps(positions)
  })

  it('keeps disconnected modules in view without stacking them', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`)
    const positions = forceDirectedLayout(graphOf(ids))
    assertNoOverlaps(positions)
    // Gravity holds them together: the spread stays bounded rather than
    // drifting arbitrarily far apart.
    const xs = Object.values(positions).map((p) => p.x)
    const ys = Object.values(positions).map((p) => p.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(NODE_WIDTH * 12)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(NODE_HEIGHT * 24)
  })

  it('ignores self-edges and edges to unknown modules', () => {
    const graph = graphOf(['a', 'b'], [
      ['a', 'a'],
      ['a', 'b']
    ])
    graph.edges.push(createEdge({ from: 'a', to: 'ghost', verified: true }))
    const positions = forceDirectedLayout(graph)
    expect(Object.keys(positions).sort()).toEqual(['a', 'b'])
    expect(positions.a.x).toBeLessThan(positions.b.x)
  })

  it('lays out a large graph quickly and cleanly', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `m${String(i).padStart(3, '0')}`)
    const edges: [string, string][] = []
    for (let i = 1; i < ids.length; i += 1) {
      // A loose tree plus some cross-links, roughly like a real codebase.
      edges.push([ids[Math.floor((i - 1) / 3)], ids[i]])
      if (i % 7 === 0) edges.push([ids[i], ids[(i * 13) % ids.length]])
    }
    const started = performance.now()
    const positions = forceDirectedLayout(graphOf(ids, edges))
    const elapsed = performance.now() - started

    expect(Object.keys(positions)).toHaveLength(200)
    assertNoOverlaps(positions)
    expect(elapsed).toBeLessThan(5_000)
  })
})
