/**
 * Minimal declarations for the two Node built-ins the tests use.
 *
 * The sample project deliberately has zero dependencies — not even
 * `@types/node` — so that `npm test` and `tsc --noEmit` both work in a fresh
 * checkout with no install step. These shims cover only what the tests touch.
 */

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void
  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: () => void | Promise<void>): void
}

declare module 'node:assert/strict' {
  interface AssertStrict {
    (value: unknown, message?: string): void
    equal(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    ok(value: unknown, message?: string): void
    throws(fn: () => unknown, expected?: RegExp | ErrorConstructor): void
  }
  const assert: AssertStrict
  export default assert
}
