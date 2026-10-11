# AI providers

Everything in `src/core` that needs a model goes through `../client.ts`, which
names no vendor. Which provider answers is decided by `AiConfig.provider` and
resolved through the registry in `index.ts`.

| File | What it is |
| --- | --- |
| `chat.ts` | **The protocol-neutral interface.** `ChatModel`, messages, tools, stop reasons. `agent.ts` and `enrich.ts` are written against this. |
| `types.ts` | `AiProvider` and `AiClient`. |
| `openai-compatible.ts` | A reusable `ChatModel` over any OpenAI-style `/chat/completions` endpoint. |
| `anthropic.ts` | Anthropic's native API: prompt caching, adaptive thinking, refusal fallbacks, eager tool-input streaming. |
| `luminal.ts` | DeepSeek V4.1 Flash via Luminal's Flash endpoint. Configuration only — the transport is shared. |

## Adding a provider

1. A descriptor in `src/shared/ai/providers.ts` — renderer-safe metadata
   (display name, models, key placeholder, console URL, env var). The settings
   dialog renders the whole catalog from this, so it needs no changes.
2. A module here exporting an `AiProvider`.
3. One line in `PROVIDERS` in `index.ts`.

**If the endpoint is OpenAI-compatible, step 2 is about 40 lines.** Copy
`luminal.ts`: it is a base URL, a model, and error wording, because
`createOpenAiCompatibleModel` is the whole transport.

For anything else, implement `ChatModel` directly. Adapt the wire protocol
**inside your own module** — that locality is what keeps a provider from
leaking a second shape into the agent loop.

A test in `tests/unit/providers.test.ts` asserts that every `available`
descriptor has a registered implementation, so a half-added provider fails CI
rather than failing at runtime when a user picks it.

## What `ChatCapabilities` is for

A provider declares what it genuinely does, and callers adapt rather than
assume:

- `jsonMode` — `schema` means the response is guaranteed to match
  `responseSchema`; `object` means only that it is valid JSON. `enrich.ts`
  parses with `parseJsonObject` either way and treats a miss as "no
  descriptions", because enrichment is a bonus and must never fail an analysis.
- `streaming` — whether `onText` fires during the turn. The agent logs the
  turn's text once, from whichever source applies.
- `effort` — whether `AiConfig.effort` is actually honoured. The OpenAI chat
  protocol has no equivalent, so the activity log does not claim an effort
  level was applied when it was ignored.
- `thinking` — whether reasoning arrives as thinking blocks.

## Things worth knowing

- **Reasoning is never replayed as assistant text.** Anthropic's thinking
  blocks are signed and cannot be reconstructed from the neutral shape, and
  reading another provider's reasoning back as a reply confuses more than it
  helps. The conversation stays valid without it, because text and tool_use
  carry the turn's actual content.
- **Some hosts still need it back, in their own field.** A thinking mode that
  keeps no state between turns rejects the next request unless the reasoning it
  produced returns as `reasoning_content` on the assistant message — a 400 that
  ends an agent run after its first reply, which looks like "no files were
  changed". `replayReasoning` on the OpenAI-compatible transport sends it back
  in that field (never as content), and Luminal turns it on. It is opt-in
  because a gateway that does not know the field may reject it instead.
- **Tool inputs are always re-validated** in `runTool`, whatever the provider
  did. Anthropic stops validating when inputs stream eagerly, and an
  OpenAI-compatible gateway never validated them at all.
- **Luminal's image API is deliberately not wired up.** Luminal also exposes an
  Ideogram-compatible endpoint at `https://images.luminal.cloud/`; Cartograph
  has nothing to do with image generation.
