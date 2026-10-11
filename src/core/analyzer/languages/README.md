# Language analyzers

Static analysis is the only source of *factual* dependency information in
Cartograph. Everything else — clustering, the graph, the canvas — consumes the
facts an analyzer reports and never asks which language produced them.

## Files here

| File | What it is |
| --- | --- |
| `../../../shared/languages/catalog.ts` | Extensions and language tags. The scanner and `../ignore.ts` read this. |
| `types.ts` | The `LanguageAnalyzer` contract and the `FileAnalysis` / `ImportRecord` shapes. |
| `registry.ts` | Partitions discovered files to the analyzer that claims them. |
| `index.ts` | The manifest: `createDefaultRegistry()`. |
| `typescript/` | The reference analyzer, built on ts-morph. |
| `tree-sitter.ts` | Shared WASM parser lifecycle, syntax diagnostics, and symbol helpers. |
| `python.ts` | Python declarations, literal `__all__`, package and relative imports. |
| `java.ts` | Java types, package/type indexing, imports and same-package type references. |
| `cpp.ts` | C/C++ declarations and includes, with compilation database search paths. |

## Adding a language

1. **Catalog** — add a `LanguageDescriptor` to `LANGUAGES` in `src/shared/languages/catalog.ts`:
   its extensions, display name, and any finer-grained variant tags.
2. **Analyzer** — create `./<language>/` with a class implementing
   `LanguageAnalyzer` from `types.ts`. It receives every discovered file of its
   kind plus an `AnalyzerContext` (project root, all files, path aliases) and
   returns one `FileAnalysis` per file.
3. **Register** — add it to `createDefaultRegistry()` in `index.ts`.

Scanning, ignore rules and module import edges use the language registry.
Detailed symbol extraction additionally lives in `../program-analysis.ts`:
register the language's grammar and declaration/reference rules there to supply
the hierarchical source model. Preserve source ranges, uncertainty and scope;
do not turn unresolved bindings into factual edges.

## The contract, in short

Report facts, not guesses.

- `symbols` — what the file declares, with a kind and a one-line signature.
- `exportedNames` — what it exports.
- `imports` — one `ImportRecord` per import, with `resolvedPath` set when the
  specifier lands on a file inside the project and `external: true` when it
  does not. Unresolved first-party imports belong in `problems`, not in a
  guessed path: a wrong edge is worse than a missing one, because the canvas
  presents verified edges as fact.
- `problems` — anything that did not parse or resolve. These surface in the
  analysis log, which is how a user finds out the picture is incomplete.

## Two things this directory does not cover

Both are needed for a language to be *editable*, not just *readable*. A new
language can be analyzed and drawn without them.

- **Import rewriting**, used when files move between modules, lives in
  `src/core/transform/imports.ts` and is TypeScript-specific today.
- **Fine edits** live in `src/core/transform/ops/program-ops.ts`; complex edits
  use the existing AI transformer and still require validation.
- **Validation** (`tsc`, `npm test`, `javac`, GCC/G++, configured tests and
  contract checks) lives in `src/core/output/validate.ts` and
  `src/core/output/program-validation.ts`.
