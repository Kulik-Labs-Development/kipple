import { useState } from 'react'
import { api, type SlaConfig, type SlaPolicy } from '../lib/api'

const DAYS = [
  { day: 1, label: 'mon' },
  { day: 2, label: 'tue' },
  { day: 3, label: 'wed' },
  { day: 4, label: 'thu' },
  { day: 5, label: 'fri' },
  { day: 6, label: 'sat' },
  { day: 7, label: 'sun' },
] as const

const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

interface DayDraft {
  start: string
  end: string
}

function configToDrafts(config: SlaConfig): { timezone: string; days: Record<number, DayDraft> } {
  const days: Record<number, DayDraft> = {}
  for (const { day } of DAYS) days[day] = { start: '', end: '' }
  for (const window of config.businessHours.windows) {
    days[window.day] = { start: window.start, end: window.end }
  }
  return { timezone: config.businessHours.timezone, days }
}

export function SlaManager({
  config,
  onChanged,
  onClose,
}: {
  config: SlaConfig
  onChanged: () => void
  onClose: () => void
}) {
  const [enabled, setEnabled] = useState(config.enabled)
  const [hours, setHours] = useState(() => configToDrafts(config))
  // policies come straight from the config prop: every mutation triggers the
  // parent to refetch, so the list is always fresh
  const policies = config.policies
  const [draftName, setDraftName] = useState('')
  const [draftTargets, setDraftTargets] = useState<Record<string, string>>(() => {
    const base: Record<string, string> = {}
    for (const priority of PRIORITIES) {
      base[`response-${priority}`] = '120'
      base[`resolve-${priority}`] = '480'
    }
    return base
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function run(action: () => Promise<void>) {
    setError(null)
    setSaving(true)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SLA save failed')
    } finally {
      setSaving(false)
    }
  }

  function toggleEnabled() {
    const next = !enabled
    setEnabled(next)
    void run(async () => {
      await api.slaSetEnabled(next)
    })
  }

  function saveBusinessHours() {
    const windows = DAYS.flatMap(({ day, label }) => {
      const draft = hours.days[day]
      if (!draft.start || !draft.end) return []
      if (draft.start >= draft.end) throw new Error(`${label}: start must be before end`)
      return [{ day, start: draft.start, end: draft.end }]
    })
    if (windows.length === 0) {
      setError('at least one business day is required')
      return
    }
    void run(async () => {
      await api.slaSetBusinessHours({ timezone: hours.timezone.trim() || 'UTC', windows })
    })
  }

  function createPolicy() {
    const name = draftName.trim()
    if (!name) {
      setError('policy name is required')
      return
    }
    const targets = {
      responseMinutes: {} as Record<(typeof PRIORITIES)[number], number>,
      resolveMinutes: {} as Record<(typeof PRIORITIES)[number], number>,
    }
    for (const priority of PRIORITIES) {
      const response = Number(draftTargets[`response-${priority}`])
      const resolve = Number(draftTargets[`resolve-${priority}`])
      if (!Number.isInteger(response) || response < 5) throw new Error(`response (${priority}) must be >= 5 minutes`)
      if (!Number.isInteger(resolve) || resolve < 5) throw new Error(`resolve (${priority}) must be >= 5 minutes`)
      targets.responseMinutes[priority] = response
      targets.resolveMinutes[priority] = resolve
    }
    void run(async () => {
      await api.slaCreatePolicy({ name, targets })
      setDraftName('')
    })
  }

  function setDefault(policy: SlaPolicy) {
    if (policy.isDefault) return
    void run(async () => {
      await api.slaPatchPolicy(policy.id, { isDefault: true })
    })
  }

  function removePolicy(policy: SlaPolicy) {
    if (!window.confirm(`Delete policy "${policy.name}"?`)) return
    void run(async () => {
      await api.slaDeletePolicy(policy.id)
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="max-h-full w-full max-w-2xl overflow-y-auto border border-line bg-ink"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm tracking-widest text-accent">SLA</div>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleEnabled}
              disabled={saving}
              className={`border px-3 py-1 text-xs uppercase tracking-widest ${
                enabled ? 'border-ok text-ok' : 'border-line text-dim'
              }`}
            >
              {enabled ? 'enabled' : 'disabled'}
            </button>
            <button onClick={onClose} className={dimButtonClass}>
              close
            </button>
          </div>
        </header>

        <div className="space-y-5 p-4">
          {error && (
            <div className="border border-danger px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs uppercase tracking-widest text-dim">business hours</h2>
              <label className="flex items-center gap-2 text-xs text-dim">
                timezone
                <input
                  value={hours.timezone}
                  onChange={(event) => setHours({ ...hours, timezone: event.target.value })}
                  className={inputClass}
                  placeholder="Europe/Berlin"
                />
              </label>
            </div>
            <div className="space-y-1">
              {DAYS.map(({ day, label }) => (
                <div key={day} className="flex items-center gap-2 text-xs">
                  <span className="w-8 text-dim">{label}</span>
                  <input
                    type="time"
                    value={hours.days[day].start}
                    onChange={(event) =>
                      setHours({
                        ...hours,
                        days: {
                          ...hours.days,
                          [day]: { ...hours.days[day], start: event.target.value },
                        },
                      })
                    }
                    className={inputClass}
                  />
                  <span className="text-dim">→</span>
                  <input
                    type="time"
                    value={hours.days[day].end}
                    onChange={(event) =>
                      setHours({
                        ...hours,
                        days: {
                          ...hours.days,
                          [day]: { ...hours.days[day], end: event.target.value },
                        },
                      })
                    }
                    className={inputClass}
                  />
                </div>
              ))}
            </div>
            <button onClick={saveBusinessHours} disabled={saving} className={buttonClass}>
              save business hours
            </button>
          </section>

          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-widest text-dim">
              policies ({policies.length})
            </h2>
            {policies.length === 0 ? (
              <p className="text-xs text-dim">
                No policies yet. SLA stays off until a default policy exists.
              </p>
            ) : (
              <ul className="space-y-1">
                {policies.map((policy) => (
                  <li
                    key={policy.id}
                    className="flex items-center gap-3 border border-line px-2 py-1 text-xs"
                  >
                    <button
                      onClick={() => setDefault(policy)}
                      disabled={policy.isDefault || saving}
                      title={policy.isDefault ? 'default policy' : 'make default'}
                      className={`h-3 w-3 rounded-full border ${
                        policy.isDefault ? 'border-accent bg-accent' : 'border-line'
                      }`}
                    />
                    <span className="text-fg">
                      {policy.name}
                      {policy.isDefault && <span className="ml-1 text-dim">(default)</span>}
                    </span>
                    <span className="ml-auto tabular-nums text-dim">
                      {PRIORITIES.map(
                        (priority) =>
                          `${priority.slice(0, 1)} ${policy.targets.responseMinutes[priority]}/${policy.targets.resolveMinutes[priority]}`,
                      ).join(' · ')}
                    </span>
                    <button onClick={() => removePolicy(policy)} disabled={saving} className={dimButtonClass}>
                      del
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-widest text-dim">new policy</h2>
            <div className="flex items-center gap-2">
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="name"
                className={`${inputClass} w-48`}
              />
              <span className="text-xs text-dim">targets (business minutes, response/resolve)</span>
            </div>
            <div className="grid grid-cols-5 gap-1 text-xs">
              <span />
              {PRIORITIES.map((priority) => (
                <span key={priority} className="text-center uppercase text-dim">
                  {priority}
                </span>
              ))}
              <span className="text-dim">response</span>
              {PRIORITIES.map((priority) => (
                <input
                  key={`response-${priority}`}
                  value={draftTargets[`response-${priority}`]}
                  onChange={(event) =>
                    setDraftTargets({
                      ...draftTargets,
                      [`response-${priority}`]: event.target.value,
                    })
                  }
                  className={`${inputClass} tabular-nums`}
                />
              ))}
              <span className="text-dim">resolve</span>
              {PRIORITIES.map((priority) => (
                <input
                  key={`resolve-${priority}`}
                  value={draftTargets[`resolve-${priority}`]}
                  onChange={(event) =>
                    setDraftTargets({
                      ...draftTargets,
                      [`resolve-${priority}`]: event.target.value,
                    })
                  }
                  className={`${inputClass} tabular-nums`}
                />
              ))}
            </div>
            <button onClick={createPolicy} disabled={saving} className={buttonClass}>
              add policy
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
