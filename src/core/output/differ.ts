/**
 * Unified diffs for the change preview.
 *
 * The preview the user approves is generated from the same `ChangeSet` the
 * writer consumes, so what is shown and what is written cannot drift.
 */

import { createTwoFilesPatch } from 'diff'

import type { ChangeSet, FileChange } from '../../shared/types/generation'
import type { DiffPreview } from '../../shared/ipc'

/** Rough upper bound so a huge generated file cannot lock up the UI. */
const MAX_DIFF_CHARS = 200_000

function labelFor(change: FileChange): { from: string; to: string } {
  switch (change.kind) {
    case 'create':
      return { from: '/dev/null', to: `b/${change.path}` }
    case 'delete':
      return { from: `a/${change.path}`, to: '/dev/null' }
    case 'rename':
      return { from: `a/${change.previousPath ?? change.path}`, to: `b/${change.path}` }
    case 'modify':
    default:
      return { from: `a/${change.path}`, to: `b/${change.path}` }
  }
}

export function diffForChange(change: FileChange): DiffPreview {
  const { from, to } = labelFor(change)
  const before = change.before ?? ''
  const after = change.after ?? ''

  if (before.length + after.length > MAX_DIFF_CHARS) {
    return {
      path: change.path,
      patch:
        `--- ${from}\n+++ ${to}\n` +
        `@@ diff suppressed @@\n` +
        ` This file is too large to diff in the preview (${before.length} -> ${after.length} characters).\n`,
      additions: 0,
      deletions: 0
    }
  }

  const patch = createTwoFilesPatch(from, to, before, after, '', '', {
    context: 3
  })

  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }

  return { path: change.path, patch, additions, deletions }
}

export function diffChangeSet(changeSet: ChangeSet): DiffPreview[] {
  return changeSet.changes.map(diffForChange)
}

/** A compact, human-readable summary of the whole change set. */
export function summarizeChangeSet(changeSet: ChangeSet): string {
  const counts = { create: 0, modify: 0, rename: 0, delete: 0 }
  for (const change of changeSet.changes) counts[change.kind] += 1
  const parts: string[] = []
  if (counts.create) parts.push(`${counts.create} created`)
  if (counts.modify) parts.push(`${counts.modify} modified`)
  if (counts.rename) parts.push(`${counts.rename} moved`)
  if (counts.delete) parts.push(`${counts.delete} deleted`)
  return parts.length > 0 ? parts.join(', ') : 'no file changes'
}
