/**
 * The virtual workspace.
 *
 * Every transformation runs against this, never against the real filesystem.
 * It is loaded with the project's current file contents, records creates,
 * edits, moves and deletes in memory, and can then hand back a `ChangeSet`
 * describing exactly what would happen.
 *
 * That single indirection is what makes the rest of the design possible:
 *
 *   - "Preview the diff" and "write the files" are the same code path, run with
 *     a different final step,
 *   - generating into a new directory and overwriting in place differ only in
 *     where the writer points,
 *   - an operation that fails half-way through cannot leave the project in a
 *     broken state, because nothing was written,
 *   - and the AI agent's `write_file` tool is handed this object, so a model
 *     literally cannot touch the user's disk.
 */

import type { FileChange } from '../../shared/types/generation'
import { normalizeRel } from '../../shared/util/paths'

interface FileState {
  /** Path in the original project, or `null` when the file is new. */
  originalPath: string | null
  content: string
  /** Original content, for diffing. `null` for new files. */
  originalContent: string | null
  reasons: string[]
  operationIds: Set<string>
}

interface DeletedState {
  originalContent: string
  reasons: string[]
  operationIds: Set<string>
}

export interface WriteOptions {
  reason: string
  operationId: string
}

export class VirtualWorkspace {
  /** Keyed by *current* project-relative POSIX path. */
  private readonly files = new Map<string, FileState>()
  /** Keyed by original path, for files removed from the project. */
  private readonly deleted = new Map<string, DeletedState>()
  /** Original path -> current path, for everything that moved. */
  private readonly moved = new Map<string, string>()

  constructor(
    readonly projectRoot: string,
    originalFiles: Iterable<[string, string]>
  ) {
    for (const [path, content] of originalFiles) {
      const key = normalizeRel(path)
      this.files.set(key, {
        originalPath: key,
        content,
        originalContent: content,
        reasons: [],
        operationIds: new Set()
      })
    }
  }

  /** Current project-relative paths, sorted. */
  listFiles(): string[] {
    return [...this.files.keys()].sort()
  }

  exists(path: string): boolean {
    return this.files.has(normalizeRel(path))
  }

  read(path: string): string | null {
    return this.files.get(normalizeRel(path))?.content ?? null
  }

  /** Where a file that started at `originalPath` lives now, if it still exists. */
  currentPathOf(originalPath: string): string | null {
    const key = normalizeRel(originalPath)
    if (this.files.has(key)) return key
    const movedTo = this.moved.get(key)
    if (movedTo && this.files.has(movedTo)) return movedTo
    return null
  }

  create(path: string, content: string, options: WriteOptions): void {
    const key = normalizeRel(path)
    if (this.files.has(key)) {
      throw new Error(`Cannot create ${key}: it already exists`)
    }
    this.files.set(key, {
      originalPath: null,
      content,
      originalContent: this.deleted.get(key)?.originalContent ?? null,
      reasons: [options.reason],
      operationIds: new Set([options.operationId])
    })
  }

  write(path: string, content: string, options: WriteOptions): void {
    const key = normalizeRel(path)
    const existing = this.files.get(key)
    if (!existing) {
      this.create(key, content, options)
      return
    }
    existing.content = content
    if (!existing.reasons.includes(options.reason)) {
      existing.reasons.push(options.reason)
    }
    existing.operationIds.add(options.operationId)
  }

  delete(path: string, options: WriteOptions): boolean {
    const key = normalizeRel(path)
    const existing = this.files.get(key)
    if (!existing) return false
    this.files.delete(key)
    if (existing.originalPath !== null && existing.originalContent !== null) {
      this.deleted.set(existing.originalPath, {
        originalContent: existing.originalContent,
        reasons: [...existing.reasons, options.reason],
        operationIds: new Set([...existing.operationIds, options.operationId])
      })
    }
    return true
  }

  /**
   * Moves a file. Content is carried over unchanged; rewriting the module
   * specifiers inside and around it is the caller's job (see `imports.ts`),
   * which keeps this class free of language knowledge.
   */
  move(from: string, to: string, options: WriteOptions): void {
    const fromKey = normalizeRel(from)
    const toKey = normalizeRel(to)
    if (fromKey === toKey) return
    const existing = this.files.get(fromKey)
    if (!existing) throw new Error(`Cannot move ${fromKey}: no such file`)
    if (this.files.has(toKey)) {
      throw new Error(`Cannot move ${fromKey} to ${toKey}: the target exists`)
    }

    this.files.delete(fromKey)
    existing.reasons.push(options.reason)
    existing.operationIds.add(options.operationId)
    this.files.set(toKey, existing)

    if (existing.originalPath !== null) {
      this.moved.set(existing.originalPath, toKey)
    }
  }

  /** Original path -> current path for every file that moved. */
  moveMap(): Map<string, string> {
    const map = new Map<string, string>()
    for (const [original, current] of this.moved) {
      if (this.files.has(current) && original !== current) {
        map.set(original, current)
      }
    }
    return map
  }

  /** `true` when nothing at all has changed. */
  get clean(): boolean {
    if (this.deleted.size > 0) return false
    for (const state of this.files.values()) {
      if (state.originalPath === null) return false
      if (state.content !== state.originalContent) return false
      if (this.moved.has(state.originalPath)) return false
    }
    return true
  }

  /**
   * The set of changes this workspace represents, as a stable, sorted list.
   * A file that both moved and was edited appears once, as a rename.
   */
  changes(): FileChange[] {
    const changes: FileChange[] = []

    for (const [path, state] of this.files) {
      const moved =
        state.originalPath !== null && state.originalPath !== path
      const edited = state.content !== state.originalContent

      if (state.originalPath === null) {
        changes.push({
          kind: 'create',
          path,
          before: null,
          after: state.content,
          operationIds: [...state.operationIds].sort(),
          reason: state.reasons.join('; ')
        })
        continue
      }

      if (moved) {
        changes.push({
          kind: 'rename',
          path,
          previousPath: state.originalPath,
          before: state.originalContent,
          after: state.content,
          operationIds: [...state.operationIds].sort(),
          reason: state.reasons.join('; ')
        })
        continue
      }

      if (edited) {
        changes.push({
          kind: 'modify',
          path,
          before: state.originalContent,
          after: state.content,
          operationIds: [...state.operationIds].sort(),
          reason: state.reasons.join('; ')
        })
      }
    }

    for (const [path, state] of this.deleted) {
      // A file that was deleted and then re-created at the same path shows up
      // in `files`, not here.
      if (this.files.has(path)) continue
      changes.push({
        kind: 'delete',
        path,
        previousPath: path,
        before: state.originalContent,
        after: null,
        operationIds: [...state.operationIds].sort(),
        reason: state.reasons.join('; ')
      })
    }

    return changes.sort(
      (a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind)
    )
  }
}
