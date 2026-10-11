# Atlas

Interactive UI replacement for Cartograph. Sample data is local React state.
The Electron backend remains available in the repository, but this prototype does
not call it, read a real project, run generation, or write source files.

## Run

```sh
npm ci
npm run dev
```

Optional browser preview at http://127.0.0.1:5181. `npm run dev` opens this design in its own native Electron window.
Each concept has isolated app data and an independent instance lock.
For a built native app, run `npm run build` followed by `npm start`.

## Try

- Select modules and files.
- Search modules, paths, and file names. Cmd/Ctrl+K focuses search.
- Move a selected file using its module selector.
- Review moves, switch between changes, and undo the last move.
- Add a module with a unique name.
- Preview the sample plan. Escape closes dialogs.
- Resize to a narrow window. Reduced motion is respected.

The code panel and import diff are illustrative, not compiler output.
