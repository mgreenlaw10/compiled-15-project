export type SymbolId = string
export type ContractId = string
export type Accessibility = 'public' | 'protected' | 'private' | 'package' | 'internal' | 'unknown'
export type ProgramSymbolKind = 'function' | 'method' | 'constructor' | 'class' | 'struct' | 'union' |
  'record' | 'interface' | 'enum' | 'type' | 'variable' | 'field'
export interface SourceRange {
  file: string
  start: number
  end: number
  line: number
  endLine: number
  column: number
}
export interface Parameter {
  name: string
  type: string
  optional: boolean
  variadic: boolean
  defaultValue?: string
  source?: SourceRange
}
export interface ProgramField {
  id: SymbolId
  name: string
  type: string
  accessibility: Accessibility
  source: SourceRange
  version: number
}
export interface ProgramSymbol {
  id: SymbolId
  name: string
  qualifiedName: string
  scope: string
  kind: ProgramSymbolKind
  language: string
  accessibility: Accessibility
  linkage: 'external' | 'internal' | 'none'
  publiclyAccessible: boolean
  signature: string
  parameters: Parameter[]
  returnType: string
  exceptions: string[]
  fields: ProgramField[]
  bases: string[]
  description: string
  descriptionOrigin: 'source' | 'heuristic' | 'ai' | 'user'
  source: SourceRange
  nameSource: SourceRange
  signatureSource: SourceRange
  bodySource?: SourceRange
  /** Exact declaration text permits stale-source detection before refactoring. */
  sourceText: string
  definition: boolean
  version: number
}
export type RelationshipKind = 'call' | 'type' | 'field_read' | 'field_write' | 'inherits' |
  'implements' | 'implementation_of' | 'shared_state' | 'callback' | 'event' | 'contract'
export interface SymbolRelationship {
  id: string
  kind: RelationshipKind
  fromSymbolId: SymbolId
  toSymbolId?: SymbolId
  toFieldId?: SymbolId
  contractId?: ContractId
  targetName: string
  source: SourceRange
  resolution: 'resolved' | 'potential' | 'unresolved'
  targetSource?: SourceRange
  origin: 'static' | 'heuristic' | 'ai' | 'user'
  assumptions: string[]
  conditional: boolean
  version: number
}
export type ContractCategory = 'precondition' | 'postcondition' | 'invariant' | 'side_effect' |
  'error_behavior' | 'ordering' | 'concurrency' | 'idempotency' | 'performance' | 'ownership' | 'lifecycle'
export interface BehavioralContract {
  id: ContractId
  moduleId?: string
  symbolId?: SymbolId
  fieldId?: SymbolId
  category: ContractCategory
  description: string
  expression?: string
  provenance: 'explicit' | 'statically_established' | 'inferred' | 'user_specified'
  verification: 'unverified' | 'runtime_checked' | 'test_supported' | 'proven'
  verificationNote: string
  evidence: SourceRange[]
  enforcement?: { kind: 'assertion' | 'guard'; expressionSource: SourceRange }
  version: number
}
export interface FileRelationship {
  fromFile: string
  toFile: string
  kind: 'import' | 'include'
  specifier: string
  line: number
}
export interface ProgramModel {
  symbols: ProgramSymbol[]
  relationships: SymbolRelationship[]
  contracts: BehavioralContract[]
  fileRelationships: FileRelationship[]
  assumptions: string[]
}
export interface ModuleComponents {
  interface: { functionIds: SymbolId[]; typeIds: SymbolId[] }
  implementation: { symbolIds: SymbolId[]; observedDescription: string; desiredDescription: string | null;
    descriptionOrigin: 'heuristic' | 'ai' | 'user' }
  dataStructures: { symbolIds: SymbolId[] }
  contracts: { contractIds: ContractId[] }
}
export interface Impact {
  moduleId: string
  symbolId?: string
  contractId?: string
  severity: 'breaking' | 'potential' | 'unverified'
  reason: string
  evidence: SourceRange[]
}
