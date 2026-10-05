import { useCallback, useEffect, useState } from 'react'
import { RULE_EVENTS } from '@kipple/shared/schemas'
import {
  api,
  type ClientSummary,
  type InboundSourceView,
  type WebhookDeliveryView,
  type WebhookView,
} from '../lib/api'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

const SOURCE_LABELS: Record<string, string> = {
  prtg: 'PRTG',
  zabbix: 'Zabbix',
  watcher: 'Watcher',
  uptimerobot: 'UptimeRobot',
  kuma: 'Uptime Kuma',
  onlineornot: 'OnlineOrNot',
  custom: 'Custom',
}

function statusChip(status: string | null): string {
  if (status === 'sent') return 'border-ok text-ok'
  if (status === 'failed') return 'border-danger text-danger'
  if (status === 'queued') return 'border-accent text-accent'
  return 'border-line text-dim'
}

/**
 * Webhooks manager (superuser, drawer-embedded or modal). Inbound: per-source
 * enable + the full vendor URL + secret rotation + the default client inbound
 * tickets land on. Outbound: hook CRUD, event subscription, test ping,
 * delivery log (preview-only payload) with manual retry.
 */
export function WebhooksManager({
  clients,
  onClose,
  embedded = false,
}: {
  clients: ClientSummary[]
  onClose: () => void
  embedded?: boolean
}) {
  const [inbound, setInbound] = useState<InboundSourceView[] | null>(null)
  const [defaultClientId, setDefaultClientId] = useState<string | null>(null)
  const [hooks, setHooks] = useState<WebhookView[] | null>(null)
  const [newUrl, setNewUrl] = useState('')
  const [newEvents, setNewEvents] = useState<string[]>(['ticket.created'])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDeliveryView[] | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [inboundSettings, outbound] = await Promise.all([
        api.inboundWebhooks(),
        api.listWebhooks(),
      ])
      setInbound(inboundSettings.sources)
      setDefaultClientId(inboundSettings.defaultClientId)
      setHooks(outbound)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load webhooks')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Keep the open delivery list fresh while it is expanded (house 30s poll).
  useEffect(() => {
    if (!expandedId) return
    const id = window.setInterval(() => {
      void api
        .listWebhookDeliveries({ webhookId: expandedId, limit: 25 })
        .then(setDeliveries)
        .catch(() => {})
    }, 30_000)
    return () => window.clearInterval(id)
  }, [expandedId])

  async function changeDefaultClient(clientId: string | null) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.setInboundDefaultClient(clientId)
      setDefaultClientId(clientId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to set the default client')
    } finally {
      setBusy(false)
    }
  }

  async function toggleInbound(source: string) {
    const row = inbound?.find((entry) => entry.source === source)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.patchInboundSource(source, { enabled: !(row?.enabled ?? false) })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to update the source')
    } finally {
      setBusy(false)
    }
  }

  async function rotateInbound(source: string) {
    if (
      !window.confirm('Rotate the secret? The current URL stops working immediately — update the vendor.')
    ) {
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.patchInboundSource(source, { rotate: true })
      await load()
      setNotice(`${SOURCE_LABELS[source] ?? source} secret rotated — the old URL no longer works`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to rotate the secret')
    } finally {
      setBusy(false)
    }
  }

  async function copyUrl(row: InboundSourceView) {
    if (!row.url) return
    try {
      await navigator.clipboard.writeText(row.url)
      setCopied(row.source)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      // Clipboard unavailable (non-secure context) — the field selects on
      // focus, so a manual select+copy still works.
    }
  }

  function toggleNewEvent(event: string) {
    setNewEvents((prev) =>
      prev.includes(event) ? prev.filter((entry) => entry !== event) : [...prev, event],
    )
  }

  async function createOutbound() {
    const url = newUrl.trim()
    if (!url) {
      setError('enter the URL that will receive the pushes')
      return
    }
    if (newEvents.length === 0) {
      setError('pick at least one event')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.createWebhook({ url, events: newEvents })
      setNewUrl('')
      setNewEvents(['ticket.created'])
      await load()
      setNotice('hook added — deliveries start on the next subscribed ticket event')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add the hook')
    } finally {
      setBusy(false)
    }
  }

  async function toggleOutbound(hook: WebhookView) {
    setBusy(true)
    setError(null)
    try {
      await api.patchWebhook(hook.id, { enabled: !hook.enabled })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to update the hook')
    } finally {
      setBusy(false)
    }
  }

  async function removeHook(hook: WebhookView) {
    if (!window.confirm(`delete the hook for "${hook.url}"?`)) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteWebhook(hook.id)
      if (expandedId === hook.id) {
        setExpandedId(null)
        setDeliveries(null)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to delete the hook')
    } finally {
      setBusy(false)
    }
  }

  async function ping(hook: WebhookView) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.testWebhook(hook.id)
      setNotice(`test ping queued — watch the deliveries below (delivery ${res.id})`)
      setExpandedId(hook.id)
      setDeliveries(await api.listWebhookDeliveries({ webhookId: hook.id, limit: 25 }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to queue the test ping')
    } finally {
      setBusy(false)
    }
  }

  async function toggleExpanded(hookId: string) {
    if (expandedId === hookId) {
      setExpandedId(null)
      setDeliveries(null)
      return
    }
    setExpandedId(hookId)
    try {
      setDeliveries(await api.listWebhookDeliveries({ webhookId: hookId, limit: 25 }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load deliveries')
    }
  }

  async function retryDelivery(id: string) {
    setBusy(true)
    setError(null)
    try {
      await api.retryWebhookDelivery(id)
      if (expandedId) {
        setDeliveries(await api.listWebhookDeliveries({ webhookId: expandedId, limit: 25 }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to retry the delivery')
    } finally {
      setBusy(false)
    }
  }

  const loading = inbound === null && hooks === null

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
          <div className="text-sm tracking-widest text-accent">webhooks</div>
          <button onClick={onClose} className={dimButtonClass}>
            close
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 border border-danger px-3 py-2 text-xs text-danger">{error}</div>
        )}
        {notice && !error && (
          <div className="mx-4 mt-3 border border-accent px-3 py-2 text-xs text-accent">{notice}</div>
        )}

        <div className="space-y-6 p-4">
          <section>
            <div className="text-[10px] tracking-[.26em] text-dim uppercase">
              inbound — vendor alerts → tickets
            </div>
            <p className="mt-1 text-xs text-dim">
              Enable a source to generate its URL, then hand that URL to the monitoring tool. An
              alert creates a ticket on the default client; a repeat of an open alert updates that
              ticket, and a recovery closes it.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <span className="w-32 shrink-0 text-xs text-dim">default client</span>
              <select
                value={defaultClientId ?? ''}
                onChange={(event) =>
                  void changeDefaultClient(event.target.value === '' ? null : event.target.value)
                }
                disabled={busy}
                className={`${inputClass} min-w-0 flex-1`}
              >
                <option value="">none — inbound alerts are rejected (409)</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-3 space-y-2">
              {loading && <div className="text-xs text-dim">loading…</div>}
              {(inbound ?? []).map((row) => (
                <div key={row.source} className="border border-line px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-24 text-xs font-bold">
                      {SOURCE_LABELS[row.source] ?? row.source}
                    </span>
                    <button
                      onClick={() => void toggleInbound(row.source)}
                      disabled={busy}
                      className={
                        row.enabled
                          ? 'border border-ok px-2 py-1 text-xs uppercase tracking-widest text-ok'
                          : dimButtonClass
                      }
                    >
                      {row.enabled ? 'enabled' : 'disabled'}
                    </button>
                    {row.url ? (
                      <>
                        <input
                          readOnly
                          value={row.url}
                          onFocus={(event) => event.currentTarget.select()}
                          className={`${inputClass} min-w-0 flex-1 font-mono text-[11px]`}
                        />
                        <button onClick={() => void copyUrl(row)} className={dimButtonClass}>
                          {copied === row.source ? 'copied' : 'copy'}
                        </button>
                        <button
                          onClick={() => void rotateInbound(row.source)}
                          disabled={busy}
                          className={dimButtonClass}
                        >
                          rotate secret
                        </button>
                      </>
                    ) : (
                      <span className="text-[11px] text-dim">enable to generate the URL</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-dim">
              The secret rides the URL path, so it can appear in vendor or proxy access logs —
              rotation is the remedy (the old URL stops working immediately). Per-vendor recipes in
              docs/DEPLOYMENT.md.
            </p>
          </section>

          <section>
            <div className="text-[10px] tracking-[.26em] text-dim uppercase">
              outbound — ticket events → your URLs
            </div>
            <p className="mt-1 text-xs text-dim">
              Each hook gets a runtime-generated secret; every delivery is a signed JSON push
              (x-kipple-signature) with retry + backoff. Nothing is sent until you add a hook.
            </p>
            <div className="mt-3 border border-line px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={newUrl}
                  onChange={(event) => setNewUrl(event.target.value)}
                  placeholder="https://your-endpoint.example/hook"
                  className={`${inputClass} min-w-0 flex-1`}
                />
                <button onClick={() => void createOutbound()} disabled={busy} className={buttonClass}>
                  add hook
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-3">
                {RULE_EVENTS.map((event) => (
                  <label key={event} className="flex items-center gap-1.5 text-[11px] text-dim">
                    <input
                      type="checkbox"
                      checked={newEvents.includes(event)}
                      onChange={() => toggleNewEvent(event)}
                    />
                    {event}
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-2 space-y-2">
              {loading && <div className="text-xs text-dim">loading…</div>}
              {(hooks ?? []).map((hook) => (
                <div key={hook.id} className="border border-line px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={hook.url}>
                      {hook.url}
                    </span>
                    <button
                      onClick={() => void toggleOutbound(hook)}
                      disabled={busy}
                      className={
                        hook.enabled
                          ? 'border border-ok px-2 py-1 text-xs uppercase tracking-widest text-ok'
                          : dimButtonClass
                      }
                    >
                      {hook.enabled ? 'enabled' : 'disabled'}
                    </button>
                    <span
                      className={`border px-2 py-1 text-[10px] tracking-widest uppercase ${statusChip(hook.lastStatus)}`}
                    >
                      {hook.lastStatus ?? 'never'}
                    </span>
                    <button onClick={() => void ping(hook)} disabled={busy} className={dimButtonClass}>
                      test ping
                    </button>
                    <button onClick={() => void toggleExpanded(hook.id)} className={dimButtonClass}>
                      deliveries
                    </button>
                    <button
                      onClick={() => void removeHook(hook)}
                      disabled={busy}
                      className={dimButtonClass}
                    >
                      delete
                    </button>
                  </div>
                  {hook.lastError && (
                    <div className="mt-1 text-[11px] text-danger">last error: {hook.lastError}</div>
                  )}
                  {hook.lastDeliveredAt && (
                    <div className="mt-1 text-[11px] text-dim">
                      last delivery {new Date(hook.lastDeliveredAt).toLocaleString()}
                    </div>
                  )}
                  {expandedId === hook.id && (
                    <div className="mt-2 border-t border-line pt-2">
                      {(deliveries ?? []).map((row) => (
                        <div key={row.id} className="flex flex-wrap items-center gap-2 py-1">
                          <span
                            className={`border px-1.5 py-0.5 text-[10px] tracking-widest uppercase ${statusChip(row.status)}`}
                          >
                            {row.status}
                          </span>
                          <span className="text-[11px] text-dim">{row.event}</span>
                          <span className="text-[11px] text-dim">attempt {row.attempts}</span>
                          {row.sentAt && (
                            <span className="text-[11px] text-dim">
                              sent {new Date(row.sentAt).toLocaleString()}
                            </span>
                          )}
                          {row.error && (
                            <span
                              className="min-w-0 flex-1 truncate text-[11px] text-danger"
                              title={row.error}
                            >
                              {row.error}
                            </span>
                          )}
                          {row.status === 'queued' && (
                            <span
                              className="min-w-0 flex-1 truncate text-[11px] text-dim"
                              title={row.payloadPreview}
                            >
                              {row.payloadPreview}
                            </span>
                          )}
                          {(row.status === 'queued' || row.status === 'failed') && (
                            <button onClick={() => void retryDelivery(row.id)} className={dimButtonClass}>
                              retry
                            </button>
                          )}
                        </div>
                      ))}
                      {deliveries !== null && deliveries.length === 0 && (
                        <div className="py-1 text-[11px] text-dim">no deliveries yet</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
