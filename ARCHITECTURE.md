# Module map and ownership

This document exists so three people can work at once without merge conflicts.
It says what each module is, who should own it for the next round of work, and —
for each planned task — exactly which files to touch and which to leave alone.

The guiding rule everywhere below: **extending the app should mean adding a
file and one line to a manifest, not editing a file someone else has open.**

## Layers

```
src/
  shared/     contracts only. No Electron, no React, no filesystem, no SDKs.
  core/       the backend. Node, no Electron, no React. Runs in a unit test.
  main/       the Electron shell: window, menu, IPC registration.
  preload/    the typed bridge. One file per API domain.
  renderer/   the UI. React, no Node.
```

`shared` is the one place every layer imports. It is deliberately thin and
split by domain so that two people adding unrelated contracts touch different
files:

| Path | What it is |
| --- | --- |
| `shared/types/` | The domain model: architecture, operations, generation, project. |
| `shared/ipc/` | The renderer↔main contract, one file per handler module, plus `channels.ts` and `commands.ts`. |
| `shared/ai/` | The provider catalog and `AiConfig`. Renderer-safe: no SDK. |
| `shared/languages/` | Which extensions are source and what language each is. Read by the scanner *and* the UI. |
| `shared/collab/` | Actor, participant and operation-batch shapes for multi-writer work. |
| `shared/graph/` | The pure reducer (`apply-operation`), diffing, layout, selectors. |

## Extension points

Every one of these is a registry or manifest. Adding to it is additive.

| To add… | Edit | Then |
| --- | --- | --- |
| A **language** | `shared/languages/catalog.ts` | new `core/analyzer/languages/<lang>/`, register in that dir's `index.ts` |
| An **AI provider** | `shared/ai/providers.ts` | new `core/ai/providers/<name>.ts` (copy `luminal.ts` if OpenAI-compatible), register in `providers/index.ts` |
| An **IPC capability** | `shared/ipc/channels.ts` + a `shared/ipc/<domain>.ts` | new `main/ipc/modules/<domain>.ts` + `preload/bridges/<domain>.ts` |
| A **dialog** | `renderer/state/types.ts` (`DialogName`) | new `renderer/features/dialogs/<X>Dialog.tsx`, register in `dialogs/registry.ts` |
| A **context-menu item** | — | `renderer/features/canvas/context-menu/items.ts` |
| **Edge colours / legend** | — | `renderer/features/canvas/edges/edge-style.ts` |
| A **command** (menu / shortcut) | `shared/ipc/commands.ts` | `renderer/app/commands.ts`, and `main/menu.ts` if it needs a menu item |
| **State** | `renderer/state/types.ts` | new or existing `renderer/state/slices/<x>.ts`, spread in `use-store.ts` |
| **Styles** | the feature's own `.css`, or `renderer/styles/<area>.css` | `@import` in `renderer/styles/index.css` |

Several of these are typed as *total* maps on purpose — `DIALOGS`,
`COMMAND_HANDLERS`, `EDGE_STYLES` — so a half-added feature fails the type
check instead of becoming a dead button or an uncoloured arrow.

## Ownership for the planned tasks

Three people, five tasks. The assignment below keeps each person inside their
own directories.

### 1 · Right-click to add module / other options — **frontend A**

Owns `renderer/features/canvas/context-menu/`.

- Add items to `context-menu/items.ts`. A `MenuItem` is a label, a predicate
  and a `run` that receives a live store snapshot, so items call store actions
  directly.
- `context-menu/ContextMenu.tsx` is the appearance; `useContextMenu.ts` is the
  React Flow wiring and is **already installed** in `GraphCanvas.tsx`.
- Styles in `context-menu/context-menu.css`.
- New dialogs a menu item opens: own file in `features/dialogs/`, one line in
  `dialogs/registry.ts`.
- Should not need to touch `GraphCanvas.tsx`, `edges/`, or `state/slices/`.

See `features/canvas/context-menu/README.md`.

### 2 · AI providers — **backend B** · Luminal is **done**

Owns `shared/ai/`, `core/ai/providers/`, `features/dialogs/SettingsDialog.tsx`.

**Luminal is implemented and tested** (DeepSeek V4.1 Flash through its
OpenAI-compatible Flash endpoint). What that required, and what it leaves
behind for the next provider:

- `core/ai/providers/chat.ts` is now a **protocol-neutral** `ChatModel`
  interface. `agent.ts` and `enrich.ts` are written against it and name no
  vendor; the Anthropic SDK is imported in exactly one file.
- `core/ai/providers/openai-compatible.ts` is a reusable transport for any
  OpenAI-style `/chat/completions` endpoint.
- `core/ai/providers/luminal.ts` is therefore ~40 lines of configuration.

So adding another provider is:

1. A descriptor in `shared/ai/providers.ts`.
2. A module in `core/ai/providers/` — copy `luminal.ts` if the endpoint is
   OpenAI-compatible, otherwise implement `ChatModel` directly.
3. One line in `PROVIDERS` in `core/ai/providers/index.ts`.

