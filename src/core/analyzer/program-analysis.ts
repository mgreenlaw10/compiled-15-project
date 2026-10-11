import type { Node } from './languages/tree-sitter'
import { analyzeSyntax, walk } from './languages/tree-sitter'
import type { AnalyzerContext, FileAnalysis } from './languages'
import type { DiscoveredFile } from './scan'
import type { Accessibility, BehavioralContract, ContractCategory, Parameter, ProgramModel, ProgramSymbol,
  ProgramSymbolKind, SourceRange, SymbolRelationship } from '../../shared/types/program'
import { emptyProgram, stableId, isCallable, isDataType } from '../../shared/graph/program'

interface Declaration { symbol: ProgramSymbol; node: Node; file: DiscoveredFile }
interface Reference { node: Node; owner: ProgramSymbol; name: string; receiver?: string; args?: Node[];
  kind: SymbolRelationship['kind']; conditional: boolean }
const declarationKinds: Record<string, ProgramSymbolKind> = {
  class_declaration: 'class', class_definition: 'class', class_specifier: 'class',
  struct_specifier: 'struct', union_specifier: 'union', record_declaration: 'record',
  interface_declaration: 'interface', annotation_type_declaration: 'interface', enum_declaration: 'enum', enum_specifier: 'enum',
  type_alias_declaration: 'type', type_definition: 'type', alias_declaration: 'type',
  function_declaration: 'function', function_definition: 'function', method_declaration: 'method',
  method_definition: 'method', constructor_declaration: 'constructor'
}
const fieldKinds = new Set(['field_declaration', 'public_field_definition', 'property_signature', 'field_definition'])
const commentKinds = new Set(['comment', 'block_comment', 'line_comment'])
const range = (node: Node, file: string): SourceRange => ({ file, start: node.startIndex, end: node.endIndex,
  line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, column: node.startPosition.column + 1 })
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const field = (node: Node, name: string): Node | null => node.childForFieldName(name)
function declarator(node: Node | null): Node | null {
  if (!node) return null
  if (['identifier', 'type_identifier', 'field_identifier', 'property_identifier', 'qualified_identifier', 'operator_name', 'destructor_name'].includes(node.type)) return node
  return declarator(field(node, 'declarator') ?? field(node, 'name') ?? node.firstNamedChild)
}
function functionNode(node: Node): Node | undefined {
  return [...walk(node)].find((n) => n.type === 'function_declarator')
}
function cleanType(text: string | undefined): string { return flat((text ?? '').replace(/^:\s*/, '')) || 'unknown' }
function parameters(node: Node, file: string): Parameter[] {
  const params = field(node, 'parameters') ?? (functionNode(node) ? field(functionNode(node)!, 'parameters') : null)
  if (!params) return []
  return params.namedChildren.filter((n) => !commentKinds.has(n.type) && !(n.type === 'parameter_declaration' && n.text === 'void'))
    .map((n) => {
      const name = field(n, 'name') ?? field(n, 'pattern') ?? declarator(field(n, 'declarator')) ??
        n.namedChildren.find((c) => c.type === 'identifier') ?? (n.type === 'identifier' ? n : null)
      const type = field(n, 'type')
      let typeText = cleanType(type?.text)
      if (type && name && n.text.includes('*')) typeText += n.text.slice(type.endIndex - n.startIndex, name.startIndex - n.startIndex).trim()
      return { name: name?.text ?? '', type: typeText, optional: n.type.includes('optional'),
        variadic: n.type.includes('spread') || n.type.includes('splat') || n.text.includes('...'),
        ...(field(n, 'value') ? { defaultValue: field(n, 'value')!.text } : {}), source: range(n, file) }
    })
}
function precedingDocNode(node: Node, content: string): Node | null {
  let current: Node | null = node
  while (current?.parent && ['export_statement', 'decorated_definition', 'template_declaration'].includes(current.parent.type)) current = current.parent
  const previous = current?.previousNamedSibling
  if (previous && commentKinds.has(previous.type) && content.slice(previous.endIndex, current!.startIndex).trim() === '') return previous
  const body = field(node, 'body')
  if (body?.firstNamedChild?.type === 'expression_statement' && body.firstNamedChild.firstNamedChild?.type === 'string') return body.firstNamedChild
  return null
}
const precedingDoc = (node: Node, content: string): string => precedingDocNode(node, content)?.text ?? ''
function visibility(node: Node, language: string, name: string, parent?: ProgramSymbol): Accessibility {
  const modifiers = node.namedChildren.filter((n) => ['modifiers', 'accessibility_modifier', 'storage_class_specifier'].includes(n.type)).map((n) => n.text).join(' ')
  if (/\bprivate\b/.test(modifiers) || name.startsWith('#')) return 'private'
  if (/\bprotected\b/.test(modifiers)) return 'protected'
  if (/\bpublic\b/.test(modifiers)) return 'public'
  if (language === 'java') return parent?.kind === 'interface' ? 'public' : 'package'
  if (language === 'python') return name.startsWith('_') ? 'private' : 'public'
  if (['c', 'cpp'].includes(language)) {
    if (/\bstatic\b/.test(modifiers) && !parent) return 'internal'
    if (parent && ['class', 'struct', 'union'].includes(parent.kind)) {
      let access = parent.kind === 'class' ? 'private' : 'public'
      for (const sibling of node.parent?.namedChildren ?? []) {
        if (sibling.startIndex >= node.startIndex) break
        if (sibling.type === 'access_specifier') access = sibling.text
      }
      return access as Accessibility
    }
    return 'public'
  }
  if (parent) return 'public'
  return node.parent?.type === 'export_statement' || /\bexport\b/.test(node.text.slice(0, 30)) ? 'public' : 'internal'
}
function conditional(node: Node): boolean {
  let parent = node.parent
  while (parent) {
    if (parent.type.startsWith('preproc_if')) return true
    parent = parent.parent
  }
  return false
}

