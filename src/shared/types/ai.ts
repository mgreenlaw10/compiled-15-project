/**
 * Model configuration shared by the renderer and the backend.
 *
 * These live in `shared` rather than next to the Anthropic client so the
 * settings dialog can offer model and effort choices without the renderer
 * bundle pulling in the SDK.
 */

/** The default model: Claude Opus 5.5, the current and most capable Claude. */
export const DEFAULT_MODEL = 'claude-opus-5-5'

/** Models offered in the settings dialog, most capable first. */
export const SUGGESTED_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5'
] as const

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: readonly Effort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export interface AiConfig {
  apiKey: string
  model: string
  effort: Effort
  /** Upper bound on files the agent may read while carrying out one operation. */
  maxFileReads: number
}

export const DEFAULT_AI_CONFIG: Omit<AiConfig, 'apiKey'> = {
  model: DEFAULT_MODEL,
  effort: 'high',
  maxFileReads: 40
}