Keys are stored **per provider** (`settings.apiKeys[providerId]`, encrypted via
`safeStorage`, with a schema-1 migration and an `envVar` fallback), and the
settings dialog renders the catalog from the descriptors. So `settings-store.ts`,
`main/ipc/modules/settings.ts`, `shared/ipc/settings.ts` and `SettingsDialog.tsx`
need no changes.

Read `core/ai/providers/README.md` before adding one — it covers
`ChatCapabilities` (how a provider declares what it genuinely does, instead of
callers assuming) and the two rules that are easy to get wrong: reasoning is
never replayed, and tool inputs are always re-validated locally.

### 3 · Colour-code arrows — **frontend A or C**

Owns `renderer/features/canvas/edges/`.

- `edge-style.ts` is the whole job: `EDGE_STYLES` maps dependency kind →
  colour and dash, `edgeAppearance` resolves one edge, `toFlowEdge` builds the
  React Flow edge, and `EDGE_LEGEND` is **derived from the same table** so the
  legend cannot disagree with the canvas.
- `EdgeLegend.tsx` renders from that data. `GraphCanvas.tsx` calls
  `toFlowEdge` and renders `<EdgeLegend />` and nothing else about colour.
- Two rules worth keeping: an unverified edge must stay visually distinct from
  a verified one (the graph presents verified edges as fact), and every colour
  on the canvas needs a legend entry.
- Note `DependencyKind` is currently `imports | depends_on | calls`; widening it
  means editing `shared/types/architecture.ts`, which is shared — coordinate.

### 4 · More language support — **backend B or C**

Owns `shared/languages/` and `core/analyzer/languages/`.

Three steps, documented in `core/analyzer/languages/README.md`:

1. A `LanguageDescriptor` in `shared/languages/catalog.ts`.
2. `core/analyzer/languages/<lang>/` implementing `LanguageAnalyzer`.
3. Register it in `core/analyzer/languages/index.ts`.

`ignore.ts`, `scan.ts` and `analyzer/index.ts` now derive everything from the
catalog, so they should not need editing. Two caveats that are **outside** this
directory and will need coordinating if the language must be *editable* rather
than just readable:

- Import rewriting (when files move between modules) is
  `core/transform/imports.ts`, TypeScript-specific today.
- Validation (`tsc`, `npm test`) is `core/output/validate.ts`.

### 5 · Multi-user concurrent work — **person C**

Owns `shared/collab/`, `renderer/features/presence/`,
`renderer/state/slices/session.ts`, and a new `main/ipc/modules/collab.ts`.

The merge primitive already exists and is already tested: operations are plain
JSON carrying an `actor` and the `baseVersion` they were authored against, and
`applyOperations` replays a log onto a graph reporting each operation that no
longer applies instead of dropping it. `state/slices/document.ts`
(`restoreDocument`) is already a merge of exactly that kind.

Read `renderer/features/presence/README.md` first — it lays out what exists and
what a build-out looks like. Adding the transport is a new IPC module plus a
channel group, which is additive by construction.

## Shared files — coordinate before editing

Short list, and it is short on purpose:

- `shared/types/architecture.ts` — the domain model. Task 3 may want to widen
  `DependencyKind`; task 4 may want per-language symbol kinds.
- `shared/types/operations.ts` — the operation union. Task 1 adds operations
  only if it adds genuinely new edits.
- `renderer/state/types.ts` — one interface per slice, so additions rarely
  collide, but it is one file.
- `renderer/styles/index.css` — the `@import` list. One line per new
  stylesheet; conflicts here are trivial to resolve.
- `electron.vite.config.ts`, the `tsconfig.*.json` files, `package.json`.

## Things that are no longer shared

For reference, the hotspots this split removed:

| Was | Now |
| --- | --- |
| `renderer/state/store.ts`, 736 lines, wanted by tasks 1, 2 and 5 | 10 slices under `state/slices/`, plus a 30-line composition root |
| `renderer/components/dialogs.tsx`, 723 lines, tasks 1 and 2 | one file per dialog behind `dialogs/registry.ts` |
| `renderer/styles/app.css`, 1062 lines, tasks 1 and 3 | 13 stylesheets, feature ones living beside their components |
| `renderer/components/GraphCanvas.tsx`, tasks 1 and 3 | canvas + `edges/` + `context-menu/`, each self-contained |
| `main/ipc/handlers.ts`, 357 lines, tasks 2 and 5 | 5 handler modules + a 95-line registrar |
| `shared/types/ipc.ts`, tasks 2 and 5 | 7 domain files assembled into `CartographApi` |
| `core/ai/client.ts` hardcoded to Anthropic, task 2 | a provider registry behind a protocol-neutral `ChatModel`; the Anthropic SDK is imported in one file |
| `analyzer/ignore.ts` hardcoding extensions, task 4 | derived from `shared/languages/catalog.ts` |

## Verifying

```bash
npm run verify
```

Runs typecheck (three projects), the test suite, the build, and the launch
smoke test. The smoke test needs no other copy of Cartograph running — it
checks the single-instance lock and reports `INCONCLUSIVE` rather than failing
if one is.
