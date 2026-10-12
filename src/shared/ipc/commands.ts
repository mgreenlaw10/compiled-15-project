/**
 * Application commands.
 *
 * A command is a named intent — "add a module", "re-analyze" — with no idea of
 * where it was triggered from. The application menu sends one, a keyboard
 * shortcut sends one, and (task: right-click menus) a context menu sends one.
 * Naming them in `shared` means the main process, the preload bridge and the
 * renderer agree on the list without any of them importing the others.
 *
 * ---------------------------------------------------------------------------
 * Adding a command
 * ---------------------------------------------------------------------------
 * 1. Add it to `COMMANDS` below.
 * 2. Handle it in `src/renderer/app/commands.ts`, which maps each command to a
 *    store action. A command with no handler there fails the type check, so
 *    one cannot be half-added.
 * 3. If it should appear in the application menu, add an item in
 *    `src/main/menu.ts`.
 *
 * The preload bridge forwards every command in this list automatically, so it
 * never needs editing.
 */

export const COMMANDS = {
  openProject: 'menu:open-project',
  saveGraph: 'menu:save-graph',
  analyze: 'menu:analyze',
  addModule: 'menu:add-module',
  relayout: 'menu:relayout',
  generate: 'menu:generate',
  settings: 'menu:settings',
  toggleLegend: 'menu:toggle-legend',
  toggleMinimap: 'menu:toggle-minimap'
} as const

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS]

/** Every command, for the preload bridge to subscribe to. */
export const COMMAND_CHANNELS: readonly CommandName[] = Object.values(COMMANDS)
