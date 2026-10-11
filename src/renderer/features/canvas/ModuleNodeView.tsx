/**
 * The graph node.
 *
 * Shows the things you need to judge a module at a glance: its name, the
 * directory it maps to, how many files it owns, its dominant domain tags, and
 * how confident the analyzer is about the boundary. A dashed amber border means
 * "this module has an edit that has not reached the source code yet" — the
 * visual the brief asks for.
 *
 * The node is also a drop target: dragging a file onto it from the project
 * explorer or the inspector is one of the two ways to move a file between
 * modules.
 */

import { useState, type DragEvent } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

import type { ModuleNode } from '../../../shared/types/architecture'
import { Badge } from '../../ui'

export const FILE_DRAG_MIME = 'application/x-cartograph-file'

export interface FileDragPayload {
  file: string
  fromModuleId: string
}

export interface ModuleNodeData extends Record<string, unknown> {
  module: ModuleNode
  isSelected: boolean
  isPending: boolean
  expanded: boolean
  onToggleExpand: (id: string) => void
  onDropFile: (payload: FileDragPayload, targetModuleId: string) => void
}

function confidenceLabel(value: number): string {
  if (value >= 0.8) return 'high confidence'
  if (value >= 0.6) return 'moderate confidence'
  if (value >= 0.4) return 'low confidence'
  return 'very low confidence'
}

export function ModuleNodeView({
  data
}: NodeProps & { data: ModuleNodeData }): JSX.Element {
  const [isDropTarget, setIsDropTarget] = useState(false)
  const { module, isSelected, isPending, expanded } = data

  const classes = ['module-node']
  if (isSelected) classes.push('is-selected')
  if (isPending) classes.push('is-pending')
  if (isDropTarget) classes.push('is-drop-target')

  const acceptsDrag = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(FILE_DRAG_MIME)

  return (
    <div
      className={classes.join(' ')}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setIsDropTarget(true)
      }}
      onDragLeave={() => setIsDropTarget(false)}
      onDrop={(event) => {
        setIsDropTarget(false)
        if (!acceptsDrag(event)) return
        event.preventDefault()
        try {
          const payload = JSON.parse(
            event.dataTransfer.getData(FILE_DRAG_MIME)
          ) as FileDragPayload
          if (payload.file) data.onDropFile(payload, module.id)
        } catch {
          // A malformed payload is not worth surfacing; the drop just does
          // nothing, which is what the user will see anyway.
        }
      }}
    >
      <Handle type="target" position={Position.Left} />

      <div className="node-head">
        <span className="node-name" title={module.name}>
          {module.name}
        </span>
        {isPending ? (
          <Badge kind="pending" title="This module has changes not yet written to the source code">
            pending
          </Badge>
        ) : null}
        {module.origin === 'user' ? (
          <Badge kind="info" title="Created in the graph editor">
            new
          </Badge>
        ) : null}
        {module.metadata.confidenceBasis === 'ai' ? (
          <Badge kind="ai" title="Described by a language model">
            ai
          </Badge>
        ) : null}
        <button
          className="node-expand"
          title={expanded ? 'Hide files' : 'Show files'}
          onClick={(event) => {
            event.stopPropagation()
            data.onToggleExpand(module.id)
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>

      <div className="node-dir" title={module.directory ?? 'Not backed by a directory'}>
        {module.directory ?? '— no directory —'}
      </div>

      <div className="node-meta">
        <span title={`${module.files.length} file(s), ${module.metadata.loc} lines`}>
          {module.files.length}f · {module.metadata.loc}L
        </span>
        <span
          className="confidence"
          title={`${Math.round(module.metadata.confidence * 100)}% — ${confidenceLabel(
            module.metadata.confidence
          )} (${module.metadata.confidenceBasis})`}
        >
          <div style={{ width: `${Math.round(module.metadata.confidence * 100)}%` }} />
        </span>
        {module.metadata.tags[0] ? (
          <span className="faint">{module.metadata.tags[0]}</span>
        ) : null}
      </div>

      {expanded && module.files.length > 0 ? (
        <ul className="node-files">
          {module.files.map((file) => (
            <li key={file} title={file}>
              {file}
            </li>
          ))}
        </ul>
      ) : null}

      <Handle type="source" position={Position.Right} />
    </div>
  )
}
