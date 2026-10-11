# Hierarchical program graph

The existing scan, language registry, module graph, operation reducer, virtual
workspace, output writer, and original/desired document are retained.

## Schema

Architecture schema 2 adds a source-grounded program model. Symbols have stable
identities derived from file, qualified scope, kind, and overload parameter types
(not line numbers), versions, full signatures, parameters, visibility, linkage,
fields, documentation, and source ranges. Fields have their own identities.
Relationships connect exact symbols or fields and retain source evidence,
resolution status, and analysis assumptions. File imports remain separate from
calls and type/field usage: including a header never implies calling its APIs.

Each module references four structured components: its public interface,
private implementation, data structures, and contracts. Public visibility and
observed cross-module usage are separate. Implementation descriptions retain
observed and desired text separately. The existing module description and
responsibilities continue to describe the overall module.

Contracts carry category, target, text/expression, provenance (explicit,
statically established, inferred, user-specified), supporting source ranges,
verification status, and version. Assertions and recognized documentation tags
are explicit specifications, not proofs. This implementation makes no claim of
sound behavioral verification. Runtime checks and passing tests are evidence
with a stated scope, not proof of universal compatibility.

Events/callbacks fit dependency relationships. Ownership, shared state,
asynchrony and resource lifecycles fit type fields and behavioral contracts.
No fifth conceptual component or multiplayer functionality is introduced.

## Analysis and boundaries

Reuse ts-morph for JS/TS and bundled Tree-sitter grammars for Python, Java, C/C++.
Extract declarations and references with actual source ranges. Resolve only
bindings supported by lexical scope, imports/includes, declared receiver types,
and unambiguous overloads. Dynamic dispatch, function pointers, macro expansion,
unknown receivers and ambiguous bindings remain potential/unresolved.
Calls in inactive preprocessor branches remain conditional evidence.

For Java/C/C++, use semantic cohesion to group header/implementation pairs and
tightly connected private implementation files. Directory/package clustering
remains a fallback and a prior, not the boundary definition. Boundary decisions
are heuristic and explain their evidence. Public API calls across independent
components remain module dependencies rather than forcing all files into one
connected component.

## Editing, generation and validation

Project -> module files -> file symbols navigation preserves module context and
view positions separately from architecture. The inspector exposes all five
requested sections and exact dependency evidence. Structured operations edit
desired symbols, fields, implementation requests, contracts and contract reliance.
Project arrows collapse to one per module pair; selecting a module reveals its
individual incoming/outgoing dependency kinds. This is a display projection;
the underlying relationships, evidence and operation log remain intact.
File and symbol subgraphs use the same display projection. Node selection opens
a focused inspector for the file, symbol, field or contract; it preserves the
current graph scope even when the selected symbol belongs to another module.
Impact analysis uses observed relationships, distinguishes structural impacts
from potential behavioral impacts, and includes dependent modules.

Source edits are staged in the existing virtual workspace. Deterministic edits
support source-anchored renames, signature replacements and supported entry
assertion/precondition changes. Complex body, type, lifecycle and behavioral
changes use the existing AI transformation hook. Unsupported edits and stale or
ambiguous anchors are reported, never silently reduced to documentation edits.
All generated changes remain reviewable before writing. Compilation and tests
run when their toolchains are available; unavailable checks are skipped, and
unverified contracts are reported explicitly. Compilation does not establish
behavioral compatibility.

Schema-1 documents migrate to empty structured components while preserving their
original/desired graphs and operation logs; reanalysis supplies richer facts.
No facts are overwritten when a user changes desired behavior.
