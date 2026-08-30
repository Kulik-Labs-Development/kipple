import { useState, type FormEvent } from 'react'
import type { ClientSummary } from '../lib/api'
import { parseTags, TICKET_PRIORITIES } from '../lib/tickets'

export interface TicketFormValues {
  clientId: string
  subject: string
  priority: string
  tags: string[]
  body: string
}

interface TicketFormProps {
  clients: ClientSummary[]
  defaultClientId?: string
  error: string | null
  onSubmit: (values: TicketFormValues) => Promise<void>
  onClose: () => void
}

const fieldClass =
  'w-full border border-line bg-ink px-3 py-2 text-sm text-fg outline-none placeholder:text-dim focus:border-accent'
const labelClass = 'mb-1 block text-xs uppercase tracking-widest text-dim'

export function TicketForm({
  clients,
  defaultClientId,
  error,
  onSubmit,
  onClose,
}: TicketFormProps) {
  const [clientId, setClientId] = useState(defaultClientId ?? clients[0]?.id ?? '')
  const [subject, setSubject] = useState('')
  const [priority, setPriority] = useState('normal')
  const [tags, setTags] = useState('')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting || !clientId || !subject.trim()) return
    setSubmitting(true)
    try {
      await onSubmit({
        clientId,
        subject: subject.trim(),
        priority,
        tags: parseTags(tags),
        body: body.trim(),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 grid place-items-center bg-ink/80 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-lg space-y-4 border border-line bg-panel p-5"
      >
        <div className="text-xs uppercase tracking-widest text-accent">new ticket</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelClass}>client</span>
            <select
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              className={fieldClass}
            >
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>priority</span>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              className={fieldClass}
            >
              {TICKET_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className={labelClass}>subject</span>
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="short summary"
            className={fieldClass}
            autoFocus
          />
        </label>
        <label className="block">
          <span className={labelClass}>tags</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="comma, separated"
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className={labelClass}>message</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            placeholder="what is going on?"
            className={`${fieldClass} resize-y`}
          />
        </label>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-line px-3 py-1 text-xs uppercase tracking-widest text-dim hover:border-fg hover:text-fg"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !clientId || !subject.trim()}
            className="border border-accent px-3 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink disabled:opacity-40"
          >
            create
          </button>
        </div>
      </form>
    </div>
  )
}
