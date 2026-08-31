import { useCallback, useEffect, useState } from 'react'
import { Field } from '../components/Field'
import { api, type TimeEntryRow } from '../lib/api'
import { formatStamp, formatDuration } from '../lib/tickets'

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function TimePanel({
  ticketId,
  onChanged,
}: {
  ticketId: string
  onChanged?: () => void
}) {
  const [entries, setEntries] = useState<TimeEntryRow[]>([])
  const [running, setRunning] = useState<TimeEntryRow | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [showManual, setShowManual] = useState(false)
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().slice(0, 16))
  const [manualMinutes, setManualMinutes] = useState('30')
  const [manualBillable, setManualBillable] = useState(true)
  const [manualNote, setManualNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [rows, active] = await Promise.all([
        api.listTime({ ticketId, completed: true }),
        api.activeTime(),
      ])
      setEntries(rows)
      setRunning(active.entry && active.entry.ticketId === ticketId ? active.entry : null)
    } catch {
      // listing is best-effort; the ticket view still works
    }
  }, [ticketId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const totalS = entries.reduce((sum, entry) => sum + (entry.durationS ?? 0), 0)
  const billableS = entries
    .filter((entry) => entry.billable)
    .reduce((sum, entry) => sum + (entry.durationS ?? 0), 0)

  async function start() {
    setBusy(true)
    setError(null)
    try {
      setRunning(await api.startTime({ ticketId }))
    } catch (err) {
      setError(errorMessage(err, 'failed to start timer'))
      if (err instanceof Error && err.message.includes('already running')) {
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    setError(null)
    try {
      await api.stopTime()
      setRunning(null)
      await refresh()
      onChanged?.()
    } catch (err) {
      setError(errorMessage(err, 'failed to stop timer'))
    } finally {
      setBusy(false)
    }
  }

  async function toggleBillable(entry: TimeEntryRow) {
    try {
      await api.patchTime(entry.id, { billable: !entry.billable })
      await refresh()
    } catch (err) {
      setError(errorMessage(err, 'failed to update entry'))
    }
  }

  async function remove(entry: TimeEntryRow) {
    setError(null)
    try {
      await api.deleteTime(entry.id)
      await refresh()
      onChanged?.()
    } catch (err) {
      setError(errorMessage(err, 'failed to delete entry'))
    }
  }

  async function addManual(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const minutes = Number(manualMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setError('enter a duration in minutes')
      setBusy(false)
      return
    }
    try {
      await api.addTimeEntry({
        ticketId,
        startedAt: new Date(manualDate).toISOString(),
        durationS: Math.round(minutes * 60),
        billable: manualBillable,
        note: manualNote,
      })
      setShowManual(false)
      setManualNote('')
      setManualMinutes('30')
      await refresh()
      onChanged?.()
    } catch (err) {
      setError(errorMessage(err, 'failed to add entry'))
    } finally {
      setBusy(false)
    }
  }

  const runningSeconds = running
    ? Math.max(0, Math.floor((now - new Date(running.startedAt).getTime()) / 1000))
    : 0

  return (
    <div className="border-t border-line">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-xs uppercase tracking-widest text-dim">
          time · <span className="text-fg">{formatDuration(totalS)}</span>
          <span className="text-dim">
            {' '}
            ({formatDuration(billableS)} billable)
          </span>
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowManual((value) => !value)}
            className="border border-line px-2 py-0.5 text-xs text-dim hover:border-accent hover:text-accent"
          >
            + manual
          </button>
          {running ? (
            <button
              onClick={stop}
              disabled={busy}
              className="border border-danger bg-danger/10 px-3 py-0.5 text-xs tracking-widest text-danger disabled:opacity-50"
            >
              STOP · {formatDuration(runningSeconds)}
            </button>
          ) : (
            <button
              onClick={start}
              disabled={busy}
              className="border border-ok bg-ok/10 px-3 py-0.5 text-xs tracking-widest text-ok disabled:opacity-50"
            >
              START TIMER
            </button>
          )}
        </div>
      </div>

      {error && <p className="px-4 pb-2 text-xs text-danger">{error}</p>}

      {showManual && (
        <form onSubmit={addManual} className="grid grid-cols-2 gap-3 border-t border-line px-4 py-3">
          <Field
            label="started"
            type="datetime-local"
            value={manualDate}
            onChange={(e) => setManualDate(e.target.value)}
            required
          />
          <Field
            label="minutes"
            type="number"
            min="1"
            value={manualMinutes}
            onChange={(e) => setManualMinutes(e.target.value)}
            required
          />
          <Field
            label="note"
            value={manualNote}
            onChange={(e) => setManualNote(e.target.value)}
            placeholder="what was the time spent on?"
          />
          <div className="flex items-end justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-dim">
              <input
                type="checkbox"
                checked={manualBillable}
                onChange={(e) => setManualBillable(e.target.checked)}
              />
              billable
            </label>
            <button
              type="submit"
              disabled={busy}
              className="border border-accent bg-accent/10 px-3 py-1.5 text-xs text-accent disabled:opacity-50"
            >
              add entry
            </button>
          </div>
        </form>
      )}

      {entries.length > 0 && (
        <div className="max-h-48 overflow-y-auto border-t border-line">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-3 border-b border-line px-4 py-1.5 text-xs"
            >
              <span className="w-20 shrink-0 text-dim">{formatDuration(entry.durationS ?? 0)}</span>
              <span className="min-w-0 flex-1 truncate text-fg">
                {entry.note || entry.agentName || 'time entry'}
              </span>
              <span className="shrink-0 text-dim">{formatStamp(entry.startedAt)}</span>
              <label className="flex shrink-0 items-center gap-1 text-dim">
                <input
                  type="checkbox"
                  checked={entry.billable}
                  onChange={() => toggleBillable(entry)}
                />
                billable
              </label>
              <button
                onClick={() => remove(entry)}
                className="shrink-0 text-dim hover:text-danger"
                title="delete entry"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
