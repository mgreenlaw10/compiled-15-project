/**
 * The source-graph node.
 *
 * Program nodes carry one line: the thing's own name. A function is labelled
 * `withdraw`, a field `balance` — not the qualified name, the signature, the
 * visibility and the source location all stacked into the node. The kind is a
 * small marker rather than words, the tooltip carries the one-line detail, and
 * everything else (signature, parameters, callers, contracts, evidence) lives
 * in the right-hand inspector for the selected node.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'

export interface ProgramNodeData extends Record<string, unknown> {
  label: string
  /** Short kind marker: `fn`, `field`, `class`, `file`, … */
  badge?: string
  /** One-line detail shown on hover; the inspector holds the full story. */
  detail?: string
}

export function ProgramNodeView({ data }: NodeProps & { data: ProgramNodeData }): JSX.Element {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className="pnode" title={data.detail ?? data.label}>
        {data.badge ? <span className="pnode-badge">{data.badge}</span> : null}
        <span className="pnode-name">{data.label}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  )
}
