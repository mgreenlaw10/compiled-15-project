import type { ModuleNode } from '../../../shared/types/architecture'
import { isDataType } from '../../../shared/graph/program'
import { analyzeImpact } from '../../../shared/graph/impact'
import { useStore, usePendingOperations } from '../../state/store'
import { Empty, SectionTitle } from '../../ui'
import { ContractCard, FieldEditor, SymbolCard } from './ProgramInspector'

/** Source selections show their own properties and related evidence, never a module editor. */
export function NodeInspector({ module }: { module: ModuleNode }): JSX.Element {
  const graph = useStore((s) => s.desired)!
  const original = useStore((s) => s.original)
  const id = useStore((s) => s.selectedSymbolId)
  const file = useStore((s) => s.selectedFile)
  const relationshipId = useStore((s) => s.selectedRelationshipId)
  const pending = usePendingOperations()
  const select = useStore((s) => s.select)
  const selectSymbol = useStore((s) => s.selectSymbol)
  const openFile = useStore((s) => s.openFile)
  const symbol = graph.program.symbols.find((s) => s.id === id || s.fields.some((f) => f.id === id))
  const field = symbol?.fields.find((f) => f.id === id)
  const contract = id?.startsWith('contract:') ? graph.program.contracts.find((c) => c.id === id.slice(9)) : undefined
  const owner = graph.modules.find((m) => symbol ? m.files.includes(symbol.source.file) : contract ? m.id === contract.moduleId : file ? m.files.includes(file) : false) ?? module
  const contracts = graph.program.contracts.filter((c) => symbol && c.symbolId === symbol.id && (field ? c.fieldId === field.id : !c.fieldId || isDataType(symbol)))
  const unresolved = id?.startsWith('unresolved:') ? graph.program.relationships.filter((r) => `unresolved:${r.fromSymbolId}:${r.targetName}` === id) : []
  const edits = pending.filter((op) => symbol && 'symbolId' in op && op.symbolId === symbol.id ||
    contract && 'contractId' in op && op.contractId === contract.id || 'contractId' in op && contracts.some((c) => c.id === op.contractId))
  const impacts = original ? edits.flatMap((op) => analyzeImpact(original, op)) : []
  const draft = symbol && !symbol.sourceText && symbol.descriptionOrigin === 'user' && !symbol.definition
  const title = field ? 'Field' : symbol ? draft ? isDataType(symbol) ? 'Data Structure' : symbol.publiclyAccessible ? 'Interface Function' : 'Private Implementation' : symbol.kind.replaceAll('_', ' ') : contract ? 'Contract' : unresolved.length ? 'Unresolved reference' : file ? 'File' : 'Inspector'
  return <aside className="pane pane--right">
    <div className="pane-header"><span style={{ textTransform: 'capitalize' }}>{title}</span></div>
    <div className="pane-body">
      <button className="btn btn--member btn--sm" onClick={() => select(owner.id)}>Module details: {owner.name}</button>
      {relationshipId && <DependencyEvidence id={relationshipId} />}
      {symbol && !field && <>
        <SymbolCard key={symbol.id} symbol={symbol} module={owner} focused />
        {isDataType(symbol) && <><SectionTitle>Members</SectionTitle>{graph.program.symbols.filter((s) => s.scope === symbol.qualifiedName && s.source.file === symbol.source.file).map((s) =>
          <button key={s.id} className="btn btn--sm btn--member" title={s.signature} onClick={() => { openFile(owner.id, s.source.file); selectSymbol(s.id) }}>{s.name}</button>)}</>}
        {symbol.sourceText && <details className="program-card"><summary>Source code</summary><pre className="program-source">{symbol.sourceText}</pre></details>}
      </>}
      {symbol && field && <>
        <FieldEditor key={field.id} field={field} symbol={symbol} module={owner} focused />
        <button className="btn btn--member btn--sm" onClick={() => selectSymbol(symbol.id)}>Declaring type: {symbol.name}</button>
        {(() => {
          const uses = graph.program.relationships.filter((r) => r.toFieldId === field.id)
          return uses.length ? <details className="program-card"><summary>Field dependencies ({uses.length})</summary>
            {uses.map((r) => <p key={r.id} className="hint">{r.kind}: {graph.program.symbols.find((s) => s.id === r.fromSymbolId)?.qualifiedName} · {r.source.file}:{r.source.line} ({r.resolution})</p>)}
          </details> : null
        })()}
      </>}
      {contract && <ContractCard key={contract.id} contract={contract} module={owner} focused />}
      {symbol && <><SectionTitle>Associated contracts</SectionTitle>{contracts.length ? contracts.map((c) => <ContractCard key={c.id} contract={c} module={owner} />) : <p className="hint">No contracts recorded for this {field ? 'field' : 'symbol'}.</p>}</>}
      {file && !id && <>
        <p className="mono">{file}</p>
        <button className="btn" onClick={() => openFile(owner.id, file)}>Open file structure</button>
        <SectionTitle>File symbols</SectionTitle>
        {graph.program.symbols.filter((s) => s.source.file === file).map((s) => <div key={s.id} className="program-member">
          <button className="btn btn--sm btn--member" title={`${s.signature} · line ${s.source.line}`}
            onClick={() => { openFile(owner.id, file); selectSymbol(s.id) }}>{s.name}</button>
          <span className="hint">{s.kind.replaceAll('_', ' ')}</span>
        </div>)}
        <SectionTitle>File dependencies</SectionTitle>
        {graph.program.fileRelationships.filter((r) => r.fromFile === file || r.toFile === file).map((r, i) => <p className="hint mono" key={i}>{r.fromFile}:{r.line} → {r.toFile} ({r.kind})</p>)}
      </>}
      {unresolved.map((r) => <div key={r.id}><p>{r.targetName} ({r.resolution})</p><DependencyEvidence id={r.id} /></div>)}
      {id && !symbol && !contract && !unresolved.length && <Empty>This node is no longer present in the desired graph.</Empty>}
      {impacts.length > 0 && <><SectionTitle>Pending Change Impact</SectionTitle>{impacts.map((impact, i) => <p className="hint" key={i}>{graph.modules.find((m) => m.id === impact.moduleId)?.name}: {impact.reason}</p>)}</>}
    </div>
  </aside>
}

