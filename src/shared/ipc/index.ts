/**
 * The renderer <-> main process contract.
 *
 * The renderer never touches the filesystem, ts-morph, or any model SDK; it
 * only calls these methods. That boundary is what the "replace the local
 * backend with a shared server" story depends on: `CartographApi` is already
 * an async, serializable, transport-agnostic interface.
 *
 * ---------------------------------------------------------------------------
 * Adding to the contract
 * ---------------------------------------------------------------------------
 * The contract is split by domain, one file per handler module. To add a
 * capability:
 *
 * 1. Add the request/result types and an `XApi` interface to the matching
 *    file here (or a new one).
 * 2. Add its channel names to `channels.ts`.
 * 3. Extend `CartographApi` below with the new fragment.
 * 4. Implement it in `src/main/ipc/modules/` and bridge it in
 *    `src/preload/bridges/`.
 *
 * Splitting it this way is deliberate: two people adding unrelated
 * capabilities touch different files.
 */

import type { DocumentApi } from './document'
import type { GenerationApi } from './generation'
import type { ProjectApi } from './project'
import type { SettingsApi } from './settings'
import type { SystemApi } from './system'

export * from './channels'
export * from './commands'
export * from './document'
export * from './generation'
export * from './log'
export * from './project'
export * from './settings'
export * from './system'

/** The whole backend surface, as seen by the renderer. */
export interface CartographApi
  extends ProjectApi,
    DocumentApi,
    GenerationApi,
    SettingsApi,
    SystemApi {}
