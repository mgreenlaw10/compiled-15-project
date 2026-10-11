/**
 * jsdom setup for the UI tests.
 *
 * React Flow measures its container, so it needs the three browser APIs jsdom
 * does not implement. These are the standard stubs; everything else in the UI
 * runs unmodified.
 */

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class DOMMatrixReadOnlyStub {
  m22 = 1
  constructor(transform?: string) {
    const match = transform?.match(/matrix\(([^)]+)\)/)
    if (match) {
      const parts = match[1].split(',').map((v) => Number(v.trim()))
      this.m22 = parts[3] ?? 1
    }
  }
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly ??=
  DOMMatrixReadOnlyStub

if (typeof Element !== 'undefined') {
  Element.prototype.getBoundingClientRect ??= function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      bottom: 800,
      right: 1200,
      toJSON: () => ({})
    } as DOMRect
  }
}

// React Flow calls these on nodes it renders.
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {}
}
