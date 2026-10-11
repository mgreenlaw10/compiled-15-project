/**
 * Formatting helpers used across the UI.
 */

export function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString(undefined, { hour12: false })
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}
