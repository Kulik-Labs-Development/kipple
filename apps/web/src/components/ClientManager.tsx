import { useCallback, useEffect, useRef, useState } from 'react'
import { portalThemes, type ClientBranding, type ThemeId } from '@kipple/shared/themes'
import { api, type ClientSummary } from '../lib/api'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

const HEX6 = /^#[0-9a-fA-F]{6}$/

function brandingSummary(client: ClientSummary): string {
  const parts: string[] = []
  if (client.branding?.themeId) parts.push(`theme:${client.branding.themeId}`)
  if (client.branding?.accent) parts.push(`accent:${client.branding.accent}`)
  if (client.branding?.logoUrl) parts.push('logo')
  if (client.selfRegDomains?.length) parts.push(`selfreg:${client.selfRegDomains.length}`)
  return parts.join(' · ')
}

export function ClientManager({
  onSaved,
  onClose,
}: {
  onSaved: () => void
  onClose: () => void
}) {
  const [clients, setClients] = useState<ClientSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [theme, setTheme] = useState('default')
  const [accent, setAccent] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [logoBroken, setLogoBroken] = useState(false)
  const [logoKey, setLogoKey] = useState<string | null>(null)
  const [logoUploadBusy, setLogoUploadBusy] = useState(false)
  const logoFileRef = useRef<HTMLInputElement>(null)
  const [selfRegDomains, setSelfRegDomains] = useState('')
  const [newName, setNewName] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const selected = clients.find((client) => client.id === selectedId) ?? null
  const previewLogo = logoUrl.trim()
    ? logoUrl.trim()
    : selectedId && logoKey
      ? `/api/clients/${selectedId}/logo`
      : null

  const refresh = useCallback(async () => {
    setClients(await api.listClients())
  }, [])

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : 'failed to load clients'))
  }, [refresh])

  // load the selected client's branding into the form when the selection
  // changes (not on every refetch, so typing never clobbers the draft)
  useEffect(() => {
    const client = clients.find((row) => row.id === selectedId)
    setTheme(client?.branding?.themeId ?? 'default')
    setAccent(client?.branding?.accent ?? '')
    const savedLogo = client?.branding?.logoUrl ?? ''
    setLogoUrl(/^https?:\/\//i.test(savedLogo) ? savedLogo : '')
    setLogoKey(savedLogo && !/^https?:\/\//i.test(savedLogo) ? savedLogo : null)
    setLogoBroken(false)
    setSelfRegDomains((client?.selfRegDomains ?? []).join(', '))
  }, [selectedId])

  function buildBranding(): ClientBranding | null {
    const out: ClientBranding = {}
    if (theme !== 'default') out.themeId = theme as ThemeId
    if (accent.trim()) out.accent = accent.trim()
    if (logoUrl.trim()) out.logoUrl = logoUrl.trim()
    else if (logoKey) out.logoUrl = logoKey
    return Object.keys(out).length > 0 ? out : null
  }

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null)
    setSaving(true)
    try {
      await action()
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback)
    } finally {
      setSaving(false)
    }
  }

  function saveBranding() {
    if (!selectedId) return
    void run(() => api.updateClient(selectedId, { branding: buildBranding() }), 'branding save failed')
  }

  function clearBranding() {
    if (!selectedId) return
    void run(() => api.updateClient(selectedId, { branding: null }), 'clearing branding failed')
  }

  function saveSelfReg() {
    if (!selectedId) return
    const domains = selfRegDomains
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean)
    void run(
      () =>
        api.updateClient(selectedId, {
          selfRegDomains: domains.length > 0 ? domains : null,
        }),
      'saving self-registration domains failed',
    )
  }

  async function uploadLogo() {
    if (!selectedId || !logoFileRef.current?.files?.[0]) return
    const file = logoFileRef.current.files[0]
    if (logoFileRef.current) logoFileRef.current.value = ''
    setError(null)
    setLogoUploadBusy(true)
    try {
      const res = await api.uploadClientLogo(selectedId, file)
      setLogoKey(res.logoUrl)
      setLogoUrl('')
      setLogoBroken(false)
      onSaved()
      void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'logo upload failed')
    } finally {
      setLogoUploadBusy(false)
    }
  }

  async function deleteLogo() {
    if (!selectedId || !logoKey) return
    setError(null)
    setLogoUploadBusy(true)
    try {
      await api.deleteClientLogo(selectedId)
      setLogoKey(null)
      setLogoBroken(false)
      onSaved()
      void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'logo removal failed')
    } finally {
      setLogoUploadBusy(false)
    }
  }

  function createClient() {
    const name = newName.trim()
    if (!name) {
      setError('client name is required')
      return
    }
    void run(
      async () => {
        await api.createClient({ name, domain: newDomain.trim() || undefined })
        setNewName('')
        setNewDomain('')
      },
      'creating the client failed',
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border border-line bg-ink">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm tracking-widest text-accent">clients &amp; portal branding</div>
          <button onClick={onClose} className={dimButtonClass}>
            close
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 border border-danger px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-widest text-dim">new client</h2>
            <div className="flex items-center gap-2">
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="company name"
                className={`${inputClass} w-56`}
              />
              <input
                value={newDomain}
                onChange={(event) => setNewDomain(event.target.value)}
                placeholder="email domain (optional)"
                className={`${inputClass} w-52`}
              />
              <button onClick={createClient} disabled={saving} className={buttonClass}>
                add client
              </button>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-widest text-dim">
              clients ({clients.length})
            </h2>
            {clients.length === 0 ? (
              <p className="text-xs text-dim">No clients yet.</p>
            ) : (
              <ul className="space-y-1">
                {clients.map((client) => (
                  <li key={client.id}>
                    <button
                      onClick={() => setSelectedId(client.id)}
                      className={`flex w-full items-baseline justify-between gap-2 border px-2 py-1 text-left text-xs ${
                        selectedId === client.id
                          ? 'border-accent text-accent'
                          : 'border-line text-fg hover:border-accent'
                      }`}
                    >
                      <span className="truncate">
                        {client.name}
                        {client.domain ? (
                          <span className="ml-2 text-dim">{client.domain}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-dim">{brandingSummary(client)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selected && (
            <section className="space-y-3 border-t border-line pt-4">
              <h2 className="text-xs uppercase tracking-widest text-dim">
                portal branding — {selected.name}
              </h2>
              <p className="text-xs text-dim">
                Applies to this client&apos;s portal only: theme, accent color, and logo. The
                agent workspace is never affected.
              </p>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs text-dim">theme</span>
                <select
                  value={theme}
                  onChange={(event) => setTheme(event.target.value)}
                  className={inputClass}
                >
                  <option value="default">instance default</option>
                  {portalThemes().map((meta) => (
                    <option key={meta.id} value={meta.id}>
                      {meta.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs text-dim">accent</span>
                <input
                  type="color"
                  value={HEX6.test(accent) ? accent : '#0b5fff'}
                  onChange={(event) => setAccent(event.target.value)}
                  className="h-6 w-8 cursor-pointer border border-line bg-panel"
                  aria-label="accent color picker"
                />
                <input
                  value={accent}
                  onChange={(event) => setAccent(event.target.value)}
                  placeholder="#hex (empty = theme accent)"
                  className={`${inputClass} w-40`}
                />
                {accent && (
                  <button onClick={() => setAccent('')} className={dimButtonClass}>
                    reset
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs text-dim">logo url</span>
                <input
                  value={logoUrl}
                  onChange={(event) => {
                    setLogoUrl(event.target.value)
                    setLogoBroken(false)
                  }}
                  placeholder="https://…/logo.png (external URL, optional)"
                  className={`${inputClass} w-72`}
                />
                {previewLogo &&
                  (logoBroken ? (
                    <span className="text-xs text-danger">image failed to load</span>
                  ) : (
                    <img
                      src={previewLogo}
                      alt="logo preview"
                      onError={() => setLogoBroken(true)}
                      className="h-8 max-w-40 border border-line bg-panel object-contain"
                    />
                  ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs text-dim">logo file</span>
                <input
                  ref={logoFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                />
                <button
                  onClick={uploadLogo}
                  disabled={logoUploadBusy || saving}
                  className={buttonClass}
                >
                  upload logo
                </button>
                {logoKey && (
                  <button
                    onClick={deleteLogo}
                    disabled={logoUploadBusy || saving}
                    className={dimButtonClass}
                  >
                    remove logo
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button onClick={saveBranding} disabled={saving} className={buttonClass}>
                  save branding
                </button>
                <button onClick={clearBranding} disabled={saving} className={dimButtonClass}>
                  clear branding
                </button>
              </div>
            </section>
          )}

          {selected && (
            <section className="space-y-3 border-t border-line pt-4">
              <h2 className="text-xs uppercase tracking-widest text-dim">
                client self-registration — {selected.name}
              </h2>
              <p className="text-xs text-dim">
                Off by default: only people whose email ends with one of these domains can create
                a portal account from the login screen. Magic link stays the only sign-in method.
              </p>
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-dim">domains</span>
                <input
                  value={selfRegDomains}
                  onChange={(event) => setSelfRegDomains(event.target.value)}
                  placeholder="clientcorp.com, clientcorp.org (empty = off)"
                  className={`${inputClass} w-80`}
                />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button onClick={saveSelfReg} disabled={saving} className={buttonClass}>
                  save self-registration
                </button>
              </div>
            </section>
          )}
        </div>
    </div>
  )
}
