import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QueuePane } from '../components/QueuePane'
import { TicketDetail, type TicketPatch } from '../components/TicketDetail'
import { TicketForm, type TicketFormValues } from '../components/TicketForm'
import { TimePanel } from '../components/TimePanel'
import {
  api,
  type ClientSummary,
  type MeUser,
  type StaffUser,
  type TicketDetail as TicketDetailData,
  type TicketRow,
  type TimeEntryRow,
} from '../lib/api'
import {
  formatClock,
  queueStats,
  TICKET_STATUSES,
  type StatusFilter,
} from '../lib/tickets'

const POLL_MS = 30_000

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function WorkspaceView({
  user,
  onSignedOut,
}: {
  user: MeUser
  onSignedOut: () => void
}) {
  const isStaff = user.role !== 'contact'
  const [signingOut, setSigningOut] = useState(false)
  const [clients, setClients] = useState<ClientSummary[]>([])
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [allTickets, setAllTickets] = useState<TicketRow[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TicketDetailData | null>(null)
  const [showNewTicket, setShowNewTicket] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeEntry, setActiveEntry] = useState<TimeEntryRow | null>(null)
  const [activeNumber, setActiveNumber] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const searchRef = useRef<HTMLInputElement>(null)

  const clientNames = useMemo(
    () => new Map(clients.map((client) => [client.id, client.name])),
    [clients],
  )

  const refreshList = useCallback(async () => {
    try {
      setAllTickets(await api.listTickets())
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'failed to load tickets'))
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
    let cancelled = false
    async function init() {
      try {
        const [clientRows, staffRows] = await Promise.all([
          api.listClients(),
          isStaff ? api.listStaff() : Promise.resolve([] as StaffUser[]),
        ])
        if (cancelled) return
        setClients(clientRows)
        setStaff(staffRows)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'failed to load workspace data'))
      }
    }
    init()
    return () => {
      cancelled = true
    }
  }, [isStaff])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    if (selectedId) {
      void refreshDetail(selectedId)
    } else {
      setDetail(null)
    }
  }, [selectedId, refreshDetail])

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshList()
      if (selectedId) void refreshDetail(selectedId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refreshList, refreshDetail, selectedId])

  const refreshActiveTimer = useCallback(async () => {
    if (!isStaff) return
    try {
      const { entry } = await api.activeTime()
      setActiveEntry(entry)
      setActiveNumber(entry ? (await api.getTicket(entry.ticketId)).number : null)
    } catch {
      setActiveEntry(null)
    }
  }, [isStaff])

  useEffect(() => {
    void refreshActiveTimer()
    const timer = setInterval(() => void refreshActiveTimer(), POLL_MS)
    return () => clearInterval(timer)
  }, [refreshActiveTimer])

  useEffect(() => {
    if (!activeEntry) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [activeEntry])

  async function toggleTimer() {
    if (!isStaff || !selectedId) return
    setError(null)
    try {
      if (activeEntry && activeEntry.ticketId === selectedId) {
        await api.stopTime()
      } else {
        await api.startTime({ ticketId: selectedId })
      }
      await refreshActiveTimer()
    } catch (err) {
      setError(errorMessage(err, 'timer action failed'))
    }
  }

  const toggleTimerRef = useRef(toggleTimer)
  useEffect(() => {
    toggleTimerRef.current = toggleTimer
  })

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 't' || event.key === 'T') {
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
        void toggleTimerRef.current()
        return
      }
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

  const visibleTickets = useMemo(() => {
    const query = search.trim().toLowerCase()
    return allTickets.filter((ticket) => {
      if (statusFilter !== 'all' && ticket.status !== statusFilter) return false
      if (query && !ticket.subject.toLowerCase().includes(query)) return false
      return true
    })
  }, [allTickets, statusFilter, search])

  const counts = useMemo(() => {
    const base: Record<string, number> = { all: allTickets.length }
    for (const status of TICKET_STATUSES) base[status] = 0
    for (const ticket of allTickets) {
      if (ticket.status in base) base[ticket.status]++
    }
    return base
  }, [allTickets])

  const stats = useMemo(() => queueStats(allTickets, user.id), [allTickets, user.id])

  async function selectTicket(id: string) {
    setError(null)
    setSelectedId(id)
  }

  async function patchTicket(id: string, patch: TicketPatch) {
    setError(null)
    try {
      await api.patchTicket(id, patch)
      await Promise.all([refreshDetail(id), refreshList()])
    } catch (err) {
      setError(errorMessage(err, 'failed to update ticket'))
    }
  }

  async function reply(id: string, kind: 'public' | 'internal', body: string) {
    setError(null)
    try {
      await api.addTicketUpdate(id, { kind, body })
      await Promise.all([refreshDetail(id), refreshList()])
    } catch (err) {
      setError(errorMessage(err, 'failed to send update'))
      throw err
    }
  }

  async function createTicket(values: TicketFormValues) {
    setFormError(null)
    try {
      const row = await api.createTicket(values)
      setShowNewTicket(false)
      await refreshList()
      setSelectedId(row.id)
    } catch (err) {
      setFormError(errorMessage(err, 'failed to create ticket'))
    }
  }

  async function deleteTicket(id: string) {
    setError(null)
    try {
      await api.deleteTicket(id)
      setSelectedId(null)
      await refreshList()
    } catch (err) {
      setError(errorMessage(err, 'failed to delete ticket'))
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
      <header className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="tracking-widest text-accent">KIPPLE</span>
          <span className="text-xs text-dim">agent workspace</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          {isStaff && activeEntry && (
            <button
              onClick={toggleTimer}
              title="stop timer (T)"
              className="border border-ok bg-ok/10 px-2 py-1 tabular-nums text-ok"
            >
              TIMER {activeNumber ? `#${activeNumber}` : ''} ·{' '}
              {formatClock((now - new Date(activeEntry.startedAt).getTime()) / 1000)}
            </button>
          )}
          <span>
            <span className="text-dim">{user.name}</span>{' '}
            <span className="text-dim">·</span>{' '}
            <span className="uppercase text-dim">{user.role}</span>
          </span>
          <button
            onClick={signOut}
            disabled={signingOut}
            className="border border-line px-2 py-1 text-dim hover:border-danger hover:text-danger"
          >
            sign out
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-4">
        {(
          [
            ['assigned to me', stats.assignedToMe],
            ['in queue', stats.inQueue],
            ['opened today', stats.openedToday],
            ['closed today', stats.closedToday],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="border border-line bg-panel p-3">
            <div className="text-2xl text-fg tabular-nums">{value}</div>
            <div className="mt-1 text-xs uppercase tracking-widest text-dim">{label}</div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mx-3 mb-3 border border-danger px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <main className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <div className="flex min-h-0 flex-1 border border-line bg-ink">
          <QueuePane
            tickets={visibleTickets}
            counts={counts}
            clientNames={clientNames}
            selectedId={selectedId}
            statusFilter={statusFilter}
            search={search}
            canCreate={isStaff}
            searchRef={searchRef}
            onStatusFilter={setStatusFilter}
            onSearch={setSearch}
            onSelect={selectTicket}
            onNewTicket={() => {
              setFormError(null)
              setShowNewTicket(true)
            }}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {detail ? (
              <>
                <TicketDetail
                  key={detail.id}
                  detail={detail}
                  staff={staff}
                  isStaff={isStaff}
                  onPatch={patchTicket}
                  onReply={reply}
                  onDelete={deleteTicket}
                />
                {isStaff && (
                  <TimePanel
                    ticketId={detail.id}
                    onChanged={() => {
                      void refreshList()
                      void refreshActiveTimer()
                    }}
                  />
                )}
              </>
            ) : (
              <div className="grid flex-1 place-items-center">
                <div className="text-center">
                  <div className="text-sm tracking-widest text-dim">QUEUE</div>
                  <p className="mt-2 text-fg">
                    {visibleTickets.length === 0
                      ? 'No tickets. The board is clean.'
                      : 'Select a ticket to open it.'}
                  </p>
                  <p className="mt-1 text-xs text-dim">press / to search</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {showNewTicket && (
        <TicketForm
          clients={clients}
          error={formError}
          onSubmit={createTicket}
          onClose={() => setShowNewTicket(false)}
        />
      )}

      <footer className="flex items-center justify-between border-t border-line bg-panel px-4 py-2 text-xs text-dim">
        <span>
          kipple v0.1.0 · presence: <span className="uppercase">{user.presence}</span>
        </span>
        <span>{user.email}</span>
      </footer>
    </div>
  )
}
