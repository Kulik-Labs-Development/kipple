import { useMemo, useState } from 'react'
import type { SlaConfig, TicketRow } from '../lib/api'
import { queueSlaState } from '../lib/sla'
import { STATUS_KEY, useI18n, type I18nKey } from '../lib/i18n'
import {
  relativeTime,
  shortDate,
  statusLedClass,
  TICKET_STATUSES,
} from '../lib/tickets'

// Priority is free-form in the DB (default 'normal') — an unmapped value
// renders as-is rather than under a wrong label.
const PRIORITY_KEY: Record<string, I18nKey> = {
  low: 'priority.low',
  normal: 'priority.normal',
  high: 'priority.high',
  urgent: 'priority.urgent',
}
const SLA_KEY: Record<NonNullable<ReturnType<typeof queueSlaState>>, I18nKey> = {
  pending: 'sla.pending',
  at_risk: 'sla.at_risk',
  breached: 'sla.breached',
  met: 'sla.met',
}

/**
 * The active queue rail entry (Swiss layout). The rail is the filter: one
 * selection at a time — all, a status, the current user's queue, or a client.
 */
export type RailSel =
  | { kind: 'all' }
  | { kind: 'status'; status: (typeof TICKET_STATUSES)[number] }
  | { kind: 'mine' }
  | { kind: 'client'; clientId: string }

type SortMode = 'recent' | 'oldest' | 'openedOldest'
const SORT_ORDER: SortMode[] = ['recent', 'oldest', 'openedOldest']
const SORT_KEY: Record<SortMode, I18nKey> = {
  recent: 'queue.sort.recent',
  oldest: 'queue.sort.oldest',
  openedOldest: 'queue.sort.openedOldest',
}

export interface ClientCount {
  id: string
  name: string
  count: number
}

interface QueuePaneProps {
  /** Tickets already filtered by the rail selection + the topbar search. */
  tickets: TicketRow[]
  /** Queue-wide counts (unfiltered): status keys + 'all'. */
  counts: Record<string, number>
  /** Count of active tickets assigned to the current user (rail row). */
  mineCount: number
  /** One row per client, with the ticket count on that client. */
  clientCounts: ClientCount[]
  clientNames: Map<string, string>
  /** Staff user id → display name (assignee strip). */
  staffNames: Map<string, string>
  selectedId: string | null
  rail: RailSel
  onRail: (sel: RailSel) => void
  onSelect: (id: string) => void
  slaConfig: SlaConfig | null
  /** Overdue tickets within the currently visible set (queue head). */
  overdue: number
}

