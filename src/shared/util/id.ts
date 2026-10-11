/**
 * Identifier helpers.
 *
 * Module ids are slugs derived from a name, because a readable id makes saved
 * documents and operation logs reviewable by hand. Uniqueness is enforced by
 * the caller through `uniqueId`.
 */

export function slugify(input: string): string {
  const slug = input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'module'
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  if (!set.has(base)) return base
  let i = 2
  while (set.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

/** Deterministic edge id so the same edge always gets the same id. */
export function edgeId(from: string, to: string, kind: string): string {
  return `${from}->${to}:${kind}`
}

let counter = 0

/**
 * Operation ids. Random enough to be unique across processes and collaborators,
 * cheap enough to call in a UI event handler.
 */
export function operationId(prefix = 'op'): string {
  counter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${rand}`
}

/** Turns `user-management` / `userManagement` into `User Management`. */
export function humanizeName(raw: string): string {
  const spaced = raw
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  if (spaced.length === 0) return raw
  return spaced
    .split(/\s+/)
    .map((word) =>
      /^[A-Z0-9]+$/.test(word) ? word : word[0].toUpperCase() + word.slice(1)
    )
    .join(' ')
}
