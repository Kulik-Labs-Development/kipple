import type { RefObject } from 'react'
import type { SlaConfig, TicketRow } from '../lib/api'
import { PhosphorIcon } from './PhosphorIcon'
import { queueSlaState, slaStateClass } from '../lib/sla'
import { STATUS_KEY, useI18n, type I18nKey } from '../lib/i18n'
import {
  formatStamp,
  priorityClass,
  relativeTime,
  shortDate,
  statusLedClass,
  TICKET_STATUSES,
  type StatusFilter,
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

interface QueuePaneProps {
  tickets: TicketRow[]
  counts: Record<string, number>
  clientNames: Map<string, string>
  selectedId: string | null
  statusFilter: StatusFilter
  search: string
  canCreate: boolean
  slaConfig: SlaConfig | null
  searchRef: RefObject<HTMLInputElement | null>
  clientFilter: string
  onStatusFilter: (filter: StatusFilter) => void
  onClientFilter: (value: string) => void
  onSearch: (value: string) => void
  onSelect: (id: string) => void
  onNewTicket: () => void
}

const FILTERS: StatusFilter[] = ['all', ...TICKET_STATUSES]

export function QueuePane({
  tickets,
  counts,
  clientNames,
  selectedId,
  statusFilter,
  search,
  canCreate,
  slaConfig,
  searchRef,
  clientFilter,
  onStatusFilter,
  onClientFilter,
  onSearch,
  onSelect,
  onNewTicket,
}: QueuePaneProps) {
  const { t } = useI18n()
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-r border-line">
      <div className="flex flex-wrap gap-1 border-b border-line p-2">
        {FILTERS.map((filter) => (
          <button
            key={filter}
            onClick={() => onStatusFilter(filter)}
            className={`border px-2 py-1 text-xs uppercase tracking-widest ${
              statusFilter === filter
                ? 'border-accent text-accent'
                : 'border-line text-dim hover:border-fg hover:text-fg'
            }`}
          >
            {t(STATUS_KEY[filter])} <span className="tabular-nums">{counts[filter] ?? 0}</span>
          </button>
        ))}
      </div>

      {clientNames.size > 1 && (
        <div className="border-b border-line p-2">
          <select
            value={clientFilter}
            onChange={(event) => onClientFilter(event.target.value)}
            className="w-full border border-line bg-ink px-2 py-1 text-xs text-fg outline-none focus:border-accent"
            aria-label={t('queue.aria.clientFilter')}
          >
            <option value="all">{t('queue.allClients')}</option>
            {[...clientNames.entries()]
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        </div>
      )}

      <div className="flex gap-2 border-b border-line p-2">
        <div className="relative min-w-0 flex-1">
          <PhosphorIcon
            name="magnifying-glass"
            size="sm"
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dim"
          />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={t('queue.searchPlaceholder')}
            className="w-full border border-line bg-ink py-1 pl-7 pr-2 text-xs text-fg outline-none placeholder:text-dim focus:border-accent"
          />
        </div>
        {canCreate && (
          <button
            onClick={onNewTicket}
            className="flex shrink-0 items-center gap-1 border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink"
          >
            <PhosphorIcon name="plus" size="sm" />
            {t('queue.new')}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tickets.length === 0 ? (
          <div className="p-6 text-center">
            <div className="text-xs uppercase tracking-widest text-dim">{t('queue.emptyHeading')}</div>
            <p className="mt-2 text-sm text-fg">{t('queue.empty')}</p>
          </div>
        ) : (
          tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={() => onSelect(ticket.id)}
              className={`block w-full border-b border-line px-3 py-2 text-left hover:bg-panel ${
                selectedId === ticket.id ? 'bg-panel' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${statusLedClass(ticket.status)}`}
                />
                <span className="shrink-0 text-xs tabular-nums text-dim">
                  #{ticket.number}
                </span>
                <span className="truncate text-sm text-fg">{ticket.subject}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 pl-4 text-xs text-dim">
                <span className="truncate">
                  {clientNames.get(ticket.clientId) ?? t('queue.unknownClient')}
                </span>
                <span className="shrink-0">·</span>
                <span
                  className={`shrink-0 border px-1 uppercase ${priorityClass(ticket.priority)}`}
                >
                  {ticket.priority in PRIORITY_KEY ? t(PRIORITY_KEY[ticket.priority]) : ticket.priority}
                </span>
                {slaConfig?.enabled &&
                  (() => {
                    const state = queueSlaState(ticket)
                    if (!state) return null
                    return (
                      <span
                        className={`shrink-0 border px-1 uppercase ${slaStateClass(state)}`}
                        title={t('queue.sla.title', { state: t(SLA_KEY[state]) })}
                      >
                        {t('queue.sla.label', { state: t(SLA_KEY[state]) })}
                      </span>
                    )
                  })()}
                <span
                  className="ml-auto flex shrink-0 items-center gap-1 tabular-nums"
                  title={t('queue.row.openedTitle', { at: formatStamp(ticket.createdAt) })}
                >
                  <PhosphorIcon name="calendar" size="xs" />
                  {shortDate(ticket.createdAt)} · {relativeTime(ticket.updatedAt)}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </aside>
  )
}