// Shared rail-row look: the selected entry gets the app-bg band + the 3px
// accent bar (no Radix bg-active token exists — bg-ink is the house stand-in).
function RailRow({
  label,
  count,
  selected,
  onClick,
}: {
  label: string
  count: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-[23px] w-full items-baseline justify-between text-left text-xs hover:bg-panel ${
        selected
          ? 'border-l-[3px] border-l-accent bg-ink pl-[17px] pr-5 font-bold'
          : 'border-l-[3px] border-l-transparent pl-5 pr-5'
      }`}
    >
      <span className="min-w-0 truncate tracking-[.02em] text-fg">{label}</span>
      <span
        className={`ml-2.5 shrink-0 text-[10px] tracking-[.06em] tabular-nums ${
          selected ? 'font-bold text-accent' : 'text-dim'
        }`}
      >
        {count}
      </span>
    </button>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <div className="px-5 pt-3 pb-1.5 text-[8px] uppercase tracking-[.3em] text-dim">
      {children}
    </div>
  )
}

function CardField({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="mr-[22px] border-r border-line pr-[22px] last:mr-0 last:border-r-0 last:pr-0">
      <div className="mb-1 text-[8px] tracking-[.24em] text-dim uppercase">{label}</div>
      <div className={`text-xs ${accent ? 'font-bold text-accent' : 'text-fg'}`}>{value}</div>
    </div>
  )
}

export function QueuePane({
  tickets,
  counts,
  mineCount,
  clientCounts,
  clientNames,
  staffNames,
  selectedId,
  rail,
  onRail,
  onSelect,
  slaConfig,
  overdue,
}: QueuePaneProps) {
  const { t } = useI18n()
  const [sort, setSort] = useState<SortMode>('recent')

  const sorted = useMemo(() => {
    const list = [...tickets]
    const byUpdated = (a: TicketRow, b: TicketRow, dir: 1 | -1) =>
      dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
    if (sort === 'recent') list.sort((a, b) => byUpdated(a, b, -1))
    else if (sort === 'oldest') list.sort((a, b) => byUpdated(a, b, 1))
    else list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    return list
  }, [tickets, sort])

  function headLabel(): string {
    if (rail.kind === 'status') return t(STATUS_KEY[rail.status])
    if (rail.kind === 'mine') return t('queue.assignedToMe')
    if (rail.kind === 'client')
      return clientNames.get(rail.clientId) ?? t('queue.unknownClient')
    return t('queue.allTickets')
  }

  function isSelected(sel: RailSel): boolean {
    if (sel.kind !== rail.kind) return false
    if (sel.kind === 'client' && rail.kind === 'client') return sel.clientId === rail.clientId
    if (sel.kind === 'status' && rail.kind === 'status') return sel.status === rail.status
    return true
  }

  return (
    <>
      {/* Filter rail */}
      <aside className="flex w-[252px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel pt-[18px]">
        <div className="mb-2.5 flex items-baseline justify-between border-b-2 border-line px-5 pb-3">
          <span className="text-[11px] font-bold tracking-[.26em] text-fg uppercase">
            {t('queue.rail.title')}
          </span>
          <span className="text-[10px] tracking-[.18em] text-dim uppercase">
            {t('queue.rail.filters')}
          </span>
        </div>

        <GroupLabel>{t('queue.rail.statusGroup')}</GroupLabel>
        <RailRow
          label={t('queue.allTickets')}
          count={counts.all ?? 0}
          selected={isSelected({ kind: 'all' })}
          onClick={() => onRail({ kind: 'all' })}
        />
        {TICKET_STATUSES.map((status) => (
          <RailRow
            key={status}
            label={t(STATUS_KEY[status])}
            count={counts[status] ?? 0}
            selected={isSelected({ kind: 'status', status })}
            onClick={() => onRail({ kind: 'status', status })}
          />
        ))}
        <RailRow
          label={t('queue.assignedToMe')}
          count={mineCount}
          selected={isSelected({ kind: 'mine' })}
          onClick={() => onRail({ kind: 'mine' })}
        />

        {clientCounts.length > 0 && (
          <>
            <GroupLabel>{t('queue.rail.clientsGroup')}</GroupLabel>
            {[...clientCounts]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((client) => (
                <RailRow
                  key={client.id}
                  label={client.name}
                  count={client.count}
                  selected={isSelected({ kind: 'client', clientId: client.id })}
                  onClick={() => onRail({ kind: 'client', clientId: client.id })}
                />
              ))}
          </>
        )}
      </aside>

      {/* Ticket cards */}
      <section className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-ink px-9 pt-[26px] pb-4">
        <div className="mb-1.5 flex items-baseline gap-4">
          <h1 className="text-[26px] leading-none font-bold tracking-[-.01em] text-fg">
            {headLabel()}
          </h1>
          <span className="text-[11px] tracking-[.2em] text-dim uppercase">
            {t('queue.nTickets', { n: tickets.length })}
          </span>
          {overdue > 0 && (
            <span className="text-[11px] font-bold tracking-[.2em] text-danger uppercase">
              · {t('queue.nOverdue', { n: overdue })}
            </span>
          )}
          <button
            onClick={() =>
              setSort(SORT_ORDER[(SORT_ORDER.indexOf(sort) + 1) % SORT_ORDER.length])
            }
            title={t('queue.sort')}
            className="ml-auto text-[10px] tracking-[.18em] text-dim uppercase hover:text-fg"
          >
            {t('queue.sort')} · <b className="font-normal text-fg">{t(SORT_KEY[sort])}</b>
          </button>
        </div>
        <div className="my-2.5 h-0.5 bg-line" />

        {sorted.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-xs tracking-widest text-dim uppercase">
              {t('queue.emptyHeading')}
            </div>
            <p className="mt-2 text-sm text-fg">{t('queue.empty')}</p>
          </div>
        ) : (
          <div>
            {sorted.map((ticket) => {
              const active = selectedId === ticket.id
              return (
                <button
                  key={ticket.id}
                  onClick={() => onSelect(ticket.id)}
                  className={`block w-full border-t border-line py-[13px] pb-[12px] text-left hover:bg-panel ${
                    active
                      ? '-ml-[17px] border-l-[3px] border-l-accent pl-[14px]'
                      : 'border-l-[3px] border-l-transparent pl-[17px]'
                  } last:border-b`}
                >
                  {/* row 1: LED + status + number + subject + age */}
                  <div className="flex items-baseline gap-3">
                    <span
                      className={`inline-block h-2 w-2 shrink-0 self-center ${statusLedClass(ticket.status)}`}
                    />
                    <span className="shrink-0 text-[9px] font-bold tracking-[.2em] text-fg uppercase">
                      {ticket.status in STATUS_KEY
                        ? t(STATUS_KEY[ticket.status as keyof typeof STATUS_KEY])
                        : ticket.status}
                    </span>
                    <span className="shrink-0 text-[10px] tracking-[.1em] text-dim">
                      #{ticket.number}
                    </span>
                    <span className="min-w-0 truncate text-sm font-bold text-fg">
                      {ticket.subject}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] tracking-[.14em] text-dim">
                      {relativeTime(ticket.updatedAt)}
                    </span>
                  </div>
                  {/* row 2: client */}
                  <div className="mt-[5px] truncate text-xs text-dim">
                    {clientNames.get(ticket.clientId) ?? t('queue.unknownClient')}
                  </div>
                  {/* row 3: metadata strip */}
                  <div className="mt-[11px] flex items-start">
                    <CardField
                      label={t('queue.card.assignee')}
                      value={
                        (ticket.assignedTo && staffNames.get(ticket.assignedTo)) ||
                        t('queue.none')
                      }
                    />
                    <CardField
                      label={t('queue.card.priority')}
                      value={
                        ticket.priority in PRIORITY_KEY
                          ? t(PRIORITY_KEY[ticket.priority])
                          : ticket.priority
                      }
                      accent={ticket.priority === 'high' || ticket.priority === 'urgent'}
                    />
                    {slaConfig?.enabled &&
                      (() => {
                        const state = queueSlaState(ticket)
                        if (!state) return null
                        return (
                          <CardField
                            label="SLA"
                            value={t(SLA_KEY[state])}
                            accent={state === 'breached'}
                          />
                        )
                      })()}
                    <CardField
                      label={t('queue.card.opened')}
                      value={shortDate(ticket.createdAt)}
                    />
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </>
  )
}
