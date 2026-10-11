/**
 * Provider-layer tests.
 *
 * The OpenAI-compatible transport is the risky part of multi-provider support:
 * it translates the agent's neutral message list into a different wire protocol
 * and back, and a mistake there shows up as a refactor that silently does
 * nothing. So the translation is tested in both directions against a stubbed
 * `fetch`, with no network involved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AI_PROVIDERS,
  availableProviders,
  findProvider,
  isKnownProvider,
  providerOrDefault
} from '../../src/shared/ai'
import {
  findAiProvider,
  implementedProviderIds,
  requireAiProvider
} from '../../src/core/ai/providers'
import {
  createOpenAiCompatibleModel,
  describeOpenAiCompatibleError,
  OpenAiCompatibleError
} from '../../src/core/ai/providers/openai-compatible'
import { parseJsonObject } from '../../src/core/ai/providers/chat'
import { LUMINAL_BASE_URL, luminalProvider } from '../../src/core/ai/providers/luminal'
import { createAiClient, isConfigured } from '../../src/core/ai/client'
import { toolDefinitions } from '../../src/core/ai/tools'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** Replaces `fetch` and records the request bodies it was given. */
function stubFetch(
  response: unknown,
  init: { status?: number; body?: string } = {}
): { bodies: Record<string, unknown>[]; urls: string[]; headers: Record<string, string>[] } {
  const bodies: Record<string, unknown>[] = []
  const urls: string[] = []
  const headers: Record<string, string>[] = []

  globalThis.fetch = vi.fn(async (url: unknown, options: unknown) => {
    const opts = options as { body: string; headers: Record<string, string> }
    urls.push(String(url))
    bodies.push(JSON.parse(opts.body) as Record<string, unknown>)
    headers.push(opts.headers)
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      text: async () => init.body ?? JSON.stringify(response)
    } as Response
  }) as unknown as typeof fetch

  return { bodies, urls, headers }
}

function model(jsonMode: 'schema' | 'object' | 'none' = 'object') {
  return createOpenAiCompatibleModel({
    baseUrl: 'https://flash.example/v1',
    apiKey: 'test-key',
    model: 'test-model',
    jsonMode
  })
}

