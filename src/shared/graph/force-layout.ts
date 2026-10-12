/**
 * Force-directed layout: the default auto-layout.
 *
 * A Fruchterman–Reingold style simulation. Every pair of modules repels, every
 * dependency pulls its two ends together, and a weak gravity keeps
 * disconnected modules from drifting off. The result spaces modules by how
 * they actually relate rather than by which layer they fall in, so clusters of
 * tightly coupled modules sit together and unrelated ones keep their distance.
 *
 * Three properties the rest of the app relies on, and how they are kept:
 *
 *   - **Deterministic.** The layout is saved into the project document and
 *     asserted in tests, so the same graph must always produce the same
 *     positions. There is no randomness: the simulation is seeded from the
 *     layered layout, runs a fixed number of iterations with a fixed cooling
 *     schedule, visits nodes in sorted id order, and separates coincident
 *     nodes with an offset derived from their indices.
 *   - **Readable direction.** A soft horizontal constraint keeps each module
 *     to the left of the modules it depends on, so the graph still reads left
 *     to right the way the layered layout did. Soft, because a dependency
 *     cycle cannot satisfy it; the simulation settles instead of fighting.
 *   - **No overlaps.** Forces act on centres, but nodes are wide rectangles.
 *     A final separation pass pushes apart any boxes that still overlap,
 *     along whichever axis needs the smaller move.
 *
 * The simulation runs in a *normalized* space where every node is a unit
 * square (x divided by node width, y by node height). That makes the physics
 * node-shaped for free: the same force spaces nodes about twice as far apart
 * horizontally as vertically, which is the shape of the boxes themselves.
 *
 * Cost is O(n² · iterations). Iterations are scaled down for large graphs so a
 * few hundred modules still lay out in well under a second, with no DOM and no
 * worker, which is what lets this run inside a plain Node test.
 */

import type { ArchitectureGraph, ModuleId, NodePosition } from '../types/architecture'
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  layeredLayout,
  type LayoutOptions
} from './layered-layout'

export interface ForceLayoutOptions extends LayoutOptions {
  /** Simulation steps. Defaults to a value scaled to the graph's size. */
  iterations?: number
  /** Ideal centre-to-centre edge length, in node units. */
  idealLength?: number
  /** Strength of the left-to-right dependency constraint. `0` disables it. */
  flowStrength?: number
  /** Pull towards the centroid, so disconnected modules stay in view. */
  gravity?: number
  /** Gap kept between neighbouring boxes after separation, in pixels. */
  paddingX?: number
  paddingY?: number
}

const DEFAULTS = {
  idealLength: 1.7,
  /**
   * Repulsion reach, as a multiple of the ideal length. Without a cutoff the
   * total push on each module grows with the number of modules while gravity
   * stays constant, so a dozen unrelated modules would spread dozens of node
   * widths apart. Beyond this distance modules ignore each other and gravity
   * compacts the layout; within it, repulsion holds them near `idealLength`.
   */
  repulsionReach: 3.5,
  flowStrength: 0.12,
  /** Desired horizontal centre gap between a module and its dependency. */
  flowGap: 1.45,
  gravity: 0.02,
  paddingX: 48,
  paddingY: 40,
  separationPasses: 400
} as const

/** Fewer steps on big graphs: the cost is quadratic per step. */
function defaultIterations(n: number): number {
  if (n <= 1) return 0
  return Math.max(120, Math.min(400, Math.round(48_000 / n)))
}

interface Body {
  id: ModuleId
  x: number
  y: number
  dx: number
  dy: number
}

interface Spring {
  a: number
  b: number
  /** Combined, log-damped import weight: heavy coupling pulls harder. */
  strength: number
}

/**
 * Deterministic tie-breaker for two bodies at the same point. Any fixed,
 * index-derived direction works; what matters is that it never changes.
 */
function separationDirection(i: number, j: number): { x: number; y: number } {
  const angle = ((i * 7919 + j * 104729) % 360) * (Math.PI / 180)
  return { x: Math.cos(angle) * 1e-3, y: Math.sin(angle) * 1e-3 }
}

