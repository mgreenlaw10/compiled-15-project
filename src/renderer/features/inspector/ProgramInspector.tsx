import { useState } from 'react'
import type { ModuleNode } from '../../../shared/types/architecture'
import type { BehavioralContract, ContractCategory, ProgramField, ProgramSymbol } from '../../../shared/types/program'
import { isCallable, isDataType, symbolsOf } from '../../../shared/graph/program'
import { operationId } from '../../../shared/util/id'
import { createDraftSymbol, type DraftCategory } from '../../../shared/graph/draft-symbol'
import { useStore } from '../../state/store'
import { SectionTitle } from '../../ui'

export function EditText({ label, value, commit, multiline = false, autoFocus = false }: { label: string; value: string; commit: (value: string) => void; multiline?: boolean; autoFocus?: boolean }): JSX.Element {
  const [draft, setDraft] = useState(value)
  return <label className="field"><span className="label">{label}</span>{multiline ?
    <textarea rows={3} autoFocus={autoFocus} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && commit(draft)} /> :
    <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && commit(draft)} />}</label>
}

/**
 * A field reads as its name. Its type, visibility and source location are one
 * quiet line underneath, and the editors sit behind a disclosure so a selected
 * data structure does not turn the sidebar into a wall of form controls.
 */
export function FieldEditor({ field: f, symbol, module, focused = false }: { field: ProgramField; symbol: ProgramSymbol; module: ModuleNode; focused?: boolean }): JSX.Element {
  const dispatch = useStore((s) => s.dispatchOperation)
  const update = (changes: Partial<ProgramField>): void => {
    dispatch({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, expectedVersion: symbol.version,
      changes: { fields: symbol.fields.map((item) => item.id === f.id ? { ...item, ...changes, version: item.version + 1 } : item) } })
  }
  return <div className="program-field">
    <p className="program-member"><strong>{f.name}</strong><span className="hint mono">{f.type}</span></p>
    <p className="program-detail"><span>{f.accessibility}</span><span className="mono">{f.source.file}:{f.source.line}</span></p>
    <details className="program-card" open={focused || undefined}><summary>Edit field</summary>
      <EditText key={`name:${f.name}`} label="Field name" value={f.name} commit={(name) => update({ name })} />
      <EditText key={`type:${f.type}`} label="Field type" value={f.type} commit={(type) => update({ type })} />
      <label className="field"><span className="label">Field visibility</span><select value={f.accessibility} onChange={(e) => update({ accessibility: e.target.value as ProgramSymbol['accessibility'] })}>
        {['public', 'protected', 'private', 'package', 'internal', 'unknown'].map((v) => <option key={v}>{v}</option>)}
      </select></label>
      <button className="btn btn--member btn--sm" onClick={() => {
        if (dispatch({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, expectedVersion: symbol.version,
          changes: { fields: symbol.fields.filter((item) => item.id !== f.id) } }) && useStore.getState().selectedSymbolId === f.id) useStore.getState().selectSymbol(symbol.id)
      }}>Remove field</button>
    </details>
  </div>
}

/**
 * A function or data structure reads as its own name plus its signature. The
 * qualified name, the visibility and the source location are one summary line;
 * the editors, the dependency lists and the destructive controls each sit
 * behind their own disclosure, so selecting a node answers "what is this"
 * before it offers "how do I change it".
 */
