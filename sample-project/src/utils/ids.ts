/** Identifier generation. Deliberately dependency-free. */

let counter = 0

/** Monotonic, collision-resistant id with a readable prefix. */
export function generateId(prefix: string): string {
  counter += 1
  const time = Date.now().toString(36)
  const random = Math.floor(Math.random() * 0xffffff).toString(36)
  return `${prefix}_${time}${counter.toString(36)}${random}`
}

/** A stable, non-cryptographic hash. Used for password hashing in this sample. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