/** Positions for every module, spaced by a force-directed simulation. */
export function forceDirectedLayout(
  graph: ArchitectureGraph,
  options: ForceLayoutOptions = {}
): Record<ModuleId, NodePosition> {
  const nodeWidth = options.nodeWidth ?? NODE_WIDTH
  const nodeHeight = options.nodeHeight ?? NODE_HEIGHT
  const ids = graph.modules.map((m) => m.id).sort()
  const n = ids.length

  if (n === 0) return {}
  if (n === 1) return { [ids[0]]: { x: 0, y: 0 } }

  const k = options.idealLength ?? DEFAULTS.idealLength
  const flowStrength = options.flowStrength ?? DEFAULTS.flowStrength
  const gravity = options.gravity ?? DEFAULTS.gravity
  const iterations = options.iterations ?? defaultIterations(n)

  // --- seed from the layered layout, in node units, by centre -------------
  const seed = layeredLayout(graph, options)
  const index = new Map(ids.map((id, i) => [id, i]))
  const bodies: Body[] = ids.map((id, i) => {
    const p = seed[id] ?? { x: 0, y: 0 }
    // The layered seed lines modules up exactly: every module with no
    // incoming edge shares one x, and every module in a row shares one y.
    // Bodies that start exactly colinear only ever feel forces along that
    // line — so a set of isolated modules spreads into one enormously tall
    // column, and two neighbours on a row can never move around each other.
    // Small offsets from two low-discrepancy sequences break the symmetry in
    // both axes without any randomness.
    const jitterX = ((i * 0.6180339887) % 1) - 0.5
    const jitterY = ((i * 0.4142135624) % 1) - 0.5
    return {
      id,
      x: (p.x + nodeWidth / 2) / nodeWidth + jitterX * 0.6,
      y: (p.y + nodeHeight / 2) / nodeHeight + jitterY * 0.6,
      dx: 0,
      dy: 0
    }
  })

  // --- springs: one per connected pair, weights combined ------------------
  const pairWeight = new Map<string, { a: number; b: number; weight: number }>()
  /** Directed pairs, for the left-to-right constraint. */
  const flows: { from: number; to: number }[] = []
  const seenFlow = new Set<string>()

  for (const edge of graph.edges) {
    const a = index.get(edge.from)
    const b = index.get(edge.to)
    if (a === undefined || b === undefined || a === b) continue

    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = `${lo}:${hi}`
    const existing = pairWeight.get(key)
    const weight = Math.max(1, edge.weight ?? 1)
    if (existing) existing.weight += weight
    else pairWeight.set(key, { a: lo, b: hi, weight })

    const flowKey = `${a}>${b}`
    if (!seenFlow.has(flowKey)) {
      seenFlow.add(flowKey)
      flows.push({ from: a, to: b })
    }
  }

  const springs: Spring[] = [...pairWeight.values()]
    .sort((p, q) => p.a - q.a || p.b - q.b)
    .map(({ a, b, weight }) => ({
      a,
      b,
      // Log-damped so a module importing fifty symbols does not collapse onto
      // its dependency, but still sits closer than one importing a single type.
      strength: Math.min(2.5, 1 + Math.log2(weight) * 0.25)
    }))

  // --- simulate -------------------------------------------------------------
  const reach = k * DEFAULTS.repulsionReach
  const reach2 = reach * reach
  // Cool enough from the first step that no body can move far enough in one
  // step to jump past a neighbour. Repulsion is a wall at short range; a body
  // that leaps over it lands on the wrong side and the wall then holds it
  // there, which is how a dependency ends up drawn to the left of its user.
  const startTemperature = k * 0.2
  const endTemperature = k * 0.01

  for (let step = 0; step < iterations; step += 1) {
    for (const body of bodies) {
      body.dx = 0
      body.dy = 0
    }

    // Repulsion between every pair within reach: k² / d, faded smoothly to
    // zero at the cutoff so there is no discontinuity for bodies to oscillate
    // across.
    for (let i = 0; i < n; i += 1) {
      const a = bodies[i]
      for (let j = i + 1; j < n; j += 1) {
        const b = bodies[j]
        let ux = a.x - b.x
        let uy = a.y - b.y
        let d2 = ux * ux + uy * uy
        if (d2 < 1e-9) {
          const offset = separationDirection(i, j)
          ux = offset.x
          uy = offset.y
          d2 = ux * ux + uy * uy
        }
        if (d2 > reach2) continue
        const d = Math.sqrt(d2)
        const fade = 1 - d / reach
        const force = ((k * k) / d) * fade * fade
        const fx = (ux / d) * force
        const fy = (uy / d) * force
        a.dx += fx
        a.dy += fy
        b.dx -= fx
        b.dy -= fy
      }
    }

    // Attraction along dependencies: d² / k, scaled by coupling.
    for (const spring of springs) {
      const a = bodies[spring.a]
      const b = bodies[spring.b]
      const ux = a.x - b.x
      const uy = a.y - b.y
      const d = Math.sqrt(ux * ux + uy * uy)
      if (d < 1e-9) continue
      const force = ((d * d) / k) * spring.strength
      const fx = (ux / d) * force
      const fy = (uy / d) * force
      a.dx -= fx
      a.dy -= fy
      b.dx += fx
      b.dy += fy
    }

    // Keep dependents to the left of their dependencies. Horizontal only, and
    // only when violated, so it orients the graph without flattening it.
    if (flowStrength > 0) {
      for (const flow of flows) {
        const from = bodies[flow.from]
        const to = bodies[flow.to]
        const shortfall = DEFAULTS.flowGap - (to.x - from.x)
        if (shortfall <= 0) continue
        const push = shortfall * flowStrength * k * 4
        from.dx -= push
        to.dx += push
      }
    }

    // Gravity towards the centroid.
    let cx = 0
    let cy = 0
    for (const body of bodies) {
      cx += body.x
      cy += body.y
    }
    cx /= n
    cy /= n
    for (const body of bodies) {
      body.dx -= (body.x - cx) * gravity * k
      body.dy -= (body.y - cy) * gravity * k
    }

    // Move, capped by a linearly cooling temperature.
    const progress = iterations <= 1 ? 1 : step / (iterations - 1)
    const temperature =
      startTemperature + (endTemperature - startTemperature) * progress
    for (const body of bodies) {
      const length = Math.sqrt(body.dx * body.dx + body.dy * body.dy)
      if (length < 1e-12) continue
      const scale = Math.min(length, temperature) / length
      body.x += body.dx * scale
      body.y += body.dy * scale
    }
  }

  separateOverlaps(bodies, {
    minX: 1 + (options.paddingX ?? DEFAULTS.paddingX) / nodeWidth,
    minY: 1 + (options.paddingY ?? DEFAULTS.paddingY) / nodeHeight
  })

  // --- back to pixels: top-left corners, anchored at the origin -------------
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const body of bodies) {
    minX = Math.min(minX, body.x)
    minY = Math.min(minY, body.y)
  }

  const positions: Record<ModuleId, NodePosition> = {}
  for (const body of bodies) {
    positions[body.id] = {
      x: Math.round((body.x - minX) * nodeWidth),
      y: Math.round((body.y - minY) * nodeHeight)
    }
  }
  return positions
}