/** Source syntax facts and conservative lexical binding, never a behavioral proof. */
export async function analyzeProgram(files: DiscoveredFile[], analyses: FileAnalysis[], context: AnalyzerContext): Promise<ProgramModel> {
  const model = emptyProgram()
  model.assumptions = [
    'References resolve from lexical declarations, declared receiver types and analyzed imports/includes; no runtime dispatch or classpath execution.',
    'Ambiguous overloads, dynamic calls and function pointers remain unresolved or potential.',
    'Preprocessor branches are not evaluated; their relationships are conditional.',
    'Documentation and assertions are explicit specifications, not formally proven guarantees.'
  ]
  const analysisByFile = new Map(analyses.map((a) => [a.path, a]))
  for (const a of analyses) for (const imp of a.imports) if (imp.resolvedPath && !imp.external) {
    model.fileRelationships.push({ fromFile: a.path, toFile: imp.resolvedPath,
      kind: ['c', 'cpp'].includes(a.language) ? 'include' : 'import', specifier: imp.specifier, line: imp.line })
  }
  const declarations: Declaration[] = []
  const references: Reference[] = []
  const variables: { name: string; type: string; file: string; owner?: string; start: number }[] = []
  const aliases = new Map<string, Map<string, string>>()
  const packageOf = new Map<string, string>()
  const usedIds = new Map<string, number>()
  const idFor = (s: Omit<ProgramSymbol, 'id'>): string => {
    const key = `${s.source.file}:${s.qualifiedName}:${s.kind}:${s.parameters.map((p) => p.type).join(',')}:${s.definition}`
    const ordinal = usedIds.get(key) ?? 0
    usedIds.set(key, ordinal + 1)
    return stableId('symbol', `${key}:${ordinal}`)
  }
  const grammar = (f: DiscoveredFile): 'java' | 'python' | 'c' | 'cpp' | 'typescript' | 'tsx' | 'javascript' =>
    f.language === 'java' ? 'java' : f.language === 'python' ? 'python' : f.language === 'c' && f.path.endsWith('.c') ? 'c' :
      ['c', 'cpp'].includes(f.language) ? 'cpp' : f.path.endsWith('.tsx') ? 'tsx' : f.language.startsWith('javascript') ? 'javascript' : 'typescript'
  await analyzeSyntax(files, context, grammar, (parsed) => {
    for (const { file, root } of parsed) {
      const language = file.language.startsWith('typescript') ? 'typescript' : file.language.startsWith('javascript') ? 'javascript' : file.language
      const pkg = root.namedChildren.find((n) => n.type === 'package_declaration')?.namedChildren.find((n) => ['identifier', 'scoped_identifier'].includes(n.type))?.text ?? ''
      packageOf.set(file.path, pkg)
      const fileAliases = new Map<string, string>()
      aliases.set(file.path, fileAliases)
      for (const n of walk(root)) {
        if (['import_specifier', 'aliased_import'].includes(n.type)) {
          const original = field(n, 'name')?.text
          if (original) fileAliases.set(field(n, 'alias')?.text ?? original, original)
        }
        if (n.type === 'namespace_import') {
          const name = n.namedChildren.find((c) => c.type === 'identifier')?.text
          const source = n.parent && field(n.parent, 'source')?.text
          if (name && source) fileAliases.set(name, source.slice(1, -1))
        }
        if (n.type === 'import_statement' && language === 'python') for (const imported of n.childrenForFieldName('name')) {
          const original = imported.type === 'aliased_import' ? field(imported, 'name')?.text : imported.text
          if (original) fileAliases.set(field(imported, 'alias')?.text ?? original, original)
        }
      }
      const collect = (node: Node, parent?: ProgramSymbol, namespace = pkg): void => {
        if (commentKinds.has(node.type)) return
        let kind: ProgramSymbolKind | undefined = declarationKinds[node.type]
        let nameNode = field(node, 'name')
        let body = field(node, 'body')
        if (node.type === 'type_definition') {
          const underlying = field(node, 'type')
          if (underlying && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(underlying.type) && field(underlying, 'body')) {
            kind = declarationKinds[underlying.type]
            body = field(underlying, 'body')
          }
        }
        if (['struct_specifier', 'union_specifier', 'enum_specifier'].includes(node.type) &&
          (!body || node.parent?.type === 'type_definition')) kind = undefined
        if (node.type === 'declaration' && functionNode(node)) {
          const fn = functionNode(node)!
          const inner = field(fn, 'declarator')
          if (inner && ['identifier', 'qualified_identifier'].includes(inner.type)) { kind = 'function'; nameNode = declarator(inner) }
        }
        if (node.type === 'declaration' && !kind && (!parent || !isCallable(parent)) && ['c', 'cpp'].includes(language)) {
          const declared = node.childrenForFieldName('declarator')
          if (declared.length === 1) { kind = parent && isDataType(parent) ? 'field' : 'variable'; nameNode = declarator(declared[0]) }
        }
        if (node.type === 'function_definition' && !nameNode) nameNode = declarator(field(node, 'declarator'))
        if (node.type === 'type_definition' && !nameNode) nameNode = declarator(field(node, 'declarator'))
        if (node.type === 'function_definition' && language === 'python' && parent?.kind === 'class') kind = 'method'
        if (node.type === 'method_definition' && nameNode?.text === 'constructor') kind = 'constructor'
        if (node.type === 'variable_declarator' && !isCallable(parent ?? { kind: 'variable' } as ProgramSymbol)) {
          const value = field(node, 'value')
          if (value && ['arrow_function', 'function_expression'].includes(value.type)) { kind = 'function'; nameNode = field(node, 'name'); body = field(value, 'body') }
          else if (!parent || parent.kind === 'class') { kind = parent ? 'field' : 'variable'; nameNode = field(node, 'name') }
        }
        if (fieldKinds.has(node.type) && parent && isDataType(parent)) {
          const type = cleanType(field(node, 'type')?.text)
          const names = node.type === 'field_declaration' ? node.childrenForFieldName('declarator').map((n) => field(n, 'name') ?? declarator(n)) : [field(node, 'name')]
          for (const name of names.filter((n): n is Node => !!n)) {
            const accessibility = visibility(node, language, name.text, parent)
            const fieldId = stableId('field', `${parent.id}:${name.text}`)
            const fieldType = type + (node.text.includes('*') ? '*' : '')
            parent.fields.push({ id: fieldId, name: name.text, type: fieldType, accessibility, source: range(name, file.path), version: 1 })
            variables.push({ name: name.text, type: fieldType, file: file.path, owner: parent.id, start: node.startIndex })
          }
          for (const child of walk(node)) collectReference(child, parent, references)
          return
        }
        if (language === 'python' && node.type === 'expression_statement' && parent?.kind === 'class') {
          const assignment = node.firstNamedChild
          const left = assignment && field(assignment, 'left')
          if (left?.type === 'identifier') parent.fields.push({ id: stableId('field', `${parent.id}:${left.text}`), name: left.text,
            type: cleanType(field(assignment!, 'type')?.text), accessibility: visibility(node, language, left.text, parent), source: range(left, file.path), version: 1 })
        }
        if (language === 'python' && node.type === 'assignment' && parent?.kind === 'method') {
          const left = field(node, 'left')
          const structure = model.symbols.find((s) => s.kind === 'class' && s.qualifiedName === parent.scope && s.source.file === file.path)
          const attribute = left?.type === 'attribute' && field(left, 'object')?.text === 'self' ? field(left, 'attribute') : null
          if (structure && attribute && !structure.fields.some((f) => f.name === attribute.text)) {
            const declaredType = field(node, 'type')
            structure.fields.push({ id: stableId('field', `${structure.id}:${attribute.text}`), name: attribute.text,
              type: cleanType(declaredType?.text), accessibility: visibility(node, language, attribute.text, structure), source: range(attribute, file.path), version: 1 })
          }
        }
        let owner = parent
        if (kind && nameNode && !(kind === 'type' && ['struct_specifier', 'union_specifier'].includes(node.parent?.type ?? ''))) {
          const fullName = nameNode.text.replaceAll('::', '.')
          const name = fullName.split('.').at(-1)!
          const scope = fullName.includes('.') ? fullName.slice(0, fullName.lastIndexOf('.')) : parent?.qualifiedName ?? namespace
          const qualifiedName = scope ? `${scope}.${name}` : name
          const parameterNode = node.type === 'variable_declarator' ? field(node, 'value') ?? node : node
          const params = parameters(parameterNode, file.path)
          const accessibility = visibility(node, language, name, parent)
          const source = range(node, file.path)
          const signatureEnd = body?.startIndex ?? node.endIndex
          const signatureSource = { ...source, end: signatureEnd, endLine: body?.startPosition.row ? body.startPosition.row + 1 : source.endLine }
          const publicParent = !parent || parent.publiclyAccessible
          const s: ProgramSymbol = { id: '', name, qualifiedName, scope, kind, language,
            accessibility, linkage: ['c', 'cpp'].includes(language) ? accessibility === 'internal' ? 'internal' : 'external' : 'none',
            publiclyAccessible: accessibility === 'public' && publicParent,
            signature: flat(file.content.slice(node.startIndex, signatureEnd)), parameters: params,
            returnType: cleanType(field(node, 'return_type')?.text ?? field(node, 'type')?.text ??
              (isCallable({ kind } as ProgramSymbol) && language === 'python' ? undefined : 'void')),
            exceptions: node.namedChildren.find((n) => n.type === 'throws')?.namedChildren.map((n) => n.text) ?? [],
            fields: [], bases: [], description: precedingDoc(node, file.content), descriptionOrigin: 'source',
            source, nameSource: range(nameNode, file.path), signatureSource, sourceText: node.text,
            ...(body ? { bodySource: range(body, file.path) } : {}), definition: !!body || isDataType({ kind } as ProgramSymbol), version: 1 }
          s.id = idFor(s)
          // Record components are fields, not only constructor parameters.
          if (kind === 'record') for (const p of params) if (p.source) s.fields.push({ id: stableId('field', `${s.id}:${p.name}`),
            name: p.name, type: p.type, accessibility: 'private', source: p.source, version: 1 })
          const baseNodes = node.namedChildren.filter((n) => ['superclass', 'super_interfaces', 'extends_type_clause', 'class_heritage', 'base_class_clause'].includes(n.type))
          s.bases = baseNodes.flatMap((n) => [...walk(n)].filter((c) => ['type_identifier', 'identifier'].includes(c.type)).map((c) => c.text))
          declarations.push({ symbol: s, node, file })
          model.symbols.push(s)
          params.forEach((p) => variables.push({ name: p.name, type: p.type, file: file.path, owner: s.id, start: node.startIndex }))
          for (const parameter of (field(parameterNode, 'parameters') ?? (functionNode(parameterNode) && field(functionNode(parameterNode)!, 'parameters')))?.namedChildren ?? []) {
            const type = field(parameter, 'type')
            if (type && language === 'python') references.push({ node: type, owner: s, name: type.text, kind: 'type', conditional: false })
          }
          owner = s
          extractContracts(s, node, file, model)
        }
        if (owner && isCallable(owner)) {
          if (node.type === 'variable_declarator') {
            const name = field(node, 'name')?.text
            const type = field(node, 'type') ?? (node.parent && field(node.parent, 'type'))
            if (name) variables.push({ name, type: cleanType(type?.text), file: file.path, owner: owner.id, start: node.startIndex })
          }
          if (node.type === 'declaration' && !kind) for (const decl of node.childrenForFieldName('declarator')) {
            const name = declarator(decl)?.text
            if (name) variables.push({ name, type: cleanType(field(node, 'type')?.text), file: file.path, owner: owner.id, start: node.startIndex })
          }
        }
        if (owner) collectReference(node, owner, references)
        const nextNamespace = node.type === 'namespace_definition' ? [namespace, field(node, 'name')?.text].filter(Boolean).join('.') : namespace
        for (const child of node.namedChildren) collect(child, owner, nextNamespace)
      }
      collect(root)
    }
    for (const declaration of declarations.filter((d) => isCallable(d.symbol))) {
      const enclosingType = model.symbols.find((s) => isDataType(s) && s.qualifiedName === declaration.symbol.scope && s.source.file === declaration.file.path)
      const globals = model.symbols.filter((s) => s.kind === 'variable' && s.source.file === declaration.file.path)
      const body = field(declaration.node, 'body')
      if (!body) continue
      for (const node of walk(body)) {
        if (node.type !== 'identifier' || variables.some((v) => v.owner === declaration.symbol.id && v.name === node.text)) continue
        if (node.parent && (field(node.parent, 'name')?.id === node.id || field(node.parent, 'function')?.id === node.id || field(node.parent, 'object')?.id === node.id)) continue
        const ownField = enclosingType?.fields.some((f) => f.name === node.text)
        const global = globals.some((s) => s.name === node.text)
        if (!ownField && !global) continue
        const write = node.parent && ['assignment_expression', 'augmented_assignment', 'update_expression'].includes(node.parent.type) &&
          (field(node.parent, 'left')?.id === node.id || node.parent.type === 'update_expression')
        references.push({ node, owner: declaration.symbol, name: node.text, kind: global ? 'shared_state' : write ? 'field_write' : 'field_read', conditional: conditional(node) })
      }
    }
    resolveReferences(model, declarations, references, variables, aliases, packageOf, analysisByFile)
  })
  return model
}

