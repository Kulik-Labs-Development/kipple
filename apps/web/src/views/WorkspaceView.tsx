import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { agentThemes, type ThemeId } from '@kipple/shared/themes'
import { AutomationManager } from '../components/AutomationManager'
import { ClientManager } from '../components/ClientManager'
import { DefaultsManager } from '../components/DefaultsManager'
import { SettingsPanel } from '../components/SettingsPanel'
import { NotificationBell } from '../components/NotificationBell'
import { PhosphorIcon } from '../components/PhosphorIcon'
import { QueuePane } from '../components/QueuePane'
import { SlaManager } from '../components/SlaManager'
import { Sparkline } from '../components/Sparkline'
import { TicketDetail, type TicketPatch } from '../components/TicketDetail'
import { TicketForm, type TicketFormValues } from '../components/TicketForm'
import { TimePanel } from '../components/TimePanel'
import {
  api,
  type ClientSummary,
  type MeUser,
  type SlaConfig,
  type StaffUser,
  type TicketDetail as TicketDetailData,
  type TicketRow,
  type TimeEntryRow,
} from '../lib/api'
import { applyTheme, resolveThemeChoice } from '../lib/theme'
import {
  dailySeries,
  formatClock,
  queueStats,
  TICKET_STATUSES,
  type StatusFilter,
} from '../lib/tickets'

const PRESENCE_VALUES = ['online', 'away', 'busy', 'offline'] as const

const PRESENCE_DOT: Record<string, string> = {
  online: 'bg-ok',
  away: 'bg-warn',
  busy: 'bg-danger',
  offline: 'bg-dim',
}

