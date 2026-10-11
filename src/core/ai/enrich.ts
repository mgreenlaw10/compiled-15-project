/**
 * Optional AI enrichment of an analyzed graph.
 *
 * Static analysis establishes the facts: which files exist, what they declare,
 * what imports what. It is poor at the other half of an architecture diagram —
 * what a module is *for*, and whether the directory layout actually reflects
 * the design. That is what a model is good at, so it is used for exactly that
 * and nothing more.
 *
 * Hard rules, enforced here rather than asked for in the prompt:
 *
 *   - the file-to-module mapping is never changed by this pass,
 *   - no dependency edge is ever created by this pass,
 *   - anything the model contributes is marked `confidenceBasis: 'ai'`, so the
 *     GUI can show it as a suggestion rather than a finding,
 *   - boundary advice lands in `metadata.notes` as text for a human to act on,
 *     not as an automatic re-clustering.
 */

import type { ArchitectureGraph } from '../../shared/types/architecture'
import { cloneGraph } from '../../shared/graph/model'
import { importantSymbols } from '../../shared/graph/selectors'
import type { Logger } from '../logger'
import { createAiClient, describeApiError } from './client'
import { parseJsonObject, textOf } from './providers/chat'
import type { AiConfig } from '../../shared/ai'

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['modules'],
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description', 'responsibilities', 'confidence'],
        properties: {
          id: { type: 'string', description: 'The module id, exactly as given.' },
          description: {
            type: 'string',
            description:
              'One or two sentences on what this module is for, in plain language.'
          },
          responsibilities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Three to six short phrases, each a distinct responsibility.'
          },
          confidence: {
            type: 'number',
            description:
              'How confident you are that this is a coherent module, from 0 to 1.'
          },
          boundaryNote: {
            type: 'string',
            description:
              'Optional: a concrete suggestion about the module boundary, e.g. which files look like they belong elsewhere. Omit it when the boundary looks right.'
          },
          implementationDescription: { type: 'string', description: 'Explain existing implementation using the supplied actual source excerpts; distinguish uncertainty.' },
          inferredContracts: { type: 'array', items: { type: 'object', additionalProperties: false,
            required: ['symbolId', 'category', 'description'], properties: { symbolId: { type: 'string' },
              category: { type: 'string', enum: ['precondition', 'postcondition', 'invariant', 'side_effect', 'error_behavior', 'ordering', 'concurrency', 'idempotency', 'performance', 'ownership', 'lifecycle'] },
              description: { type: 'string' } } } }
        }
      }
    }
  }
} as const

interface EnrichResponse {
  modules: {
    id: string
    description: string
    responsibilities: string[]
    confidence: number
    boundaryNote?: string
    implementationDescription?: string
    inferredContracts?: { symbolId: string; category: import('../../shared/types/program').ContractCategory; description: string }[]
  }[]
}

const SYSTEM = `You describe software architecture.

You are given modules of a real codebase, extracted by static analysis, with source excerpts. Describe their purpose and how the existing implementation works. Optional behavioral contracts are hypotheses only, never proven guarantees.

Rules:
- Describe only what the supplied source excerpts and relationships support. Do not invent features, frameworks or behavior you cannot see. If excerpts are incomplete, state that limitation.
- Inferred contracts are unverified hypotheses; do not use language implying formal proof. Only use symbol IDs supplied for that module.
- Write for a developer new to the codebase. Plain, specific language, no filler, no marketing tone.
- Responsibilities are short phrases ("Hash and verify passwords"), not sentences, and should not simply restate the module name.
- Set confidence honestly. A directory holding several unrelated things deserves a low score and a boundaryNote saying what looks misplaced.
- Never suggest moving a file you were not shown.`

export interface EnrichOptions {
  config: AiConfig
  logger: Logger
  signal?: AbortSignal
}

function graphDigest(graph: ArchitectureGraph): string {
  const lines: string[] = [`Project: ${graph.name}`, '']
  for (const m of graph.modules) {
    lines.push(
      `module ${m.id}`,
      `  directory: ${m.directory ?? '(not directory-backed)'}`,
      `  files: ${m.files.join(', ')}`,
      `  exports: ${m.publicInterface.slice(0, 25).join(', ') || '(none)'}`,
      `  notable declarations: ${
        importantSymbols(m, 8)
          .map((s) => `${s.kind} ${s.name}`)
          .join(', ') || '(none)'
      }`,
      `  imports from: ${
        graph.edges
          .filter((e) => e.from === m.id)
          .map((e) => e.to)
          .join(', ') || '(nothing)'
      }`,
      `  source-grounded components: ${JSON.stringify(m.components)}`,
      `  source excerpts: ${graph.program.symbols.filter((s) => m.files.includes(s.source.file)).slice(0, 12).map((s) => `${s.id} ${s.qualifiedName}\n${s.sourceText.slice(0, 1200)}`).join('\n').slice(0, 7000)}`,
      ''
    )
  }
  return lines.join('\n')
}

