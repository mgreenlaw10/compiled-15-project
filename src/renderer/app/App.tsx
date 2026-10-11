import { useEffect, useRef, useState } from 'react'
import './mockup.css'

type Module = { id: string; name: string; path: string; files: string[] }
type Change = { file: string; from: string; to: string }
const initial: Module[] = [
  {
    id: 'api',
    name: 'API',
    path: 'src/api',
    files: ['routes.ts', 'server.ts'],
  },
  {
    id: 'auth',
    name: 'Auth',
    path: 'src/auth',
    files: ['login.ts', 'middleware.ts', 'index.ts'],
  },
  {
    id: 'sessions',
    name: 'Sessions',
    path: 'src/sessions',
    files: ['session.ts'],
  },
  {
    id: 'payments',
    name: 'Payments',
    path: 'src/payments',
    files: ['checkout.ts', 'stripe.ts'],
  },
  {
    id: 'db',
    name: 'Database',
    path: 'src/db',
    files: ['client.ts', 'queries.ts'],
  },
  {
    id: 'utils',
    name: 'Utils',
    path: 'src/utils',
    files: ['logger.ts', 'env.ts'],
  },
  {
    id: 'types',
    name: 'Types',
    path: 'src/types',
    files: ['context.ts', 'index.ts'],
  },
]
const links = [
  ['api', 'auth'],
  ['api', 'payments'],
  ['api', 'sessions'],
  ['auth', 'sessions'],
  ['auth', 'db'],
  ['payments', 'db'],
  ['payments', 'sessions'],
  ['sessions', 'db'],
  ['db', 'utils'],
  ['auth', 'types'],
  ['payments', 'types'],
]
const positions = [
  [14, 43],
  [40, 22],
  [40, 62],
  [70, 22],
  [70, 62],
  [88, 81],
  [14, 81],
]
const fileCode = (file: string) =>
  file === 'session.ts'
    ? [
        "import { db } from '../db/client'",
        "import type { Context } from '../types/context'",
        '',
        'export async function createSession(ctx: Context) {',
        '  const session = await db.sessions.create({',
        '    userId: ctx.user.id,',
        '    expiresAt: Date.now() + 86_400_000,',
        '  })',
        '',
        '  return session',
        '}',
      ]
    : [
        "import { createSession } from '../sessions/session'",
        "import type { Context } from '../types/context'",
        '',
        'export async function handle(ctx: Context) {',
        '  const session = await createSession(ctx)',
        '',
        '  return {',
        '    ok: true,',
        '    session,',
        '  }',
        '}',
      ]

