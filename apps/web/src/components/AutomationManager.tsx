import { useCallback, useEffect, useState } from 'react'
import {
  api,
  RULE_EVENTS,
  type ClientSummary,
  type EmailTemplate,
  type RuleAction,
  type RuleEventName,
  type RuleRow,
  type RuleTestMatch,
  type StaffUser,
} from '../lib/api'
import { TICKET_PRIORITIES, TICKET_STATUSES } from '../lib/tickets'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

const ACTION_LABELS: Record<RuleAction['type'], string> = {
  send_template: 'send template',
  assign: 'assign',
  add_tag: 'add tag(s)',
  set_status: 'set status',
  webhook: 'webhook',
}

function describeAction(action: RuleAction): string {
  switch (action.type) {
    case 'send_template':
      return `send template “${action.templateKey}”`
    case 'assign':
      return `assign → ${action.userId.slice(0, 8)}…`
    case 'add_tag':
      return `tags +${action.tags.join(' +')}`
    case 'set_status':
      return `status → ${action.status}`
    case 'webhook':
      return `webhook → ${action.url}`
  }
}

function describeMatch(match: RuleRow['match']): string {
  const parts: string[] = [match.event]
  if (match.status) parts.push(`status=${match.status}`)
  if (match.fromStatus) parts.push(`from=${match.fromStatus}`)
  if (match.priority) parts.push(`priority=${match.priority}`)
  if (match.clientId) parts.push('client')
  if (match.tags?.length) parts.push(`tags=${match.tags.join(',')}`)
  if (match.staffOnly) parts.push('staff-only')
  return parts.join(' · ')
}

// ------------------------------------------------------------- templates tab

interface TemplateDraft {
  name: string
  subject: string
  body: string
}

