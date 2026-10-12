/**
 * A module-graph arrow that leaves and enters whichever sides are nearest.
 *
 * React Flow normally pins an edge to the handle it was created from. This
 * edge ignores those coordinates and reads both modules' live position and
 * measured size instead, then picks the shortest side pairing with
 * `pickSides`. Because the node internals update on every frame of a drag,
 * arrows swing round to the best side while a module is being moved, not only
 * once it is dropped.
 *
 * Two shapes, chosen from the edge's data rather than its type so that the
 * shared edge projection in `module-edges.ts` stays unchanged:
 *
 *   - overview arrows (one per module pair) draw a plain bezier;
 *   - detail arrows (one per dependency kind, shown for the selected module)
 *     and self-loops reuse the fanned curve from `DependencyDetailEdge`, so
 *     parallel arrows still separate.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
  type InternalNode
} from '@xyflow/react'

import { detailEdgeGeometry } from './DependencyDetailEdge'
import { pickSides, selfLoopSides, type Rect, type SidePair } from './edge-sides'

/** A node's on-canvas rectangle, or `null` before React Flow has measured it. */
function rectOf(node: InternalNode | undefined): Rect | null {
  const width = node?.measured?.width
  const height = node?.measured?.height
  if (!node || !width || !height) return null
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height
  }
}

export function FloatingEdge(props: EdgeProps): JSX.Element {
  const sourceNode = useInternalNode(props.source)
  const targetNode = useInternalNode(props.target)
  const sourceRect = rectOf(sourceNode)
  const targetRect = rectOf(targetNode)
  const selfLoop = props.source === props.target

  // Until both ends are measured — the first frame after a node mounts —
  // fall back to the handle coordinates React Flow already computed, so the
  // arrow is drawn somewhere sensible rather than briefly missing.
  const sides: SidePair =
    sourceRect && targetRect
      ? selfLoop
        ? selfLoopSides(sourceRect)
        : pickSides(sourceRect, targetRect)
      : {
          source: { x: props.sourceX, y: props.sourceY, position: props.sourcePosition },
          target: { x: props.targetX, y: props.targetY, position: props.targetPosition }
        }

  const { source, target } = sides
  const overview = props.data?.overview === true && !selfLoop

  let path: string
  let labelX: number
  let labelY: number
  if (overview) {
    ;[path, labelX, labelY] = getBezierPath({
      sourceX: source.x,
      sourceY: source.y,
      sourcePosition: source.position,
      targetX: target.x,
      targetY: target.y,
      targetPosition: target.position
    })
  } else {
    const offset = typeof props.data?.offset === 'number' ? props.data.offset : 0
    ;({ path, labelX, labelY } = detailEdgeGeometry(
      source.x, source.y, source.position,
      target.x, target.y, target.position,
      offset
    ))
  }

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={props.interactionWidth}
      />
      {props.label ? (
        <EdgeLabelRenderer>
          <div
            className="dependency-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {props.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
