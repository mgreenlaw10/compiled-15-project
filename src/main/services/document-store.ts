/**
 * Saving and loading the architecture document.
 *
 * The document lives inside the analyzed project, under `.cartograph/`, so that
 * the architecture travels with the code — commit it and a teammate opening the
 * project sees the same graph, the same edits, and the same layout. That is also
 * the seam a shared backend would replace: swap this file for a client of a
 * remote store and nothing else has to change.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  CARTOGRAPH_DIR,
  DOCUMENT_FILENAME,
  DOCUMENT_SCHEMA_VERSION,
  type ArchitectureDocument
} from '../../shared/types/project'
import { ARCHITECTURE_SCHEMA_VERSION } from '../../shared/types/architecture'

export function documentPath(projectRoot: string): string {
  return path.join(projectRoot, CARTOGRAPH_DIR, DOCUMENT_FILENAME)
}

export interface LoadProblem {
  reason: string
}

/**
 * Reads the saved document. Returns `null` when there is none, and throws only
 * when a document exists but cannot be used — the caller turns that into a
 * visible message rather than silently analyzing from scratch.
 */
export async function loadDocument(
  projectRoot: string
): Promise<ArchitectureDocument | null> {
  const file = documentPath(projectRoot)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }

  let parsed: ArchitectureDocument
  try {
    parsed = JSON.parse(raw) as ArchitectureDocument
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON (${(error as Error).message}). Delete it to start from a fresh analysis.`
    )
  }

  if (parsed.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new Error(
      `${file} was written by a different version of Cartograph (document schema ${parsed.schemaVersion}, this build reads ${DOCUMENT_SCHEMA_VERSION}).`
    )
  }
  if (
    parsed.original?.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION ||
    parsed.desired?.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION
  ) {
    throw new Error(
      `${file} holds an architecture in an unsupported format (expected schema ${ARCHITECTURE_SCHEMA_VERSION}).`
    )
  }
  if (!Array.isArray(parsed.operations) || !parsed.desired.modules) {
    throw new Error(`${file} is missing required fields.`)
  }

  // The project may have been moved or cloned elsewhere since it was saved.
  const normalizedRoot = path.resolve(projectRoot)
  if (path.resolve(parsed.projectRoot) !== normalizedRoot) {
    parsed.projectRoot = normalizedRoot
    parsed.original.projectRoot = normalizedRoot
    parsed.desired.projectRoot = normalizedRoot
  }

  return parsed
}

export async function saveDocument(
  document: ArchitectureDocument
): Promise<{ path: string }> {
  const file = documentPath(document.projectRoot)
  await fs.mkdir(path.dirname(file), { recursive: true })

  const payload: ArchitectureDocument = {
    ...document,
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    savedAt: new Date().toISOString()
  }

  // Write to a sibling file and rename, so an interrupted save cannot leave a
  // truncated document behind.
  const temp = `${file}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await fs.rm(file, { force: true })
  await fs.rename(temp, file)

  await ensureGitignore(document.projectRoot)
  return { path: file }
}

/**
 * Keeps backups out of version control while leaving the document itself
 * committable, since sharing the architecture is the point.
 */
async function ensureGitignore(projectRoot: string): Promise<void> {
  const file = path.join(projectRoot, CARTOGRAPH_DIR, '.gitignore')
  try {
    await fs.access(file)
    return
  } catch {
    // Not written yet.
  }
  await fs.writeFile(
    file,
    [
      '# Cartograph keeps per-machine artefacts here. The architecture document',
      '# itself is meant to be committed, so it is not ignored.',
      'backups/',
      '*.tmp',
      ''
    ].join('\n'),
    'utf8'
  )
}
