/**
 * The application menu.
 *
 * Menu items send a command name from `shared/ipc/commands.ts` rather than
 * doing anything themselves; the renderer decides what each one means. Kept out
 * of `index.ts` so adding a menu item never touches window lifecycle or the
 * security posture.
 */

import { Menu, dialog, type BrowserWindow } from 'electron'

import { COMMANDS, type CommandName } from '../shared/ipc'

export interface MenuDeps {
  /** Sends a command to the renderer. */
  send: (command: CommandName) => void
  getWindow: () => BrowserWindow | null
}

function aboutBox(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: 'Cartograph',
    message: 'Cartograph',
    detail: [
      'An AI-powered visual codebase editor.',
      '',
      'Import a codebase, see its architecture as an editable module',
      'graph, change the graph, and regenerate the source to match.',
      '',
      `Electron ${process.versions.electron} · Node ${process.versions.node}`
    ].join('\n')
  })
}

export function buildMenuTemplate(
  deps: MenuDeps
): Electron.MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  const send = deps.send

  return [
    ...(isMac
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send(COMMANDS.openProject)
        },
        {
          label: 'Save Architecture',
          accelerator: 'CmdOrCtrl+S',
          click: () => send(COMMANDS.saveGraph)
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => send(COMMANDS.settings)
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Architecture',
      submenu: [
        {
          label: 'Re-analyze Project',
          accelerator: 'CmdOrCtrl+R',
          click: () => send(COMMANDS.analyze)
        },
        {
          label: 'Add Module',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => send(COMMANDS.addModule)
        },
        {
          label: 'Auto Layout',
          accelerator: 'CmdOrCtrl+L',
          click: () => send(COMMANDS.relayout)
        },
        { type: 'separator' },
        {
          label: 'Generate Project…',
          accelerator: 'CmdOrCtrl+G',
          click: () => send(COMMANDS.generate)
        }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Checkbox items keep their own checked state, and the renderer
        // mirrors it. Defaults here must match the store's initial values:
        // the colour legend starts hidden, the minimap starts shown.
        {
          label: 'Dependency Colour Legend',
          type: 'checkbox',
          checked: false,
          click: () => send(COMMANDS.toggleLegend)
        },
        {
          label: 'Minimap',
          type: 'checkbox',
          checked: true,
          click: () => send(COMMANDS.toggleMinimap)
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      role: 'help',
      submenu: [{ label: 'About Cartograph', click: aboutBox }]
    }
  ]
}

export function installMenu(deps: MenuDeps): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(deps)))
}
