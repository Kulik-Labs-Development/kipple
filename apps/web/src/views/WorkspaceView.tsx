import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { agentThemes, type ThemeId } from '@kipple/shared/themes'
import { AutomationManager } from '../components/AutomationManager'
import { ClientManager } from '../components/ClientManager'
import { DefaultsManager } from '../components/DefaultsManager'
import { HoldsManager } from '../components/HoldsManager'
import { UsersManager } from '../components/UsersManager'
import { SettingsPanel } from '../components/SettingsPanel'
import { NotificationBell } from '../components/NotificationBell'
import { PhosphorIcon } from '../components/PhosphorIcon'
import { QueuePane, type ClientCount, type RailSel } from '../components/QueuePane'
import { SettingsDrawer, type DrawerPanel } from '../components/SettingsDrawer'
import { SlaManager } from '../components/SlaManager'
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
import { useI18n, type I18nKey } from '../lib/i18n'
import { formatClock, queueStats, TICKET_STATUSES } from '../lib/tickets'

const PRESENCE_VALUES = ['online', 'away', 'busy', 'offline'] as const

// The presence state arrives as a plain string from the API — an unmapped
// value falls back to 'presence.offline' at the call sites.
const PRESENCE_KEY: Record<string, I18nKey> = {
  online: 'presence.online',
  away: 'presence.away',
  busy: 'presence.busy',
  offline: 'presence.offline',
}

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
  ssoEnabled,
  onSignedOut,
  onUserUpdated,
  instanceName,
}: {
  user: MeUser
  preferences: { theme: string | null; colorMode: string }
  ssoEnabled: boolean
  onSignedOut: () => void
  onUserUpdated: (next: MeUser) => void
  instanceName: string | null
}) {
  const { t } = useI18n()
  const isStaff = user.role !== 'contact'
  const [signingOut, setSigningOut] = useState(false)
  const [clients, setClients] = useState<ClientSummary[]>([])
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [allTickets, setAllTickets] = useState<TicketRow[]>([])
  const [rail, setRail] = useState<RailSel>({ kind: 'all' })
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
  const [view, setView] = useState<'tickets' | 'clients'>('tickets')
  const [showDefaults, setShowDefaults] = useState(false)
  const [showHolds, setShowHolds] = useState(false)
  const [showUsers, setShowUsers] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [presence, setPresence] = useState(user.presence)
  const [theme, setTheme] = useState(preferences.theme ?? 'default')
  const [now, setNow] = useState(() => Date.now())
  const searchRef = useRef<HTMLInputElement>(null)

  const initials = useMemo(
    () =>
      user.name
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase() || '?',
    [user.name],
  )

  const clientNames = useMemo(
    () => new Map(clients.map((client) => [client.id, client.name])),
    [clients],
  )

  const staffNames = useMemo(
    () => new Map(staff.map((member) => [member.id, member.name])),
    [staff],
  )

  const clientCounts = useMemo<ClientCount[]>(
    () =>
      clients.map((client) => ({
        id: client.id,
        name: client.name,
        count: allTickets.filter((ticket) => ticket.clientId === client.id).length,
      })),
    [clients, allTickets],
  )

  const refreshList = useCallback(async () => {
    try {
      setAllTickets(await api.listTickets())
      setError(null)
    } catch (err) {
      setError(errorMessage(err, t('workspace.error.loadTickets')))
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
        if (!cancelled) setError(errorMessage(err, t('workspace.error.loadData')))
      }
    }
    init()
    return () => {
      cancelled = true
    }
  }, [isStaff])

  // Real-time presence (issue #96): the SSE channel pushes presence changes;
  // the initial list above is the baseline. EventSource reconnects on its own.
  useEffect(() => {
    if (!isStaff) return
    const source = new EventSource('/api/events')
    const onPresence = (event: MessageEvent) => {
      try {
        const { userId, presence: next } = JSON.parse(event.data) as {
          userId: string
          presence: string
        }
        setStaff((prev) =>
          prev.map((row) => (row.id === userId ? { ...row, presence: next } : row)),
        )
      } catch {
        /* malformed frame — ignore */
      }
    }
    source.addEventListener('presence', onPresence)
    return () => {
      source.removeEventListener('presence', onPresence)
      source.close()
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
      setError(errorMessage(err, t('workspace.error.timer')))
    }
  }

  const toggleTimerRef = useRef(toggleTimer)
  useEffect(() => {
    toggleTimerRef.current = toggleTimer
  })

  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  })

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (viewRef.current === 'clients') return
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

  // The rail IS the filter — one selection at a time (all / status / mine /
  // client); the topbar search narrows subject within it.
  const visibleTickets = useMemo(() => {
    const query = search.trim().toLowerCase()
    return allTickets.filter((ticket) => {
      if (rail.kind === 'status' && ticket.status !== rail.status) return false
      if (rail.kind === 'mine' && ticket.assignedTo !== user.id) return false
      if (rail.kind === 'client' && ticket.clientId !== rail.clientId) return false
      if (query && !ticket.subject.toLowerCase().includes(query)) return false
      return true
    })
  }, [allTickets, rail, search, user.id])

  const counts = useMemo(() => {
    const base: Record<string, number> = { all: allTickets.length }
    for (const status of TICKET_STATUSES) base[status] = 0
    for (const ticket of allTickets) {
      if (ticket.status in base) base[ticket.status]++
    }
    return base
  }, [allTickets])

  // Queue-wide rail counts (assigned-to-me row) + the overdue count for the
  // currently visible set (queue head).
  const stats = useMemo(() => queueStats(allTickets, user.id), [allTickets, user.id])
  const overdue = useMemo(() => queueStats(visibleTickets, user.id).overdue, [visibleTickets, user.id])

  async function changePresence(next: string) {
    setPresence(next)
    try {
      await api.setPresence(next)
    } catch (err) {
      setError(errorMessage(err, t('workspace.error.presence')))
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
      setError(errorMessage(err, t('workspace.error.theme')))
    }
  }

  async function selectTicket(id: string) {
    setError(null)
    setView('tickets')
    setSelectedId(id)
  }

  async function patchTicket(id: string, patch: TicketPatch) {
    setError(null)
    try {
      await api.patchTicket(id, patch)
      await Promise.all([refreshDetail(id), refreshList()])
    } catch (err) {
      setError(errorMessage(err, t('workspace.error.patchTicket')))
    }
  }

  async function reply(id: string, kind: 'public' | 'internal', body: string, uploadIds: string[]) {
    setError(null)
    try {
      await api.addTicketUpdate(id, {
        kind,
        body,
        ...(uploadIds.length > 0 ? { uploadIds } : {}),
      })
      await Promise.all([refreshDetail(id), refreshList()])
    } catch (err) {
      setError(errorMessage(err, t('workspace.error.reply')))
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
      setFormError(errorMessage(err, t('workspace.error.createTicket')))
    }
  }

  async function deleteTicket(id: string) {
    setError(null)
    try {
      await api.deleteTicket(id)
      setSelectedId(null)
      await refreshList()
    } catch (err) {
      setError(errorMessage(err, t('workspace.error.deleteTicket')))
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

  // Drawer items open the existing superuser panels (clients / self-registration
  // switch to the clients page, which carries the per-client settings).
  function openPanel(panel: DrawerPanel) {
    setDrawerOpen(false)
    switch (panel) {
      case 'general':
        setShowSettings(true)
        break
      case 'appearance':
      case 'uploads':
        setShowDefaults(true)
        break
      case 'users':
      case 'invites':
        setShowUsers(true)
        break
      case 'clients':
      case 'selfReg':
        setView('clients')
        break
      case 'sla':
        setShowSlaManager(true)
        break
      case 'automation':
        setShowAutomation(true)
        break
      case 'holds':
        setShowHolds(true)
        break
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-7 border-b-2 border-line bg-panel px-7">
        <span className="shrink-0 text-[19px] leading-none font-bold tracking-[-.03em] text-fg">
          kip<span className="text-accent">p</span>le
        </span>
        <span className="shrink-0 border-l border-line pl-7 text-[9px] tracking-[.28em] text-dim uppercase">
          {t('workspace.workspace')}
        </span>
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('queue.searchPlaceholder')}
          aria-label={t('queue.searchPlaceholder')}
          className="min-w-0 max-w-[520px] flex-1 border-b border-line bg-transparent py-2 text-[13px] text-fg outline-none placeholder:text-dim/70 focus:border-accent"
        />
        <div className="ml-auto flex shrink-0 items-center gap-[18px]">
          {isStaff && <NotificationBell onOpenTicket={selectTicket} />}
          {isStaff && activeEntry && (
            <button
              onClick={toggleTimer}
              title={t('workspace.timer.stop')}
              className="border border-ok bg-ok/10 px-2.5 py-1 text-[10px] tabular-nums text-ok"
            >
              {t('workspace.timer.label')} {activeNumber ? `#${activeNumber}` : ''} ·{' '}
              {formatClock((now - new Date(activeEntry.startedAt).getTime()) / 1000)}
            </button>
          )}
          {isStaff && user.role === 'superuser' && (
            <button
              onClick={() => setDrawerOpen(true)}
              className="border border-line px-3 py-[7px] text-[9px] tracking-[.2em] text-dim uppercase hover:border-accent hover:text-accent"
            >
              {t('workspace.system')}
            </button>
          )}
          {isStaff && (
            <button
              onClick={() => {
                setFormError(null)
                setShowNewTicket(true)
              }}
              className="bg-accent px-4 py-2.5 text-[10px] tracking-[.22em] text-ink uppercase"
            >
              + {t('workspace.newTicket')}
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={t('workspace.profile')}
              title={`${user.name} · ${user.role}`}
              className="flex h-[30px] w-[30px] items-center justify-center border border-fg bg-ink text-[10px] font-bold text-fg"
            >
              {initials}
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-[38px] z-40 w-52 border-2 border-fg bg-panel">
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      setShowSettings(true)
                    }}
                    className="block w-full px-4 py-2.5 text-left text-[10px] tracking-[.18em] text-fg uppercase hover:bg-ink"
                  >
                    {t('workspace.profile')}
                  </button>
                  <label className="block border-t border-line px-4 py-2 text-[8px] tracking-[.24em] text-dim uppercase">
                    {t('workspace.theme.title')}
                    <select
                      value={theme}
                      onChange={(event) => void changeTheme(event.target.value)}
                      className="mt-1.5 w-full border border-line bg-ink px-1.5 py-1 text-[10px] tracking-[.12em] text-fg uppercase outline-none focus:border-accent"
                    >
                      <option value="default">{t('workspace.theme.default')}</option>
                      {agentThemes().map((meta) => (
                        <option key={meta.id} value={meta.id}>
                          {meta.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block border-t border-line px-4 py-2 text-[8px] tracking-[.24em] text-dim uppercase">
                    <span className="flex items-center gap-2">
                      <span
                        className={`presence-dot h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT[presence] ?? 'bg-dim'}`}
                      />
                      {t('workspace.presence.title')}
                    </span>
                    <select
                      value={presence}
                      onChange={(event) => void changePresence(event.target.value)}
                      className="mt-1.5 w-full border border-line bg-ink px-1.5 py-1 text-[10px] tracking-[.12em] text-fg uppercase outline-none focus:border-accent"
                    >
                      {PRESENCE_VALUES.map((value) => (
                        <option key={value} value={value}>
                          {t(PRESENCE_KEY[value])}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    onClick={() => void signOut()}
                    disabled={signingOut}
                    className="block w-full border-t border-line px-4 py-2.5 text-left text-[10px] tracking-[.18em] text-dim uppercase hover:bg-ink hover:text-danger"
                  >
                    {t('workspace.signOut')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-danger bg-panel px-7 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <main className="flex min-h-0 flex-1">
        {view === 'clients' ? (
          <div className="flex min-h-0 flex-1 bg-ink">
            <ClientManager
              onSaved={() => {
                void refreshClients()
              }}
              onClose={() => setView('tickets')}
            />
          </div>
        ) : (
          <>
            <QueuePane
              tickets={visibleTickets}
              counts={counts}
              mineCount={stats.assignedToMe}
              clientCounts={clientCounts}
              clientNames={clientNames}
              staffNames={staffNames}
              selectedId={selectedId}
              rail={rail}
              onRail={setRail}
              onSelect={selectTicket}
              slaConfig={slaConfig}
              overdue={overdue}
            />
            <div className="flex min-h-0 flex-1 flex-col border-l border-line">
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
                    <div className="text-sm tracking-widest text-dim">{t('workspace.empty.heading')}</div>
                    <p className="mt-2 text-fg">
                      {visibleTickets.length === 0
                        ? t('queue.empty')
                        : t('workspace.empty.select')}
                    </p>
                    <p className="mt-1 text-xs text-dim">{t('workspace.empty.searchHint')}</p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        {isStaff && user.role === 'superuser' && drawerOpen && (
          <SettingsDrawer onOpen={openPanel} onClose={() => setDrawerOpen(false)} />
        )}
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

      {showDefaults && <DefaultsManager onClose={() => setShowDefaults(false)} />}
      {showHolds && <HoldsManager onClose={() => setShowHolds(false)} />}
      {showUsers && <UsersManager onClose={() => setShowUsers(false)} />}
      {showSettings && (
        <SettingsPanel
          user={user}
          ssoEnabled={ssoEnabled}
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

      <footer className="flex items-center justify-between gap-4 border-t border-line bg-panel px-4 py-2 text-xs text-dim">
        <span className="flex min-w-0 items-center gap-2">
          <a
            href="https://github.com/Kulik-Labs-Development/kipple"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Kipple on GitHub"
            className="shrink-0 hover:text-accent"
          >
            <PhosphorIcon name="github" />
          </a>
          <span className="truncate">
            <a
              href="https://kippleticket.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-accent hover:underline"
            >
              kipple v0.1.0
            </a>{' '}
            · <span className="uppercase">{t('workspace.footer.presence', { presence })}</span>
          </span>
        </span>
        <span className="hidden truncate uppercase tracking-widest sm:block">{instanceName}</span>
        <span className="shrink-0">{user.email}</span>
      </footer>
    </div>
  )
}