function extractContracts(symbol: ProgramSymbol, node: Node, file: DiscoveredFile, model: ProgramModel): void {
  const tags: Record<string, ContractCategory> = { precondition: 'precondition', requires: 'precondition',
    postcondition: 'postcondition', ensures: 'postcondition', invariant: 'invariant', 'side-effect': 'side_effect',
    throws: 'error_behavior', concurrency: 'concurrency', ownership: 'ownership', lifecycle: 'lifecycle',
    idempotent: 'idempotency', ordering: 'ordering', performance: 'performance' }
  const count = new Map<ContractCategory, number>()
  const add = (category: ContractCategory, description: string, evidence: SourceRange[], expression?: string,
    enforcement?: BehavioralContract['enforcement']): void => {
    const ordinal = count.get(category) ?? 0; count.set(category, ordinal + 1)
    model.contracts.push({ id: stableId('contract', `${symbol.id}:${category}:${ordinal}`), symbolId: symbol.id,
      category, description, ...(expression ? { expression } : {}), provenance: 'explicit', verification: 'unverified',
      verificationNote: 'Declared in source. Its presence does not prove the implementation satisfies it.', evidence,
      ...(enforcement ? { enforcement } : {}), version: 1 })
  }
  for (const match of symbol.description.matchAll(/@(precondition|requires|postcondition|ensures|invariant|side-effect|throws|concurrency|ownership|lifecycle|idempotent|ordering|performance)\s+([^\r\n@]+)/g)) {
    const text = match[2].replace(/\*\/$/, '').trim()
    const doc = precedingDocNode(node, file.content)
    add(tags[match[1]], text, [doc ? range(doc, file.path) : symbol.source], ['precondition', 'requires', 'postcondition', 'ensures', 'invariant'].includes(match[1]) ? text : undefined)
  }
  const body = field(node, 'body')
  if (!body || !isCallable(symbol)) return
  const first = body.namedChildren.find((n) => !commentKinds.has(n.type))
  for (const n of walk(body)) {
    let enclosing = n.parent
    let nested = false
    while (enclosing && enclosing.id !== body.id) {
      if (['function_definition', 'function_declaration', 'arrow_function', 'lambda', 'lambda_expression', 'method_declaration', 'class_definition'].includes(enclosing.type)) { nested = true; break }
      enclosing = enclosing.parent
    }
    if (nested) continue
    if (n.type === 'if_statement' && n.id === first?.id && ['java', 'javascript', 'typescript'].includes(symbol.language)) {
      let condition = field(n, 'condition')
      while (condition?.type === 'parenthesized_expression') condition = condition.firstNamedChild
      const consequence = field(n, 'consequence')
      const statements = consequence?.namedChildren.filter((c) => !commentKinds.has(c.type)) ?? []
      const rejects = consequence?.type === 'throw_statement' || consequence?.type === 'block' && statements.length === 1 && statements[0].type === 'throw_statement'
      if (condition?.type === 'unary_expression' && condition.children.some((c) => c.text === '!') && consequence &&
        rejects) {
        let requirement = field(condition, 'argument') ?? field(condition, 'operand') ?? condition.firstNamedChild
        while (requirement?.type === 'parenthesized_expression') requirement = requirement.firstNamedChild
        if (requirement) add('precondition', requirement.text, [range(n, file.path)], requirement.text,
          { kind: 'guard', expressionSource: range(requirement, file.path) })
      }
    }
    let expression: Node | undefined
    if (n.type === 'assert_statement') expression = n.namedChildren[0]
    else if (n.type === 'call_expression' && field(n, 'function')?.text === 'assert') expression = field(n, 'arguments')?.namedChildren[0]
    if (expression) {
      const category = first?.id === n.id || n.parent?.type === 'expression_statement' && n.parent.id === first?.id ? 'precondition' : 'invariant'
      add(category, expression.text, [range(n, file.path)], expression.text,
        { kind: 'assertion', expressionSource: range(expression, file.path) })
    }
    if (['throw_statement', 'raise_statement'].includes(n.type)) add('error_behavior', flat(n.text), [range(n, file.path)])
  }
}

