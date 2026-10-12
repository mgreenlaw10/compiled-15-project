/**
 * The source-graph node.
 *
 * Program nodes carry one line: the thing's own name. A function is labelled
 * `withdraw`, a field `balance` — not the qualified name, the signature, the
 * visibility and the source location all stacked into the node. The kind is a
 * small marker rather than words, the tooltip carries the one-line detail, and
 * everything else (signature, parameters, callers, contracts, evidence) lives
 * in the right-hand inspector for the selected node.
 *
 * Drawn with the same frame as a top-level module node — panel background,
 * border, radius, padding, hover and selection — so drilling into a module
 * looks like the same canvas one level down. What a node *is* (function,
 * type, field, contract, file) is carried by a coloured accent on its leading
 * edge, matching the colours of the arrows that reach it.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'

export type ProgramNodeTone =
  | 'file'
  | 'function'
  | 'type'
  | 'field'
  | 'contract'
  | 'unresolved'

export interface ProgramNodeData extends Record<string, unknown> {
  label: string
  /** Short kind marker: `fn`, `field`, `class`, `file`, … */
  badge?: string
  /** One-line detail shown on hover; the inspector holds the full story. */
  detail?: string
  /** Which kind of thing this is, for the accent colour. */
  tone?: ProgramNodeTone
  /**
   * `true` for nodes outside the open module or file — a callee in another
   * module, an unresolved reference. Shown muted rather than dashed, because
   * a dashed border already means "pending change" on module nodes.
   */
  external?: boolean
}

export function ProgramNodeView({
  data,
  selected
}: NodeProps & { data: ProgramNodeData }): JSX.Element {
  const classes = ['pnode']
  if (data.tone) classes.push(`pnode--${data.tone}`)
  if (data.external) classes.push('is-external')
  if (selected) classes.push('is-selected')

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className={classes.join(' ')} title={data.detail ?? data.label}>
        {data.badge ? <span className="pnode-badge">{data.badge}</span> : null}
        <span className="pnode-name">{data.label}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  )
}