const POLL_MS = 30_000

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function WorkspaceView({
  user,
  preferences,
  onSignedOut,
  onUserUpdated,
}: {
  user: MeUser
  preferences: { theme: string | null; colorMode: string }
  onSignedOut: () => void
  onUserUpdated: (next: MeUser) => void
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
  const [slaConfig, setSlaConfig] = useState<SlaConfig | null>(null)
  const [showSlaManager, setShowSlaManager] = useState(false)
  const [showAutomation, setShowAutomation] = useState(false)
  const [showClients, setShowClients] = useState(false)
  const [showDefaults, setShowDefaults] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [presence, setPresence] = useState(user.presence)
  const [theme, setTheme] = useState(preferences.theme ?? 'default')
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

  const refreshSlaConfig = useCallback(async () => {
    if (!isStaff) return
    try {
      setSlaConfig(await api.slaConfig())
    } catch {
      setSlaConfig(null)
    }
  }, [isStaff])

  const refreshClients = useCallback(async () => {
    try {
      setClients(await api.listClients())
    } catch {
      /* keep the previous list */
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
    void refreshSlaConfig()
  }, [refreshSlaConfig])

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
      void refreshSlaConfig()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refreshList, refreshDetail, refreshSlaConfig, selectedId])

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

  const series = useMemo(() => dailySeries(allTickets, 14), [allTickets])

  async function changePresence(next: string) {
    setPresence(next)
    try {
      await api.setPresence(next)
    } catch (err) {
      setError(errorMessage(err, 'failed to update presence'))
    }
  }

  async function changeTheme(value: string) {
    setTheme(value)
    try {
      await api.patchPreferences({ theme: value === 'default' ? null : (value as ThemeId) })
      const me = await api.me()
      applyTheme(
        resolveThemeChoice(me.preferences, me.instanceTheme, me.user.role, me.primaryClient?.branding ?? null),
      )
    } catch (err) {
      setError(errorMessage(err, 'failed to update theme'))
    }
  }

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

  async function reply(id: string, kind: 'public' | 'internal', body: string, files: File[]) {
    setError(null)
    try {
      if (files.length > 0) {
        await api.uploadUpdate(id, { kind, body }, files)
      } else {
        await api.addTicketUpdate(id, { kind, body })
      }
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
          {isStaff && (
            <NotificationBell onOpenTicket={selectTicket} />
          )}
          {isStaff && user.role === 'superuser' && (
            <button
              onClick={() => setShowSlaManager(true)}
              title="SLA settings (superuser)"
              className={`group flex items-center gap-1.5 border px-2 py-1 uppercase tracking-widest ${
                slaConfig?.enabled ? 'border-ok text-ok' : 'border-line text-dim'
              }`}
            >
              <PhosphorIcon name="clock" size="sm" />
              sla
            </button>
          )}
          {isStaff && (
            <button
              onClick={
                user.role === 'superuser' ? () => setShowAutomation(true) : undefined
              }
              title={
                user.role === 'superuser'
                  ? 'email templates + rules (superuser)'
                  : 'automation (superuser only)'
              }
              className="group flex items-center gap-1.5 border border-line px-2 py-1 uppercase tracking-widest text-dim hover:border-accent hover:text-accent"
            >
              <PhosphorIcon
                name="gear"
                size="sm"
                className="transition-transform duration-300 group-hover:rotate-90"
              />
              auto
            </button>
          )}
          {isStaff && (
            <button
              onClick={
                user.role === 'superuser' || user.role === 'admin'
                  ? () => setShowClients(true)
                  : undefined
              }
              title={
                user.role === 'superuser' || user.role === 'admin'
                  ? 'clients + portal branding'
                  : 'clients (admin or superuser only)'
              }
              className="group flex items-center gap-1.5 border border-line px-2 py-1 uppercase tracking-widest text-dim hover:border-accent hover:text-accent"
            >
              <PhosphorIcon
                name="users"
                size="sm"
                className="transition-transform duration-300 group-hover:-translate-y-0.5"
              />
              clients
            </button>
          )}
          {isStaff && user.role === 'superuser' && (
            <button
              onClick={() => setShowDefaults(true)}
              title="instance defaults (superuser)"
              className="group flex items-center gap-1.5 border border-line px-2 py-1 uppercase tracking-widest text-dim hover:border-accent hover:text-accent"
            >
              <PhosphorIcon name="sliders" size="sm" />
              defaults
            </button>
          )}
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
          <button
            onClick={() => setShowSettings(true)}
            title="settings"
            className="flex items-center gap-1.5 border border-transparent px-1 py-0.5 hover:border-line"
          >
            {user.image && (
              <img
                src="/api/me/avatar"
                alt=""
                aria-hidden
                className="h-4 w-4 rounded-full border border-line object-cover"
              />
            )}
            <span className="text-dim">{user.name}</span>{' '}
            <span className="text-dim">·</span>{' '}
            <span className="uppercase text-dim">{user.role}</span>
          </button>
          <span className="flex items-center gap-1.5">
            <span
              className={`presence-dot h-2 w-2 rounded-full ${PRESENCE_DOT[presence] ?? 'bg-dim'}`}
              title={`presence: ${presence}`}
            />
            <select
              value={presence}
              onChange={(event) => void changePresence(event.target.value)}
              title="presence"
              className="border border-line bg-panel px-1 py-1 text-xs uppercase tracking-widest text-dim outline-none focus:border-accent"
            >
              {PRESENCE_VALUES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </span>
          <select
            value={theme}
            onChange={(event) => void changeTheme(event.target.value)}
            title="theme (default = company setting)"
            className="border border-line bg-panel px-1 py-1 text-xs uppercase tracking-widest text-dim outline-none focus:border-accent"
          >
            <option value="default">default</option>
            {agentThemes().map((meta) => (
              <option key={meta.id} value={meta.id}>
                {meta.label}
              </option>
            ))}
          </select>
          <button
            onClick={signOut}
            disabled={signingOut}
            className="border border-line px-2 py-1 text-dim hover:border-danger hover:text-danger"
          >
            sign out
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-5">
        {(
          [
            ['assigned to me', stats.assignedToMe],
            ['in queue', stats.inQueue],
            ['opened today', stats.openedToday],
            ['closed today', stats.closedToday],
            ['overdue', stats.overdue],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="border border-line bg-panel p-3">
            <div
              className={`text-2xl tabular-nums ${
                label === 'overdue' && value > 0 ? 'text-danger' : 'text-fg'
              }`}
            >
              {value}
            </div>
            <div className="mt-1 text-xs uppercase tracking-widest text-dim">{label}</div>
          </div>
        ))}
      </div>

      <div className="mx-3 mb-3 flex flex-wrap items-center gap-6 border border-line bg-panel px-3 py-2">
        <span className="text-xs uppercase tracking-widest text-dim">14 days</span>
        <Sparkline label="opened" values={series.opened} barClass="bg-accent" />
        <Sparkline label="closed" values={series.closed} barClass="bg-ok" />
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
            slaConfig={slaConfig}
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
                  slaConfig={slaConfig}
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

      {showSlaManager && slaConfig && (
        <SlaManager
          config={slaConfig}
          onChanged={() => {
            void refreshSlaConfig()
            void refreshList()
            if (selectedId) void refreshDetail(selectedId)
          }}
          onClose={() => setShowSlaManager(false)}
        />
      )}

      {showClients && (
        <ClientManager
          onSaved={() => {
            void refreshClients()
          }}
          onClose={() => setShowClients(false)}
        />
      )}
      {showDefaults && <DefaultsManager onClose={() => setShowDefaults(false)} />}
      {showSettings && (
        <SettingsPanel
          user={user}
          onProfileSaved={(patch) => {
            if (patch.name || patch.email) {
              onUserUpdated({ ...user, name: patch.name ?? user.name, email: patch.email ?? user.email })
            }
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showAutomation && (
        <AutomationManager
          clients={clients}
          staff={staff}
          ticketId={selectedId}
          onTicketId={setSelectedId}
          onClose={() => setShowAutomation(false)}
          onChanged={() => {
            void refreshList()
            if (selectedId) void refreshDetail(selectedId)
          }}
        />
      )}

      <footer className="flex items-center justify-between border-t border-line bg-panel px-4 py-2 text-xs text-dim">
        <span>
          kipple v0.1.0 · presence: <span className="uppercase">{presence}</span>
        </span>
        <span>{user.email}</span>
      </footer>
    </div>
  )
}
