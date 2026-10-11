/**
 * Moving a single exported declaration from one module to another.
 *
 * This is the operation that makes "pull the session functions out of
 * Authentication" a real refactor rather than a file shuffle. It is entirely
 * compiler-aware:
 *
 *   - the declaration is lifted with its JSDoc intact,
 *   - the imports the declaration needs are reconstructed in the destination
 *     file, with specifiers recomputed for the new location,
 *   - anything it referenced that was local to the source file is exported and
 *     imported back,
 *   - every importer of the symbol (including barrel re-exports) is updated,
 *   - imports left unused in the source file are removed, so a project with
 *     `noUnusedLocals` still compiles.
 *
 * Where it cannot finish the job it says so and returns `partial`, listing
 * precisely what a human needs to look at.
 */

import {
  Node,
  SyntaxKind,
  type ImportDeclaration,
  type Project,
  type SourceFile
} from 'ts-morph'

import type {
  GraphOperation,
  MoveSymbolOperation
} from '../../../shared/types/operations'
import { findModule } from '../../../shared/graph/model'
import { join, normalizeRel } from '../../../shared/util/paths'
import { SpecifierResolver } from '../../analyzer/resolve'
import {
  buildSpecifier,
  createTransformProject,
  findImporters,
  inferQuoteKind,
  inferSpecifierStyle,
  rewriteSpecifier,
  type SpecifierStyle
} from '../imports'
import { failed, type OpContext, type OpResult, unsupported } from './context'

interface LocatedDeclaration {
  node: Node & {
    isExported(): boolean
    setIsExported(value: boolean): unknown
    remove(): unknown
  }
  kind: string
}

/** Finds the statement that declares `name` at the top level of a file. */
function locateDeclaration(
  sf: SourceFile,
  name: string
): LocatedDeclaration | null {
  const fn = sf.getFunction(name)
  if (fn) return { node: fn as LocatedDeclaration['node'], kind: 'function' }
  const cls = sf.getClass(name)
  if (cls) return { node: cls as LocatedDeclaration['node'], kind: 'class' }
  const iface = sf.getInterface(name)
  if (iface) return { node: iface as LocatedDeclaration['node'], kind: 'interface' }
  const alias = sf.getTypeAlias(name)
  if (alias) return { node: alias as LocatedDeclaration['node'], kind: 'type' }
  const en = sf.getEnum(name)
  if (en) return { node: en as LocatedDeclaration['node'], kind: 'enum' }

  for (const statement of sf.getVariableStatements()) {
    const declarations = statement.getDeclarations()
    if (!declarations.some((d) => d.getName() === name)) continue
    if (declarations.length > 1) return null // a shared `const a = 1, b = 2`
    return { node: statement as LocatedDeclaration['node'], kind: 'variable' }
  }
  return null
}

/** Top-level names a file declares itself. */
function localDeclarationNames(sf: SourceFile): Set<string> {
  const names = new Set<string>()
  for (const fn of sf.getFunctions()) if (fn.getName()) names.add(fn.getName()!)
  for (const cls of sf.getClasses()) if (cls.getName()) names.add(cls.getName()!)
  for (const i of sf.getInterfaces()) names.add(i.getName())
  for (const t of sf.getTypeAliases()) names.add(t.getName())
  for (const e of sf.getEnums()) names.add(e.getName())
  for (const s of sf.getVariableStatements()) {
    for (const d of s.getDeclarations()) names.add(d.getName())
  }
  return names
}

/**
 * Identifiers a node actually references, excluding property names, member
 * names, and its own declared name. Deliberately conservative: a false
 * positive only adds a redundant import, which the unused-import pass removes.
 */
function referencedIdentifiers(node: Node, ownName: string): Set<string> {
  const names = new Set<string>()
  for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const text = id.getText()
    if (text === ownName) continue
    const parent = id.getParent()
    if (!parent) continue

    // `obj.member` — `member` is not a free identifier.
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === id
    ) {
      continue
    }
    // `{ key: value }` — `key` is not a reference.
    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) continue
    // Declared names: parameters, properties, methods, local variables.
    if (
      (Node.isParameterDeclaration(parent) ||
        Node.isPropertySignature(parent) ||
        Node.isPropertyDeclaration(parent) ||
        Node.isMethodDeclaration(parent) ||
        Node.isMethodSignature(parent) ||
        Node.isVariableDeclaration(parent) ||
        Node.isFunctionDeclaration(parent) ||
        Node.isClassDeclaration(parent) ||
        Node.isInterfaceDeclaration(parent) ||
        Node.isTypeAliasDeclaration(parent) ||
        Node.isEnumDeclaration(parent) ||
        Node.isEnumMember(parent) ||
        Node.isBindingElement(parent)) &&
      'getNameNode' in parent &&
      (parent as { getNameNode(): Node | undefined }).getNameNode() === id
    ) {
      continue
    }
    // `label.qualified.Type` — only the leftmost part is a reference.
    if (Node.isQualifiedName(parent) && parent.getRight() === id) continue

    names.add(text)
  }
  return names
}

