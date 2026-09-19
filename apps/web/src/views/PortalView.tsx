import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientBranding } from '@kipple/shared/themes'
import {
  api,
  clientLogoSrc,
  type MeUser,
  type TicketDetail as TicketDetailData,
  type TicketRow,
} from '../lib/api'
import { formatFileSize } from '../lib/format'
import { useStagedUploads } from '../lib/useStagedUploads'
import { PhosphorIcon } from '../components/PhosphorIcon'
import { RichTextEditor } from '../components/RichTextEditor'
import { textOfHtml, toRenderable } from '../lib/rich'
import {
  filterPortalTickets,
  formatStamp,
  relativeTime,
  statusLedClass,
  type StatusFilter,
} from '../lib/tickets'
import { STATUS_KEY, useI18n } from '../lib/i18n'

const POLL_MS = 30_000
const PORTAL_STATUSES: StatusFilter[] = ['all', 'open', 'pending', 'hold', 'closed']

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function PortalView({
  user,
  primaryClient,
  onSignedOut,
}: {
  user: MeUser
  primaryClient: {
    id: string
    name: string
    domain: string | null
    branding: ClientBranding | null
  } | null
  onSignedOut: () => void
}) {
  const { t } = useI18n()
  const [tickets, setTickets] = useState<TicketRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TicketDetailData | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [reply, setReply] = useState('')
  const [replyKey, setReplyKey] = useState(0)
  const { staged, addFiles, removeFile, clear, readyIds, inFlight } = useStagedUploads()
  const [showNew, setShowNew] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [newSubject, setNewSubject] = useState('')
  const [newBody, setNewBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const clientId = primaryClient?.id ?? null
  const logoSrc = primaryClient ? clientLogoSrc(primaryClient) : null
  const [logoBroken, setLogoBroken] = useState(false)

  useEffect(() => {
    const logo = logoSrc
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
    if (logo) {
      const target = link ?? document.createElement('link')
      target.rel = 'icon'
      target.href = logo
      if (!link) document.head.appendChild(target)
      document.title = t('portal.title.withClient', {
        client: primaryClient?.name ?? t('portal.fallbackClient'),
      })
    } else {
      link?.remove()
      document.title = t('portal.title.fallback')
    }
    setLogoBroken(false)
  }, [logoSrc, primaryClient?.name])

  const refreshList = useCallback(async () => {
    try {
      setTickets(await api.listTickets())
      setError(null)
    } catch (err) {
      setError(errorMessage(err, t('portal.error.load')))
    }
  }, [])

  const refreshDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.getTicket(id))
    } catch {
      setDetail(null)
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    if (selectedId) void refreshDetail(selectedId)
    else setDetail(null)
    clear()
  }, [selectedId, refreshDetail, clear])

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshList()
      if (selectedId) void refreshDetail(selectedId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refreshList, refreshDetail, selectedId])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== '/') return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const visible = useMemo(
    () => filterPortalTickets(tickets, { status: statusFilter, q: search }),
    [tickets, statusFilter, search],
  )

  // Chip counts are queue-wide (unfiltered) so the chips read as a breakdown
  // of "your requests", not of the current filter.
  const chipCounts = useMemo(() => {
    const base: Record<string, number> = { all: tickets.length }
    for (const status of PORTAL_STATUSES) {
      if (status !== 'all') base[status] = 0
    }
    for (const ticket of tickets) {
      if (ticket.status in base) base[ticket.status]++
    }
    return base
  }, [tickets])

  async function sendReply() {
    if (!selectedId || inFlight || (!textOfHtml(reply) && readyIds.length === 0)) return
    setBusy(true)
    setError(null)
    try {
      await api.addTicketUpdate(selectedId, {
        body: reply.trim(),
        ...(readyIds.length > 0 ? { uploadIds: readyIds } : {}),
      })
      setReply('')
      clear()
      setReplyKey((k) => k + 1)
      if (fileInputRef.current) fileInputRef.current.value = ''
      await Promise.all([refreshDetail(selectedId), refreshList()])
    } catch (err) {
      setError(errorMessage(err, t('portal.error.reply')))
    } finally {
      setBusy(false)
    }
  }

  async function createTicket(e: React.FormEvent) {
    e.preventDefault()
    if (!clientId || !newSubject.trim()) return
    setBusy(true)
    setError(null)
    try {
      const row = await api.createTicket({
        clientId,
        subject: newSubject.trim(),
        body: newBody.trim() || undefined,
      })
      setShowNew(false)
      setNewSubject('')
      setNewBody('')
      await refreshList()
      setSelectedId(row.id)
    } catch (err) {
      setError(errorMessage(err, t('portal.error.create')))
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setSigningOut(true)
    try {
      await api.signOut()
    } finally {
      onSignedOut()
    }
  }

  return (
    <div className="flex h-full flex-col bg-ink">
      <header className="flex h-16 shrink-0 items-center border-b-2 border-line bg-panel px-9">
        <div className="flex min-w-0 items-center gap-4">
          {logoSrc && !logoBroken ? (
            <img
              src={logoSrc}
              alt=""
              onError={() => setLogoBroken(true)}
              className="h-[30px] w-[30px] shrink-0 border border-fg object-contain"
            />
          ) : (
            <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center border border-fg text-sm font-bold text-fg">
              {(primaryClient?.name ?? t('portal.fallbackClient')).charAt(0).toUpperCase()}
            </div>
          )}
          <span className="truncate text-base font-bold text-fg">
            {primaryClient?.name ?? t('portal.fallbackClient')}
          </span>
          <span className="shrink-0 border-l border-line pl-[18px] text-[9px] tracking-[.26em] text-dim uppercase">
            {t('portal.sub')}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-4">
          <span className="text-[10px] tracking-[.18em] text-dim uppercase">{user.name}</span>
          <button
            onClick={signOut}
            disabled={signingOut}
            className="border border-line px-3 py-[7px] text-[9px] tracking-[.2em] text-dim uppercase hover:border-danger hover:text-danger"
          >
            {t('workspace.signOut')}
          </button>
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-danger bg-panel px-9 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <main className="flex min-h-0 flex-1">
        {/* Request list */}
        <section className="flex w-[340px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="flex items-center justify-between px-[18px] py-3">
            <span className="text-[11px] font-bold tracking-[.24em] text-fg uppercase">
              {t('portal.yourRequests')} {tickets.length}
            </span>
            <button
              onClick={() => setShowNew(true)}
              className="bg-accent px-[10px] py-[7px] text-[9px] tracking-[.18em] text-ink uppercase"
            >
              {t('portal.newRequest')}
            </button>
          </div>
          <div className="flex flex-wrap gap-1 px-2 pb-2">
            {PORTAL_STATUSES.map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`border px-2 py-1 text-[9px] tracking-[.14em] uppercase ${
                  statusFilter === status
                    ? 'border-accent bg-ink font-bold text-accent'
                    : 'border-line text-dim hover:border-fg'
                }`}
              >
                {t(STATUS_KEY[status])} {chipCounts[status] ?? 0}
              </button>
            ))}
          </div>
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('portal.searchPlaceholder')}
            className="border-b border-line bg-transparent px-[18px] py-2 text-[13px] text-fg outline-none placeholder:text-dim/70 focus:border-accent"
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-[18px] py-4 text-[13px] text-dim">{t('portal.empty')}</p>
            ) : (
              visible.map((ticket) => (
                <button
                  key={ticket.id}
                  onClick={() => setSelectedId(ticket.id)}
                  className={`flex w-full items-start gap-2 border-b border-line py-[11px] pr-[18px] text-left ${
                    selectedId === ticket.id
                      ? 'border-l-[3px] border-l-accent bg-ink pl-[15px]'
                      : 'pl-[18px] hover:bg-ink/40'
                  }`}
                >
                  <span className={`mt-[5px] h-2 w-2 shrink-0 ${statusLedClass(ticket.status)}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold text-fg">
                      {ticket.subject}
                    </span>
                    <span className="mt-[3px] block text-[10px] tracking-[.08em] text-dim">
                      #{ticket.number} · {relativeTime(ticket.updatedAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        {/* Detail */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink">
          {detail ? (
            <>
              <div className="shrink-0 border-b-2 border-line px-8 pt-[22px] pb-4">
                <h2 className="text-[22px] leading-tight font-bold tracking-[-.01em] text-fg">
                  {detail.subject}
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <span className={`h-2 w-2 ${statusLedClass(detail.status)}`} />
                  <span className="text-[10px] font-bold tracking-[.16em] text-accent uppercase">
                    {detail.status in STATUS_KEY
                      ? t(STATUS_KEY[detail.status as keyof typeof STATUS_KEY])
                      : detail.status}
                    {detail.status === 'hold' && detail.holdOn
                      ? ` · ${t('portal.waitingOn', { who: detail.holdOn })}`
                      : ''}
                  </span>
                  <span className="text-[10px] text-dim">#{detail.number}</span>
                  <span className="text-[10px] text-dim">
                    {t('portal.meta.opened')} {formatStamp(detail.createdAt)}
                  </span>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {detail.updates.map((update) => (
                  <div key={update.id} className="border-b border-line px-8 py-[15px]">
                    <p className="text-[10px] tracking-[.14em]">
                      <b className="font-bold text-fg">
                        {update.authorName ?? t('portal.supportTeam')}
                      </b>{' '}
                      · <span className="text-dim">{formatStamp(update.createdAt)}</span>
                    </p>
                    <div
                      className="rich-text mt-1.5 max-w-[900px] text-[13px] text-fg"
                      dangerouslySetInnerHTML={{ __html: toRenderable(update.body) }}
                    />
                    {update.attachments.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {update.attachments.map((attachment) => (
                          <a
                            key={attachment.id}
                            href={`/api/attachments/${attachment.id}`}
                            download
                            className="inline-flex items-center gap-1 border border-line px-2 py-0.5 text-[10px] text-accent hover:border-accent"
                          >
                            <PhosphorIcon name="paperclip" size="sm" />
                            {attachment.filename} ({formatFileSize(attachment.size)})
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="shrink-0 border-t-2 border-line px-8 py-3">
                <RichTextEditor
                  key={`${selectedId}-${replyKey}`}
                  placeholder={t('portal.replyPlaceholder')}
                  onHtmlChange={setReply}
                />
                {staged.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {staged.map((upload, index) => (
                      <span
                        key={`${upload.file.name}-${index}`}
                        title={upload.error ?? upload.file.name}
                        className={`flex items-center gap-1 border px-2 py-0.5 text-xs transition-colors ${
                          upload.status === 'error'
                            ? 'border-danger text-danger'
                            : 'border-line text-dim hover:text-fg'
                        }`}
                      >
                        <PhosphorIcon name="paperclip" size="sm" />
                        <span className="max-w-52 truncate">{upload.file.name}</span>
                        {upload.status === 'staging' && (
                          <span className="tabular-nums">
                            {Math.round((upload.offset / upload.file.size) * 100)}%
                          </span>
                        )}
                        {upload.status === 'ready' && (
                          <span className="tabular-nums">{formatFileSize(upload.file.size)}</span>
                        )}
                        {upload.status === 'error' && <span>failed</span>}
                        <button
                          type="button"
                          onClick={() => removeFile(upload.file)}
                          className="hover:text-danger"
                          aria-label={t('portal.removeFile', { file: upload.file.name })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                        addFiles(Array.from(event.target.files ?? []))
                      }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 border border-line px-3 py-1.5 text-[9px] tracking-[.2em] text-dim uppercase hover:border-accent hover:text-accent"
                  >
                    <PhosphorIcon name="paperclip" size="sm" />
                    {t('portal.attach')}
                  </button>
                  <span className="ml-auto text-[8px] tracking-[.2em] text-dim uppercase">
                    {t('portal.notesPrivate')}
                  </span>
                  <button
                    onClick={sendReply}
                    disabled={busy || inFlight || (!textOfHtml(reply) && readyIds.length === 0)}
                    className="bg-accent px-4 py-[7px] text-[10px] tracking-[.2em] text-ink uppercase disabled:opacity-50"
                  >
                    {t('portal.sendReply')}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center">
              <div className="text-center">
                <p className="text-sm text-fg">
                  {tickets.length === 0
                    ? t('portal.emptyDetail.none')
                    : t('portal.emptyDetail.select')}
                </p>
                <p className="mt-1 text-xs text-dim">{t('portal.emptyDetail.emailNote')}</p>
              </div>
            </div>
          )}
        </section>
      </main>

      {showNew && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-ink/60 p-4">
          <form
            onSubmit={createTicket}
            className="w-[470px] space-y-4 border-2 border-fg bg-panel p-[26px]"
          >
            <div>
              <h3 className="text-[11px] font-bold tracking-[.3em] text-accent uppercase">
                {t('portal.modal.heading')}
              </h3>
              <div className="mt-2 h-0.5 bg-fg" />
            </div>
            <label className="block">
              <span className="text-[8px] tracking-[.26em] text-dim uppercase">
                {t('portal.modal.field.subject')}
              </span>
              <input
                value={newSubject}
                onChange={(event) => setNewSubject(event.target.value)}
                placeholder={t('portal.modal.placeholder.subject')}
                required
                className="mt-1.5 w-full border-b border-line bg-transparent py-2 text-[13px] text-fg outline-none placeholder:text-dim/70 focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="text-[8px] tracking-[.26em] text-dim uppercase">
                {t('portal.modal.field.description')}
              </span>
              <textarea
                value={newBody}
                onChange={(event) => setNewBody(event.target.value)}
                placeholder={t('portal.modal.placeholder.description')}
                rows={4}
                className="mt-1.5 w-full resize-y border-b border-line bg-transparent py-2 text-[13px] text-fg outline-none placeholder:text-dim/70 focus:border-accent"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNew(false)}
                className="border border-line px-4 py-1.5 text-[10px] tracking-[.2em] text-dim uppercase hover:border-fg"
              >
                {t('portal.modal.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy || !newSubject.trim() || !clientId}
                className="bg-accent px-4 py-[7px] text-[10px] tracking-[.2em] text-ink uppercase disabled:opacity-50"
              >
                {t('portal.modal.create')}
              </button>
            </div>
            {!clientId && <p className="text-xs text-danger">{t('portal.modal.noClient')}</p>}
          </form>
        </div>
      )}
    </div>
  )
}