function collectReference(node: Node, owner: ProgramSymbol, references: Reference[]): void {
  let name: string | undefined
  let receiver: string | undefined
  let args: Node[] | undefined
  let kind: SymbolRelationship['kind'] | undefined
  if (node.type === 'method_invocation') {
    name = field(node, 'name')?.text; receiver = field(node, 'object')?.text; args = field(node, 'arguments')?.namedChildren; kind = 'call'
  } else if (['call_expression', 'call'].includes(node.type)) {
    const fn = field(node, 'function')
    if (!fn || fn.text === 'assert') return
    name = field(fn, 'property')?.text ?? field(fn, 'attribute')?.text ?? field(fn, 'field')?.text ?? fn.text
    receiver = field(fn, 'object')?.text ?? field(fn, 'argument')?.text
    args = field(node, 'arguments')?.namedChildren; kind = 'call'
  } else if (['field_access', 'field_expression', 'attribute', 'member_expression'].includes(node.type)) {
    if (node.parent && ['call_expression', 'call'].includes(node.parent.type) && field(node.parent, 'function')?.id === node.id) return
    name = field(node, 'field')?.text ?? field(node, 'attribute')?.text ?? field(node, 'property')?.text
    receiver = field(node, 'object')?.text ?? field(node, 'argument')?.text
    const parent = node.parent
    kind = parent && ['assignment_expression', 'assignment', 'augmented_assignment'].includes(parent.type) && field(parent, 'left')?.id === node.id ? 'field_write' : 'field_read'
  } else if (['type_identifier', 'scoped_type_identifier'].includes(node.type)) {
    if (node.parent?.type === 'scoped_type_identifier') return
    if (field(node.parent ?? node, 'name')?.id === node.id) return
    name = node.text; kind = owner.bases.includes(node.text) ? 'inherits' : 'type'
  }
  if (name && kind) references.push({ node, owner, name, receiver, args, kind, conditional: conditional(node) })
}