interface ImportBinding {
  declaration: ImportDeclaration
  specifier: string
  kind: 'default' | 'namespace' | 'named'
  /** The imported name (for `named`), i.e. before any `as` alias. */
  importedName: string
  localName: string
  typeOnly: boolean
}

function findImportBinding(sf: SourceFile, localName: string): ImportBinding | null {
  for (const decl of sf.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue()
    const typeOnly = decl.isTypeOnly()

    const def = decl.getDefaultImport()
    if (def && def.getText() === localName) {
      return {
        declaration: decl,
        specifier,
        kind: 'default',
        importedName: 'default',
        localName,
        typeOnly
      }
    }
    const ns = decl.getNamespaceImport()
    if (ns && ns.getText() === localName) {
      return {
        declaration: decl,
        specifier,
        kind: 'namespace',
        importedName: '*',
        localName,
        typeOnly
      }
    }
    for (const named of decl.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName()
      if (local === localName) {
        return {
          declaration: decl,
          specifier,
          kind: 'named',
          importedName: named.getName(),
          localName,
          typeOnly: typeOnly || named.isTypeOnly()
        }
      }
    }
  }
  return null
}

/** Counts references to a local name outside import declarations. */
function countReferences(sf: SourceFile, localName: string): number {
  let count = 0
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== localName) continue
    if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue
    count += 1
  }
  return count
}

/**
 * Drops imports the file no longer uses. Without this, moving a declaration out
 * of a file leaves imports behind that fail `noUnusedLocals`.
 */
export function removeUnusedImports(sf: SourceFile): string[] {
  const removed: string[] = []

  for (const decl of [...sf.getImportDeclarations()]) {
    const def = decl.getDefaultImport()
    const ns = decl.getNamespaceImport()
    const named = [...decl.getNamedImports()]

    // A bare `import './side-effect'` is never unused.
    if (!def && !ns && named.length === 0) continue

    if (def && countReferences(sf, def.getText()) === 0) {
      removed.push(def.getText())
      decl.removeDefaultImport()
    }
    if (ns && countReferences(sf, ns.getText()) === 0) {
      removed.push(ns.getText())
      decl.removeNamespaceImport()
    }
    for (const item of named) {
      const local = item.getAliasNode()?.getText() ?? item.getName()
      if (countReferences(sf, local) === 0) {
        removed.push(local)
        item.remove()
      }
    }

    const stillHasBindings =
      decl.getDefaultImport() !== undefined ||
      decl.getNamespaceImport() !== undefined ||
      decl.getNamedImports().length > 0
    if (!stillHasBindings) decl.remove()
  }

  return removed
}

/** Adds an import to `sf`, merging into an existing declaration when possible. */
function addImport(
  sf: SourceFile,
  options: {
    specifier: string
    named?: { name: string; alias?: string }[]
    defaultImport?: string
    namespaceImport?: string
    typeOnly?: boolean
  }
): void {
  const existing = sf
    .getImportDeclarations()
    .find(
      (d) =>
        d.getModuleSpecifierValue() === options.specifier &&
        d.isTypeOnly() === (options.typeOnly ?? false) &&
        d.getNamespaceImport() === undefined &&
        options.namespaceImport === undefined
    )

  if (existing) {
    for (const item of options.named ?? []) {
      const already = existing
        .getNamedImports()
        .some((n) => n.getName() === item.name)
      if (!already) existing.addNamedImport(item)
    }
    if (options.defaultImport && !existing.getDefaultImport()) {
      existing.setDefaultImport(options.defaultImport)
    }
    return
  }

  sf.addImportDeclaration({
    moduleSpecifier: options.specifier,
    ...(options.named ? { namedImports: options.named } : {}),
    ...(options.defaultImport ? { defaultImport: options.defaultImport } : {}),
    ...(options.namespaceImport
      ? { namespaceImport: options.namespaceImport }
      : {}),
    isTypeOnly: options.typeOnly ?? false
  })
}

function moduleHeader(name: string, description: string): string {
  return `/**\n * ${name}\n${
    description.trim() === '' ? '' : ` *\n * ${description.trim()}\n`
  } */\n`
}

