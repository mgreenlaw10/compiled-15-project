import { useState } from 'react'
import type { ModuleNode } from '../../../shared/types/architecture'
import type { BehavioralContract, ContractCategory, ProgramField, ProgramSymbol } from '../../../shared/types/program'
import { isCallable, isDataType, symbolsOf } from '../../../shared/graph/program'
import { analyzeImpact } from '../../../shared/graph/impact'
import { operationId } from '../../../shared/util/id'
import { useStore, usePendingOperations } from '../../state/store'
import { SectionTitle } from '../../ui'

export function EditText({ label, value, commit, multiline = false }: { label: string; value: string; commit: (value: string) => void; multiline?: boolean }): JSX.Element {
  const [draft, setDraft] = useState(value)
  return <label className="field"><span className="label">{label}</span>{multiline ?
    <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && commit(draft)} /> :
    <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && commit(draft)} />}</label>
}

export function FieldEditor({ field: f, symbol, module }: { field: ProgramField; symbol: ProgramSymbol; module: ModuleNode }): JSX.Element {
  const dispatch = useStore((s) => s.dispatchOperation)
  const update = (changes: Partial<ProgramField>): void => {
    dispatch({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, expectedVersion: symbol.version,
      changes: { fields: symbol.fields.map((item) => item.id === f.id ? { ...item, ...changes, version: item.version + 1 } : item) } })
  }
  return <div className="program-field">
    <EditText key={`name:${f.name}`} label="Field name" value={f.name} commit={(name) => update({ name })} />
    <EditText key={`type:${f.type}`} label="Field type" value={f.type} commit={(type) => update({ type })} />
    <label className="field"><span className="label">Field visibility</span><select value={f.accessibility} onChange={(e) => update({ accessibility: e.target.value as ProgramSymbol['accessibility'] })}>
      {['public', 'protected', 'private', 'package', 'internal', 'unknown'].map((v) => <option key={v}>{v}</option>)}
    </select></label>
    <span className="hint">{f.accessibility} · {f.source.file}:{f.source.line}</span>
    <button className="btn btn--ghost btn--sm" onClick={() => {
      if (dispatch({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, expectedVersion: symbol.version,
        changes: { fields: symbol.fields.filter((item) => item.id !== f.id) } }) && useStore.getState().selectedSymbolId === f.id) useStore.getState().selectSymbol(symbol.id)
    }}>Remove field</button>
  </div>
}