function resolveReferences(model: ProgramModel, declarations: Declaration[], refs: Reference[],
  variables: { name: string; type: string; file: string; owner?: string; start: number }[],
  aliases: Map<string, Map<string, string>>, packages: Map<string, string>, analyses: Map<string, FileAnalysis>): void {
  const symbols = model.symbols
  const byId = new Map(symbols.map((s) => [s.id, s]))
  const knownFiles = new Set(symbols.map((s) => s.source.file))
  const reachable = (file: string): Set<string> => {
    const result = new Set([file]); const queue = [file]
    while (queue.length) {
      const current = queue.pop()!
      for (const rel of model.fileRelationships.filter((r) => r.fromFile === current)) {
        if (!result.has(rel.toFile)) { result.add(rel.toFile); queue.push(rel.toFile) }
      }
    }
    return result
  }
  const reach = new Map([...knownFiles].map((f) => [f, reachable(f)]))
  const typesFor = (name: string, from: ProgramSymbol): ProgramSymbol[] => {
    const simple = cleanType(name).replace(/<.*>/g, '').replace(/\b(const|struct|class|union)\s+/g, '').replace(/[\s*&[\]]/g, '')
    const mapped = aliases.get(from.source.file)?.get(simple) ?? simple
    return symbols.filter((s) => isDataType(s) && (s.qualifiedName === mapped || s.name === mapped) &&
      (reach.get(from.source.file)?.has(s.source.file) || s.language === 'java' && packages.get(from.source.file) === packages.get(s.source.file)))
  }
  const receiverType = (ref: Reference): ProgramSymbol[] => {
    const parent = symbols.find((s) => isDataType(s) && s.qualifiedName === ref.owner.scope && s.source.file === ref.owner.source.file)
    if (['this', 'self', 'cls'].includes(ref.receiver ?? '')) return parent ? [parent] : []
    const vars = variables.filter((v) => v.file === ref.owner.source.file && v.name === ref.receiver &&
      (v.owner === ref.owner.id || v.owner === parent?.id) && v.start <= ref.node.startIndex)
    const best = vars.filter((v) => v.owner === ref.owner.id).at(-1) ?? vars.at(-1)
    if (best) return typesFor(best.type, ref.owner)
    return ref.receiver ? typesFor(ref.receiver, ref.owner) : parent ? [parent] : []
  }
  const argumentType = (node: Node, ref: Reference): string | null => {
    if (['string_literal', 'string'].includes(node.type)) return ref.owner.language === 'java' ? 'String' : 'string'
    if (['number_literal', 'decimal_integer_literal', 'integer', 'number'].includes(node.type)) return ref.owner.language === 'java' ? 'int' : 'number'
    if (['true', 'false'].includes(node.type)) return 'boolean'
    if (node.type === 'identifier') return variables.find((v) => v.name === node.text && v.owner === ref.owner.id)?.type ?? null
    return null
  }
  for (const ref of refs) {
    const file = ref.owner.source.file
    const accessible = reach.get(file) ?? new Set([file])
    const name = aliases.get(file)?.get(ref.name) ?? ref.name
    let candidates: ProgramSymbol[] = []
    let targetField: string | undefined
    if (ref.kind === 'call') {
      const receiver = receiverType(ref)
      if (ref.receiver) candidates = symbols.filter((s) => isCallable(s) && s.name === name && receiver.some((t) => t.qualifiedName === s.scope))
      else {
        candidates = symbols.filter((s) => isCallable(s) && s.name === name &&
          (s.scope === ref.owner.scope && s.source.file === file || accessible.has(s.source.file) &&
            (s.linkage !== 'internal' || s.source.file === file)))
        if (ref.owner.language === 'java') candidates = candidates.filter((s) => s.scope === ref.owner.scope || accessible.has(s.source.file))
        if (variables.some((v) => v.name === ref.name && v.owner === ref.owner.id)) candidates = []
      }
      if (ref.receiver && !receiver.length && ['python', 'typescript', 'javascript'].includes(ref.owner.language) &&
        !variables.some((v) => v.name === ref.receiver && v.owner === ref.owner.id)) {
        const qualifier = aliases.get(file)?.get(ref.receiver) ?? ref.receiver
        const imports = analyses.get(file)?.imports.filter((i) => i.resolvedPath && (i.specifier === qualifier ||
          i.symbols.includes(qualifier) && i.resolvedPath.split('/').at(-1)?.replace(/\.pyi?$/, '') === qualifier)) ?? []
        const targetFiles = new Set(imports.map((i) => i.resolvedPath!))
        candidates = symbols.filter((s) => isCallable(s) && s.name === name && !s.scope && targetFiles.has(s.source.file))
      }
      candidates = candidates.filter((s) => s.parameters.filter((p) => !['self', 'cls'].includes(p.name) && !p.optional && !p.variadic).length <= (ref.args?.length ?? 0) &&
        (s.parameters.some((p) => p.variadic) || s.parameters.filter((p) => !['self', 'cls'].includes(p.name)).length >= (ref.args?.length ?? 0)))
      if (candidates.length > 1 && ref.owner.language === 'java') {
        const matched = candidates.filter((s) => s.parameters.every((p, i) => !ref.args?.[i] || !argumentType(ref.args[i], ref) || p.type === argumentType(ref.args[i], ref)))
        if (matched.length) candidates = matched
      }
      // C declarations and definitions are the same binding when signature types agree.
      if (['c', 'cpp'].includes(ref.owner.language)) {
        const signatures = new Set(candidates.map((s) => `${s.qualifiedName}(${s.parameters.map((p) => p.type).join(',')})`))
        if (signatures.size === 1) {
          const definitions = symbols.filter((s) => isCallable(s) && s.definition && s.name === name &&
            `${s.qualifiedName}(${s.parameters.map((p) => p.type).join(',')})` === [...signatures][0] && (s.linkage !== 'internal' || s.source.file === file))
          if (definitions.length === 1) candidates = definitions
          else if (candidates.length > 1) candidates = candidates.filter((s) => s.definition)
        }
      }
    } else if (ref.kind.startsWith('field_')) {
      const receiver = receiverType(ref)
      candidates = receiver.filter((s) => s.fields.some((f) => f.name === name))
      if (candidates.length === 1) targetField = candidates[0].fields.find((f) => f.name === name)?.id
    } else if (ref.kind === 'shared_state') candidates = symbols.filter((s) => s.kind === 'variable' && s.name === name && accessible.has(s.source.file))
    else candidates = typesFor(name, ref.owner)
    const unique = [...new Map(candidates.map((s) => [s.id, s])).values()]
    const resolution = unique.length === 1 ? 'resolved' : unique.length > 1 ? 'potential' : 'unresolved'
    const targets: (ProgramSymbol | undefined)[] = unique.length ? unique : [undefined]
    for (const target of targets) {
      const referenceName = field(ref.node, 'name') ?? field(ref.node, 'function') ?? field(ref.node, 'field') ??
        field(ref.node, 'attribute') ?? field(ref.node, 'property') ?? ref.node
      const targetNameNode = field(referenceName, 'property') ?? field(referenceName, 'attribute') ?? field(referenceName, 'field') ?? referenceName
      model.relationships.push({ id: stableId('relationship', `${ref.owner.id}:${ref.kind}:${ref.node.startIndex}:${target?.id ?? name}`),
        kind: ref.kind, fromSymbolId: ref.owner.id, ...(target ? { toSymbolId: target.id } : {}), ...(targetField ? { toFieldId: targetField } : {}),
        targetName: target ? `${target.qualifiedName}${targetField ? `.${ref.name}` : ''}` : [ref.receiver, ref.name].filter(Boolean).join('.'), source: range(ref.node, file),
        targetSource: range(targetNameNode, file),
        resolution, origin: 'static', assumptions: resolution === 'resolved' ? ['Lexical binding; runtime overrides and indirect dispatch are not established.'] :
          [unique.length ? 'Multiple declarations match; no unique binding established.' : 'No analyzed declaration can be bound under the supported lexical rules.'],
        conditional: ref.conditional, version: 1 })
    }
    if (unique.length > 1) analyses.get(file)?.problems.push(`${file}:${ref.node.startPosition.row + 1}: ambiguous ${ref.kind} ${name}; recorded as potential dependencies.`)
  }
  // Match external-linkage prototypes and implementations across folders.
  for (const decl of declarations.filter((d) => isCallable(d.symbol) && !d.symbol.definition && d.symbol.linkage === 'external')) {
    const definitions = symbols.filter((s) => s.definition && s.linkage === 'external' && s.qualifiedName === decl.symbol.qualifiedName &&
      s.parameters.map((p) => p.type).join(',') === decl.symbol.parameters.map((p) => p.type).join(','))
    if (definitions.length !== 1) continue
    model.relationships.push({ id: stableId('relationship', `${definitions[0].id}:implements:${decl.symbol.id}`), kind: 'implementation_of',
      fromSymbolId: definitions[0].id, toSymbolId: decl.symbol.id, targetName: decl.symbol.qualifiedName, source: definitions[0].source,
      resolution: 'resolved', origin: 'static', assumptions: ['External linkage and matching declaration signature.'], conditional: false, version: 1 })
  }
  // Explicit reliance annotations identify specifications, not proven implementation behavior.
  for (const s of symbols) for (const match of s.description.matchAll(/@relies-on\s+([\w.]+):([\w_]+)/g)) {
    const declaration = declarations.find((d) => d.symbol.id === s.id)
    const doc = declaration && precedingDocNode(declaration.node, declaration.file.content)
    for (const c of model.contracts.filter((c) => c.category === match[2] && byId.get(c.symbolId ?? '')?.qualifiedName === match[1])) {
      model.relationships.push({ id: stableId('relationship', `${s.id}:contract:${c.id}`), kind: 'contract', fromSymbolId: s.id,
        toSymbolId: c.symbolId, contractId: c.id, targetName: `${match[1]}:${match[2]}`, source: doc ? range(doc, s.source.file) : s.source,
        resolution: 'resolved', origin: 'static', assumptions: ['Reliance explicitly documented; provider guarantee remains unverified.'], conditional: false, version: 1 })
    }
  }
}