/**
 * Pushes apart boxes that still overlap after the simulation.
 *
 * In node units every box is 1×1, so two boxes overlap when their centres are
 * closer than `minX` horizontally *and* `minY` vertically. Each overlapping
 * pair is separated along the axis needing the smaller move, split evenly
 * between the two, which disturbs the simulated arrangement as little as
 * possible. Repeated until clean or the pass limit is reached; a pass that
 * moves nothing ends it early.
 */
function separateOverlaps(
  bodies: Body[],
  gap: { minX: number; minY: number }
): void {
  for (let pass = 0; pass < DEFAULTS.separationPasses; pass += 1) {
    let moved = false
    for (let i = 0; i < bodies.length; i += 1) {
      const a = bodies[i]
      for (let j = i + 1; j < bodies.length; j += 1) {
        const b = bodies[j]
        const ux = b.x - a.x
        const uy = b.y - a.y
        const overlapX = gap.minX - Math.abs(ux)
        const overlapY = gap.minY - Math.abs(uy)
        if (overlapX <= 0 || overlapY <= 0) continue

        moved = true
        // Converted to a comparable scale: a unit of x is a node width, a unit
        // of y a node height, so compare the pixel-ish cost of each move.
        if (overlapX * NODE_WIDTH <= overlapY * NODE_HEIGHT) {
          const sign = ux > 0 || (ux === 0 && i < j) ? 1 : -1
          a.x -= (sign * overlapX) / 2
          b.x += (sign * overlapX) / 2
        } else {
          const sign = uy > 0 || (uy === 0 && i < j) ? 1 : -1
          a.y -= (sign * overlapY) / 2
          b.y += (sign * overlapY) / 2
        }
      }
    }
    if (!moved) return
  }
}
