/**
 * The bridge manifest.
 *
 * One file per domain, mirroring `shared/ipc` and `main/ipc/modules`, so that
 * adding a capability means adding a bridge here rather than editing a file
 * everyone else is also editing. `CartographApi` is the intersection of the
 * fragments, so a method declared in the contract but never bridged fails the
 * type check below.
 */

import type { CartographApi } from '../../shared/ipc'
import { documentBridge } from './document'
import { generationBridge } from './generation'
import { projectBridge } from './project'
import { settingsBridge } from './settings'
import { systemBridge } from './system'

export const api: CartographApi = {
  ...projectBridge,
  ...documentBridge,
  ...generationBridge,
  ...settingsBridge,
  ...systemBridge
}
