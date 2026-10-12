/**
 * Settings: which provider, which model, how hard it works.
 *
 * Everything on this screen is driven by the provider catalog in
 * `shared/ai/providers.ts` — the provider list, the models offered, the key
 * placeholder, where to get a key. Adding a provider means adding a descriptor
 * there and an implementation under `core/ai/providers/`; this file should not
 * need to change.
 *
 * Keys are per provider, so switching providers does not discard the key for
 * the one you came from, and the field shows the status of the provider
 * currently selected.
 */

import { useEffect, useState } from 'react'

import {
  EFFORT_LEVELS,
  availableProviders,
  providerOrDefault,
  type AiProviderId
} from '../../../shared/ai'
import { useStore } from '../../state/store'
import { Banner, Checkbox, Modal, TextField } from '../../ui'

export function SettingsDialog(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const openDialog = useStore((s) => s.openDialog)

  const providers = availableProviders()

  const [provider, setProvider] = useState<AiProviderId>(
    settings?.provider ?? providers[0]?.id ?? 'anthropic'
  )
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings?.model ?? '')
  const [effort, setEffort] = useState(settings?.effort ?? 'high')
  const [assist, setAssist] = useState(settings?.aiAssistAnalysis ?? true)
  const [maxReads, setMaxReads] = useState(settings?.maxAiFileReads ?? 40)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const descriptor = providerOrDefault(provider)
  const status = settings?.providers?.[provider]
  const hasKeyForProvider = status?.hasApiKey === true

  // Switching providers moves to that provider's default model, since a model
  // name from one provider is meaningless to another. An unsaved key typed for
  // the previous provider is dropped rather than silently sent to the new one.
  const switchProvider = (next: AiProviderId): void => {
    setProvider(next)
    setApiKey('')
    setTest(null)
    setModel(
      next === settings?.provider && settings.model
        ? settings.model
        : providerOrDefault(next).defaultModel
    )
  }

  // Keep the model in range when the dialog opens against stored settings.
  useEffect(() => {
    if (model === '') setModel(descriptor.defaultModel)
  }, [model, descriptor.defaultModel])

  const save = async (): Promise<void> => {
    await updateSettings({
      provider,
      ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
      model,
      effort,
      aiAssistAnalysis: assist,
      maxAiFileReads: maxReads
    })
    setApiKey('')
  }

  const keyHint = (): string => {
    if (status?.fromEnvironment === true) {
      return `Using the key in $${descriptor.envVar}. Type one here to store it instead.`
    }
    if (hasKeyForProvider) {
      return `A key is stored (${status?.apiKeyHint}). Type a new one to replace it; leave it blank to keep it. Stored in your user data directory, encrypted with the OS keychain where one is available — never inside the project.`
    }
    return 'Stored in your user data directory, encrypted with the OS keychain where one is available — never inside the analyzed project.'
  }

  return (
    <Modal
      title="Settings"
      bodyClassName="settings-body"
      onClose={() => openDialog(null)}
      footer={
        <>
          <button
            className="btn"
            disabled={testing || (!hasKeyForProvider && apiKey.trim() === '')}
            onClick={async () => {
              setTesting(true)
              setTest(null)
              await save()
              setTest(await window.cartograph.testApiKey(provider))
              setTesting(false)
            }}
          >
            {testing ? 'Testing…' : 'Test key'}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Close
          </button>
          <button
            className="btn btn--primary"
            onClick={() => {
              void save().then(() => openDialog(null))
            }}
          >
            Save
          </button>
        </>
      }
    >
      {test ? (
        <Banner kind={test.ok ? 'ok' : 'error'} onClose={() => setTest(null)}>
          {test.message}
        </Banner>
      ) : null}

      {settings?.storesKeysInPlainText === true ? (
        <Banner kind="warn">
          No OS keychain is available on this system, so API keys are stored
          unencrypted in the Cartograph settings file.
        </Banner>
      ) : null}

      {providers.length > 1 ? (
        <label className="field">
          <span className="label">Provider</span>
          <select
            value={provider}
            onChange={(event) => switchProvider(event.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
                {settings?.providers?.[p.id]?.hasApiKey ? ' — key stored' : ''}
              </option>
            ))}
          </select>
          <span className="hint">{descriptor.summary}</span>
        </label>
      ) : null}

      <TextField
        label={`${descriptor.displayName} API key`}
        type="password"
        value={apiKey}
        onChange={setApiKey}
        placeholder={
          hasKeyForProvider
            ? `stored (${status?.apiKeyHint})`
            : descriptor.keyPlaceholder
        }
        hint={keyHint()}
      />

      <label className="field">
        <span className="label">Model</span>
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {[...new Set([model, ...descriptor.models])]
            .filter((m) => m !== '')
            .map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
        </select>
        <span className="hint">
          {descriptor.defaultModel} is the default and the most capable of these.
        </span>
      </label>

      <label className="field">
        <span className="label">Effort</span>
        <select value={effort} onChange={(event) => setEffort(event.target.value)}>
          {EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <span className="hint">
          How hard the model works per request. Higher costs more and takes
          longer; refactoring usually wants “high”.
        </span>
      </label>

      <label className="field">
        <span className="label">File reads per task</span>
        <input
          type="number"
          min={1}
          max={500}
          value={maxReads}
          onChange={(event) => setMaxReads(Number(event.target.value))}
        />
        <span className="hint">
          A ceiling on how much of the codebase the agent may read while
          carrying out one operation.
        </span>
      </label>

      <Checkbox
        checked={assist}
        onChange={setAssist}
        label="Use the model to describe modules when analyzing"
        hint="Static analysis still decides which files belong to which module; the model only writes descriptions and responsibilities, and they are labelled as model-written."
      />
    </Modal>
  )
}
