import { useRef, useState, type FormEvent } from 'react'
import type { SlaConfig, StaffUser, TicketDetail as TicketDetailData } from '../lib/api'
import { formatFileSize } from '../lib/format'
import { PhosphorIcon } from './PhosphorIcon'
import { RichTextEditor } from './RichTextEditor'
import { textOfHtml, toRenderable } from '../lib/rich'
import {
  formatRemainingMinutes,
  slaRemainingMinutes,
  slaStateClass,
  slaStateLabel,
  type SlaLine,
} from '../lib/sla'
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
  slaPolicyId?: string | null
}

interface TicketDetailProps {
  detail: TicketDetailData
  staff: StaffUser[]
  isStaff: boolean
  slaConfig: SlaConfig | null
  onPatch: (id: string, patch: TicketPatch) => Promise<void>
  onReply: (id: string, kind: 'public' | 'internal', body: string, files: File[]) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

const selectClass =
  'border border-line bg-ink px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const labelClass = 'text-xs uppercase tracking-widest text-dim'

function SlaChip({ line, label, businessHours }: { line: SlaLine; label: string; businessHours: SlaConfig['businessHours'] }) {
  const remaining = slaRemainingMinutes(line.dueAt, businessHours)
  const settled = line.state === 'met' || line.state === 'breached'
  return (
    <span className={`flex items-center gap-2 border px-2 py-0.5 ${slaStateClass(line.state)}`}>
      <span className="uppercase tracking-widest">{label}</span>
      <span className="text-fg/80">{slaStateLabel(line.state)}</span>
      <span className="tabular-nums text-dim">
        {settled && line.doneAt
          ? `done ${formatStamp(line.doneAt)}`
          : line.dueAt
            ? `due ${formatStamp(line.dueAt)}${
                remaining !== null ? ` · ${formatRemainingMinutes(remaining)} left` : ''
              }`
            : 'no target'}
      </span>
    </span>
  )
}

export function TicketDetail({
  detail,
  staff,
  isStaff,
  slaConfig,
  onPatch,
  onReply,
  onDelete,
}: TicketDetailProps) {
  const [body, setBody] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const [kind, setKind] = useState<'public' | 'internal'>('public')
  const [tagsDraft, setTagsDraft] = useState(detail.tags.join(', '))
  const [sending, setSending] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function commitTags() {
    const tags = parseTags(tagsDraft)
    if (tags.join(',') !== detail.tags.join(',')) {
      await onPatch(detail.id, { tags })
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = body.trim()
    if ((!textOfHtml(text) && files.length === 0) || sending) return
    setSending(true)
    try {
      await onReply(detail.id, kind, text, files)
      setBody('')
      setFiles([])
      setEditorKey((k) => k + 1)
      if (fileInputRef.current) fileInputRef.current.value = ''
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
          <span className="flex items-center gap-1 tabular-nums">
            <PhosphorIcon name="clock" size="sm" />
            opened {formatStamp(detail.createdAt)}
          </span>
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
        {isStaff && slaConfig?.enabled && (detail.slaResponseDueAt || detail.slaResolveDueAt) && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <SlaChip
              line={{
                state: detail.slaResponseState as SlaLine['state'],
                dueAt: detail.slaResponseDueAt,
                doneAt: detail.slaResponseAt,
              }}
              label="response"
              businessHours={slaConfig.businessHours}
            />
            <SlaChip
              line={{
                state: detail.slaResolveState as SlaLine['state'],
                dueAt: detail.slaResolveDueAt,
                doneAt: detail.slaResolvedAt,
              }}
              label="resolve"
              businessHours={slaConfig.businessHours}
            />
            {detail.status !== 'closed' && detail.status !== 'deleted' && (
              <label className="flex items-center gap-2">
                <span className={labelClass}>policy</span>
                <select
                  value={detail.slaPolicyId ?? ''}
                  onChange={(event) =>
                    onPatch(detail.id, { slaPolicyId: event.target.value || null })
                  }
                  className={selectClass}
                >
                  <option value="">inherited</option>
                  {slaConfig.policies.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name}
                      {policy.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {detail.updates.length === 0 ? (
          <p className="text-sm text-dim">No updates yet.</p>
        ) : (
          detail.updates.map((update) => (
            <article
              key={update.id}
              className={
                update.kind === 'internal'
                  ? 'border border-warn/60 bg-warn/5 p-3'
                  : 'border border-line bg-panel p-3'
              }
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="tabular-nums text-dim">[{formatStamp(update.createdAt)}]</span>
                <span className="uppercase text-fg">
                  {update.authorName ?? 'system'}
                </span>
                {update.kind === 'internal' ? (
                  <span className="border border-warn/60 px-1 uppercase text-warn">
                    internal note
                  </span>
                ) : (
                  <span className="text-dim">{update.kind}</span>
                )}
              </div>
              <div
                className="rich-text mt-2 text-sm text-fg"
                dangerouslySetInnerHTML={{ __html: toRenderable(update.body) }}
              />
              {update.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {update.attachments.map((attachment) => (
                    <a
                      key={attachment.id}
                      href={`/api/attachments/${attachment.id}`}
                      download
                      className="inline-flex items-center gap-1 border border-line bg-ink px-2 py-0.5 text-xs text-accent hover:border-accent"
                    >
                      <PhosphorIcon name="paperclip" size="sm" />
                      {attachment.filename} ({formatFileSize(attachment.size)})
                    </a>
                  ))}
                </div>
              )}
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
          <RichTextEditor
            key={editorKey}
            placeholder={
              isStaff && kind === 'internal'
                ? 'internal note — never emailed'
                : 'reply — sent to the client by email'
            }
            onHtmlChange={setBody}
          />
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {files.map((file, index) => (
                <span
                  key={`${file.name}-${index}`}
                  className="flex items-center gap-1 border border-line bg-ink px-2 py-0.5 text-xs text-dim transition-colors hover:text-fg"
                >
                  <PhosphorIcon name="paperclip" size="sm" />
                  <span className="max-w-52 truncate">{file.name}</span>
                  <span className="tabular-nums">{formatFileSize(file.size)}</span>
                  <button
                    type="button"
                    onClick={() => setFiles(files.filter((_, i) => i !== index))}
                    className="hover:text-danger"
                    aria-label={`remove ${file.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
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
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? [])
                  setFiles((current) => [...current, ...picked].slice(0, 10))
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-accent hover:text-accent"
              >
                <PhosphorIcon name="paperclip" size="sm" />
                attach
              </button>
              <button
                type="submit"
                disabled={sending || (!textOfHtml(body) && files.length === 0)}
                className="flex items-center gap-1.5 border border-accent px-3 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink disabled:opacity-40"
              >
                <PhosphorIcon name="paper-plane-tilt" size="sm" />
                {kind === 'internal' ? 'add note' : 'send reply'}
              </button>
            </div>
          </div>
        </form>
      </footer>
    </div>
  )
}
