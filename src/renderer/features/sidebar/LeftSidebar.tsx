/**
 * Left sidebar: what is open, what modules exist, and the files underneath.
 *
 * The explorer labels each source file with the module that owns it, which is
 * the clearest way to see the mapping the whole tool depends on. File rows are
 * draggable onto a graph node to move a file between modules.
 */

import { useMemo, useState, type ReactNode } from 'react'

import type { FileTreeNode } from '../../../shared/types/project'
import { moduleStats } from '../../../shared/graph/selectors'
import {
  DEFAULT_LEFT_PANE_WIDTH,
  useModulesWithPendingChanges,
  useStore
} from '../../state/store'
import { TeamSection } from '../collab'
import { Badge, Empty, plural, useDragSize } from '../../ui'
import { FILE_DRAG_MIME, type FileDragPayload } from '../canvas/ModuleNodeView'

function ProjectInfoSection(): JSX.Element {
  const project = useStore((s) => s.project)
  const reveal = (target: string): void => {
    void window.cartograph.revealInFolder(target)
  }

  if (!project) {
    return (
      <div className="pane-body">
        <p className="faint" style={{ margin: 0 }}>
          Open a project to begin. Nothing is written to disk until you ask for
          it.
        </p>
      </div>
    )
  }

  return (
    <div className="pane-body">
      <dl className="kv">
        <dt>Name</dt>
        <dd>{project.name}</dd>
        <dt>Path</dt>
        <dd>
          <button
            className="btn btn--ghost btn--sm"
            style={{ padding: 0, textAlign: 'left' }}
            title="Show in file manager"
            onClick={() => reveal(project.root)}
          >
            <span className="mono">{project.root}</span>
          </button>
        </dd>
      </dl>
    </div>
  )
}

