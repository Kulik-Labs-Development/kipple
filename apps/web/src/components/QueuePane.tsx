import type { RefObject } from 'react'
import type { SlaConfig, TicketRow } from '../lib/api'
import { queueSlaState, slaStateClass, slaStateLabel } from '../lib/sla'
import {
  priorityClass,
  relativeTime,
  statusLedClass,
  TICKET_STATUSES,
  type StatusFilter,
} from '../lib/tickets'

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
  onStatusFilter: (filter: StatusFilter) => void
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
  onStatusFilter,
  onSearch,
  onSelect,
  onNewTicket,
}: QueuePaneProps) {
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
            {filter} <span className="tabular-nums">{counts[filter] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="flex gap-2 border-b border-line p-2">
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="search subject…  ( / )"
          className="w-full border border-line bg-ink px-2 py-1 text-xs text-fg outline-none placeholder:text-dim focus:border-accent"
        />
        {canCreate && (
          <button
            onClick={onNewTicket}
            className="shrink-0 border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink"
          >
            + new
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tickets.length === 0 ? (
          <div className="p-6 text-center">
            <div className="text-xs uppercase tracking-widest text-dim">queue</div>
            <p className="mt-2 text-sm text-fg">No tickets. The board is clean.</p>
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
                  {clientNames.get(ticket.clientId) ?? 'unknown client'}
                </span>
                <span className="shrink-0">·</span>
                <span
                  className={`shrink-0 border px-1 uppercase ${priorityClass(ticket.priority)}`}
                >
                  {ticket.priority}
                </span>
                {slaConfig?.enabled &&
                  (() => {
                    const state = queueSlaState(ticket)
                    if (!state) return null
                    return (
                      <span
                        className={`shrink-0 border px-1 uppercase ${slaStateClass(state)}`}
                        title={`SLA ${slaStateLabel(state)}`}
                      >
                        sla {slaStateLabel(state)}
                      </span>
                    )
                  })()}
                <span className="ml-auto shrink-0 tabular-nums">
                  {relativeTime(ticket.updatedAt)}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </aside>
  )
}