describe('the provider catalog', () => {
  it('registers an implementation for every available descriptor', () => {
    for (const descriptor of availableProviders()) {
      expect(
        findAiProvider(descriptor.id),
        `no implementation registered for "${descriptor.id}"`
      ).not.toBeNull()
    }
  })

  it('offers both Anthropic and Luminal', () => {
    expect(implementedProviderIds()).toEqual(
      expect.arrayContaining(['anthropic', 'luminal'])
    )
    expect(isKnownProvider('luminal')).toBe(true)
    expect(isKnownProvider('nonesuch')).toBe(false)
  })

  it('describes Luminal as DeepSeek V4.1 Flash', () => {
    const luminal = findProvider('luminal')
    expect(luminal?.defaultModel).toBe('deepseek-ai/DeepSeek-V4.1-Flash')
    expect(luminal?.envVar).toBe('LUMINAL_API_KEY')
    expect(luminal?.available).toBe(true)
  })

  it('falls back to the default provider for an unknown id', () => {
    expect(providerOrDefault('nonesuch').id).toBe('anthropic')
    // The registry falls back too, rather than throwing mid-refactor.
    expect(requireAiProvider('nonesuch').id).toBe('anthropic')
  })

  it('gives every descriptor the fields the settings dialog renders', () => {
    for (const descriptor of AI_PROVIDERS) {
      expect(descriptor.displayName).toBeTruthy()
      expect(descriptor.summary).toBeTruthy()
      expect(descriptor.keyPlaceholder).toBeTruthy()
      expect(descriptor.consoleUrl).toMatch(/^https:\/\//)
      expect(descriptor.models).toContain(descriptor.defaultModel)
    }
  })
})

describe('the Luminal client', () => {
  it('builds a client pointed at the Flash endpoint with the key as a bearer token', async () => {
    const stub = stubFetch({
      choices: [{ finish_reason: 'stop', message: { content: 'ready' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    })

    const client = luminalProvider.createClient({
      provider: 'luminal',
      apiKey: 'lum-secret',
      model: '',
      effort: 'high',
      maxFileReads: 10
    })

    expect(client.providerId).toBe('luminal')
    expect(client.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash')

    await client.chat.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16
    })

    expect(stub.urls[0]).toBe(`${LUMINAL_BASE_URL}/chat/completions`)
    expect(stub.headers[0].authorization).toBe('Bearer lum-secret')
    expect(stub.bodies[0].model).toBe('deepseek-ai/DeepSeek-V4.1-Flash')
  })

  it('reaches Luminal through the shared facade when configured', () => {
    const client = createAiClient({
      provider: 'luminal',
      apiKey: 'lum-secret',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      effort: 'high',
      maxFileReads: 10
    })
    expect(client.providerId).toBe('luminal')
    expect(isConfigured({ apiKey: 'lum-secret' })).toBe(true)
    expect(isConfigured({ apiKey: '  ' })).toBe(false)
  })

  it('reports a rejected key rather than throwing', async () => {
    stubFetch(null, { status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) })
    const result = await luminalProvider.testApiKey({
      provider: 'luminal',
      apiKey: 'wrong',
      model: '',
      effort: 'high',
      maxFileReads: 10
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('401')
  })
})

describe('the OpenAI-compatible transport', () => {
  it('sends the system prompt as the first message', async () => {
    const stub = stubFetch({ choices: [{ message: { content: 'ok' } }] })
    await model().complete({
      system: 'you are a refactoring agent',
      messages: [{ role: 'user', content: 'do the thing' }],
      maxTokens: 100
    })

    const sent = stub.bodies[0].messages as { role: string; content: string }[]
    expect(sent[0]).toEqual({ role: 'system', content: 'you are a refactoring agent' })
    expect(sent[1]).toEqual({ role: 'user', content: 'do the thing' })
  })

  it('translates tool definitions into function tools', async () => {
    const stub = stubFetch({ choices: [{ message: { content: 'ok' } }] })
    await model().complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: toolDefinitions(),
      maxTokens: 100
    })

    const tools = stub.bodies[0].tools as {
      type: string
      function: { name: string; description: string; parameters: Record<string, unknown> }
    }[]
    expect(tools.length).toBeGreaterThan(0)
    expect(stub.bodies[0].tool_choice).toBe('auto')

    const writeFile = tools.find((t) => t.function.name === 'write_file')
    expect(writeFile?.type).toBe('function')
    expect(writeFile?.function.description).toBeTruthy()
    expect(writeFile?.function.parameters.type).toBe('object')
  })

  it('reads a tool call back out, parsing its JSON arguments', async () => {
    stubFetch({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'write_file',
                  arguments: '{"path":"src/a/new.ts","content":"export const a = 1\\n"}'
                }
              }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7 }
    })

    const response = await model().complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      maxTokens: 100
    })

    expect(response.stopReason).toBe('tool_use')
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
    expect(response.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'write_file',
        input: { path: 'src/a/new.ts', content: 'export const a = 1\n' }
      }
    ])
  })

  it('accepts tool arguments that arrive already parsed', async () => {
    stubFetch({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              { id: 'c1', function: { name: 'read_file', arguments: { path: 'src/a.ts' } } }
            ]
          }
        }
      ]
    })
    const response = await model().complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      maxTokens: 100
    })
    expect(response.content[0]).toMatchObject({ input: { path: 'src/a.ts' } })
  })

  it('surfaces an unparseable argument string instead of crashing the loop', async () => {
    stubFetch({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{not json' } }]
          }
        }
      ]
    })
    const response = await model().complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      maxTokens: 100
    })
    // The turn survives; `runTool`'s validation reports the bad input.
    expect(response.content[0]).toMatchObject({
      type: 'tool_use',
      input: { __unparsed: '{not json' }
    })
  })

  it('sends tool results back as one tool message per result', async () => {
    const stub = stubFetch({ choices: [{ message: { content: 'done' } }] })
    await model().complete({
      system: 'sys',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'writing it' },
            { type: 'tool_use', id: 'c1', name: 'write_file', input: { path: 'a.ts' } }
          ]
        },
        {
          role: 'tool_results',
          results: [
            { toolUseId: 'c1', content: 'wrote a.ts', isError: false },
            { toolUseId: 'c2', content: 'no such file', isError: true }
          ]
        }
      ],
      maxTokens: 100
    })

    const sent = stub.bodies[0].messages as Record<string, unknown>[]
    expect(sent[2]).toMatchObject({
      role: 'assistant',
      content: 'writing it',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"a.ts"}' }
        }
      ]
    })
    expect(sent[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'wrote a.ts' })
    // An error result is marked, so the model can tell failure from output.
    expect(sent[4]).toEqual({
      role: 'tool',
      tool_call_id: 'c2',
      content: 'ERROR: no such file'
    })
  })

  it('does not replay reasoning back as assistant text', async () => {
    const stub = stubFetch({ choices: [{ message: { content: 'ok' } }] })
    await model().complete({
      system: 'sys',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal deliberation' },
            { type: 'text', text: 'the answer' }
          ]
        }
      ],
      maxTokens: 100
    })
    const sent = stub.bodies[0].messages as { role: string; content: string }[]
    expect(sent[2].content).toBe('the answer')
    expect(JSON.stringify(stub.bodies[0])).not.toContain('internal deliberation')
  })

  it('exposes a reasoning field as a thinking block', async () => {
    stubFetch({
      choices: [
        {
          finish_reason: 'stop',
          message: { reasoning_content: 'first I will read the file', content: 'done' }
        }
      ]
    })
    const response = await model().complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      maxTokens: 100
    })
    expect(response.content).toEqual([
      { type: 'thinking', thinking: 'first I will read the file' },
      { type: 'text', text: 'done' }
    ])
  })

  it('maps finish reasons the agent has to act on', async () => {
    for (const [finish, expected] of [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['content_filter', 'refusal']
    ] as const) {
      stubFetch({ choices: [{ finish_reason: finish, message: { content: 'x' } }] })
      const response = await model().complete({
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        maxTokens: 100
      })
      expect(response.stopReason, `finish_reason "${finish}"`).toBe(expected)
    }
  })

  it('asks for a plain JSON object when a schema cannot be enforced', async () => {
    const stub = stubFetch({ choices: [{ message: { content: '{}' } }] })
    await model('object').complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      maxTokens: 100,
      responseSchema: { type: 'object', properties: {} }
    })
    expect(stub.bodies[0].response_format).toEqual({ type: 'json_object' })
  })

  it('asks for a strict schema when the endpoint enforces one', async () => {
    const stub = stubFetch({ choices: [{ message: { content: '{}' } }] })
    await model('schema').complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      maxTokens: 100,
      responseSchema: { type: 'object', properties: {} }
    })
    expect(stub.bodies[0].response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true }
    })
  })

  it('reports an HTTP error with its status', async () => {
    stubFetch(null, { status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) })
    await expect(
      model().complete({
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        maxTokens: 100
      })
    ).rejects.toThrow(OpenAiCompatibleError)
  })

  it('tolerates a missing usage block', async () => {
    stubFetch({ choices: [{ message: { content: 'ok' } }] })
    const response = await model().complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      maxTokens: 100
    })
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe('error wording', () => {
  it('turns statuses into something a user can act on', () => {
    const cases: [number, string][] = [
      [401, 'rejected'],
      [403, 'access'],
      [404, 'recognise'],
      [429, 'Rate limited']
    ]
    for (const [status, fragment] of cases) {
      const message = describeOpenAiCompatibleError(
        new OpenAiCompatibleError('detail', status),
        'Luminal'
      )
      expect(message).toContain('Luminal')
      expect(message).toContain(fragment)
    }
  })

  it('passes a connection failure through unchanged', () => {
    expect(
      describeOpenAiCompatibleError(
        new OpenAiCompatibleError('Could not reach host', null),
        'Luminal'
      )
    ).toBe('Could not reach host')
  })
})

describe('lenient JSON parsing', () => {
  it('reads a bare object', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('reads an object out of a fenced block', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('reads an object out of surrounding prose', () => {
    expect(parseJsonObject('Here you go: {"a":1} — hope that helps')).toEqual({ a: 1 })
  })

  it('returns null rather than throwing when there is no object', () => {
    expect(parseJsonObject('I could not do that')).toBeNull()
    expect(parseJsonObject('[1,2,3]')).toEqual([1, 2, 3])
  })
})