export function SymbolCard({ symbol, module, focused = false }: { symbol: ProgramSymbol; module: ModuleNode; focused?: boolean }): JSX.Element {
  const graph = useStore((s) => s.desired)!
  const dispatch = useStore((s) => s.dispatchOperation)
  const openFile = useStore((s) => s.openFile)
  const callers = graph.program.relationships.filter((r) => r.toSymbolId === symbol.id && r.kind === 'call')
  const consumers = graph.program.relationships.filter((r) => r.toSymbolId === symbol.id && r.kind !== 'implementation_of')
  const contracts = graph.program.contracts.filter((c) => c.symbolId === symbol.id)
  const update = (changes: Extract<Parameters<typeof dispatch>[0], { type: 'update_symbol' }>['changes']): void => {
    dispatch({ type: 'update_symbol', moduleId: module.id, symbolId: symbol.id, changes, expectedVersion: symbol.version })
  }
  return <details className="program-card" open={useStore((s) => s.selectedSymbolId) === symbol.id || focused}>
    <summary><strong>{symbol.qualifiedName}</strong><span className="hint">{symbol.accessibility} · {symbol.kind}</span></summary>
    <p className="mono program-signature">{symbol.signature}</p>
    <button className="btn btn--ghost btn--sm" onClick={() => openFile(module.id, symbol.source.file)}>{symbol.source.file}:{symbol.source.line}</button>
    <p className="hint">Publicly accessible: {symbol.publiclyAccessible ? 'yes' : 'no'} · Known callers: {callers.length} · Cross-module uses: {
      consumers.filter((r) => !module.files.includes(r.source.file)).length}</p>
    <EditText key={`name:${symbol.id}:${symbol.name}`} label="Symbol name" value={symbol.name} commit={(name) => update({ name })} />
    <EditText key={`signature:${symbol.id}:${symbol.signature}`} label="Source signature" value={symbol.signature} commit={(signature) => update({ signature })} />
    {isCallable(symbol) && <>
      {symbol.parameters.map((parameter, index) => <div className="program-parameter" key={`${symbol.id}:${index}:${parameter.name}:${parameter.type}`}>
        <EditText label={`Parameter ${index + 1} name`} value={parameter.name} commit={(name) => update({ parameters: symbol.parameters.map((p, i) => i === index ? { ...p, name } : p) })} />
        <EditText label={`Parameter ${index + 1} type`} value={parameter.type} commit={(type) => update({ parameters: symbol.parameters.map((p, i) => i === index ? { ...p, type } : p) })} />
        <button className="btn btn--ghost btn--sm" onClick={() => update({ parameters: symbol.parameters.filter((_p, i) => i !== index) })}>Remove parameter</button>
      </div>)}
      <button className="btn btn--sm" onClick={() => update({ parameters: [...symbol.parameters, { name: 'argument', type: symbol.language === 'python' ? 'int' : 'unknown', optional: false, variadic: false }] })}>Add parameter</button>
      <EditText key={`${symbol.id}:return:${symbol.returnType}`} label="Return type" value={symbol.returnType} commit={(returnType) => update({ returnType })} />
      {symbol.exceptions.length > 0 && <p className="hint">Declared exceptions: {symbol.exceptions.join(', ')}</p>}
    </>}
    <EditText key={`${symbol.id}:description:${symbol.description}`} label="Function or type description" value={symbol.description} multiline commit={(description) => update({ description })} />
    <label className="field"><span className="label">Accessibility</span><select value={symbol.accessibility} onChange={(e) => update({ accessibility: e.target.value as ProgramSymbol['accessibility'] })}>
      {['public', 'protected', 'private', 'package', 'internal', 'unknown'].map((v) => <option key={v}>{v}</option>)}
    </select></label>
    {isDataType(symbol) && <>
      <p className="hint">Bases: {symbol.bases.join(', ') || 'none declared'}. {symbol.publiclyAccessible ? 'Public data structure' : 'Implementation data structure'}.</p>
      {symbol.fields.map((f) => <FieldEditor key={f.id} field={f} symbol={symbol} module={module} />)}
      <button className="btn btn--sm" onClick={() => update({ fields: [...symbol.fields, { id: operationId('field'), name: 'field', type: 'unknown', accessibility: 'public', source: symbol.source, version: 1 }] })}>Add field</button>
    </>}
    <div className="hint">{callers.map((r) => <div key={r.id}>Caller: {graph.program.symbols.find((s) => s.id === r.fromSymbolId)?.qualifiedName} · {r.source.file}:{r.source.line} ({r.resolution})</div>)}</div>
    {graph.program.relationships.filter((r) => r.fromSymbolId === symbol.id).map((r) => <div key={r.id} className="hint">
      <button className="btn btn--ghost btn--sm" onClick={() => useStore.getState().selectRelationship(r.id)}>{r.kind}: {r.targetName} ({r.resolution})</button>
      <span>{r.source.file}:{r.source.line}</span>
    </div>)}
    {isDataType(symbol) && consumers.map((r) => <p className="hint" key={r.id}>{r.kind}: used by {graph.program.symbols.find((s) => s.id === r.fromSymbolId)?.qualifiedName} · {r.source.file}:{r.source.line} ({r.resolution})</p>)}
    {!focused && contracts.map((c) => <p className="hint" key={c.id}>{c.category}: {c.description} ({c.provenance}, {c.verification})</p>)}
    <button className="btn btn--danger btn--sm" onClick={() => dispatch({ type: 'remove_symbol', moduleId: module.id, symbolId: symbol.id, expectedVersion: symbol.version })}>Remove {symbol.kind}</button>
    <label className="field"><span className="label">Move source component</span><select value="" onChange={(e) => {
      if (e.target.value) dispatch({ type: 'move_symbol', symbolId: symbol.id, symbol: symbol.name, fromFile: symbol.source.file,
        fromModuleId: module.id, toModuleId: e.target.value, leaveReExport: false })
    }}><option value="">Choose destination module</option>{graph.modules.filter((m) => m.id !== module.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
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
  const original = useStore((s) => s.original)
  const dispatch = useStore((s) => s.dispatchOperation)
  const openModule = useStore((s) => s.openModule)
  const selectedRelationship = useStore((s) => s.selectedRelationshipId)
  const pending = usePendingOperations()
  const symbols = symbolsOf(graph, module)
  const [category, setCategory] = useState<ContractCategory>('precondition')
  const [target, setTarget] = useState('')
  const [fieldId, setFieldId] = useState('')
  const [description, setDescription] = useState('')
  const [expression, setExpression] = useState('')
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<ProgramSymbol['kind']>('function')
  const [newSignature, setNewSignature] = useState('')
  const [newFile, setNewFile] = useState(module.files[0] ?? '')
  const contracts = graph.program.contracts.filter((c) => module.components.contracts.contractIds.includes(c.id))
  const impacts = original ? pending.flatMap((op) => analyzeImpact(original, op)) : []
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
    <SectionTitle>Data Structures</SectionTitle>
    {symbols.filter(isDataType).map((s) => <SymbolCard key={s.id} symbol={s} module={module} />)}
    {!module.components.dataStructures.symbolIds.length && <p className="hint">No data structures were found.</p>}
    <details className="program-card"><summary>Add function or data structure</summary>
      <label className="field"><span className="label">Kind</span><select value={newKind} onChange={(e) => setNewKind(e.target.value as ProgramSymbol['kind'])}>{['function', 'class', 'struct', 'interface', 'record', 'enum', 'type'].map((k) => <option key={k}>{k}</option>)}</select></label>
      <label className="field"><span className="label">New symbol name</span><input value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
      <label className="field"><span className="label">Desired signature</span><input value={newSignature} onChange={(e) => setNewSignature(e.target.value)} /></label>
      <label className="field"><span className="label">Source file</span><select value={newFile} onChange={(e) => setNewFile(e.target.value)}>{module.files.map((f) => <option key={f}>{f}</option>)}</select></label>
      <button className="btn btn--sm" disabled={!newName.trim() || !newSignature.trim() || !newFile} onClick={() => {
        const source = { file: newFile, start: 0, end: 0, line: 1, endLine: 1, column: 1 }
        const neighbor = symbols.find((s) => s.source.file === newFile)
        dispatch({ type: 'add_symbol', moduleId: module.id, symbol: { id: operationId('symbol'), name: newName.trim(), qualifiedName: newName.trim(), scope: '',
          kind: newKind, language: neighbor?.language ?? 'unknown', accessibility: 'public', linkage: neighbor?.linkage ?? 'none', publiclyAccessible: true,
          signature: newSignature, parameters: [], returnType: 'unknown', exceptions: [], fields: [], bases: [], description: '', descriptionOrigin: 'user',
          source, nameSource: source, signatureSource: source, sourceText: '', definition: false, version: 1 } })
        setNewName(''); setNewSignature('')
      }}>Add pending source component</button>
    </details>
    <SectionTitle>Private Implementation</SectionTitle>
    <p className="hint">Observed explanation ({module.components.implementation.descriptionOrigin}):</p>
    <p>{module.components.implementation.observedDescription}</p>
    <EditText key={`${module.id}:${module.components.implementation.desiredDescription}`} label="Desired implementation behavior" multiline
      value={module.components.implementation.desiredDescription ?? ''} commit={(text) => dispatch({ type: 'update_implementation', moduleId: module.id, description: text })} />
    {symbols.filter((s) => isCallable(s) && !s.publiclyAccessible).map((s) => <SymbolCard key={s.id} symbol={s} module={module} />)}
    <SectionTitle>Module Contracts</SectionTitle>
    {['Module-wide guarantees', 'Interface function contracts', 'Data structure invariants', 'Shared state and resource requirements'].map((group, index) => {
      const grouped = contracts.filter((c) => {
        if (c.fieldId || ['ownership', 'lifecycle', 'concurrency', 'side_effect'].includes(c.category)) return index === 3
        if (!c.symbolId) return index === 0
        const component = symbols.find((s) => s.id === c.symbolId)
        return index === (component && isDataType(component) ? 2 : 1)
      })
      return grouped.length ? <div key={group}><p className="label">{group}</p>{grouped.map((c) => <ContractCard key={c.id} contract={c} module={module} />)}</div> : null
    })}
    {!contracts.length && <p className="hint">No explicit contracts extracted. Add a specification below.</p>}
    <details className="program-card"><summary>Add behavioral contract</summary>
      <label className="field"><span className="label">Contract category</span><select value={category} onChange={(e) => setCategory(e.target.value as ContractCategory)}>{categories.map((c) => <option key={c} value={c}>{c.replaceAll('_', ' ')}</option>)}</select></label>
      <label className="field"><span className="label">Contract target</span><select value={target} onChange={(e) => { setTarget(e.target.value); setFieldId('') }}><option value="">Module-wide</option>{symbols.map((s) => <option key={s.id} value={s.id}>{s.qualifiedName}</option>)}</select></label>
      {!!symbols.find((s) => s.id === target)?.fields.length && <label className="field"><span className="label">Contract field</span><select value={fieldId} onChange={(e) => setFieldId(e.target.value)}><option value="">Whole component</option>{symbols.find((s) => s.id === target)!.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
      <label className="field"><span className="label">New contract description</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="field"><span className="label">New contract expression</span><input value={expression} onChange={(e) => setExpression(e.target.value)} /></label>
      <button className="btn btn--sm" disabled={!description.trim()} onClick={() => {
        dispatch({ type: 'add_contract', moduleId: module.id, contract: { id: operationId('contract'), moduleId: module.id, ...(target ? { symbolId: target } : {}),
          ...(fieldId ? { fieldId } : {}), category, description, ...(expression.trim() ? { expression: expression.trim() } : {}), provenance: 'user_specified', verification: 'unverified',
          verificationNote: 'Pending user specification.', evidence: [], version: 1 } }); setDescription(''); setExpression('')
      }}>Add contract</button>
    </details>
    {impacts.length > 0 && <><SectionTitle>Pending Change Impact</SectionTitle>{impacts.map((i, index) => <p className="hint" key={index}>
      <strong>{graph.modules.find((m) => m.id === i.moduleId)?.name ?? i.moduleId}</strong> ({i.severity}): {i.reason}
      {i.evidence.map((e, j) => <span key={j}> {e.file}:{e.line}</span>)}
    </p>)}</>}
  </>
}