export function App(): JSX.Element {
  const [modules, setModules] = useState(initial)
  const [selected, setSelected] = useState('auth')
  const [file, setFile] = useState('login.ts')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'map' | 'changes'>('map')
  const [changes, setChanges] = useState<Change[]>([
    { file: 'session.ts', from: 'auth', to: 'sessions' },
  ])
  const [activeChange, setActiveChange] = useState(0)
  const [modal, setModal] = useState<'add' | 'plan' | null>(null)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [zoom, setZoom] = useState(1)
  const [compact, setCompact] = useState(
    () => window.matchMedia('(max-width: 760px)').matches,
  )
  const graphPositions =
    modules.length > 7
      ? modules.map((_, i) =>
          compact
            ? [i % 2 ? 80 : 20, 15 + Math.floor(i / 2) * 20]
            : [18 + (i % 3) * 32, 20 + Math.floor(i / 3) * 23],
        )
      : compact
        ? [
            [20, 40],
            [20, 17],
            [80, 40],
            [80, 17],
            [80, 63],
            [50, 80],
            [20, 63],
          ]
        : positions
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = () => setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const search = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const current = modules.find((m) => m.id === selected) ?? modules[0]
  const visible = modules.filter((m) =>
    `${m.name} ${m.path} ${m.files.join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const change = changes[activeChange] ?? changes[0]
  const select = (id: string) => {
    setSelected(id)
    setFile(modules.find((m) => m.id === id)?.files[0] ?? '')
    setMessage('')
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        search.current?.focus()
      }
      if (event.key === 'Escape') {
        setModal(null)
        setQuery('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (modal) dialog.current?.showModal()
    else dialog.current?.close()
  }, [modal])
  function move(target: string) {
    if (target === selected || !file) return
    setModules((prev) =>
      prev.map((m) =>
        m.id === selected
          ? { ...m, files: m.files.filter((f) => f !== file) }
          : m.id === target
            ? { ...m, files: [...m.files, file] }
            : m,
      ),
    )
    setChanges((prev) => [...prev, { file, from: selected, to: target }])
    setSelected(target)
    setMessage(`${file} moved to ${modules.find((m) => m.id === target)?.name}`)
  }
  function undo() {
    const last = changes.at(-1)
    if (!last) return
    setModules((prev) =>
      prev.map((m) =>
        m.id === last.to
          ? { ...m, files: m.files.filter((f) => f !== last.file) }
          : m.id === last.from
            ? { ...m, files: [...m.files, last.file] }
            : m,
      ),
    )
    setChanges((prev) => prev.slice(0, -1))
    setActiveChange(0)
    setMessage('Last move undone')
  }
  function add() {
    const trimmed = name.trim()
    const id = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    if (!id || modules.some((m) => m.id === id)) {
      setMessage('Use a unique module name')
      return
    }
    setModules((prev) => [
      ...prev,
      { id, name: trimmed, path: `src/${id}`, files: [] },
    ])
    setSelected(id)
    setFile('')
    setName('')
    setModal(null)
    setMessage(`${trimmed} added`)
  }
  const primary = (
    <button
      className="primary"
      disabled={!changes.length}
      onClick={() => setModal('plan')}
    >
      Preview plan <span aria-hidden="true">↗</span>
    </button>
  )
  const tabs = (
    <nav className="view-tabs" aria-label="Workspace view">
      <button
        aria-current={view === 'map' ? 'page' : undefined}
        onClick={() => setView('map')}
      >
        Architecture
      </button>
      <button
        aria-current={view === 'changes' ? 'page' : undefined}
        onClick={() => setView('changes')}
      >
        Changes <span className="count">{changes.length}</span>
      </button>
    </nav>
  )
  const searchBox = (
    <label className="search">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m13 13 4 4" />
      </svg>
      <input
        ref={search}
        aria-label="Search modules"
        placeholder="Find a module"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <kbd>⌘ K</kbd>
    </label>
  )
  const moduleList = (
    <div className="module-list">
      {visible.length ? (
        visible.map((m) => (
          <button
            key={m.id}
            aria-pressed={selected === m.id}
            className={selected === m.id ? 'selected' : ''}
            onClick={() => select(m.id)}
          >
            <span className="module-symbol" aria-hidden="true">
              ▧
            </span>
            <span>{m.name}</span>
            <small>{m.files.length}</small>
          </button>
        ))
      ) : (
        <p className="empty">No matching modules</p>
      )}
    </div>
  )
  const details = (
    <aside className="details" aria-label="Module details">
      <div className="detail-title">
        <span className="module-symbol" aria-hidden="true">
          ▧
        </span>
        <h2>{current.name}</h2>
      </div>
      <p className="mono muted">{current.path}</p>
      <div className="detail-section">
        <h3>
          Files <span>{current.files.length}</span>
        </h3>
        {current.files.map((f) => (
          <button
            className={`file-row ${file === f ? 'active-file' : ''}`}
            key={f}
            onClick={() => setFile(f)}
          >
            <span className="file-type">TS</span>
            {f}
            <span className="arrow" aria-hidden="true">
              ↗
            </span>
          </button>
        ))}
        {!current.files.length && <p className="empty">No files yet</p>}
      </div>
      <div className="detail-section">
        <h3>Imports</h3>
        {links
          .filter(([from]) => from === current.id)
          .map(([, to]) => (
            <button
              className="dependency-row"
              key={to}
              onClick={() => select(to)}
            >
              {modules.find((m) => m.id === to)?.name}
              <span aria-hidden="true">→</span>
            </button>
          ))}
        {!links.some(([from]) => from === current.id) && (
          <p className="empty">No dependencies</p>
        )}
      </div>
      {file && (
        <label className="move-control">
          Move {file}
          <select
            aria-label="Move file to module"
            value={selected}
            onChange={(e) => move(e.target.value)}
          >
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </aside>
  )
  const graph = (
    <section className="graph" aria-label="Architecture map">
      <div className="canvas-top">
        <span>
          shop-api <span className="muted">/ src</span>
        </span>
        <button className="quiet" onClick={() => setModal('add')}>
          + Module
        </button>
      </div>
      <div className="graph-world" style={{ transform: `scale(${zoom})` }}>
        <svg
          className="connections"
          viewBox="0 0 1000 650"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {links.map(([from, to]) => {
            const a = graphPositions[modules.findIndex((m) => m.id === from)],
              b = graphPositions[modules.findIndex((m) => m.id === to)]
            if (!a || !b) return null
            return (
              <path
                key={from + to}
                className={
                  selected === from || selected === to ? 'connected' : ''
                }
                d={`M ${a[0] * 10} ${a[1] * 6.5} C ${a[0] * 10 + 90} ${a[1] * 6.5}, ${b[0] * 10 - 90} ${b[1] * 6.5}, ${b[0] * 10} ${b[1] * 6.5}`}
              />
            )
          })}
        </svg>
        {modules.map((m, i) => {
          const p = graphPositions[i] ?? [20 + (i % 4) * 22, 10]
          return (
            <button
              key={m.id}
              aria-pressed={selected === m.id}
              className={`graph-node ${selected === m.id ? 'node-selected' : ''} ${m.id === 'sessions' && changes.length ? 'node-changed' : ''} ${query && !visible.includes(m) ? 'node-filtered' : ''}`}
              style={{ left: `${p[0]}%`, top: `${p[1]}%` }}
              onClick={() => select(m.id)}
            >
              <span className="node-top">
                <span className="node-icon" aria-hidden="true">
                  ▧
                </span>
                {m.name}
                {m.id === 'sessions' && changes.length > 0 && (
                  <i aria-label="Changed" />
                )}
              </span>
              <span className="node-path">{m.path}</span>
              <span className="node-bottom">{m.files.length} files</span>
            </button>
          )
        })}
      </div>
      <div className="canvas-bottom">
        <span>
          <i className="status-dot" /> {modules.length} modules{' '}
          <span className="muted">· {links.length} imports</span>
        </span>
        <div className="zoom">
          <button
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.6, z - 0.1))}
          >
            −
          </button>
          <button aria-label="Reset zoom" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(1.3, z + 0.1))}
          >
            +
          </button>
        </div>
      </div>
    </section>
  )
  const changeList = (
    <aside className="change-list">
      <div className="section-title">
        <h3>Pending changes</h3>
        <span>{changes.length}</span>
      </div>
      {changes.map((c, i) => (
        <button
          className={i === activeChange ? 'active-change' : ''}
          key={i}
          onClick={() => {
            setActiveChange(i)
            setFile(c.file)
          }}
        >
          <span className="change-mark" aria-hidden="true">
            ↗
          </span>
          <span>
            <strong>{c.file}</strong>
            <small>
              {modules.find((m) => m.id === c.from)?.name} →{' '}
              {modules.find((m) => m.id === c.to)?.name}
            </small>
          </span>
        </button>
      ))}
      {!changes.length && <p className="empty">No pending changes</p>}
      <button className="undo quiet" disabled={!changes.length} onClick={undo}>
        Undo last move <span aria-hidden="true">↶</span>
      </button>
    </aside>
  )
  const diff = (
    <section className="diff">
      <div className="diff-heading">
        <span className="mono">
          {change ? 'src/api/routes.ts' : 'No changes'}
        </span>
        <span className="diff-stats">{change ? '+1 −1' : ''}</span>
      </div>
      {change ? (
        <>
          <div className="diff-labels">
            <span>
              Before{' '}
              <small>{modules.find((m) => m.id === change.from)?.path}</small>
            </span>
            <span>
              After{' '}
              <small>{modules.find((m) => m.id === change.to)?.path}</small>
            </span>
          </div>
          <div className="diff-columns">
            {['before', 'after'].map((side) => (
              <div className="code-pane" key={side}>
                {fileCode('routes.ts').map((line, i) => (
                  <div
                    className={`code-line ${i === 0 ? (side === 'before' ? 'removed' : 'added') : ''}`}
                    key={i}
                  >
                    <span className="line-number">{i + 1}</span>
                    <code>
                      {i === 0
                        ? `import { ${change.file === 'session.ts' ? 'createSession' : 'handle'} } from '../${side === 'before' ? modules.find((m) => m.id === change.from)?.id : modules.find((m) => m.id === change.to)?.id}/${change.file.replace(/\.ts$/, '')}'`
                        : line}
                    </code>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="diff-note">
            <span className="change-mark">↗</span>
            <span>
              Move {change.file} to{' '}
              {modules.find((m) => m.id === change.to)?.name}
            </span>
            <span className="muted">Import preview</span>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <h2>All clear.</h2>
          <p>Move a file to preview a change.</p>
          <button className="quiet" onClick={() => setView('map')}>
            Back to architecture →
          </button>
        </div>
      )}
    </section>
  )
  const source = (
    <section className="source-editor">
      <div className="diff-heading">
        <span className="mono">
          {current.path}/{file || 'index.ts'}
        </span>
        <span className="muted">TypeScript</span>
      </div>
      <div className="source-code">
        {file ? (
          fileCode(file).map((line, i) => (
            <div className="code-line" key={i}>
              <span className="line-number">{i + 1}</span>
              <code>{line}</code>
            </div>
          ))
        ) : (
          <p className="empty">Select a file to inspect it.</p>
        )}
      </div>
      <div className="source-bottom">
        <span className="muted">
          {current.files.length} files in {current.name}
        </span>
        <button className="quiet" onClick={() => setModal('add')}>
          + New module
        </button>
      </div>
    </section>
  )
  const footer = (
    <footer className="status">
      <span className="status-project">
        <i className="status-dot" /> shop-api{' '}
        <span className="muted">/ main</span>
      </span>
      <span role="status">
        {message ||
          `${changes.length} pending ${changes.length === 1 ? 'change' : 'changes'}`}
      </span>
      <span className="muted">Interactive mockup</span>
    </footer>
  )
  const modalView = (
    <dialog
      aria-labelledby="dialog-title"
      ref={dialog}
      onCancel={() => setModal(null)}
      onClick={(e) => {
        if (e.target === e.currentTarget) setModal(null)
      }}
    >
      <div className="modal-body">
        <div className="modal-header">
          <h2 id="dialog-title">
            {modal === 'add' ? 'New module' : 'Plan preview'}
          </h2>
          <button
            className="quiet"
            aria-label="Close dialog"
            onClick={() => setModal(null)}
          >
            ×
          </button>
        </div>
        {modal === 'add' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <label>
              Module name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Notifications"
                required
              />
            </label>
            <p className="muted">
              {message === 'Use a unique module name'
                ? message
                : 'Files can be moved here after creation.'}
            </p>
            <button className="primary" type="submit">
              Create module
            </button>
          </form>
        ) : (
          <>
            <p className="muted">
              {changes.length} file moves in this sample project.
            </p>
            {changes.map((c, i) => (
              <div className="plan-row" key={i}>
                <strong>{c.file}</strong>
                <span>
                  {modules.find((m) => m.id === c.from)?.name} →{' '}
                  {modules.find((m) => m.id === c.to)?.name}
                </span>
              </div>
            ))}
            <p className="prototype-note">
              Prototype only. No source files will be written.
            </p>
            <button
              className="primary"
              onClick={() => {
                setModal(null)
                setView('changes')
              }}
            >
              Review changes
            </button>
          </>
        )}
      </div>
    </dialog>
  )
  const panels = { tabs, moduleList, details, graph, changeList, diff, source }
  return (
    <div className="app atlas">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Cartograph">
          <Logo />
          Cartograph
        </a>
        <span className="breadcrumb">
          / <strong>shop-api</strong>
        </span>
        {tabs}
        <div className="header-end">
          {searchBox}
          {primary}
        </div>
      </header>
      <main className="atlas-layout">
        {view === 'map' ? (
          <>
            {panels.graph}
            {panels.details}
          </>
        ) : (
          <>
            {panels.changeList}
            {panels.diff}
          </>
        )}
      </main>
      {footer}
      {modalView}
    </div>
  )
}

function Logo(): JSX.Element {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h7v7H4zM13 13h7v7h-7zM14 4h6v6M4 14v6h6" />
      <path d="m11 7 6 6M7 11l6 6" />
    </svg>
  )
}
