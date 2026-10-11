# Canvas context menu

Right-click on the canvas, a module, or an edge.

| File | What it is |
| --- | --- |
| `types.ts` | `MenuItem` and `MenuTarget`: what an item is and where the click landed. |
| `items.ts` | **What the menu offers.** Add items here. |
| `ContextMenu.tsx` | How the menu looks and dismisses. Content-agnostic. |
| `useContextMenu.ts` | The React Flow wiring, already installed in `../GraphCanvas.tsx`. |

## Adding an item

Add a `MenuItem` to `CANVAS_MENU_ITEMS` in `items.ts`:

```ts
{
  id: 'rename-module',
  label: 'Rename…',
  appliesTo: ['module'],
  disabled: ({ state }) => (state.busy !== 'idle' ? 'Busy' : false),
  run: ({ state, target }) => { /* call store actions */ }
}
```

`run` and the predicates receive a live store snapshot, so items call store
actions directly — nothing needs threading through the canvas, and
`GraphCanvas.tsx` does not need editing.

Prefer `disabled` (which takes a reason, shown on hover) over `visible`: a menu
whose items appear and disappear is harder to learn than one where they grey
out and say why.

## Styling

`styles/context-menu.css`, via the `.context-menu*` classes.