export function executeMoveSymbol(
  op: MoveSymbolOperation & GraphOperation,
  ctx: OpContext
): OpResult {
  const from = findModule(ctx.graph, op.fromModuleId)
  const to =
    findModule(ctx.graph, op.toModuleId) ?? findModule(ctx.nextGraph, op.toModuleId)
  if (!from) return failed(`Module ${op.fromModuleId} is not in the graph`)
  if (!to) return failed(`Module ${op.toModuleId} is not in the graph`)

  const fromFile = ctx.workspace.currentPathOf(normalizeRel(op.fromFile)) ??
    normalizeRel(op.fromFile)
  if (!ctx.workspace.exists(fromFile)) {
    return failed(`${fromFile} does not exist in the project`)
  }

  const toFile = op.toFile
    ? normalizeRel(op.toFile)
    : to.directory
      ? join(to.directory, 'index.ts')
      : null
  if (toFile === null) {
    return unsupported(
      `Cannot move "${op.symbol}" into "${to.name}": that module has no directory, so there is no file to move it into.`
    )
  }
  if (toFile === fromFile) {
    return failed(`Source and destination file are the same (${fromFile})`)
  }

  const fromContent = ctx.workspace.read(fromFile)!
  // Generated imports follow the conventions of the file they come from: its
  // quote style, and whether it writes extensions on relative specifiers.
  const style: SpecifierStyle = inferSpecifierStyle(fromContent)
  const project: Project = createTransformProject(inferQuoteKind(fromContent))
  const sfFrom = project.createSourceFile(fromFile, fromContent, { overwrite: true })

  const located = locateDeclaration(sfFrom, op.symbol)
  if (!located) {
    return failed(
      `Could not find a top-level declaration of "${op.symbol}" in ${fromFile}. Declarations merged into a single statement (\`const a = 1, b = 2\`) are not supported.`
    )
  }

  const warnings: string[] = []
  const wasExported = located.node.isExported()
  if (!wasExported) {
    located.node.setIsExported(true)
    warnings.push(
      `"${op.symbol}" was not exported from ${fromFile}; it is now exported so the destination module can hold it.`
    )
  }

  const referenced = referencedIdentifiers(located.node, op.symbol)
  const localNames = localDeclarationNames(sfFrom)
  const declarationText = located.node.getText(true)

  // ---- Work out what the moved declaration needs ------------------------
  const resolver = new SpecifierResolver({ knownFiles: ctx.workspace.listFiles() })
  const importsToAdd: Parameters<typeof addImport>[1][] = []
  const localsToImport: string[] = []

  for (const name of [...referenced].sort()) {
    const binding = findImportBinding(sfFrom, name)
    if (binding) {
      const specifier = binding.specifier.startsWith('.')
        ? (() => {
            const resolved = resolver.resolve(fromFile, binding.specifier)
            return resolved.resolvedPath
              ? rewriteSpecifier(toFile, resolved.resolvedPath, binding.specifier)
              : binding.specifier
          })()
        : binding.specifier

      if (binding.specifier.startsWith('.') && specifier === binding.specifier) {
        const resolved = resolver.resolve(fromFile, binding.specifier)
        if (resolved.resolvedPath === null) {
          warnings.push(
            `"${binding.specifier}" (needed by ${op.symbol}) could not be resolved, so it was copied verbatim into ${toFile}.`
          )
        }
      }

      importsToAdd.push({
        specifier,
        typeOnly: binding.typeOnly,
        ...(binding.kind === 'named'
          ? {
              named: [
                binding.importedName === binding.localName
                  ? { name: binding.importedName }
                  : { name: binding.importedName, alias: binding.localName }
              ]
            }
          : {}),
        ...(binding.kind === 'default' ? { defaultImport: binding.localName } : {}),
        ...(binding.kind === 'namespace'
          ? { namespaceImport: binding.localName }
          : {})
      })
      continue
    }

    if (localNames.has(name)) localsToImport.push(name)
  }

  // Anything the declaration used that lives in the source file has to become
  // part of that file's public surface.
  const exportedForMove: string[] = []
  for (const name of localsToImport) {
    const decl = locateDeclaration(sfFrom, name)
    if (!decl) continue
    if (!decl.node.isExported()) {
      decl.node.setIsExported(true)
      exportedForMove.push(name)
    }
  }
  if (exportedForMove.length > 0) {
    warnings.push(
      `${fromFile} now exports ${exportedForMove.join(', ')} because "${op.symbol}" depends on them from its new home.`
    )
  }

  // ---- Build the destination file ---------------------------------------
  const toExisted = ctx.workspace.exists(toFile)
  const toContent = toExisted
    ? ctx.workspace.read(toFile)!
    : moduleHeader(to.name, to.description)
  const sfTo = project.createSourceFile(toFile, toContent, { overwrite: true })

  for (const spec of importsToAdd) addImport(sfTo, spec)
  if (localsToImport.length > 0) {
    addImport(sfTo, {
      specifier: buildSpecifier(toFile, fromFile, style),
      named: [...new Set(localsToImport)].sort().map((name) => ({ name }))
    })
  }
  sfTo.addStatements(`\n${declarationText}`)

  // ---- Remove it from the source file -----------------------------------
  located.node.remove()

  // The source file may still use the symbol it just gave away.
  if (countReferences(sfFrom, op.symbol) > 0) {
    addImport(sfFrom, {
      specifier: buildSpecifier(fromFile, toFile, style),
      named: [{ name: op.symbol }]
    })
  } else if (op.leaveReExport) {
    sfFrom.addExportDeclaration({
      moduleSpecifier: buildSpecifier(fromFile, toFile, style),
      namedExports: [op.symbol]
    })
  }

  const removedImports = removeUnusedImports(sfFrom)

  const touched = new Set<string>([fromFile, toFile])
  ctx.workspace.write(toFile, sfTo.getFullText(), {
    reason: `Receive "${op.symbol}" from ${fromFile}`,
    operationId: op.id
  })
  ctx.workspace.write(fromFile, sfFrom.getFullText(), {
    reason: `Move "${op.symbol}" to ${toFile}`,
    operationId: op.id
  })

  // ---- Update everyone who imported the symbol --------------------------
  let rewrittenImporters = 0
  const unfixable: string[] = []

  if (!op.leaveReExport) {
    for (const importer of findImporters(ctx.workspace, fromFile)) {
      if (!importer.symbols.includes(op.symbol)) continue
      const content = ctx.workspace.read(importer.file)
      if (content === null) continue

      const sf = project.createSourceFile(importer.file, content, { overwrite: true })
      let changed = false
      const newSpecifier = rewriteSpecifier(importer.file, toFile, importer.specifier)

      for (const decl of [...sf.getImportDeclarations()]) {
        if (
          resolver.resolve(importer.file, decl.getModuleSpecifierValue())
            .resolvedPath !== fromFile
        ) {
          continue
        }
        const named = decl.getNamedImports().find((n) => n.getName() === op.symbol)
        if (!named) continue
        const alias = named.getAliasNode()?.getText()
        const typeOnly = decl.isTypeOnly() || named.isTypeOnly()
        named.remove()
        if (
          decl.getNamedImports().length === 0 &&
          !decl.getDefaultImport() &&
          !decl.getNamespaceImport()
        ) {
          decl.remove()
        }
        addImport(sf, {
          specifier: newSpecifier,
          named: [alias ? { name: op.symbol, alias } : { name: op.symbol }],
          typeOnly
        })
        changed = true
      }

      for (const decl of [...sf.getExportDeclarations()]) {
        const specifier = decl.getModuleSpecifierValue()
        if (!specifier) continue
        if (resolver.resolve(importer.file, specifier).resolvedPath !== fromFile) {
          continue
        }
        const named = decl.getNamedExports().find((n) => n.getName() === op.symbol)
        if (!named) continue
        const alias = named.getAliasNode()?.getText()
        named.remove()
        if (decl.getNamedExports().length === 0) decl.remove()
        sf.addExportDeclaration({
          moduleSpecifier: newSpecifier,
          namedExports: [alias ? { name: op.symbol, alias } : { name: op.symbol }]
        })
        changed = true
      }

      if (changed) {
        ctx.workspace.write(importer.file, sf.getFullText(), {
          reason: `Point "${op.symbol}" at ${toFile}`,
          operationId: op.id
        })
        touched.add(importer.file)
        rewrittenImporters += 1
      } else {
        unfixable.push(importer.file)
      }
      project.removeSourceFile(sf)
    }
  }

  if (removedImports.length > 0) {
    warnings.push(
      `Removed ${removedImports.length} now-unused import(s) from ${fromFile}: ${removedImports.join(', ')}.`
    )
  }
  for (const file of unfixable) {
    warnings.push(
      `${file} references ${fromFile} in a way this transformation could not rewrite; check it by hand.`
    )
  }
  if (op.leaveReExport) {
    warnings.push(
      `${fromFile} re-exports "${op.symbol}" from its new location, so "${from.name}" still depends on "${to.name}". Remove the re-export once callers are updated.`
    )
  }

  return {
    status: unfixable.length > 0 ? 'partial' : 'applied',
    executor: 'deterministic',
    message:
      `Moved ${located.kind} "${op.symbol}" from ${fromFile} to ${toFile}` +
      (rewrittenImporters > 0
        ? `, updating ${rewrittenImporters} importing file(s).`
        : op.leaveReExport
          ? ', leaving a re-export behind.'
          : '.'),
    touchedPaths: [...touched].sort(),
    warnings,
    breakingChanges: unfixable.map(
      (f) => `${f} still imports "${op.symbol}" from ${fromFile}.`
    )
  }
}
