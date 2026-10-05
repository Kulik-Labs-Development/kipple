import { useCallback, useEffect, useState } from 'react'
import {
  api,
  API_KEY_SCOPES,
  type ApiKeyRow,
  type ApiKeyScope,
} from '../lib/api'
import { useI18n } from '../lib/i18n'

// API & MCP superuser panel (Phase 2 row 1). Key list + create (the full key
// is shown exactly once, with copy + a one-time warning) + revoke with
// confirm. The list rows show metadata only — the API never returns hashes
// or full keys after creation.

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

function stamp(value: string | null, neverLabel: string): string {
  if (!value) return neverLabel
  return new Date(value).toISOString().slice(0, 10)
}

function keyStatus(row: ApiKeyRow): 'active' | 'revoked' | 'expired' {
  if (row.revokedAt) return 'revoked'
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return 'expired'
  return 'active'
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  // fallback for non-secure contexts (local http deploys)
  const area = document.createElement('textarea')
  area.value = text
  document.body.append(area)
  area.select()
  document.execCommand('copy')
  area.remove()
  return Promise.resolve()
}

export function ApiKeysManager({
  onClose,
  embedded = false,
}: {
  onClose: () => void
  embedded?: boolean
}) {
  const { t } = useI18n()
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ApiKeyScope[]>([])
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(() => {
    api
      .listApiKeys()
      .then((rows) => {
        setKeys(rows)
        setLoaded(true)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('api.error.load')))
  }, [t])

  useEffect(() => {
    refresh()
  }, [refresh])

  function toggleScope(scope: ApiKeyScope) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))
  }

  async function create() {
    if (!name.trim() || scopes.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const row = await api.createApiKey({
        name: name.trim(),
        scopes,
        expiresAt: expires ? new Date(expires).toISOString() : null,
      })
      setCreated(row.key)
      setCopied(false)
      setShowCreate(false)
      setName('')
      setScopes([])
      setExpires('')
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('api.error.create'))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!created) return
    try {
      await copyToClipboard(created)
      setCopied(true)
    } catch {
      /* the value stays visible — the user can select it manually */
    }
  }

  async function revoke(row: ApiKeyRow) {
    if (!window.confirm(t('api.revoke.confirm', { name: row.name }))) return
    setError(null)
    try {
      await api.revokeApiKey(row.id)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('api.error.revoke'))
    }
  }

  const th = 'px-3 py-2 text-left text-[9px] tracking-[.2em] text-dim uppercase'
  const td = 'border-t border-line px-3 py-2 align-top'

  return (
    <div
      className={
        embedded
          ? 'flex h-full min-h-0 min-w-0 flex-1 flex-col bg-ink'
          : 'fixed inset-0 z-50 grid place-items-center bg-black/60 p-4'
      }
      onMouseDown={embedded ? undefined : onClose}
    >
      <div
        className={
          embedded
            ? 'min-h-0 flex-1 overflow-y-auto'
            : 'w-full max-w-3xl border border-line bg-ink'
        }
        onMouseDown={embedded ? undefined : (event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-baseline gap-3 text-sm tracking-widest text-accent">
            <span>{t('api.title')}</span>
            <a
              href={t('api.specUrl')}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-dim underline decoration-line hover:text-fg"
            >
              {t('api.spec')}
            </a>
          </div>
          <button onClick={onClose} className={dimButtonClass}>
            {t('drawer.close')}
          </button>
        </header>

        <div className="space-y-4 p-4">
          <p className="text-xs text-dim">{t('api.intro')}</p>

          {error && (
            <div className="border border-danger px-3 py-2 text-xs text-danger">{error}</div>
          )}

          {created && (
            <div className="border border-warn px-3 py-2.5">
              <div className="text-[10px] tracking-[.2em] text-warn uppercase">
                {t('api.created.title')}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all border border-line bg-panel px-2 py-1.5 text-[11px] text-fg select-all">
                  {created}
                </code>
                <button onClick={() => void copy()} className={buttonClass}>
                  {copied ? t('api.copied') : t('api.copy')}
                </button>
                <button
                  onClick={() => setCreated(null)}
                  className="border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:text-fg"
                >
                  {t('api.done')}
                </button>
              </div>
              <div className="mt-1.5 text-[11px] text-warn">{t('api.created.warning')}</div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-[10px] tracking-[.24em] text-dim uppercase">api keys</span>
            <button onClick={() => setShowCreate((open) => !open)} className={buttonClass}>
              {t('api.new')}
            </button>
          </div>

          {showCreate && (
            <div className="space-y-3 border border-line bg-panel p-3">
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs text-dim">{t('api.field.name')}</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('api.placeholder.name')}
                  className={`${inputClass} flex-1`}
                />
              </div>
              <div>
                <div className="mb-1.5 text-xs text-dim">{t('api.field.scopes')}</div>
                <div className="grid grid-cols-2 gap-1">
                  {API_KEY_SCOPES.map((scope) => (
                    <label key={scope} className="flex cursor-pointer items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      {scope}
                    </label>
                  ))}
                </div>
                <div className="mt-1 text-[10px] text-dim">{t('api.scopes.hint')}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs text-dim">{t('api.field.expires')}</span>
                <input
                  type="datetime-local"
                  value={expires}
                  onChange={(event) => setExpires(event.target.value)}
                  className={`${inputClass} w-56`}
                />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => void create()}
                  disabled={busy || !name.trim() || scopes.length === 0}
                  className={`${buttonClass} disabled:cursor-default disabled:opacity-40`}
                >
                  {busy ? t('api.creating') : t('api.create')}
                </button>
              </div>
            </div>
          )}

          {loaded && keys.length === 0 && (
            <div className="border border-line px-3 py-4 text-center text-xs text-dim">
              {t('api.empty')}
            </div>
          )}

          {keys.length > 0 && (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className={th}>{t('api.th.name')}</th>
                  <th className={th}>{t('api.th.prefix')}</th>
                  <th className={th}>{t('api.th.scopes')}</th>
                  <th className={th}>{t('api.th.created')}</th>
                  <th className={th}>{t('api.th.lastUsed')}</th>
                  <th className={th}>{t('api.th.expires')}</th>
                  <th className={th}>{t('api.th.status')}</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {keys.map((row) => {
                  const status = keyStatus(row)
                  return (
                    <tr key={row.id}>
                      <td className={`${td} font-bold text-fg`}>{row.name}</td>
                      <td className={`${td} font-mono text-dim`}>kip_{row.prefix}…</td>
                      <td className={`${td} text-dim`}>{row.scopes.join(' ')}</td>
                      <td className={td}>{stamp(row.createdAt, t('api.na'))}</td>
                      <td className={td}>{stamp(row.lastUsedAt, t('api.na'))}</td>
                      <td className={td}>{stamp(row.expiresAt, t('api.never'))}</td>
                      <td
                        className={
                          `${td} uppercase ${
                            status === 'active'
                              ? 'text-ok'
                              : status === 'expired'
                                ? 'text-warn'
                                : 'text-danger'
                          }`
                        }
                      >
                        {t(`api.status.${status}`)}
                      </td>
                      <td className={`${td} text-right`}>
                        {status === 'active' && (
                          <button
                            onClick={() => void revoke(row)}
                            className="border border-line px-2 py-0.5 text-[10px] tracking-[.14em] text-dim uppercase hover:border-danger hover:text-danger"
                          >
                            {t('api.revoke')}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
