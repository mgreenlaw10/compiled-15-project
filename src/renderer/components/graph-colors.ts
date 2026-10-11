/** Stable source-module colors, independent of ordering, naming and layout. */
export function moduleColor(id: string): string {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  }
  return `hsl(${(hash >>> 0) % 360}, 54%, 43%)`
}
