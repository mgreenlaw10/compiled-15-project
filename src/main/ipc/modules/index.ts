/**
 * The handler manifest.
 *
 * Every IPC handler module, in registration order. Adding a capability means
 * adding a module here and a channel group in `shared/ipc/channels.ts` — not
 * editing a file someone else is also editing.
 *
 * A module is a function of the handler context returning a
 * `channel -> implementation` map. It reaches Electron, the filesystem and the
 * backend only through that context, which is what keeps the IPC layer thin:
 * validate the arguments, call into `CartographService`, return. No analysis,
 * transformation or filesystem logic belongs in these files.
 */

import type { HandlerModule } from '../context'
import { collabHandlers } from './collab'
import { documentHandlers } from './document'
import { generationHandlers } from './generation'
import { projectHandlers } from './project'
import { settingsHandlers } from './settings'
import { systemHandlers } from './system'

export const HANDLER_MODULES: readonly HandlerModule[] = [
  projectHandlers,
  documentHandlers,
  generationHandlers,
  settingsHandlers,
  collabHandlers,
  systemHandlers
]
