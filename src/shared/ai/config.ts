/**
 * Model configuration shared by the renderer and the backend.
 *
 * This lives in `shared` rather than next to the provider SDKs so the settings
 * dialog can offer provider, model and effort choices without the renderer
 * bundle pulling in any vendor SDK.
 */

import type { AiProviderId } from './providers'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: readonly Effort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** One resolved, ready-to-use model configuration. */
export interface AiConfig {
  /** Which provider in the catalog this key and model belong to. */
  provider: AiProviderId
  apiKey: string
  model: string
  effort: Effort
  /** Upper bound on files the agent may read while carrying out one operation. */
  maxFileReads: number
}

export const DEFAULT_EFFORT: Effort = 'high'
export const DEFAULT_MAX_FILE_READS = 40
