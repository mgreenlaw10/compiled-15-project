/**
 * The domain model: what an architecture is, how it changes, and what
 * generating it produces.
 *
 * The renderer <-> main contract lives in `shared/ipc`, and model
 * configuration in `shared/ai`; neither is re-exported here so that importing
 * the domain model never drags in the transport or the provider catalog.
 */

export * from './architecture'
export * from './operations'
export * from './generation'
export * from './project'
