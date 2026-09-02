import { useEffect, useState } from 'react'
import { agentThemes, portalThemes } from '@kipple/shared/themes'
import { api } from '../lib/api'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

export function DefaultsManager({ onClose }: { onClose: () => void }) {
  const [agentTheme, setAgentTheme] = useState('')
  const [portalTheme, setPortalTheme] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .instanceDefaults()
      .then((defaults) => {
        setAgentTheme(defaults.agentTheme ?? '')
        setPortalTheme(defaults.portalTheme ?? '')
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'failed to load instance defaults'),
      )
  }, [])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api.patchInstanceDefaults({
        agentTheme: agentTheme || null,
        portalTheme: portalTheme || null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save instance defaults')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md border border-line bg-ink"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm tracking-widest text-accent">instance defaults</div>
          <button onClick={onClose} className={dimButtonClass}>
            close
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 border border-danger px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="space-y-4 p-4">
          <p className="text-xs text-dim">
            What users see without their own theme choice: agents get the agent default, the
            client portal gets the portal default (client branding still wins over it).
            “default” = the built-in (console for agents, slate for the portal).
          </p>
          <div className="flex items-center gap-2">
            <span className="w-24 text-xs text-dim">agent default</span>
            <select
              value={agentTheme}
              onChange={(event) => setAgentTheme(event.target.value)}
              className={inputClass}
            >
              <option value="">default</option>
              {agentThemes().map((meta) => (
                <option key={meta.id} value={meta.id}>
                  {meta.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 text-xs text-dim">portal default</span>
            <select
              value={portalTheme}
              onChange={(event) => setPortalTheme(event.target.value)}
              className={inputClass}
            >
              <option value="">default</option>
              {portalThemes().map((meta) => (
                <option key={meta.id} value={meta.id}>
                  {meta.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end">
            <button onClick={() => void save()} disabled={busy} className={buttonClass}>
              save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
