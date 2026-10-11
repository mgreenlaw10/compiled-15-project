/**
 * The collaboration domain model.
 *
 * Shared between the backend (which synchronizes it through Git) and the
 * renderer (which draws it). Pure data and pure functions: no Git, no React,
 * no filesystem.
 */

export * from './actor'
export * from './merge'
export * from './model'
export * from './session'
export * from './status'
