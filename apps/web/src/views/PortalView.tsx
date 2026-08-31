import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Field } from '../components/Field'
import {
  api,
  type MeUser,
  type TicketDetail as TicketDetailData,
  type TicketRow,
} from '../lib/api'
import {
  filterPortalTickets,
  formatStamp,
  relativeTime,
  statusLedClass,
  type StatusFilter,
} from '../lib/tickets'

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
  primaryClient: { id: string; name: string; domain: string | null } | null
  onSignedOut: () => void
}) {
  const [tickets, setTickets] = useState<TicketRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TicketDetailData | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [reply, setReply] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newSubject, setNewSubject] = useState('')
  const [newBody, setNewBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const clientId = primaryClient?.id ?? null

  const refreshList = useCallback(async () => {
    try {
      setTickets(await api.listTickets())
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'failed to load requests'))
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
  }, [selectedId, refreshDetail])

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

  async function sendReply() {
    if (!selectedId || !reply.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.addTicketUpdate(selectedId, { body: reply.trim() })
      setReply('')
      await Promise.all([refreshDetail(selectedId), refreshList()])
    } catch (err) {
      setError(errorMessage(err, 'failed to send reply'))
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
      setError(errorMessage(err, 'failed to create request'))
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
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line bg-panel px-5 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-base font-semibold text-fg">
            {primaryClient?.name ?? 'Support'}
          </span>
          <span className="text-xs text-dim">client portal</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-dim">{user.name}</span>
          <button
            onClick={signOut}
            disabled={signingOut}
            className="border border-line px-3 py-1 text-xs text-dim hover:border-danger hover:text-danger"
          >
            sign out
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-4 border border-danger px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 md:grid-cols-[minmax(280px,380px)_1fr]">
        <section className="flex min-h-0 flex-col border border-line bg-panel">
          <div className="flex items-center justify-between border-b border-line p-3">
            <span className="text-xs uppercase tracking-widest text-dim">
              your requests
            </span>
            <button
              onClick={() => setShowNew(true)}
              className="border border-accent bg-accent/10 px-2 py-1 text-xs text-accent"
            >
              + new request
            </button>
          </div>
          <div className="flex flex-wrap gap-1 p-2">
            {PORTAL_STATUSES.map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`border px-2 py-0.5 text-xs capitalize ${
                  statusFilter === status
                    ? 'border-accent text-accent'
                    : 'border-line text-dim'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search ( / )"
            className="border-b border-line bg-transparent px-3 py-2 text-sm outline-none placeholder:text-dim"
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="p-4 text-sm text-dim">No requests here.</p>
            ) : (
              visible.map((ticket) => (
                <button
                  key={ticket.id}
                  onClick={() => setSelectedId(ticket.id)}
                  className={`flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left hover:bg-ink ${
                    selectedId === ticket.id ? 'bg-ink' : ''
                  }`}
                >
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusLedClass(ticket.status)}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{ticket.subject}</span>
                    <span className="text-xs text-dim">
                      #{ticket.number} · {relativeTime(ticket.updatedAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col border border-line bg-panel">
          {detail ? (
            <>
              <div className="border-b border-line p-4">
                <h2 className="text-lg font-semibold text-fg">{detail.subject}</h2>
                <p className="mt-1 text-xs text-dim">
                  #{detail.number} · <span className="capitalize">{detail.status}</span> ·
                  opened {formatStamp(detail.createdAt)}
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {detail.updates.map((update) => (
                  <div key={update.id} className="border-b border-line px-4 py-3">
                    <p className="text-xs text-dim">
                      <span className="text-fg">{update.authorName ?? 'Support team'}</span> ·{' '}
                      {formatStamp(update.createdAt)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-fg">{update.body}</p>
                  </div>
                ))}
              </div>
              <div className="border-t border-line p-3">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  rows={3}
                  placeholder="Write a reply…"
                  className="w-full resize-none border border-line bg-transparent p-2 text-sm outline-none placeholder:text-dim"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    onClick={sendReply}
                    disabled={busy || !reply.trim()}
                    className="border border-accent bg-accent/10 px-4 py-1.5 text-sm text-accent disabled:opacity-50"
                  >
                    send reply
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center">
              <div className="text-center">
                <p className="text-sm text-fg">
                  {tickets.length === 0
                    ? "You don't have any requests yet."
                    : 'Select a request to open it.'}
                </p>
                <p className="mt-1 text-xs text-dim">
                  You can also reply by email to your ticket address.
                </p>
              </div>
            </div>
          )}
        </section>
      </main>

      {showNew && (
        <div className="fixed inset-0 z-10 grid place-items-center bg-ink/60 p-4">
          <form
            onSubmit={createTicket}
            className="w-full max-w-md space-y-4 border border-line bg-panel p-5"
          >
            <h3 className="text-sm uppercase tracking-widest text-accent">new request</h3>
            <Field
              label="subject"
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder="What do you need help with?"
              required
            />
            <Field
              label="description"
              type="textarea"
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="Tell us what happened (optional)"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNew(false)}
                className="border border-line px-4 py-1.5 text-sm text-dim"
              >
                cancel
              </button>
              <button
                type="submit"
                disabled={busy || !newSubject.trim() || !clientId}
                className="border border-accent bg-accent/10 px-4 py-1.5 text-sm text-accent disabled:opacity-50"
              >
                create request
              </button>
            </div>
            {!clientId && (
              <p className="text-xs text-danger">
                No company is linked to your account yet. Ask your MSP to link it.
              </p>
            )}
          </form>
        </div>
      )}
    </div>
  )
}
