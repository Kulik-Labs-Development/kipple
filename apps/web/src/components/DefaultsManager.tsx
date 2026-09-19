import { useEffect, useState } from 'react'
import { agentThemes, portalThemes } from '@kipple/shared/themes'
import { api } from '../lib/api'
import { applyTheme, resolveThemeChoice } from '../lib/theme'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

// Instance-wide defaults. Precedence (per surface): the viewer's own theme
// choice ("your theme") > the instance default > the built-in (console for
// agents, slate for the portal); on the portal a client's branding theme
// (set on the Clients page) sits between the two. The panel surfaces every
// factor, because a saved default that a per-user row shadows looks like a
// dead save button.
export function DefaultsManager({ onClose }: { onClose: () => void }) {
  const [agentTheme, setAgentTheme] = useState('')
  const [portalTheme, setPortalTheme] = useState('')
  const [personalTheme, setPersonalTheme] = useState('')
  const [maxMb, setMaxMb] = useState('')
  const [allowedMimes, setAllowedMimes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.instanceDefaults(), api.uploadSettings(), api.me()])
      .then(([defaults, uploads, me]) => {
        setAgentTheme(defaults.agentTheme ?? '')
        setPortalTheme(defaults.portalTheme ?? '')
        setPersonalTheme(me.preferences.theme ?? '')
        setMaxMb(String(uploads.maxMb))
        setAllowedMimes(uploads.allowedMimes.join('\n'))
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'failed to load instance defaults'),
      )
  }, [])

  // The viewer's own choice: applies immediately (the same house pattern as
  // the topbar picker), and is what shadows the defaults when set.
  async function changePersonal(value: string) {
    const previous = personalTheme
    setPersonalTheme(value)
    setNotice(null)
    try {
      await api.patchPreferences({ theme: value || null })
      const me = await api.me()
      applyTheme(
        resolveThemeChoice(
          me.preferences,
          me.instanceTheme,
          me.user.role,
          me.primaryClient?.branding ?? null,
          me.agentDefaultTheme,
        ),
      )
    } catch (err) {
      setPersonalTheme(previous)
      setError(err instanceof Error ? err.message : 'failed to save your theme')
    }
  }

  async function save() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.patchInstanceDefaults({
        agentTheme: agentTheme || null,
        portalTheme: portalTheme || null,
      })
      const mb = Number.parseInt(maxMb, 10)
      const mimes = allowedMimes
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      if (Number.isFinite(mb) && mb >= 1) {
        await api.patchUploadSettings({ maxMb: mb, allowedMimes: mimes })
      }
      // Apply the new defaults to the open app so the save is visible
      // without a reload, and re-read the viewer's own row for the notice.
      const me = await api.me()
      applyTheme(
        resolveThemeChoice(
          me.preferences,
          me.instanceTheme,
          me.user.role,
          me.primaryClient?.branding ?? null,
          me.agentDefaultTheme,
        ),
      )
      setPersonalTheme(me.preferences.theme ?? '')
      setNotice(
        me.preferences.theme
          ? 'saved — your personal theme still applies to you (see "your theme" above)'
          : 'saved',
      )
      setTimeout(() => setNotice(null), 3000)
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
        {notice && (
          <div className="mx-4 mt-3 border border-ok px-3 py-2 text-xs text-ok">{notice}</div>
        )}

        <div className="space-y-4 p-4">
          <p className="text-xs text-dim">
            What users see without their own theme choice: agents get the agent default, the
            client portal gets the portal default (client branding still wins over it).
            “default” = the built-in (console for agents, slate for the portal). A personal
            choice below overrides these defaults for that user.
          </p>
          <div className="flex items-center gap-2">
            <span className="w-24 text-xs text-dim">your theme</span>
            <select
              value={personalTheme}
              onChange={(event) => void changePersonal(event.target.value)}
              className={inputClass}
            >
              <option value="">default (follows the agent default)</option>
              {agentThemes().map((meta) => (
                <option key={meta.id} value={meta.id}>
                  {meta.label}
                </option>
              ))}
            </select>
          </div>
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
          <p className="-mt-2 text-[10px] leading-snug text-dim">
            A client’s branding theme (set on the Clients page) wins over the portal default
            for that client.
          </p>
          <div className="border-t border-line pt-3">
            <p className="mb-2 text-xs text-dim">
              Upload limits: max file size in MB (1–4096) and the allowed MIME types — one
              per line, e.g. <span className="font-mono">image/*</span> or{' '}
              <span className="font-mono">application/pdf</span>. An empty list allows
              everything.
            </p>
            <div className="flex items-center gap-2">
              <span className="w-24 text-xs text-dim">max size</span>
              <input
                value={maxMb}
                onChange={(event) => setMaxMb(event.target.value)}
                inputMode="numeric"
                className={inputClass}
              />
              <span className="text-xs text-dim">MB</span>
            </div>
            <div className="mt-2 flex items-start gap-2">
              <span className="w-24 pt-1 text-xs text-dim">allowed types</span>
              <textarea
                value={allowedMimes}
                onChange={(event) => setAllowedMimes(event.target.value)}
                rows={4}
                className={inputClass + ' w-full font-mono'}
                placeholder="image/*&#10;application/pdf"
              />
            </div>
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