/**
 * Returns a copy of the graph with AI-written descriptions. On any failure the
 * original graph is returned unchanged — enrichment is a bonus, never a
 * prerequisite, so a network error must not fail an analysis.
 */
export async function enrichGraphWithAi(
  graph: ArchitectureGraph,
  options: EnrichOptions
): Promise<{ graph: ArchitectureGraph; applied: boolean; message: string }> {
  const log = options.logger.child('ai')
  if (graph.modules.length === 0) {
    return { graph, applied: false, message: 'There are no modules to describe.' }
  }

  const client = createAiClient(options.config)
  log.info(`Asking ${client.model} to describe ${graph.modules.length} module(s)`)

  let parsed: EnrichResponse
  try {
    const response = await client.chat.complete({
      system: SYSTEM,
      messages: [{ role: 'user', content: graphDigest(graph) }],
      maxTokens: 16_000,
      responseSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      ...(options.signal ? { signal: options.signal } : {})
    })

    if (response.stopReason === 'refusal') {
      return {
        graph,
        applied: false,
        message: 'The model declined to describe this project; the graph is unchanged.'
      }
    }
    if (response.stopReason === 'max_tokens') {
      return {
        graph,
        applied: false,
        message:
          'The description response was cut off by the output limit, so none of it was used.'
      }
    }

    // Only providers advertising `jsonMode: 'schema'` guarantee the shape, so
    // the text is parsed leniently and a miss is reported rather than thrown:
    // enrichment is a bonus and must never fail an analysis.
    const found = parseJsonObject<EnrichResponse>(textOf(response))
    if (!found) {
      log.warn('The model did not return usable JSON; keeping the analyzed descriptions')
      return {
        graph,
        applied: false,
        message: 'The model did not return a usable description response.'
      }
    }
    parsed = found
  } catch (error) {
    const message = describeApiError(error, client.providerId)
    log.warn('AI enrichment failed; keeping the analyzed descriptions', message)
    return { graph, applied: false, message }
  }

  const byId = new Map(parsed.modules?.map((m) => [m.id, m]) ?? [])
  const next = cloneGraph(graph)
  let updated = 0
  const unknown: string[] = []

  for (const suggestion of byId.values()) {
    const target = next.modules.find((m) => m.id === suggestion.id)
    if (!target) {
      unknown.push(suggestion.id)
      continue
    }
    if (typeof suggestion.description === 'string' && suggestion.description.trim() !== '') {
      target.description = suggestion.description.trim()
    }
    if (typeof suggestion.implementationDescription === 'string' && suggestion.implementationDescription.trim()) {
      target.components.implementation.observedDescription = suggestion.implementationDescription.trim()
      target.components.implementation.descriptionOrigin = 'ai'
    }
    for (const [index, contract] of (suggestion.inferredContracts ?? []).entries()) {
      const symbol = next.program.symbols.find((s) => s.id === contract.symbolId && target.files.includes(s.source.file))
      if (!symbol || !contract.description?.trim()) continue
      const id = `inferred:${symbol.id}:${index}`
      if (next.program.contracts.some((c) => c.id === id)) continue
      next.program.contracts.push({ id, moduleId: target.id, symbolId: symbol.id, category: contract.category,
        description: contract.description, provenance: 'inferred', verification: 'unverified',
        verificationNote: 'AI-inferred hypothesis based on source excerpts; no formal verification performed.', evidence: [symbol.source], version: 1 })
      target.components.contracts.contractIds.push(id)
    }
    if (Array.isArray(suggestion.responsibilities) && suggestion.responsibilities.length > 0) {
      target.responsibilities = suggestion.responsibilities
        .filter((r) => typeof r === 'string' && r.trim() !== '')
        .slice(0, 8)
    }
    // The model's confidence is about the *boundary*, so it is averaged with
    // the analyzer's own cohesion-derived score rather than replacing it.
    if (typeof suggestion.confidence === 'number' && Number.isFinite(suggestion.confidence)) {
      const clamped = Math.min(1, Math.max(0, suggestion.confidence))
      target.metadata.confidence = Number(
        ((target.metadata.confidence + clamped) / 2).toFixed(2)
      )
    }
    target.metadata.confidenceBasis = 'ai'
    target.metadata.notes.push('Description and responsibilities written by the model.')
    if (suggestion.boundaryNote && suggestion.boundaryNote.trim() !== '') {
      target.metadata.notes.push(`Model's boundary note: ${suggestion.boundaryNote.trim()}`)
    }
    updated += 1
  }

  next.analysis.aiAssisted = true
  if (unknown.length > 0) {
    next.analysis.warnings.push({
      code: 'ai-unknown-module',
      message: `The model described ${unknown.length} module id(s) that do not exist and were ignored: ${unknown.join(', ')}.`
    })
  }

  const message = `Described ${updated} of ${graph.modules.length} module(s).`
  log.success(message)
  return { graph: next, applied: updated > 0, message }
}
