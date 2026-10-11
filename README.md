# Cartograph

**An AI-powered visual codebase editor.** Import a TypeScript, JavaScript,
Python, Java, or C/C++ codebase and see its architecture as a module graph.
Open modules and files to inspect source symbols, types, calls and behavioral
contracts. Edit individual components, preview generated source changes, and
run the available project checks.

The whole point of the tool is the round trip:

```
Import codebase → analyze → module graph → edit the graph → generate code → verify
```

That pipeline is implemented end to end and covered by tests that run the real
analyzer and the real transformation engine against a real project, then check
that the generated output still type checks and that its own tests still pass.

---

## Table of contents

- [Install and run](#install-and-run)
- [The five-minute demo](#the-five-minute-demo)
- [What it actually does](#what-it-actually-does)
- [Operation support, stated honestly](#operation-support-stated-honestly)
- [Architecture](#architecture)
- [The data model](#the-data-model)
- [Using an API key](#using-an-api-key)
- [Validation](#validation)
- [Tests](#tests)
- [Limitations](#limitations)
- [Designed for multiplayer later](#designed-for-multiplayer-later)
- [Project layout](#project-layout)

---

## Install and run

Requires **Node 20.19+** (developed on Node 24) and npm.

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite dev server and launches Electron against it, with
hot reload for the renderer.

To build and run the production bundle:

```bash
npm run build
npm start
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run dev` | Dev server + Electron, with hot reload |
| `npm run build` | Type check, then bundle main / preload / renderer into `out/` |
| `npm start` | Run the built app |
| `npm test` | The whole test suite |
| `npm run typecheck` | Type check all three TypeScript projects |
| `npm run smoke` | Boot the built app and fail if the renderer logs an error |
| `npm run verify` | typecheck → test → build → smoke |

No API key is needed for any of this.

---

## The five-minute demo

A sample project is included at [`sample-project/`](sample-project) — a small
but realistic TypeScript service (`shop-api`) with 15 source files, an HTTP
layer, auth, a database layer, payments, and 9 of its own tests, all passing. It
is deliberately shaped so that one obvious architectural improvement exists, and
it has zero dependencies, so both `npx tsc --noEmit` and `npm test` work in a
fresh checkout with no install step.

1. **Open it.** `Open Project` → pick `sample-project`.

   Cartograph scans it, parses it with ts-morph, and in about 130 ms groups its
   19 source files into 8 modules: `Entry Point → Api → Auth → Db → Utils`,
   plus `Payments`, `Types` and `Test`. Import edges and additional call, type,
   field and contract relationships retain source evidence. Select an arrow
   to inspect the symbols and assumptions responsible for the connection.

2. **Notice the problem.** Select **Auth**. It owns five files, and one of them
   is `src/auth/session.ts` — session creation, expiry, revocation and purging.
   Session management is its own concern, and `Payments` and `Api` both reach
   into `src/auth/session.ts` directly to get at it.

3. **Fix it in the graph.** `Add Module` →

   - Name: `Session Management`
   - Directory: `src/session-management` (suggested for you)

   Then select **Auth**, find `src/auth/session.ts` in its file list, and drag it
   onto the new node — or use the `Move to…` menu next to the file.

   Both nodes get a dashed amber border, and the status bar changes from
   *"Graph matches the source code"* to *"2 changes not yet in the code"*. Try
   dragging a node around: the status bar does **not** change, because node
   positions are visual state and can never cause a code change.

4. **Generate.** `Generate Project`.

   The Changes tab fills in with the plan, per operation:

   - `Create module` → **applied** — created `src/session-management/index.ts`
   - `Move file` → **applied** — *"Moved src/auth/session.ts to
     src/session-management/session.ts and rewrote 7 import specifier(s) in 8
     file(s)."*

   Nine file changes in all, each with a diff you can expand. `auth/login.ts`,
   `auth/index.ts`, `api/routes.ts`, `api/server.ts` and `payments/checkout.ts`
   now import from `../session-management/session.ts` — and so do
   `test/session.test.ts` and `test/checkout.test.ts`, because the rewriter does
   not stop at the `src` directory. Nothing anywhere still references the old
   path. The rewritten specifiers keep the sample project's explicit `.ts`
   extensions: the rewriter preserves the project's own convention rather than
   imposing one.

5. **Write it and check it.** `Write the changes…` → *Generate into a new
   directory* → pick an empty folder → `Write changes`.

   The Results tab reports what was written, and then the result of actually
   running the project's own checks in the output directory:

   - **TypeScript type check** — passed
   - **Project tests** — passed (all 9 of the sample's tests, including the four
     that import the module that just moved)

6. **Confirm the loop closes.** `Open Project` on the generated directory.
   `Session Management` is now a module the analyzer found by itself, and the
   `Auth → Session Management` edge is marked *verified*, because real imports
   back it up.

That round trip is exactly what [`tests/integration/pipeline.test.ts`](tests/integration/pipeline.test.ts)
asserts, step by step, on every test run.

---

## What it actually does

### Import and analysis

- **Recursive scan** with conservative ignore rules: `node_modules`, `.git`,
  build output, caches, minified and `@generated` files, plus simple
  `.gitignore` entries. What was skipped and why is reported in the log.
- **Real static analysis** with ts-morph over an in-memory copy of the source
  (so analysis can never touch your working tree): classes, functions,
  interfaces, type aliases, enums, exported consts and React components, with
  file, line, exported-ness and a rendered signature.
- **Import graph** from static `import`s, `export … from` re-exports, dynamic
  `import()` and CommonJS `require()`. Specifiers are resolved by a hand-written
  resolver that understands relative paths, extension and `index` conventions,
  and tsconfig `paths` aliases — so it works with no `node_modules` present.
- **Module clustering** from directory structure, splitting directories that
  have grown large into their subdirectories, and falling back to grouping a
  large flat directory by the domain keyword in its file names. Every decision
  is recorded as a note on the module.
- **Descriptions and responsibilities** derived from evidence: directory names
  outrank file names, which outrank symbol names. `createSession` becomes
  "Create session"; a directory called `types` is described as types even though
  its interfaces are named `RequestContext` and `RouteHandler`.
- **Confidence** per module, adjusted by cohesion — what share of the imports
  written inside a module point at files inside it — and labelled with its basis
  (`static`, `heuristic`, `ai` or `user`).

### The graph editor

Pan, zoom, drag, select, expand a node to see its files. Create, rename and
delete modules; edit descriptions and responsibilities; draw and delete
dependency edges; move files between modules by dragging them from the explorer
or the inspector onto a node; move individual exported symbols between modules.
Save the architecture into the project and reload it later.

Verified edges are solid; edges you declared that no import backs are dashed and
labelled *declared*. Modules with changes that have not reached the source code
are dashed amber, in the graph, the module list and the minimap.

### Code generation

Graph edits become a **change set** — a list of file creates, edits, moves and
deletes, each with a reason and the operations behind it — computed without
writing anything. You can review it as a diff, then write it either into a new
directory (the original is untouched) or over the project itself (with a backup
and an explicit confirmation).

The transformations are compiler-aware. Moving a file moves it *and* rewrites
its own imports *and* every import of it across the project, including barrel
re-exports, dynamic imports and `require()` calls. Moving a symbol lifts the
declaration with its JSDoc, reconstructs the imports it needs in its new home,
exports anything it depended on locally, updates every importer, and removes
imports the source file no longer uses so a project with `noUnusedLocals` still
compiles.

---

## Operation support, stated honestly

This is the part worth reading. Nothing in Cartograph reports success it cannot
back up with a change set.

| Operation | Status | What happens |
|---|---|---|
| `add_module` | **Deterministic, end to end** | Creates `<dir>/index.ts` with the module's description and responsibilities as the header. Declared exports become placeholders that **throw** when called, with a message naming the module — a gap you cannot miss. Reported as `metadata_only` for a module with no directory, since there is nothing to write. |
| `rename_module` (name only) | **Deterministic** | `metadata_only`. A module name is documentation; no code changes, and the UI says so. |
| `rename_module` (directory) | **Deterministic, end to end** | Moves every file in the directory and rewrites every affected import. Files that live outside the old directory are reported, not silently left behind. |
| `move_file` | **Deterministic, end to end** | Moves the file; rewrites its imports and all importers. Warns when the source module's barrel still re-exports it, because that leaves a cross-module dependency behind. |
| `move_symbol` | **Deterministic, end to end** | Moves one top-level declaration between files, with its dependencies, its importers and its barrel re-exports. Reports `partial` with specifics if a reference could not be rewritten. |
| `delete_module` | **Deterministic** | Three explicit choices: leave the files (`metadata_only`), move them into another module (real moves + import rewriting), or delete them. Deleting lists every import elsewhere that will break **before** anything is written, and reports `partial`. |
| `update_module` | **Metadata only** | Description, responsibilities and interface are documentation. Reported as `metadata_only`, never as applied. |
| `add_dependency` | **Metadata only** | Records intent. Nothing can honestly make one module *use* another without deciding what it should call, so no code is written and the edge is drawn dashed until a real import appears. |
| `remove_dependency` | **Unsupported when real imports exist** | Lists the exact imports that stand in the way and refuses. Severing a dependency means choosing what replaces it; the engine will not guess. Removing a merely *declared* edge is `metadata_only`. |
| `move_responsibility` | **AI required** | Needs an API key. The agent reads the code, works out which declarations implement the responsibility, and relocates them using the deterministic tools. Without a key it is reported `unsupported`, not quietly dropped. |
| `scaffold_module` | **AI required** | Asks the model to implement a module from its description, responsibilities and declared interface, using the project's existing types and helpers. |

The directory/import operations above use the existing JS/TS refactoring tools.
Creating an empty module in a Python/Java/C/C++ project records architectural
intent; it does not insert a TypeScript scaffold. Physical file moves in those
languages require AI assistance to update imports/includes and ownership.
The hierarchical program model adds:

| Operation | Source transformation |
|---|---|
| `update_symbol` | Compiler-aware JS/TS callable renames; anchored Java/Python/C/C++ callable renames with known callers and matching C declarations. Signature edits are partial until callers and implementations are adapted. Ambiguous or stale bindings are refused. |
| `add_symbol`, fields/type edits | Targeted AI implementation using the existing virtual workspace, or an explicit unsupported outcome without a configured model. |
| `remove_symbol` | Anchored removal when no known dependents exist; otherwise targeted AI work is required. |
| `move_symbol` with a scoped identity | Desired movement is recorded precisely. Java/Python/C/C++ movement needs AI assistance; deterministic movement remains limited to JS/TS top-level declarations. |
| `update_implementation` | Separates an observed explanation from desired behavior; generation requires targeted AI implementation. |
| Contract add/modify/remove | Supported entry guards and assertion edits change actual code. More complex guarantees require AI implementation. Documentation-only changes never count as an implemented behavioral change. |
| `add_contract_dependency` | Records potential reliance with traceable symbol/contract IDs; it does not invent consuming source evidence. |

For a working Java/C demonstration, open the projects in
[`examples/program-graph`](examples/program-graph/README.md). Double-click a
module, then a file; breadcrumbs return to the project. The inspector presents
Overall Description, Interface Functions, Data Structures, Private Implementation,
and Module Contracts. Public visibility and actual cross-module use are separate.
Selecting a function, type, field, contract or file opens a focused inspector
for that node. Its properties remain editable; the module editor is available
through the Module details button.
The project overview shows one arrow per module pair (with arrowheads at both
ends for mutual dependencies). Select a module to reveal its individual incoming
and outgoing dependency types; click the canvas background to collapse them.
The module/file subgraphs use the same collapsed overview and reveal arrows only
around their selected node.

Three guarantees hold throughout:

1. **A graph edit is never reported as implemented unless files changed.** If
   the AI agent claims success but the change set is empty, the outcome is
   downgraded to `unsupported` and the mismatch is surfaced
   ([`transformer.ts`](src/core/ai/transformer.ts), tested in
   [`tests/unit/ai.test.ts`](tests/unit/ai.test.ts)).
2. **Visual changes and structural changes are separate.** Node positions live
   in `GraphLayout`, not `ArchitectureGraph`, and dragging a node records no
   operation at all.
3. **Nothing is written until you say so.** Planning runs entirely in a virtual
   workspace; the writer is the only module that touches your files.

---

## Architecture

Four layers, with one-way dependencies:

```
┌───────────────────────────────────────────────────────────────────┐
│ src/renderer     React + @xyflow/react. Holds the original and    │
│                  the desired graph, plus the operation log.       │
│                  No filesystem, no ts-morph, no SDK.              │
└───────────────────────────┬───────────────────────────────────────┘
                            │ window.cartograph  (typed CartographApi)
┌───────────────────────────┴───────────────────────────────────────┐
│ src/preload      contextBridge. One frozen object, nothing else.  │
└───────────────────────────┬───────────────────────────────────────┘
                            │ IPC
┌───────────────────────────┴───────────────────────────────────────┐
│ src/main         Electron window, menu, dialogs, settings store,  │
│                  document store. Thin adapters only.              │
└───────────────────────────┬───────────────────────────────────────┘
                            │ CartographService
┌───────────────────────────┴───────────────────────────────────────┐
│ src/core         The engine. Framework-free, no Electron.         │
│                  analyzer/ · transform/ · ai/ · output/           │
└───────────────────────────┬───────────────────────────────────────┘
                            │
┌───────────────────────────┴───────────────────────────────────────┐
│ src/shared       The model: types, the operation reducer, the     │
│                  diff, the layout algorithm, path utilities.      │
│                  Pure, no IO. Imported by every layer.            │
└───────────────────────────────────────────────────────────────────┘
```

Roughly 13,900 lines of source and 3,400 lines of tests.

### Where the real work happens

| Concern | File |
|---|---|
| File discovery and ignore rules | [`src/core/analyzer/scan.ts`](src/core/analyzer/scan.ts), [`ignore.ts`](src/core/analyzer/ignore.ts) |
| Language analyzers (JS/TS, Python, Java, C/C++) | [`src/core/analyzer/languages/`](src/core/analyzer/languages/) |
| Specifier resolution (incl. tsconfig aliases) | [`src/core/analyzer/resolve.ts`](src/core/analyzer/resolve.ts) |
| Grouping files into modules | [`src/core/analyzer/cluster.ts`](src/core/analyzer/cluster.ts) |
| Building the graph with import evidence | [`src/core/analyzer/build-graph.ts`](src/core/analyzer/build-graph.ts) |
| The operation reducer (pure) | [`src/shared/graph/apply-operation.ts`](src/shared/graph/apply-operation.ts) |
| Original vs desired diff | [`src/shared/graph/diff.ts`](src/shared/graph/diff.ts) |
| Deterministic layered layout | [`src/shared/graph/layout.ts`](src/shared/graph/layout.ts) |
| Plan-without-writing | [`src/core/transform/workspace.ts`](src/core/transform/workspace.ts) |
| Import rewriting | [`src/core/transform/imports.ts`](src/core/transform/imports.ts) |
| Operation executors | [`src/core/transform/ops/`](src/core/transform/ops) |
| Orchestration | [`src/core/transform/engine.ts`](src/core/transform/engine.ts) |
| Writing, backups, restore | [`src/core/output/writer.ts`](src/core/output/writer.ts) |
| Running the project's own checks | [`src/core/output/validate.ts`](src/core/output/validate.ts) |
| The AI agent loop and its tools | [`src/core/ai/`](src/core/ai) |
| The backend service interface | [`src/core/pipeline.ts`](src/core/pipeline.ts) |

### Two decisions worth explaining

**The virtual workspace.** Every transformation runs against an in-memory
overlay of the project rather than the filesystem. One indirection buys a lot:
previewing a diff and writing files are the same code path with a different last
step; generating into a new directory and overwriting in place differ only in
where the writer points; an operation that fails half-way cannot leave a broken
project; and the AI agent's `write_file` tool is handed this object, so a
confused model literally cannot touch your disk.

**The language registry.** Static analysis sits behind a narrow interface
([`LanguageAnalyzer`](src/core/analyzer/languages/index.ts)): files in, per-file
symbols and imports out. Adding Python or Go means implementing that interface
and registering it; clustering, the graph, the UI and the diff never learn which
language anything came from. Files no analyzer claims are reported as
unsupported rather than silently dropped.

---

## The data model

Four pieces, deliberately separate ([`src/shared/types/`](src/shared/types)):

**`ArchitectureGraph`** — modules and edges. A `ModuleNode` has a stable id,
name, description, responsibilities, the **source files it owns**, its notable
symbols with file and line, its public interface, its external packages, its
origin, and metadata (confidence + basis, notes, LOC, tags, and `owner` /
`lockedBy` fields reserved for collaboration). A `DependencyEdge` has a kind
(`imports` / `depends_on` / `calls` / `types` / `fields` / `contracts`), a weight, a `verified` flag, a confidence,
and the concrete `DependencyEvidence` — importing file, imported file,
specifier, symbols, line — that justifies it.

Architecture schema 2 also stores the structured `ProgramModel` and each
module's four component references. Scoped symbols, overloads, fields and
contracts have identities and versions; relationships retain source ranges,
resolution status and assumptions. Contracts distinguish explicit specifications,
static results, inferred hypotheses and user intent, independently of verification.
Schema-1 documents migrate additively. See the
[schema and analysis design](docs/program-graph-design.md).

**`GraphLayout`** — positions and expanded state, stored separately so visual
changes cannot be mistaken for architectural ones.

**`GraphOperation`** — a discriminated union of every structural and metadata
edit, each carrying an id, the actor that issued it, a timestamp and the graph
version it was written against. Example:

```json
{
  "type": "add_module",
  "module": {
    "id": "session-management",
    "name": "Session Management",
    "description": "Owns user sessions and their lifecycle.",
    "responsibilities": ["Create sessions", "Expire and revoke sessions"],
    "directory": "src/session-management",
    "publicInterface": []
  },
  "id": "op_mgk2x1_1_a7f3de",
  "actor": "local-user",
  "issuedAt": "2026-10-11T14:21:08.442Z",
  "baseVersion": 1
}
```

**`ArchitectureDocument`** — what gets saved, into
`.cartograph/architecture.cartograph.json` *inside the project*, so the
architecture travels with the code and can be committed. It holds the
**original** architecture (what the analyzer found), the **desired** architecture
(after your edits), the layout, the ordered operation log, and which operations
have already been written to disk.

The operation log and the original/desired diff are two views of the same thing,
and the tests assert they agree: replaying the log reproduces the desired graph,
and replaying the *derived* operations from the diff lands in the same place.

---

## Using an API key

Static analysis, navigation, impact reporting and supported deterministic edits
work without a key. A configured model adds:

1. **Model-written module descriptions** during analysis. The model never
   changes the file-to-module mapping or invents an edge — it writes prose and a
   boundary note, and the result is labelled `ai` in the UI so a suggestion is
   never mistaken for a finding.
2. **`move_responsibility`** — relocating the code that implements a
   responsibility.
3. **`scaffold_module`** — implementing a module you created in the graph.
4. **Fine-grained implementation work** — new functions/types, field changes,
   desired implementation behavior and complex contracts. Existing implementation
   explanations use actual source excerpts; inferred contracts remain unverified.

Add the key in **Settings**. It is stored in Electron's per-user data directory,
encrypted with the OS keychain via `safeStorage` where one is available (the UI
warns you when it is not), and **never** inside the analyzed project. The
renderer is never given the key — only whether one is configured and its last
four characters.

The default model is **Claude Opus 5.5** (`claude-opus-5-5`) with adaptive
thinking and `high` effort; both are configurable. The agent gets nine tools —
query the graph, list and read files, find a symbol, write and delete files, and
the two compiler-aware refactors (`move_file_to_module`, `move_symbol_to_file`)
so it asks for a correct refactor instead of hand-editing import statements —
plus `report_result`, which it must call to finish. Every path it supplies is
validated against the project, and every tool input is re-validated against its
schema client-side, because eager input streaming means the server no longer
does that.

---

## Validation

After generating, Cartograph runs the project's own checks in the output
directory and reports precisely what happened:

- **Type check.** Prefers the project's own `node_modules/typescript`. When the
  project has none — the usual case right after generating into a fresh
  directory — it falls back to the compiler bundled with Cartograph through the
  TypeScript API, and says so in the report, because a different compiler
  version can legitimately give a different answer.
- **Tests.** Runs `npm test` when a `test` script exists, and notes when
  `node_modules` is absent.
- **Java.** Runs `javac`; assertion-enabled test classes can be listed in
  `cartograph.validation.json` as `javaTestClasses`.
- **Python.** Parses sources with the available Python interpreter without
  importing the project; configure test commands for behavioral checks.
- **C/C++.** Runs GCC/G++ syntax checks. `cTestSources` lists the C sources to
  compile, link and execute as assertion-based tests.
- **Project-specific checks.** `checks` in `cartograph.validation.json` accepts
  `{name, exe, args, kind: "tests" | "contracts"}` for existing build/test/verification
  tools. Commands are spawned directly. Missing toolchains are reported as skipped.

Java's default check uses analyzed sources without an external classpath; the
C/C++ default check uses conventional include roots. Configure checks for
Maven/Gradle projects or specialized compiler settings. Passing compilation is
not a behavioral compatibility claim. Contract checks report unverified
specifications separately from the results of exercised assertions/tests.

A check that was skipped is never counted as a pass. `ValidationReport.passed`
is true only when at least one check ran and none failed, and the summary says
"No checks could be run, so the generated project is unverified" when that is
the truth.

---

## Tests

```bash
npm test
```

**165 tests across 10 files.** They use the real analyzer, the real engine and
the real compiler — nothing about the pipeline is mocked.

| File | What it covers |
|---|---|
| [`tests/unit/analyzer.test.ts`](tests/unit/analyzer.test.ts) | Ignore rules, specifier resolution incl. aliases, and the full analysis of the sample project: expected modules, every edge verified and backed by evidence, symbols mapped to real lines, deterministic repeat runs |
| [`tests/unit/graph.test.ts`](tests/unit/graph.test.ts) | The operation reducer (every operation, including the ones it refuses), path projection, the architecture diff and its round trip, the layout algorithm, selectors, invariant checks |
| [`tests/unit/transform.test.ts`](tests/unit/transform.test.ts) | Path and specifier utilities, the virtual workspace's change tracking, import rewriting across all four import syntaxes, unused-import removal, writer path safety and preflight, diffs, and the engine on a hand-built graph |
| [`tests/unit/ai.test.ts`](tests/unit/ai.test.ts) | The tool surface and every tool's behaviour against a workspace, path refusals, and the "don't believe the model" logic — all with no network call |
| [`tests/integration/pipeline.test.ts`](tests/integration/pipeline.test.ts) | The full round trip on a copy of the sample project: analyze → edit → generate → **type check and run the output's own tests** → re-analyze and confirm the new architecture. Plus in-place writing with a backup and a verified rollback, a symbol-level refactor, and the four ways an operation can decline |
| [`tests/ui/app.test.tsx`](tests/ui/app.test.tsx) | The real React app in jsdom against the real backend: the graph renders, pending modules are flagged, a drag records no operation, a structural edit plans real file changes, writing reports honest validation, and an unsupported operation says so instead of claiming success |
| [`tests/unit/languages.test.ts`](tests/unit/languages.test.ts) | Python packages, Java imports/types, C/C++ includes and compilation database paths, mixed projects and parser diagnostics |
| [`tests/integration/program-graph.test.ts`](tests/integration/program-graph.test.ts) | Java/C functional modules, scoped/overloaded symbols, Python/C++ details, exact call/field/contract dependencies, pending edits, generated renames, sequential source anchors, compilation failures and behavior failures despite successful compilation |
| [`tests/ui/program-graph.test.tsx`](tests/ui/program-graph.test.tsx) | Hierarchical navigation, all five inspector sections, contract CRUD as pending intent, impact and exact source evidence |
| [`tests/ui/module-edges.test.tsx`](tests/ui/module-edges.test.tsx) | Collapsed module arrows, selection-only dependency detail, mutual direction, uncertainty, evidence inspection and individual dependency deletion |

`npm run smoke` additionally boots the built Electron app and fails if the
renderer logs an error.

---

## Limitations

Stated plainly, because a tool that rewrites your code should not be vague about
what it cannot do.

**Language support.** Module-tree analysis supports TypeScript/JavaScript,
Python (`.py`, `.pyi`), Java (`.java`), and C/C++ sources and headers (`.c`, `.h`,
`.cc`, `.cpp`, `.cxx`, `.c++`, `.hh`, `.hpp`, `.hxx`, `.h++`, `.ipp`, `.tpp`), including
mixed-language repositories. Python, Java, and C/C++ use bundled Tree-sitter WASM
grammars, so analysis needs no additional language runtimes or compilers.
Python resolves packages under the project root, `src`, and `lib`, plus relative
imports. Java indexes declared packages and types, resolves ordinary/static/wildcard
imports, and detects project types referenced in the same package without imports.
C/C++ resolves quoted includes beside the source file, then compiler include paths
from a root-level `compile_commands.json` (`-I`, `-iquote`, `-isystem`, `/I`). Without
a compilation entry, it checks the project root, `include`, `src`, and `lib` and
reports ambiguity. Syntax errors, unresolved local imports, and macro includes
produce analysis warnings. Dynamic Python imports, custom Python search paths,
Java classpath inference, C/C++ modules, and preprocessor condition evaluation are
not supported; conditional imports/includes are collected as potential dependencies.
Automatic file-move import rewriting remains specific to TypeScript/JavaScript.
Fine-grained source edits and Java/C/C++ checks are supported as described above.
Symbol binding is conservative lexical analysis, not a complete Java classpath or
C++ compiler semantic model. Unknown receivers, indirect calls and ambiguous
overloads remain unresolved or potential. No formal behavioral prover is bundled.
See [the language registry](src/core/analyzer/languages/index.ts) to add analyzers.

**Clustering is a heuristic.** Java/C/C++ use resolved interface/implementation
and private-helper relationships to group files across directories and subdivide
packages. Independent public consumers remain separate. JS/TS/Python retain
directory/naming clustering. Confidence and boundary notes explain these choices;
they remain architectural suggestions rather than proven conceptual boundaries.

**Dependency removal is not implemented.** `remove_dependency` on an edge that
real imports back is refused with the list of offending imports. This is a
deliberate refusal, not a gap waiting to be filled with a guess.

**`add_dependency` writes no code.** It records intent and draws a dashed edge.

**Symbol moves have known edges.** A declaration merged into a shared statement
(`const a = 1, b = 2`) is refused. Namespace imports of a moved symbol's module
are not rewritten (the symbol is still reachable, but the edge stays). Decorator
metadata, `declare module` blocks and ambient declarations are not analyzed.
Anything the mover cannot finish is reported as `partial` with the files to
check by hand.

**Generating to a new directory skips dependency directories.** `node_modules`
and build output are not copied, so the output needs `npm install` before its
own tests can run with their dependencies. The validation report says when it
ran without them. For the sample project this does not matter — it has no
dependencies at all.

**No packaging step.** `npm run build` produces the Electron bundle in `out/`;
there is no installer target. Adding `electron-builder` is a config change, not
a code change.

**Scale is untested beyond medium projects.** Analysis holds every source file
in memory and the layout is a single pass. It handles the sample project in
~130 ms and projects of a few thousand files comfortably; a very large monorepo
will be slow, and the graph will be dense enough to need filtering that is not
implemented.

**No undo.** The operation log is append-only in this prototype. The recovery
paths that exist are: re-analyze (which discards unapplied graph edits), and the
backup directory written before an in-place write, which
[`restoreBackup`](src/core/output/writer.ts) can replay.

**The API key is as safe as the OS allows.** Encrypted with the OS keychain
where `safeStorage` reports one; stored in plain text in the settings file where
it does not, with a warning in the activity log.

---

## Designed for multiplayer later

Multiplayer is explicitly not implemented. The structural decisions that would
make it painful were avoided:

- **The graph model is independent of the GUI.** [`src/shared`](src/shared) has
  no React and no IO; the reducer is a pure function the renderer and the backend
  both call.
- **Every edit is a discrete, serializable operation** carrying its `actor`, its
  `issuedAt`, and the `baseVersion` it was authored against — the three fields
  conflict detection needs.
- **Ids are stable** across renames, saves and reloads, for modules and for
  edges.
- **Versions exist at every level**: the graph, each module, each edge, the
  layout, and the document schema.
- **No global mutable state.** Logging goes through an injected `Logger`;
  analysis and generation take their dependencies as arguments, so two sessions
  can run side by side in one process (the UI tests do exactly that).
- **The backend is already an interface.**
  [`CartographService`](src/core/pipeline.ts) is async, serializable and
  transport-agnostic; the Electron main process is one implementation, and a
  server would be another. Code generation is modelled as a `GenerationTask`
  value — project, graph, operations — precisely so it can later be submitted by
  a remote user or handed to a parallel agent.
- **Ownership and locking have somewhere to live:** `ModuleMetadata.owner` and
  `lockedBy`.
- **Storage is swappable.** [`document-store.ts`](src/main/services/document-store.ts)
  is the only code that knows the document is a file on disk.

---

## Project layout

```
src/
  shared/              The model. Pure, no IO, imported everywhere.
    types/             architecture · operations · generation · project · ipc · ai
    graph/             model · apply-operation (the reducer) · diff · layout · selectors
    util/              paths (POSIX, portable) · id
  core/                The engine. Framework-free, no Electron.
    analyzer/          scan · ignore · resolve · lexicon · cluster · build-graph
      languages/       LanguageAnalyzer registry + JS/TS, Python, Java, C/C++ analyzers
    transform/         workspace (virtual FS) · imports (rewriting) · engine
      ops/             module-ops · move-symbol · dependency-ops
    ai/                client · tools · agent · prompts · transformer · enrich
    output/            differ · writer (+ backup/restore) · validate
    pipeline.ts        CartographService — the backend interface
    logger.ts          Injected logging/progress channel
  main/                Electron main process
    ipc/handlers.ts    Thin adapters over CartographService
    services/          settings-store (safeStorage) · document-store
  preload/index.ts     contextBridge: exposes exactly CartographApi
  renderer/            React UI
    state/store.ts     Original + desired graph, layout, operation log
    components/        Toolbar · LeftSidebar · GraphCanvas · ModuleNodeView ·
                       Inspector · BottomPanel · dialogs · common
    styles/app.css     One stylesheet, CSS variables, no framework
sample-project/        shop-api — the TypeScript project used by the demo and tests
tests/
  unit/                analyzer · graph · transform · ai
  integration/         pipeline — the full round trip
  ui/                  the real React app against the real backend, in jsdom
scripts/smoke-launch.mjs
```

### Stack

Electron 38 · React 18 · TypeScript 5.9 · `@xyflow/react` 12 · ts-morph 27 ·
Zustand 5 · Zod 4 · `@anthropic-ai/sdk` · electron-vite 4 · Vitest 3.

The layout algorithm is hand-written rather than pulled from a library, because
it has to be byte-for-byte reproducible (it is saved into the document and
asserted in tests) and has to run in a plain Node test with no DOM.

---

## License

MIT.
