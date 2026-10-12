/**
 * Command handling.
 *
 * A command is a named intent that arrives from somewhere outside React — the
 * application menu, a keyboard accelerator — and this is the one place that
 * says what each one means. The canvas right-click menu calls store actions
 * directly instead, because its items need the click target; see
 * `features/canvas/context-menu/items.ts`.
 *
 * `COMMAND_HANDLERS` is typed as a total map over `CommandName`, so a command
 * added to `shared/ipc/commands.ts` without a handler here fails the type
 * check rather than becoming a silently dead menu item.
 */

import { useEffect } from 'react'

import { COMMAND_CHANNELS, COMMANDS, type CommandName } from '../../shared/ipc'
import { useStore } from '../state/store'
import type { AppState } from '../state/store'

export type CommandHandler = (state: AppState) => void

export const COMMAND_HANDLERS: Record<CommandName, CommandHandler> = {
  [COMMANDS.openProject]: (s) => void s.openProject(),
  [COMMANDS.saveGraph]: (s) => void s.saveDocument(),
  [COMMANDS.analyze]: (s) => void s.analyze(),
  [COMMANDS.addModule]: (s) => s.openDialog('add-module'),
  [COMMANDS.relayout]: (s) => s.relayout(),
  [COMMANDS.generate]: (s) => void s.plan(s.settings?.hasApiKey === true),
  [COMMANDS.settings]: (s) => s.openDialog('settings'),
  [COMMANDS.toggleLegend]: (s) => s.toggleLegend(),
  [COMMANDS.toggleMinimap]: (s) => s.toggleMinimap()
}

/** Runs one command against the current state. */
export function runCommand(command: CommandName): void {
  COMMAND_HANDLERS[command]?.(useStore.getState())
}

/**
 * Subscribes to every command the preload bridge republishes as a DOM event.
 * Registered once, on mount; the handlers read state through `getState` so the
 * listeners never need re-attaching.
 */
export function useCommands(): void {
  useEffect(() => {
    const offs = COMMAND_CHANNELS.map((channel) => {
      const listener = (): void => runCommand(channel)
      window.addEventListener(channel, listener)
      return () => window.removeEventListener(channel, listener)
    })
    return () => {
      for (const off of offs) off()
    }
  }, [])
}
