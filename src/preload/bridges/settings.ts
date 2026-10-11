import { ipcRenderer } from 'electron'

import { SETTINGS_CHANNELS, type SettingsApi } from '../../shared/ipc'

export const settingsBridge: SettingsApi = {
  getSettings: () => ipcRenderer.invoke(SETTINGS_CHANNELS.getSettings),
  setSettings: (patch) =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.setSettings, patch),
  testApiKey: (provider) =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.testApiKey, provider)
}
