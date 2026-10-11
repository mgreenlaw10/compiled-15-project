/**
 * The domain lexicon used to describe modules without an LLM.
 *
 * Cartograph has to be useful with no API key, so module names, roles, and
 * responsibilities are derived from evidence in the code: directory names, file
 * names, and exported symbol names. These are *heuristics* and are labelled as
 * such everywhere they surface (`confidenceBasis: 'heuristic'`) so they are
 * never mistaken for verified facts.
 */

export interface DomainTag {
  tag: string
  /** Short role sentence used in generated descriptions. */
  role: string
  /** Keywords matched against path and symbol names, lowercase. */
  keywords: readonly string[]
}

export const DOMAIN_TAGS: readonly DomainTag[] = [
  {
    tag: 'auth',
    role: 'Handles authentication and credential verification.',
    keywords: ['auth', 'login', 'logout', 'signin', 'signup', 'credential', 'password', 'oauth', 'jwt', 'token']
  },
  {
    tag: 'session',
    role: 'Manages user sessions and their lifecycle.',
    keywords: ['session', 'cookie']
  },
  {
    tag: 'users',
    role: 'Manages user records and profiles.',
    keywords: ['user', 'profile', 'account', 'member']
  },
  {
    tag: 'database',
    role: 'Provides data access and persistence.',
    keywords: ['db', 'database', 'repository', 'repo', 'dao', 'model', 'entity', 'schema', 'migration', 'query', 'orm', 'prisma', 'sql', 'mongo', 'store', 'storage', 'persistence']
  },
  {
    tag: 'http',
    role: 'Exposes the HTTP surface and routes requests.',
    keywords: ['route', 'router', 'routing', 'controller', 'endpoint', 'api', 'handler', 'rest', 'graphql', 'resolver', 'server', 'http']
  },
  {
    tag: 'middleware',
    role: 'Intercepts and augments requests.',
    keywords: ['middleware', 'interceptor', 'guard', 'filter']
  },
  {
    tag: 'payments',
    role: 'Processes payments and billing.',
    keywords: ['payment', 'billing', 'invoice', 'stripe', 'checkout', 'subscription', 'charge', 'refund', 'price']
  },
  {
    tag: 'ui',
    role: 'Renders the user interface.',
    keywords: ['ui', 'component', 'components', 'view', 'views', 'page', 'pages', 'screen', 'widget', 'layout', 'style', 'styles', 'css', 'theme', 'render']
  },
  {
    tag: 'state',
    role: 'Holds client-side application state.',
    keywords: ['state', 'store', 'reducer', 'slice', 'context', 'atom', 'signal']
  },
  {
    tag: 'validation',
    role: 'Validates and normalizes input.',
    keywords: ['valid', 'validate', 'validation', 'validator', 'sanitize', 'schema', 'parse', 'guard']
  },
  {
    tag: 'config',
    role: 'Supplies configuration and environment settings.',
    keywords: ['config', 'configuration', 'settings', 'env', 'option', 'constant', 'constants']
  },
  {
    tag: 'logging',
    role: 'Records diagnostics and telemetry.',
    keywords: ['log', 'logger', 'logging', 'telemetry', 'metric', 'metrics', 'trace', 'monitor', 'audit']
  },
  {
    tag: 'messaging',
    role: 'Sends notifications and messages.',
    keywords: ['mail', 'mailer', 'email', 'notification', 'notify', 'sms', 'push', 'webhook']
  },
  {
    tag: 'queue',
    role: 'Schedules background and asynchronous work.',
    keywords: ['queue', 'job', 'jobs', 'worker', 'task', 'cron', 'schedule', 'scheduler']
  },
  {
    tag: 'cache',
    role: 'Caches computed or fetched values.',
    keywords: ['cache', 'caching', 'memo', 'redis']
  },
  {
    tag: 'utilities',
    role: 'Provides shared helpers used across the codebase.',
    keywords: ['util', 'utils', 'utility', 'helper', 'helpers', 'common', 'shared', 'lib', 'misc', 'support']
  },
  {
    tag: 'types',
    role: 'Declares shared types and contracts.',
    keywords: ['type', 'types', 'interface', 'interfaces', 'contract', 'dto', 'protocol']
  },
  {
    tag: 'tests',
    role: 'Contains automated tests.',
    keywords: ['test', 'tests', 'spec', 'specs', '__tests__', 'fixture', 'fixtures', 'mock', 'mocks', 'e2e']
  },
  {
    tag: 'cli',
    role: 'Implements the command-line interface.',
    keywords: ['cli', 'command', 'commands', 'bin', 'prompt', 'argv']
  },
  {
    tag: 'integration',
    role: 'Talks to external services.',
    keywords: ['client', 'adapter', 'gateway', 'provider', 'integration', 'external', 'sdk', 'connector', 'fetch']
  },
  {
    tag: 'entry',
    role: 'Wires the application together and starts it.',
    keywords: ['index', 'main', 'app', 'bootstrap', 'entry', 'init', 'startup']
  }
]