function TemplatesTab({
  templates,
  onTemplates,
  ticketId,
  onError,
}: {
  templates: EmailTemplate[]
  onTemplates: () => void
  ticketId: string | null
  onError: (message: string) => void
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(
    templates[0]?.key ?? null,
  )
  const [draft, setDraft] = useState<TemplateDraft | null>(null)
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newName, setNewName] = useState('')

  const selected = templates.find((t) => t.key === selectedKey) ?? null

  useEffect(() => {
    setDraft(selected ? { name: selected.name, subject: selected.subject, body: selected.body } : null)
    setPreview(null)
  }, [selectedKey, selected])

  async function save() {
    if (!selected || !draft) return
    try {
      await api.patchTemplate(selected.key, {
        name: draft.name,
        subject: draft.subject,
        body: draft.body,
      })
      onTemplates()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'template save failed')
    }
  }

  async function toggleEnabled() {
    if (!selected) return
    try {
      await api.patchTemplate(selected.key, { enabled: !selected.enabled })
      onTemplates()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'template update failed')
    }
  }

  async function remove() {
    if (!selected) return
    if (!window.confirm(`delete template “${selected.key}”?`)) return
    try {
      await api.deleteTemplate(selected.key)
      setSelectedKey(null)
      onTemplates()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'template delete failed')
    }
  }

  async function doPreview() {
    if (!selected) return
    try {
      setPreview(await api.previewTemplate(selected.key, ticketId))
    } catch (err) {
      onError(err instanceof Error ? err.message : 'preview failed')
    }
  }

  async function create() {
    const key = newKey.trim()
    if (!/^[a-z0-9][a-z0-9_]{0,59}$/.test(key)) {
      onError('template key: lowercase letters, digits, underscores')
      return
    }
    try {
      await api.createTemplate({ key, name: newName.trim() || key, subject: '', body: '' })
      setCreating(false)
      setNewKey('')
      setNewName('')
      onTemplates()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'template create failed')
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-widest text-dim">templates</h3>
          <button onClick={() => setCreating(!creating)} className={buttonClass}>
            new
          </button>
        </div>
        {creating && (
          <div className="space-y-1 border border-line bg-panel p-2">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key (e.g. ticket_new)"
              className={`${inputClass} w-full`}
            />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="display name"
              className={`${inputClass} w-full`}
            />
            <button onClick={() => void create()} className={buttonClass}>
              create
            </button>
          </div>
        )}
        {templates.map((template) => (
          <button
            key={template.key}
            onClick={() => setSelectedKey(template.key)}
            className={`block w-full border px-2 py-1.5 text-left text-xs ${
              template.key === selectedKey
                ? 'border-accent text-accent'
                : 'border-line text-dim hover:border-accent hover:text-fg'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{template.key}</span>
              {template.enabled ? (
                <span className="shrink-0 text-ok">on</span>
              ) : (
                <span className="shrink-0">off</span>
              )}
            </div>
            <div className="truncate text-dim">{template.name}</div>
          </button>
        ))}
        {templates.length === 0 && (
          <p className="text-xs text-dim">no templates — create one</p>
        )}
      </div>

      <div className="space-y-3">
        {selected && draft ? (
          <>
            <div className="flex items-center gap-2">
              <button onClick={() => void toggleEnabled()} className={buttonClass}>
                {selected.enabled ? 'disable' : 'enable'}
              </button>
              <button onClick={() => void doPreview()} className={buttonClass}>
                preview{ticketId ? '' : ' (blank)'}
              </button>
              <button onClick={() => void remove()} className={dimButtonClass}>
                delete
              </button>
            </div>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="display name"
              className={`${inputClass} w-full`}
            />
            <input
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="subject — {{ticket.number}}, {{client.name}}, …"
              className={`${inputClass} w-full`}
            />
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="body — {{body}}, {{agent.name}}, …"
              rows={12}
              className={`${inputClass} w-full font-mono`}
            />
            <button onClick={() => void save()} className={buttonClass}>
              save
            </button>
            {preview && (
              <div className="space-y-2 border border-line bg-panel p-3">
                <div className="text-xs uppercase tracking-widest text-dim">
                  rendered{ticketId ? ' against the selected ticket' : ' with no ticket'}
                </div>
                <div className="text-xs text-fg">
                  <span className="text-dim">subject: </span>
                  {preview.subject}
                </div>
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs text-fg">
                  {preview.body}
                </pre>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-dim">select a template to edit</p>
        )}
      </div>
    </div>
  )
}

// --------------------------------------------------------------- rules tab

interface RuleDraft {
  name: string
  enabled: boolean
  event: RuleEventName
  status: string
  fromStatus: string
  priority: string
  clientId: string
  tags: string
  staffOnly: boolean
  actionType: RuleAction['type']
  templateKey: string
  userId: string
  actionTags: string
  actionStatus: string
  webhookUrl: string
  webhookSecret: string
}

function emptyRuleDraft(templateKey: string): RuleDraft {
  return {
    name: '',
    enabled: false,
    event: 'ticket.created',
    status: '',
    fromStatus: '',
    priority: '',
    clientId: '',
    tags: '',
    staffOnly: false,
    actionType: 'send_template',
    templateKey,
    userId: '',
    actionTags: '',
    actionStatus: 'closed',
    webhookUrl: '',
    webhookSecret: '',
  }
}

function ruleToDraft(rule: RuleRow): RuleDraft {
  const action = rule.action
  return {
    name: rule.name,
    enabled: rule.enabled,
    event: rule.match.event,
    status: rule.match.status ?? '',
    fromStatus: rule.match.fromStatus ?? '',
    priority: rule.match.priority ?? '',
    clientId: rule.match.clientId ?? '',
    tags: (rule.match.tags ?? []).join(', '),
    staffOnly: rule.match.staffOnly ?? false,
    actionType: action.type,
    templateKey: action.type === 'send_template' ? action.templateKey : '',
    userId: action.type === 'assign' ? action.userId : '',
    actionTags: action.type === 'add_tag' ? action.tags.join(', ') : '',
    actionStatus: action.type === 'set_status' ? action.status : 'closed',
    webhookUrl: action.type === 'webhook' ? action.url : '',
    webhookSecret: action.type === 'webhook' ? (action.secret ?? '') : '',
  }
}

function draftToInput(draft: RuleDraft): {
  name: string
  enabled: boolean
  match: RuleRow['match']
  action: RuleAction
} {
  const tags = draft.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const match: RuleRow['match'] = { event: draft.event }
  if (draft.status) match.status = draft.status
  if (draft.event === 'ticket.status_changed' && draft.fromStatus) {
    match.fromStatus = draft.fromStatus
  }
  if (draft.priority) match.priority = draft.priority
  if (draft.clientId) match.clientId = draft.clientId
  if (tags.length) match.tags = tags
  if (draft.staffOnly) match.staffOnly = true
  let action: RuleAction
  switch (draft.actionType) {
    case 'send_template':
      action = { type: 'send_template', templateKey: draft.templateKey }
      break
    case 'assign':
      action = { type: 'assign', userId: draft.userId }
      break
    case 'add_tag':
      action = {
        type: 'add_tag',
        tags: draft.actionTags.split(',').map((t) => t.trim()).filter(Boolean),
      }
      break
    case 'set_status':
      action = { type: 'set_status', status: draft.actionStatus }
      break
    case 'webhook':
      action = {
        type: 'webhook',
        url: draft.webhookUrl,
        ...(draft.webhookSecret ? { secret: draft.webhookSecret } : {}),
      }
      break
  }
  return { name: draft.name, enabled: draft.enabled, match, action }
}

function RulesTab({
  rules,
  onRules,
  templates,
  staff,
  clients,
  ticketId,
  onTicketId,
  onError,
}: {
  rules: RuleRow[]
  onRules: () => void
  templates: EmailTemplate[]
  staff: StaffUser[]
  clients: ClientSummary[]
  ticketId: string | null
  onTicketId: (id: string | null) => void
  onError: (message: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [testEvent, setTestEvent] = useState<RuleEventName>('ticket.created')
  const [testTicket, setTestTicket] = useState('')
  const [testResult, setTestResult] = useState<RuleTestMatch[] | null>(null)

  const editing = rules.find((r) => r.id === editingId) ?? null
  useEffect(() => {
    setDraft(editing ? ruleToDraft(editing) : null)
  }, [editingId, editing])

  async function toggleEnabled(rule: RuleRow) {
    try {
      await api.patchRule(rule.id, { enabled: !rule.enabled })
      onRules()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'rule update failed')
    }
  }

  async function remove(rule: RuleRow) {
    if (!window.confirm(`delete rule “${rule.name}”?`)) return
    try {
      await api.deleteRule(rule.id)
      if (editingId === rule.id) setEditingId(null)
      onRules()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'rule delete failed')
    }
  }

  async function save() {
    if (!draft) return
    const input = draftToInput(draft)
    if (!input.name.trim()) {
      onError('rule name is required')
      return
    }
    if (input.action.type === 'send_template' && !input.action.templateKey) {
      onError('pick a template to send')
      return
    }
    if (input.action.type === 'assign' && !input.action.userId) {
      onError('pick an agent to assign')
      return
    }
    if (input.action.type === 'add_tag' && input.action.tags.length === 0) {
      onError('add at least one tag')
      return
    }
    if (input.action.type === 'webhook' && !/^https?:\/\//.test(input.action.url)) {
      onError('webhook url must be http(s)')
      return
    }
    try {
      if (editing) {
        await api.patchRule(editing.id, input)
      } else {
        await api.createRule(input)
      }
      setEditingId(null)
      setDraft(null)
      onRules()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'rule save failed')
    }
  }

  async function runTest() {
    const id = testTicket.trim()
    if (!id) {
      onError('set the ticket id for the test (use the ticket id field in the detail header)')
      return
    }
    try {
      const res = await api.testRules({ ticketId: id, event: testEvent })
      setTestResult(res.matches)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'test failed')
    }
  }

  const set = (patch: Partial<RuleDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-widest text-dim">
          rules — disabled until enabled
        </h3>
        <button
          onClick={() => {
            setEditingId(null)
            setDraft(emptyRuleDraft(templates[0]?.key ?? ''))
          }}
          className={buttonClass}
        >
          new rule
        </button>
      </div>

      <div className="space-y-2">
        {rules.map((rule) => (
          <div
            key={rule.id}
            className={`border px-3 py-2 text-xs ${
              rule.id === editingId ? 'border-accent' : 'border-line'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className={rule.enabled ? 'text-fg' : 'text-dim'}>{rule.name}</span>{' '}
                <span className="text-dim">— {describeMatch(rule.match)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setEditingId(rule.id)}
                  className="border border-line px-2 py-0.5 text-dim hover:border-accent hover:text-fg"
                >
                  edit
                </button>
                <button
                  onClick={() => void toggleEnabled(rule)}
                  className={`border px-2 py-0.5 ${
                    rule.enabled ? 'border-ok text-ok' : 'border-line text-dim'
                  }`}
                >
                  {rule.enabled ? 'on' : 'off'}
                </button>
                <button
                  onClick={() => void remove(rule)}
                  className="border border-line px-2 py-0.5 text-dim hover:border-danger hover:text-danger"
                >
                  del
                </button>
              </div>
            </div>
            <div className="mt-1 text-dim">→ {describeAction(rule.action)}</div>
          </div>
        ))}
        {rules.length === 0 && (
          <p className="text-xs text-dim">no rules yet — nothing will ever fire</p>
        )}
      </div>

      {draft && (
        <div className="space-y-3 border border-accent p-3">
          <div className="grid gap-2 md:grid-cols-2">
            <input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="rule name"
              className={inputClass}
            />
            <div className="flex items-center gap-3">
              <select
                value={draft.event}
                onChange={(e) => set({ event: e.target.value as RuleEventName })}
                className={inputClass}
              >
                {RULE_EVENTS.map((event) => (
                  <option key={event} value={event}>
                    {event}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-dim">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => set({ enabled: e.target.checked })}
                />
                enabled
              </label>
            </div>
            <select
              value={draft.status}
              onChange={(e) => set({ status: e.target.value })}
              className={inputClass}
            >
              <option value="">status: any</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  status: {s}
                </option>
              ))}
            </select>
            {draft.event === 'ticket.status_changed' && (
              <select
                value={draft.fromStatus}
                onChange={(e) => set({ fromStatus: e.target.value })}
                className={inputClass}
              >
                <option value="">from status: any</option>
                {TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    from: {s}
                  </option>
                ))}
              </select>
            )}
            <select
              value={draft.priority}
              onChange={(e) => set({ priority: e.target.value })}
              className={inputClass}
            >
              <option value="">priority: any</option>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  priority: {p}
                </option>
              ))}
            </select>
            <select
              value={draft.clientId}
              onChange={(e) => set({ clientId: e.target.value })}
              className={inputClass}
            >
              <option value="">client: any</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  client: {client.name}
                </option>
              ))}
            </select>
            <input
              value={draft.tags}
              onChange={(e) => set({ tags: e.target.value })}
              placeholder="tags (comma-separated, all must match)"
              className={inputClass}
            />
            <label className="flex items-center gap-1 text-xs text-dim">
              <input
                type="checkbox"
                checked={draft.staffOnly}
                onChange={(e) => set({ staffOnly: e.target.checked })}
              />
              staff-only (event actor must be staff)
            </label>
          </div>

          <div className="space-y-2 border-t border-line pt-2">
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-widest text-dim">action</span>
              <select
                value={draft.actionType}
                onChange={(e) => set({ actionType: e.target.value as RuleAction['type'] })}
                className={inputClass}
              >
                {(Object.keys(ACTION_LABELS) as RuleAction['type'][]).map((type) => (
                  <option key={type} value={type}>
                    {ACTION_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {draft.actionType === 'send_template' && (
                <select
                  value={draft.templateKey}
                  onChange={(e) => set({ templateKey: e.target.value })}
                  className={inputClass}
                >
                  <option value="">template…</option>
                  {templates.map((template) => (
                    <option key={template.key} value={template.key}>
                      {template.key}
                      {template.enabled ? '' : ' (disabled)'}
                    </option>
                  ))}
                </select>
              )}
              {draft.actionType === 'assign' && (
                <select
                  value={draft.userId}
                  onChange={(e) => set({ userId: e.target.value })}
                  className={inputClass}
                >
                  <option value="">agent…</option>
                  {staff.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} ({member.role})
                    </option>
                  ))}
                </select>
              )}
              {draft.actionType === 'add_tag' && (
                <input
                  value={draft.actionTags}
                  onChange={(e) => set({ actionTags: e.target.value })}
                  placeholder="tags to add (comma-separated)"
                  className={inputClass}
                />
              )}
              {draft.actionType === 'set_status' && (
                <select
                  value={draft.actionStatus}
                  onChange={(e) => set({ actionStatus: e.target.value })}
                  className={inputClass}
                >
                  {TICKET_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
              {draft.actionType === 'webhook' && (
                <>
                  <input
                    value={draft.webhookUrl}
                    onChange={(e) => set({ webhookUrl: e.target.value })}
                    placeholder="https://example.com/hook"
                    className={inputClass}
                  />
                  <input
                    value={draft.webhookSecret}
                    onChange={(e) => set({ webhookSecret: e.target.value })}
                    placeholder="HMAC secret (optional, min 8 chars)"
                    className={inputClass}
                  />
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => void save()} className={buttonClass}>
              {editing ? 'save rule' : 'create rule'}
            </button>
            <button
              onClick={() => {
                setEditingId(null)
                setDraft(null)
              }}
              className={dimButtonClass}
            >
              cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        <div className="text-xs uppercase tracking-widest text-dim">test — what would fire</div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={testEvent}
            onChange={(e) => setTestEvent(e.target.value as RuleEventName)}
            className={inputClass}
          >
            {RULE_EVENTS.map((event) => (
              <option key={event} value={event}>
                {event}
              </option>
            ))}
          </select>
          <input
            value={testTicket}
            onChange={(e) => setTestTicket(e.target.value)}
            placeholder="ticket id (or use the one selected in the queue)"
            className={`${inputClass} w-72`}
          />
          <button
            onClick={() => {
              onTicketId(ticketId)
              if (ticketId) setTestTicket(ticketId)
            }}
            className={buttonClass}
          >
            use selected
          </button>
          <button onClick={() => void runTest()} className={buttonClass}>
            run test (dry run)
          </button>
        </div>
        {testResult && (
          <div className="space-y-1 border border-line bg-panel p-2 text-xs">
            {testResult.length === 0 && (
              <p className="text-dim">no rules would fire for this ticket + event</p>
            )}
            {testResult.map((match) => (
              <div key={match.ruleId} className="flex items-center justify-between gap-2">
                <span>
                  {match.name} — {describeMatch(match.match)} → {describeAction(match.action)}
                </span>
                <span className={match.enabled ? 'text-ok' : 'text-warn'}>
                  {match.enabled ? 'would fire' : 'would fire if enabled'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------- shell

export function AutomationManager({
  clients,
  staff,
  ticketId,
  onTicketId,
  onClose,
  onChanged,
}: {
  clients: ClientSummary[]
  staff: StaffUser[]
  ticketId: string | null
  onTicketId: (id: string | null) => void
  onClose: () => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState<'templates' | 'rules'>('templates')
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [rules, setRules] = useState<RuleRow[]>([])
  const [error, setError] = useState<string | null>(null)

  const refreshAll = useCallback(async () => {
    try {
      const [templateRows, ruleRows] = await Promise.all([api.listTemplates(), api.listRules()])
      setTemplates(templateRows)
      setRules(ruleRows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load automation config')
    }
  }, [])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  function fail(message: string) {
    setError(message)
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="max-h-full w-full max-w-3xl overflow-y-auto border border-line bg-ink"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-4 text-sm tracking-widest text-accent">
            AUTOMATION
            <nav className="flex items-center gap-1 text-xs">
              <button
                onClick={() => setTab('templates')}
                className={`border px-2 py-1 uppercase tracking-widest ${
                  tab === 'templates' ? 'border-accent text-accent' : 'border-line text-dim'
                }`}
              >
                templates
              </button>
              <button
                onClick={() => setTab('rules')}
                className={`border px-2 py-1 uppercase tracking-widest ${
                  tab === 'rules' ? 'border-accent text-accent' : 'border-line text-dim'
                }`}
              >
                rules
              </button>
            </nav>
          </div>
          <button onClick={onClose} className={dimButtonClass}>
            close
          </button>
        </header>

        <div className="space-y-4 p-4">
          {error && (
            <div className="border border-danger px-3 py-2 text-xs text-danger">{error}</div>
          )}
          {tab === 'templates' ? (
            <TemplatesTab
              templates={templates}
              onTemplates={() => {
                void refreshAll()
                onChanged()
              }}
              ticketId={ticketId}
              onError={fail}
            />
          ) : (
            <RulesTab
              rules={rules}
              onRules={() => {
                void refreshAll()
                onChanged()
              }}
              templates={templates}
              staff={staff}
              clients={clients}
              ticketId={ticketId}
              onTicketId={onTicketId}
              onError={fail}
            />
          )}
        </div>
      </div>
    </div>
  )
}
