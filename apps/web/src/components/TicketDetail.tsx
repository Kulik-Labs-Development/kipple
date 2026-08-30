import { useState, type FormEvent } from 'react'
import type { StaffUser, TicketDetail as TicketDetailData } from '../lib/api'
import {
  formatStamp,
  parseTags,
  priorityClass,
  statusLedClass,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '../lib/tickets'

export interface TicketPatch {
  status?: string
  priority?: string
  assignedTo?: string | null
  tags?: string[]
}

interface TicketDetailProps {
  detail: TicketDetailData
  staff: StaffUser[]
  isStaff: boolean
  onPatch: (id: string, patch: TicketPatch) => Promise<void>
  onReply: (id: string, kind: 'public' | 'internal', body: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

const selectClass =
  'border border-line bg-ink px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const labelClass = 'text-xs uppercase tracking-widest text-dim'

export function TicketDetail({
  detail,
  staff,
  isStaff,
  onPatch,
  onReply,
  onDelete,
}: TicketDetailProps) {
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<'public' | 'internal'>('public')
  const [tagsDraft, setTagsDraft] = useState(detail.tags.join(', '))
  const [sending, setSending] = useState(false)

  async function commitTags() {
    const tags = parseTags(tagsDraft)
    if (tags.join(',') !== detail.tags.join(',')) {
      await onPatch(detail.id, { tags })
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = body.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onReply(detail.id, kind, text)
      setBody('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="flex items-center gap-2 text-sm text-accent">
            <span className={`h-2.5 w-2.5 rounded-full ${statusLedClass(detail.status)}`} />
            <span className="tabular-nums">#{detail.number}</span>
          </span>
          <h1 className="truncate text-lg text-fg">{detail.subject}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-dim">
          <span>{detail.clientName ?? 'unknown client'}</span>
          {detail.alias && (
            <>
              <span>·</span>
              <span className="tabular-nums">{detail.alias}</span>
            </>
          )}
          <span>·</span>
          <span className="tabular-nums">opened {formatStamp(detail.createdAt)}</span>
          {detail.tags.map((tag) => (
            <span key={tag} className="border border-line px-1 text-dim">
              {tag}
            </span>
          ))}
          <span
            className={`ml-auto border px-1 uppercase ${priorityClass(detail.priority)}`}
          >
            {detail.priority}
          </span>
        </div>
        {isStaff && (
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <span className={labelClass}>status</span>
              <select
                value={detail.status}
                onChange={(event) => onPatch(detail.id, { status: event.target.value })}
                className={selectClass}
              >
                {TICKET_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className={labelClass}>priority</span>
              <select
                value={detail.priority}
                onChange={(event) => onPatch(detail.id, { priority: event.target.value })}
                className={selectClass}
              >
                {TICKET_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className={labelClass}>assignee</span>
              <select
                value={detail.assignedTo ?? ''}
                onChange={(event) =>
                  onPatch(detail.id, { assignedTo: event.target.value || null })
                }
                className={selectClass}
              >
                <option value="">unassigned</option>
                {staff.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className={labelClass}>tags</span>
              <input
                value={tagsDraft}
                onChange={(event) => setTagsDraft(event.target.value)}
                onBlur={commitTags}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitTags()
                  }
                }}
                placeholder="comma, separated"
                className={`${selectClass} w-40`}
              />
            </label>
          </div>
        )}
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {detail.updates.length === 0 ? (
          <p className="text-sm text-dim">No updates yet.</p>
        ) : (
          detail.updates.map((update) => (
            <article key={update.id} className="border border-line bg-panel p-3">
              <div className="flex items-center gap-2 text-xs">
                <span className="tabular-nums text-dim">[{formatStamp(update.createdAt)}]</span>
                <span className="uppercase text-fg">
                  {update.authorName ?? 'system'}
                </span>
                <span className={update.kind === 'internal' ? 'text-warn' : 'text-dim'}>
                  {update.kind}
                </span>
              </div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-fg">{update.body}</div>
            </article>
          ))
        )}
      </div>

      <footer className="space-y-2 border-t border-line p-3">
        <form onSubmit={submit} className="space-y-2">
          {isStaff && (
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <span className={labelClass}>visible</span>
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as 'public' | 'internal')}
                  className={selectClass}
                >
                  <option value="public">public reply (email)</option>
                  <option value="internal">internal note</option>
                </select>
              </label>
            </div>
          )}
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            placeholder={
              isStaff && kind === 'internal'
                ? 'internal note — never emailed'
                : 'reply — sent to the client by email'
            }
            className="w-full resize-y border border-line bg-ink px-3 py-2 text-sm text-fg outline-none placeholder:text-dim focus:border-accent"
          />
          <div className="flex items-center justify-between">
            {isStaff ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Delete this ticket? It can be recovered from the audit log.')) {
                    void onDelete(detail.id)
                  }
                }}
                className="border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger"
              >
                delete
              </button>
            ) : (
              <span />
            )}
            <button
              type="submit"
              disabled={sending || !body.trim()}
              className="border border-accent px-3 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink disabled:opacity-40"
            >
              {kind === 'internal' ? 'add note' : 'send reply'}
            </button>
          </div>
        </form>
      </footer>
    </div>
  )
}
