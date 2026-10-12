/**
 * The architecture model.
 *
 * This file is the contract between every layer of Cartograph: the analyzer
 * produces it, the GUI renders and edits it, and the transformation engine
 * consumes it. It deliberately contains no behaviour and no imports so that it
 * can be used from the Electron main process, the renderer, and plain Node
 * tests alike.
 *
 * Two invariants matter more than anything else here:
 *
 *  1. Architectural information and *visual* information are stored separately
 *     (`ArchitectureGraph` vs `GraphLayout`). Dragging a node never touches the
 *     architecture, so it can never trigger a code change.
 *  2. Every module keeps a mapping back to real source files
 *     (`ModuleNode.files`). Without that mapping a graph edit could not be
 *     replayed onto the codebase.
 */

/** Stable identifier for a module. Stable across renames, saves, and reloads. */
import type { ModuleComponents, ProgramModel } from './program'
export type ModuleId = string

/** Stable identifier for a dependency edge. */
export type EdgeId = string

/**
 * Where a piece of information came from. Used to keep facts and guesses apart.
 *
 *  - `static`:    read directly out of the syntax tree. A fact.
 *  - `heuristic`: inferred by the analyzer from names and structure. A guess
 *                 with a rationale, always carrying a confidence score.
 *  - `analysis`:  produced by the analysis pipeline as a whole (used for a
 *                 module's `origin`, which mixes both of the above).
 *  - `ai`:        suggested by a language model. A guess.
 *  - `user`:      stated by a person. Authoritative about intent, not code.
 */
export type Provenance = 'static' | 'heuristic' | 'analysis' | 'ai' | 'user'

export type SymbolKind =
  | 'class'
  | 'function'
  | 'interface'
  | 'type'
  | 'variable'
  | 'enum'
  | 'component'
  | 'unknown'

/** A class, function, interface, … discovered by static analysis. */
export interface SourceSymbol {
  name: string
  kind: SymbolKind
  /** Project-relative POSIX path of the declaring file. */
  file: string
  /** 1-based line of the declaration. */
  line: number
  exported: boolean
  /** `true` when the symbol is the file's default export. */
  isDefaultExport: boolean
  /** Short rendered signature, e.g. `login(email: string): Promise<Session>`. */
  signature: string
  /** Rough size of the declaration in lines; used to rank "important" symbols. */
  loc: number
}

/** A file belonging to a module, with the facts the UI needs to show it. */
export interface ModuleFile {
  /** Project-relative POSIX path. */
  path: string
  language: string
  loc: number
  /** Number of exported symbols declared in the file. */
  exportCount: number
}

export interface ModuleMetadata {
  /** 0..1. How much the analyzer trusts this module's boundary. */
  confidence: number
  confidenceBasis: Provenance
  /** Human-readable notes: why the boundary was drawn here, AI caveats, … */
  notes: string[]
  /** Total lines of code across the module's files. */
  loc: number
  /** Detected domain keywords, e.g. `['auth', 'http']`. */
  tags: string[]
  /**
   * @deprecated Superseded by collaboration state; always `null`.
   *
   * Module ownership lives on the `collab-state` branch as a
   * `ModuleReservation`, not here. Keeping it out of the graph is deliberate:
   * the graph is derived from source and is written back to it, so storing a
   * claim here would turn "I am working on this" into a source-code change
   * that two developers conflict over textually. Read ownership through
   * `moduleCollabState` in `shared/collab/status.ts`.
   */
  owner: string | null
  /**
   * @deprecated Superseded by collaboration state; always `null`.
   *
   * See `owner`. A live agent's hold on a module is a reservation lease plus a
   * session heartbeat, which can expire — a field on the graph cannot.
   */
  lockedBy: string | null
}

export interface ModuleNode {
  id: ModuleId
  name: string
  description: string
  responsibilities: string[]
  /** Project-relative POSIX paths. The authoritative source mapping. */
  files: string[]
  /** Notable symbols inside `files`, ranked by the analyzer. */
  symbols: SourceSymbol[]
  /** Exported symbol names — the module's public interface. */
  publicInterface: string[]
  /**
   * Canonical directory for the module, project-relative POSIX, or `null` when
   * the module is not directory-backed (e.g. a module the user created from
   * files scattered across the tree). Directory-backed modules support more
   * deterministic transformations.
   */
  directory: string | null
  /** External package names imported by this module's files. */
  externalDependencies: string[]
  origin: Provenance
  metadata: ModuleMetadata
  /** Bumped whenever this module is changed by an operation. */
  version: number
  components: ModuleComponents
}

export type DependencyKind = 'imports' | 'depends_on' | 'calls' | 'types' | 'fields' | 'contracts'

/** A concrete import that justifies a module-level edge. */
export interface DependencyEvidence {
  /** Project-relative POSIX path of the importing file. */
  fromFile: string
  /** Project-relative POSIX path of the imported file. */
  toFile: string
  /** The specifier exactly as written in the source, e.g. `'../db/client'`. */
  specifier: string
  /** Imported binding names; `['*']` for namespace imports. */
  symbols: string[]
  line: number
  relationshipId?: string
  fromSymbolId?: string
  toSymbolId?: string
  contractId?: string
  resolution?: 'resolved' | 'potential' | 'unresolved'
}

export interface DependencyEdge {
  id: EdgeId
  from: ModuleId
  to: ModuleId
  kind: DependencyKind
  /** Number of distinct file-to-file imports behind this edge. */
  weight: number
  /**
   * `true` only when the edge is backed by at least one real import found by
   * static analysis. AI- or user-declared edges are `false` and are rendered
   * differently so a guess is never mistaken for a fact.
   */
  verified: boolean
  confidence: number
  evidence: DependencyEvidence[]
  origin: Provenance
  version: number
}

export interface AnalysisWarning {
  code: string
  message: string
  file?: string
}

export interface AnalysisSummary
{
  analyzedAt: string
  /** Analyzer/clustering version, so stale saved graphs can be detected. */
  analyzerVersion: string
  durationMs: number
  fileCount: number
  /** Files that were discovered but not parsed (unsupported language). */
  skippedFileCount: number
  loc: number
  languages: Record<string, number>
  /** Source roots the analyzer decided to treat as code roots, e.g. `['src']`. */
  sourceRoots: string[]
  /** `true` when an LLM contributed descriptions / responsibilities. */
  aiAssisted: boolean
  warnings: AnalysisWarning[]
}

export interface ArchitectureGraph {
  schemaVersion: number
  /** Absolute path of the analyzed project. */
  projectRoot: string
  /** Display name of the project (from package.json, else the folder name). */
  name: string
  modules: ModuleNode[]
  edges: DependencyEdge[]
  /** Source files the analyzer could not attribute to any module. */
  unassignedFiles: string[]
  /** Monotonic counter bumped by every applied operation. */
  version: number
  analysis: AnalysisSummary
  program: ProgramModel
}

export interface NodePosition {
  x: number
  y: number
}

/**
 * Visual state. Changing anything in here is a view-only change and never
 * produces a code transformation.
 */
export interface GraphLayout {
  schemaVersion: number
  positions: Record<ModuleId, NodePosition>
  /** Which modules are expanded to show their files in the canvas. */
  expanded: Record<ModuleId, boolean>
  /** `force` is the default auto-layout; `manual` once a node is dragged. */
  algorithm: 'force' | 'layered' | 'manual'
  version: number
}

export const ARCHITECTURE_SCHEMA_VERSION = 2
export const LAYOUT_SCHEMA_VERSION = 1