export function SymbolCard({ symbol, module, focused = false }: { symbol: ProgramSymbol; module: ModuleNode; focused?: boolean }): JSX.Element {
  const graph = useStore((s) => s.desired)!
  const draft = !symbol.sourceText && symbol.descriptionOrigin === 'user' && !symbol.definition
  const dispatch = useStore((s) => s.dispatchOperation)
  const openFile = useStore((s) => s.openFile)
  const callers = graph.program.relationships.filter((r) => r.toSymbolId === symbol.id && r.kind === 'call')
  const consumers = graph.program.relationships.filter((r) => r.toSymbolId === symbol.id && r.kind !== 'implementation_of')
  const outgoing = graph.program.relationships.filter((r) => r.fromSymbolId === symbol.id)
  const contracts = graph.program.contracts.filter((c) => c.symbolId === symbol.id)
  const crossModule = consumers.filter((r) => !module.files.includes(r.source.file)).length
  const dataKinds = symbol.language === 'java' ? ['class', 'interface', 'record', 'enum'] : symbol.language === 'c' ? ['struct', 'union', 'enum', 'type'] :
    symbol.language === 'python' ? ['class', 'type'] : symbol.language === 'javascript' ? ['class'] : symbol.language === 'cpp' ? ['class', 'struct', 'union', 'enum', 'type'] : ['class', 'interface', 'enum', 'type']
  const update = (changes: Extract<Parameters<typeof dispatch>[0], { type: 'update_symbol' }>['changes']): void => {
    dispatch({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, changes, expectedVersion: symbol.version })
  }
  return <details className="program-card" open={useStore((s) => s.selectedSymbolId) === symbol.id || focused}>
    <summary><strong>{symbol.name}</strong><span className="hint">{symbol.kind.replaceAll('_', ' ')}</span></summary>
    {symbol.signature && <p className="mono program-signature">{symbol.signature}</p>}
    <p className="program-detail">
      <span>{symbol.accessibility}</span>
      <span>{symbol.publiclyAccessible ? 'public API' : 'internal'}</span>
      <button className="btn btn--member btn--sm" onClick={() => openFile(module.id, symbol.source.file)}>{symbol.source.file}{draft ? ' (planned)' : `:${symbol.source.line}`}</button>
    </p>
    <details className="program-card" open={draft || undefined}><summary>Properties</summary>
      <p className="hint mono">{symbol.qualifiedName}</p>
      {draft && <>
        <EditText key={`${symbol.id}:description:${symbol.description}`} label="Description" value={symbol.description} multiline autoFocus={!symbol.description} commit={(description) => update({ description })} />
        <p className="hint">Describe what this {isDataType(symbol) ? 'data structure' : 'function'} should do. Generation derives its implementation from this description; the fields below are optional guidance.</p>
      </>}
      <EditText key={`name:${symbol.id}:${symbol.name}`} label="Symbol name" value={symbol.name} commit={(name) => update({ name })} />
      {isDataType(symbol) && <label className="field"><span className="label">Data structure kind</span><select value={symbol.kind} onChange={(e) => update({ kind: e.target.value as ProgramSymbol['kind'] })}>
        {[...new Set([symbol.kind, ...dataKinds])].map((kind) => <option key={kind}>{kind}</option>)}
      </select></label>}
      <EditText key={`signature:${symbol.id}:${symbol.signature}`} label={draft ? 'Suggested signature (optional)' : 'Source signature'} value={symbol.signature} commit={(signature) => update({ signature })} />
      {isCallable(symbol) && <>
        {symbol.parameters.map((parameter, index) => <div className="program-parameter" key={`${symbol.id}:${index}:${parameter.name}:${parameter.type}`}>
          <EditText label={`Parameter ${index + 1} name`} value={parameter.name} commit={(name) => update({ parameters: symbol.parameters.map((p, i) => i === index ? { ...p, name } : p) })} />
          <EditText label={`Parameter ${index + 1} type`} value={parameter.type} commit={(type) => update({ parameters: symbol.parameters.map((p, i) => i === index ? { ...p, type } : p) })} />
          <button className="btn btn--member btn--sm" onClick={() => update({ parameters: symbol.parameters.filter((_p, i) => i !== index) })}>Remove parameter</button>
        </div>)}
        <button className="btn btn--sm" onClick={() => update({ parameters: [...symbol.parameters, { name: 'argument', type: draft ? '' : symbol.language === 'python' ? 'int' : 'unknown', optional: false, variadic: false }] })}>Add parameter</button>
        <EditText key={`${symbol.id}:return:${symbol.returnType}`} label="Return type" value={symbol.returnType} commit={(returnType) => update({ returnType })} />
        {symbol.exceptions.length > 0 && <p className="hint">Declared exceptions: {symbol.exceptions.join(', ')}</p>}
      </>}
      {!draft && <EditText key={`${symbol.id}:description:${symbol.description}`} label="Function or type description" value={symbol.description} multiline commit={(description) => update({ description })} />}
      <label className="field"><span className="label">Accessibility</span><select value={symbol.accessibility} onChange={(e) => update({ accessibility: e.target.value as ProgramSymbol['accessibility'] })}>
        {['public', 'protected', 'private', 'package', 'internal', 'unknown'].map((v) => <option key={v}>{v}</option>)}
      </select></label>
      {isDataType(symbol) && <p className="hint">Bases: {symbol.bases.join(', ') || 'none declared'}.</p>}
    </details>
    {isDataType(symbol) && <details className="program-card" open={draft || undefined}><summary>Fields ({symbol.fields.length})</summary>
      {symbol.fields.map((f) => <FieldEditor key={f.id} field={f} symbol={symbol} module={module} focused={draft} />)}
      <button className="btn btn--sm" onClick={() => update({ fields: [...symbol.fields, { id: operationId('field'), name: 'field', type: draft ? '' : 'unknown', accessibility: 'public', source: symbol.source, version: 1 }] })}>Add field</button>
    </details>}
    {(callers.length > 0 || outgoing.length > 0 || (isDataType(symbol) && consumers.length > 0)) &&
      <details className="program-card"><summary>Dependencies ({callers.length + outgoing.length})</summary>
        <p className="hint">{callers.length} known {callers.length === 1 ? 'caller' : 'callers'} · {crossModule} cross-module {crossModule === 1 ? 'use' : 'uses'}</p>
        {callers.map((r) => <p className="hint" key={r.id}>Caller: {graph.program.symbols.find((s) => s.id === r.fromSymbolId)?.qualifiedName} · {r.source.file}:{r.source.line} ({r.resolution})</p>)}
        {outgoing.map((r) => <div key={r.id} className="hint">
          <button className="btn btn--member btn--sm" onClick={() => useStore.getState().selectRelationship(r.id)}>{r.kind}: {r.targetName} ({r.resolution})</button>
          <span>{r.source.file}:{r.source.line}</span>
        </div>)}
        {isDataType(symbol) && consumers.map((r) => <p className="hint" key={r.id}>{r.kind}: used by {graph.program.symbols.find((s) => s.id === r.fromSymbolId)?.qualifiedName} · {r.source.file}:{r.source.line} ({r.resolution})</p>)}
      </details>}
    {!focused && contracts.map((c) => <p className="hint" key={c.id}>{c.category}: {c.description} ({c.provenance}, {c.verification})</p>)}
    <details className="program-card"><summary>Move or remove</summary>
      <label className="field"><span className="label">Move source component</span><select value="" onChange={(e) => {
        if (e.target.value) dispatch({ type: 'move_symbol', symbolId: symbol.id, symbol: symbol.name, fromFile: symbol.source.file,
          fromModuleId: module.id, toModuleId: e.target.value, leaveReExport: false })
      }}><option value="">Choose destination module</option>{graph.modules.filter((m) => m.id !== module.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <button className="btn btn--danger btn--sm" onClick={() => dispatch({ type: 'remove_symbol', moduleId: module.id, symbolId: symbol.id, expectedVersion: symbol.version })}>Remove {symbol.kind}</button>
    </details>
  </details>
}

const categories: ContractCategory[] = ['precondition', 'postcondition', 'invariant', 'side_effect', 'error_behavior', 'ordering', 'concurrency', 'idempotency', 'performance', 'ownership', 'lifecycle']
export function ContractCard({ contract: c, module, focused = false }: { contract: BehavioralContract; module: ModuleNode; focused?: boolean }): JSX.Element {
  const dispatch = useStore((s) => s.dispatchOperation)
  const graph = useStore((s) => s.desired)!
  const symbol = graph.program.symbols.find((s) => s.id === c.symbolId)
  const reliance = graph.program.relationships.filter((r) => r.contractId === c.id)
  const targets = symbolsOf(graph, module)
  return <details className="program-card" data-testid={`contract-${c.id}`} open={focused || undefined}>
    <summary>{c.category.replaceAll('_', ' ')} · {symbol?.qualifiedName ?? 'Module-wide'}</summary>
    <p>{c.description}</p><p className="hint">{c.provenance.replaceAll('_', ' ')} · {c.verification} — {c.verificationNote}</p>
    <label className="field"><span className="label">Contract category</span><select value={c.category} onChange={(e) => dispatch({ type: 'modify_contract', moduleId: module.id, contractId: c.id,
      changes: { category: e.target.value as ContractCategory }, expectedVersion: c.version })}>{categories.map((category) => <option key={category} value={category}>{category.replaceAll('_', ' ')}</option>)}</select></label>
    <label className="field"><span className="label">Associated component</span><select value={c.symbolId ?? ''} onChange={(e) => dispatch({ type: 'modify_contract', moduleId: module.id, contractId: c.id,
      changes: { symbolId: e.target.value, fieldId: '' }, expectedVersion: c.version })}><option value="">Module-wide</option>{targets.map((s) => <option key={s.id} value={s.id}>{s.qualifiedName}</option>)}</select></label>
    {symbol?.fields.length ? <label className="field"><span className="label">Associated field</span><select value={c.fieldId ?? ''} onChange={(e) => dispatch({ type: 'modify_contract', moduleId: module.id, contractId: c.id,
      changes: { fieldId: e.target.value }, expectedVersion: c.version })}><option value="">Whole component</option>{symbol.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label> : null}
    <EditText key={`${c.id}:desc:${c.description}`} label="Contract description" value={c.description} multiline commit={(description) => dispatch({ type: 'modify_contract', moduleId: module.id, contractId: c.id, changes: { description }, expectedVersion: c.version })} />
    <EditText key={`${c.id}:expr:${c.expression}`} label="Contract expression" value={c.expression ?? ''} commit={(expression) => dispatch({ type: 'modify_contract', moduleId: module.id, contractId: c.id, changes: { expression, description: expression }, expectedVersion: c.version })} />
    <p className="hint">Changing a contract requests a behavior change when you generate.</p>
    {c.evidence.map((e, i) => <p className="mono hint" key={i}>Evidence: {e.file}:{e.line}</p>)}
    {reliance.map((r) => <p className="hint" key={r.id}>Relied on by {graph.program.symbols.find((s) => s.id === r.fromSymbolId)?.qualifiedName}: {r.resolution === 'resolved' && r.origin === 'static' ? 'explicit evidence' : 'potential reliance'}</p>)}
    <label className="field"><span className="label">Declare potential reliance</span><select value="" onChange={(e) => {
      const consumer = graph.program.symbols.find((s) => s.id === e.target.value)
      const owner = graph.modules.find((m) => consumer && m.files.includes(consumer.source.file))
      if (consumer && owner) dispatch({ type: 'add_contract_dependency', moduleId: owner.id, fromSymbolId: consumer.id, contractId: c.id })
    }}><option value="">Choose consuming function</option>{graph.program.symbols.filter((s) => isCallable(s) && s.id !== c.symbolId && !reliance.some((r) => r.fromSymbolId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.qualifiedName}</option>)}</select></label>
    <button className="btn btn--danger btn--sm" onClick={() => dispatch({ type: 'remove_contract', moduleId: module.id, contractId: c.id, expectedVersion: c.version })}>Remove contract</button>
  </details>
}

export function ProgramInspector({ module }: { module: ModuleNode }): JSX.Element {
  const graph = useStore((s) => s.desired)!
  const dispatch = useStore((s) => s.dispatchOperation)
  const openModule = useStore((s) => s.openModule)
  const selectedRelationship = useStore((s) => s.selectedRelationshipId)
  const symbols = symbolsOf(graph, module)
  const add = (category: DraftCategory): void => {
    const symbol = createDraftSymbol(graph, module, category, operationId('symbol'))
    if (dispatch({ type: 'add_symbol', moduleId: module.id, symbol })) useStore.getState().selectSymbol(symbol.id)
  }
  const selectedEdge = graph.edges.find((e) => e.id === selectedRelationship)
  const selectedRelation = graph.program.relationships.find((r) => r.id === selectedRelationship)
  const selectedContract = selectedRelationship?.startsWith('contract:') ? graph.program.contracts.find((c) => c.id === selectedRelationship.slice(9)) : null
  return <>
    <button className="btn" onClick={() => openModule(module.id)}>Open module structure</button>
    {selectedRelationship && <div className="program-evidence"><SectionTitle>Dependency evidence</SectionTitle>
      {selectedEdge?.evidence.map((e, i) => <p className="hint mono" key={i}>{e.fromFile}:{e.line} → {e.toFile}<br />{e.toSymbolId ? graph.program.symbols.find((s) => s.id === e.toSymbolId)?.qualifiedName : e.symbols.join(', ')} · {e.resolution ?? 'import'}</p>)}
      {selectedRelation && <><p>{selectedRelation.kind}: {selectedRelation.targetName} ({selectedRelation.resolution})</p>
        <p className="mono hint">{selectedRelation.source.file}:{selectedRelation.source.line}</p>
        {selectedRelation.assumptions.map((a) => <p key={a} className="hint">{a}</p>)}
        {selectedRelation.conditional && <p className="hint">Conditional source; preprocessor condition was not evaluated.</p>}</>}
      {selectedContract && <><p>{selectedContract.category}: {selectedContract.description}</p><p className="hint">{selectedContract.provenance} · {selectedContract.verification}. {selectedContract.verificationNote}</p></>}
      {selectedRelationship.startsWith('file-relation:') && (() => { const r = graph.program.fileRelationships[Number(selectedRelationship.split(':')[1])]; return r ? <p className="hint">{r.fromFile}:{r.line} {r.kind}s {r.toFile}. This establishes a file relationship, not use of every declared function.</p> : null })()}
    </div>}
    <SectionTitle>Interface Functions</SectionTitle>
    {symbols.filter((s) => isCallable(s) && s.publiclyAccessible).map((s) => <SymbolCard key={s.id} symbol={s} module={module} />)}
    {!module.components.interface.functionIds.length && <p className="hint">No publicly accessible functions were found.</p>}
    <button className="btn btn--sm btn--add" aria-label="Add interface function" onClick={() => add('interface')}>Add</button>
    <SectionTitle>Data Structures</SectionTitle>
    {symbols.filter(isDataType).map((s) => <SymbolCard key={s.id} symbol={s} module={module} />)}
    {!module.components.dataStructures.symbolIds.length && <p className="hint">No data structures were found.</p>}
    <button className="btn btn--sm btn--add" aria-label="Add data structure" onClick={() => add('data')}>Add</button>
    <SectionTitle>Private Implementation</SectionTitle>
    <button className="btn btn--sm btn--add" aria-label="Add private implementation" onClick={() => add('implementation')}>Add</button>
    <EditText key={`${module.id}:${module.components.implementation.desiredDescription}`} label="Desired implementation behavior" multiline
      value={module.components.implementation.desiredDescription ?? ''} commit={(text) => dispatch({ type: 'update_implementation', moduleId: module.id, description: text })} />
    {symbols.filter((s) => isCallable(s) && !s.publiclyAccessible).map((s) => <SymbolCard key={s.id} symbol={s} module={module} />)}
  </>
}