export function DependencyEvidence({ id }: { id: string }): JSX.Element {
  const graph = useStore((s) => s.desired)!
  if (id.startsWith('references:')) {
    let ids: string[] = []
    try { const parsed: unknown = JSON.parse(id.slice(11)); if (Array.isArray(parsed)) ids = parsed.filter((value): value is string => typeof value === 'string' && !value.startsWith('references:')) }
    catch { /* An invalid display selection carries no source evidence. */ }
    return <>{ids.map((value) => <DependencyEvidence key={value} id={value} />)}</>
  }
  const relation = graph.program.relationships.find((r) => r.id === id)
  const edge = graph.edges.find((e) => e.id === id)
  const fileRelation = id.startsWith('file-relation:') ? graph.program.fileRelationships[Number(id.slice(14))] : undefined
  const contract = relation?.contractId ? graph.program.contracts.find((c) => c.id === relation.contractId) : id.startsWith('contract:') ? graph.program.contracts.find((c) => c.id === id.slice(9)) : undefined
  return <div className="program-evidence"><SectionTitle>Dependency evidence</SectionTitle>
    {relation && <><p>{relation.kind}: {relation.targetName} ({relation.resolution})</p><p className="mono hint">{relation.source.file}:{relation.source.line}</p>
      {relation.assumptions.map((a) => <p className="hint" key={a}>{a}</p>)}{relation.conditional && <p className="hint">Conditional source; preprocessor condition was not evaluated.</p>}</>}
    {fileRelation && <p className="hint mono">{fileRelation.fromFile}:{fileRelation.line} → {fileRelation.toFile} ({fileRelation.kind}). This does not imply use of every declared symbol.</p>}
    {edge?.evidence.map((e, i) => <p className="hint mono" key={i}>{e.fromFile}:{e.line} → {e.toFile} · {e.specifier} ({e.resolution ?? 'import'})</p>)}
    {contract && <p className="hint">{contract.category}: {contract.description} ({contract.provenance}, {contract.verification}). {contract.verificationNote}</p>}
  </div>
}