function ModuleListSection(): JSX.Element {
  const graph = useStore((s) => s.desired)
  const selected = useStore((s) => s.selectedModuleId)
  const select = useStore((s) => s.select)
  const pending = useModulesWithPendingChanges()
  const [query, setQuery] = useState('')

  const modules = useMemo(() => {
    const all = graph?.modules ?? []
    const q = query.trim().toLowerCase()
    const filtered =
      q === ''
        ? all
        : all.filter(
            (m) =>
              m.name.toLowerCase().includes(q) ||
              (m.directory ?? '').toLowerCase().includes(q) ||
              m.metadata.tags.some((t) => t.includes(q))
          )
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
  }, [graph, query])

  if (!graph) return <Empty>No modules yet.</Empty>

  return (
    <>
      <div style={{ padding: '8px 12px 6px' }}>
        <input
          type="text"
          placeholder={`Filter ${plural(graph.modules.length, 'module')}…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="pane-body pane-body--flush" style={{ paddingTop: 0 }}>
        <div className="list">
          {modules.map((module) => {
            const stats = moduleStats(graph, module.id)
            return (
              <button
                key={module.id}
                className={
                  module.id === selected ? 'row is-selected' : 'row'
                }
                onClick={() => select(module.id)}
              >
                <span className="row-main">
                  <span className="row-title">{module.name}</span>
                  <span className="row-sub">
                    {plural(stats.fileCount, 'file')} · {stats.dependencyCount} out
                    · {stats.dependentCount} in
                  </span>
                </span>
                {pending.has(module.id) ? (
                  <Badge kind="pending">●</Badge>
                ) : null}
              </button>
            )
          })}
          {modules.length === 0 ? (
            <Empty>Nothing matches “{query}”.</Empty>
          ) : null}
        </div>
      </div>
    </>
  )
}

function TreeNode({
  node,
  depth,
  ownerOf,
  selectedFile,
  onSelect
}: {
  node: FileTreeNode
  depth: number
  ownerOf: Map<string, { id: string; name: string }>
  selectedFile: string | null
  onSelect: (path: string) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(depth < 2)

  if (node.type === 'directory') {
    const children = node.children ?? []
    if (children.length === 0) return null
    return (
      <div className="tree-node">
        <div
          className="tree-row"
          style={{ paddingLeft: 12 + depth * 12 }}
          onClick={() => setOpen(!open)}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          <span className="tree-label">{node.name}</span>
        </div>
        {open
          ? children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                ownerOf={ownerOf}
                selectedFile={selectedFile}
                onSelect={onSelect}
              />
            ))
          : null}
      </div>
    )
  }

  const owner = ownerOf.get(node.path)
  return (
    <div
      className={
        selectedFile === node.path ? 'tree-row is-selected' : 'tree-row'
      }
      style={{ paddingLeft: 12 + depth * 12 + 15 }}
      onClick={() => onSelect(node.path)}
      draggable={owner !== undefined}
      onDragStart={(event) => {
        if (!owner) return
        const payload: FileDragPayload = {
          file: node.path,
          fromModuleId: owner.id
        }
        event.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(payload))
        event.dataTransfer.effectAllowed = 'move'
      }}
      title={
        owner
          ? `${node.path} — in ${owner.name}. Drag onto a module to move it.`
          : `${node.path} — not analyzed`
      }
    >
      <span className="tree-label">{node.name}</span>
      {owner ? (
        <span className="tree-module">{owner.name}</span>
      ) : (
        <span className="tree-module faint">—</span>
      )}
    </div>
  )
}

function ExplorerSection(): JSX.Element {
  const tree = useStore((s) => s.fileTree)
  const graph = useStore((s) => s.desired)
  const selectedFile = useStore((s) => s.selectedFile)
  const selectFile = useStore((s) => s.selectFile)
  const select = useStore((s) => s.select)

  const ownerOf = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const module of graph?.modules ?? []) {
      for (const file of module.files) {
        map.set(file, { id: module.id, name: module.name })
      }
    }
    return map
  }, [graph])

  if (!tree) return <Empty>No files loaded.</Empty>

  return (
    <div className="pane-body pane-body--flush">
      {(tree.children ?? []).map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={0}
          ownerOf={ownerOf}
          selectedFile={selectedFile}
          onSelect={(path) => {
            selectFile(path)
            const owner = ownerOf.get(path)
            if (owner) select(owner.id)
          }}
        />
      ))}
    </div>
  )
}

/**
 * One accordion section.
 *
 * The header is the whole clickable target, so it carries no nested button —
 * a button inside a clickable row fights it for clicks, which is why the
 * project's "Open" control lives in the section body instead.
 */
function Section({
  title,
  open,
  onToggle,
  grow,
  children
}: {
  title: string
  open: boolean
  onToggle: () => void
  /** Expanded sections that should take the leftover height. */
  grow?: boolean
  children: ReactNode
}): JSX.Element {
  const classes = ['pane-section', 'pane-section--accordion']
  if (open && grow) classes.push('pane-section--grow')

  return (
    <div className={classes.join(' ')}>
      <button
        className="pane-header pane-header--toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="pane-caret">{open ? '▾' : '▸'}</span>
        <span className="pane-header-label">{title}</span>
      </button>
      {open ? children : null}
    </div>
  )
}

type SectionName = 'project' | 'team' | 'modules' | 'explorer'

export function LeftSidebar(): JSX.Element {
  const openProject = useStore((s) => s.openProject)
  const busy = useStore((s) => s.busy)
  const width = useStore((s) => s.leftPaneWidth)
  const setWidth = useStore((s) => s.setLeftPaneWidth)

  // Independently collapsible rather than one-at-a-time: these answer
  // different questions and people want more than one open at once. Team
  // starts closed because it is empty unless the project is collaborative.
  const [open, setOpen] = useState<Record<SectionName, boolean>>({
    project: true,
    team: false,
    modules: true,
    explorer: true
  })
  const toggle = (name: SectionName): void =>
    setOpen((current) => ({ ...current, [name]: !current[name] }))

  const resize = useDragSize({
    value: width,
    onChange: setWidth,
    min: 200,
    // Leave room for the canvas; the inspector has its own column.
    max: () => Math.max(200, Math.round(window.innerWidth * 0.5)),
    initial: DEFAULT_LEFT_PANE_WIDTH,
    from: 'end',
    axis: 'x'
  })

  return (
    <aside className={resize.resizing ? 'pane pane--left is-resizing' : 'pane pane--left'}>
      <div className="pane-scroll">
        <Section
          title="Project"
          open={open.project}
          onToggle={() => toggle('project')}
        >
          <div className="pane-section-actions">
            <button
              className="btn btn--sm"
              onClick={() => void openProject()}
              disabled={busy !== 'idle'}
            >
              Open…
            </button>
          </div>
          <ProjectInfoSection />
        </Section>

        <Section title="Team" open={open.team} onToggle={() => toggle('team')}>
          <TeamSection />
        </Section>

        <Section
          title="Modules"
          open={open.modules}
          onToggle={() => toggle('modules')}
          grow
        >
          <ModuleListSection />
        </Section>

        <Section
          title="Project explorer"
          open={open.explorer}
          onToggle={() => toggle('explorer')}
          grow
        >
          <ExplorerSection />
        </Section>
      </div>

      <div
        className="pane-resize-handle"
        aria-label="Resize the sidebar"
        aria-valuemax={Math.round(window.innerWidth * 0.5)}
        title="Drag to resize. Double-click to reset."
        {...resize.handleProps}
      />
    </aside>
  )
}