const TOKEN_SPLIT = /[^a-z0-9]+/

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 1)
}

export interface WeightedText {
  text: string
  weight: number
}

/**
 * Relative trust in each kind of evidence. A directory called `types` says more
 * about a module's role than the fact that one of its interfaces is named
 * `RequestContext`, so paths outrank file names, which outrank symbol names.
 */
export const EVIDENCE_WEIGHTS = {
  path: 6,
  fileName: 2,
  symbol: 1
} as const

/**
 * Scores every domain tag against weighted bags of text (paths, file names,
 * symbol names). Returns tags sorted by score, strongest first.
 */
export function scoreTags(
  texts: (string | WeightedText)[]
): { tag: string; score: number }[] {
  const tokens = new Map<string, number>()
  for (const entry of texts) {
    const text = typeof entry === 'string' ? entry : entry.text
    const weight = typeof entry === 'string' ? 1 : entry.weight
    for (const token of tokenize(text)) {
      tokens.set(token, (tokens.get(token) ?? 0) + weight)
    }
  }

  const scores: { tag: string; score: number }[] = []
  for (const domain of DOMAIN_TAGS) {
    let score = 0
    for (const keyword of domain.keywords) {
      score += tokens.get(keyword) ?? 0
    }
    if (score > 0) scores.push({ tag: domain.tag, score })
  }
  return scores.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
}

export function roleOf(tag: string): string {
  return DOMAIN_TAGS.find((d) => d.tag === tag)?.role ?? ''
}

/** The single strongest tag for a file name, or `null` when nothing matches. */
export function primaryTagOfName(name: string): string | null {
  const scores = scoreTags([name])
  return scores.length > 0 ? scores[0].tag : null
}

const VERB_PREFIXES = [
  'create',
  'make',
  'build',
  'get',
  'fetch',
  'load',
  'read',
  'list',
  'find',
  'search',
  'query',
  'update',
  'patch',
  'set',
  'save',
  'store',
  'write',
  'persist',
  'delete',
  'remove',
  'destroy',
  'revoke',
  'validate',
  'verify',
  'check',
  'assert',
  'ensure',
  'parse',
  'format',
  'render',
  'send',
  'publish',
  'emit',
  'dispatch',
  'handle',
  'process',
  'run',
  'start',
  'stop',
  'init',
  'register',
  'resolve',
  'apply',
  'compute',
  'calculate',
  'hash',
  'sign',
  'encrypt',
  'decrypt',
  'login',
  'logout',
  'authenticate',
  'authorize',
  'refresh',
  'expire',
  'connect',
  'close',
  'open',
  'use'
]

/**
 * Turns an exported symbol name into a responsibility phrase, e.g.
 * `createSession` -> "Create session", `UserRepository` -> "Provide user
 * repository". Returns `null` for names that carry no useful signal.
 */
export function responsibilityFromSymbol(name: string): string | null {
  const bare = name.replace(/^default:/, '')
  if (bare.length < 3) return null
  const tokens = tokenize(bare)
  if (tokens.length === 0) return null

  const first = tokens[0]
  if (VERB_PREFIXES.includes(first)) {
    const rest = tokens.slice(1)
    if (rest.length === 0) return capitalize(first)
    return `${capitalize(first)} ${rest.join(' ')}`
  }

  // A noun-ish name: describe it as something the module provides.
  if (/^[A-Z]/.test(bare)) return `Provide ${tokens.join(' ')}`
  return null
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)
}

/** De-duplicates and caps a responsibility list. */
export function normalizeResponsibilities(
  items: (string | null)[],
  limit = 6
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (!item) continue
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}
