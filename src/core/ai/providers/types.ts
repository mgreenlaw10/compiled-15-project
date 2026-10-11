/**
 * The provider interface.
 *
 * Cartograph is usable with no API key at all: every deterministic path — scan,
 * analyze, cluster, graph edit, file move, symbol move, generate, validate —
 * runs without any provider ever being constructed. A provider is built lazily,
 * only when an operation genuinely needs a model, so a user without a key never
 * sees an auth error.
 *
 * A client exposes a `ChatModel` (see `./chat.ts`), which is protocol-neutral.
 * That is what lets Anthropic's native API and an OpenAI-compatible gateway
 * both drive the same agent loop: each provider adapts its own wire protocol
 * inside its own module, and no vendor shape reaches `agent.ts` or `enrich.ts`.
 */

import type { AiConfig, Effort } from '../../../shared/ai'
import type { ChatModel } from './chat'

export interface AiClient {
  /** Which provider produced this client. */
  readonly providerId: string
  /** The protocol-neutral message API. */
  readonly chat: ChatModel
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
  /** Turns a provider error into something worth showing a user. */
  describeError(error: unknown): string
  /** Sends the smallest possible request, to check a key really works. */
  testApiKey(config: AiConfig): Promise<ApiKeyTest>
}
