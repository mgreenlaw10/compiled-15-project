# Features

One directory per region of the UI. A feature owns its components, its own
small helpers, and its stylesheet; anything shared with another feature moves
to `../ui` (components) or `../state` (state).

| Directory | What it is |
| --- | --- |
| `canvas/` | The architecture graph. Owns edge styling (`edges/`) and the right-click menu (`context-menu/`), each with its own registry. |
| `dialogs/` | Modals, one file each, behind `registry.ts`. |
| `inspector/` | The selected module in detail, composed into the review panel by the app. |
| `sidebar/` | The left pane: project info, module list, file explorer. |
| `toolbar/` | The top toolbar and the status bar. |
| `bottom-panel/` | Review panel tabs: preview, module, activity, plan, and results. |
| `review/` | Pending edits and architecture/source comparisons. Receives the project explorer through app composition. |
| `presence/` | Multi-writer UI. Empty; see its README. |

## The rule that keeps these independent

Features talk to each other through the store, not through imports. A feature
importing another feature's component is a sign the component belongs in
`../ui` instead. The one exception is `canvas/ModuleNodeView`, whose drag
payload type is shared with the panes that drop onto it.
