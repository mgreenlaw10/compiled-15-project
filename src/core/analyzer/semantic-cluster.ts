import type { ProgramModel } from '../../shared/types/program'
import type { FileAnalysis } from './languages'
import type { ClusterResult } from './cluster'
import { stableId } from '../../shared/graph/program'
import { humanizeName } from '../../shared/util/id'

/** Merge interface/implementation units and private helpers; keep public consumers separate. */
export function refineSemanticClusters(clustered: ClusterResult, program: ProgramModel, analyses: FileAnalysis[]): ClusterResult {
  const files = analyses.filter((a) => ['java', 'c', 'cpp'].includes(a.language)).map((a) => a.path)
  if (!files.length) return clustered
  const parent = new Map(files.map((f) => [f, f]))
  const find = (f: string): string => {
    const p = parent.get(f) ?? f
    if (p === f) return f
    const root = find(p); parent.set(f, root); return root
  }
  const join = (a: string, b: string): void => {
    const x = find(a); const y = find(b)
    if (x !== y) { const root = x < y ? x : y; parent.set(x, root); parent.set(y, root) }
  }
  const byId = new Map(program.symbols.map((s) => [s.id, s]))
  for (const r of program.relationships) {
    if (r.resolution !== 'resolved' || !r.toSymbolId) continue
    const a = byId.get(r.fromSymbolId); const b = byId.get(r.toSymbolId)
    if (!a || !b || a.source.file === b.source.file || !parent.has(a.source.file) || !parent.has(b.source.file)) continue
    if (r.kind === 'implementation_of' || r.kind === 'call' && !b.publiclyAccessible && b.accessibility !== 'protected') join(a.source.file, b.source.file)
  }
  // Files with the same semantic type name (e.g. a Java interface and its implementation)
  // stay separate unless a real implements/inherits relation connects them.
  for (const r of program.relationships.filter((r) => r.kind === 'inherits' && r.resolution === 'resolved')) {
    const a = byId.get(r.fromSymbolId); const b = byId.get(r.toSymbolId ?? '')
    if (a && b && parent.has(a.source.file) && parent.has(b.source.file) && b.kind === 'interface') join(a.source.file, b.source.file)
  }
  const groups = new Map<string, string[]>()
  files.forEach((f) => { const key = find(f); groups.set(key, [...(groups.get(key) ?? []), f]) })
  const semanticFiles = new Set(files)
  const remaining = clustered.modules.map((m) => ({ ...m, files: m.files.filter((f) => !semanticFiles.has(f)) })).filter((m) => m.files.length)
  const semantic = [...groups.values()].map((group) => {
    const sorted = group.sort()
    const types = program.symbols.filter((s) => group.includes(s.source.file) && ['class', 'interface', 'struct', 'record', 'union'].includes(s.kind))
    const base = types.find((s) => s.publiclyAccessible)?.name ?? types[0]?.name ?? sorted[0].split('/').at(-1)!.replace(/\.[^.]+$/, '')
    return { id: stableId('module', sorted.join('|')), name: humanizeName(base), directory: null,
      files: sorted, tags: [], confidence: group.length > 1 ? 0.85 : 0.65,
      notes: [group.length > 1 ? 'Grouped by resolved interface/implementation or private-helper relationships, independently of folders/packages.' :
        'A distinct source component; imports of its public API remain dependencies rather than forcing a package/folder boundary.'] }
  })
  return { modules: [...remaining, ...semantic], unassigned: clustered.unassigned }
}
