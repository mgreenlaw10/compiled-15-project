/**
 * The provider interface.
 *
 * Cartograph is usable with no API key at all: every deterministic path — scan,
 * analyze, cluster, graph edit, file move, symbol move, generate, validate —
 * runs without any provider ever being constructed. A provider is built lazily,
 * only when an operation genuinely needs a model, so a user without a key never
 * sees an auth error.
 *
 * `AiClient` is intentionally shaped around the Anthropic SDK's message surface
 * because that is what `agent.ts` and `enrich.ts` drive. A provider that speaks
 * the same wire protocol (most gateways and proxies do) only needs a different
 * `baseURL`; one that does not should adapt itself to this shape inside its own
 * module rather than leaking a second shape into the callers.
 */

import type Anthropic from '@anthropic-ai/sdk'

import type { AiConfig, Effort } from '../../../shared/ai'

export interface AiClient {
  /** Which provider produced this client. */
  readonly providerId: string
  /** The message API. Anthropic-SDK shaped; see the note above. */
  readonly sdk: Anthropic
  readonly model: string
  readonly effort: Effort
  readonly maxFileReads: number
}

export interface ApiKeyTest {
  ok: boolean
  message: string
}

export interface AiProvider {
  /** Must match a descriptor id in `shared/ai/providers.ts`. */
  readonly id: string
  /** Builds a ready-to-use client. Never called without a key. */
  createClient(config: AiConfig): AiClient
  /** Turns a vendor SDK error into something worth showing a user. */
  describeError(error: unknown): string
  /** Sends the smallest possible request, to check a key really works. */
  testApiKey(config: AiConfig): Promise<ApiKeyTest>
}
