import { useEffect, useState } from 'react'
import { api } from '../lib/api'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

export function HoldsManager({ onClose }: { onClose: () => void }) {
  const [autoCloseDays, setAutoCloseDays] = useState('')
  const [warnDays, setWarnDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .holdSettings()
      .then((s) => {
        setAutoCloseDays(s.autoCloseDays === null ? '' : String(s.autoCloseDays))
        setWarnDays(s.warnDays === null ? '' : String(s.warnDays))
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'failed to load hold settings'),
      )
  }, [])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const auto = autoCloseDays.trim() === '' ? null : Number(autoCloseDays)
      const warn = warnDays.trim() === '' ? null : Number(warnDays)
      if (auto !== null && (!Number.isInteger(auto) || auto < 1 || auto > 365)) {
        throw new Error('auto-close days must be a whole number between 1 and 365')
      }
      if (warn !== null && (!Number.isInteger(warn) || warn < 1 || warn > 364)) {
        throw new Error('warning days must be a whole number between 1 and 364')
      }
      await api.patchHoldSettings({ autoCloseDays: auto, warnDays: warn })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save hold settings')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md border border-line bg-ink"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm tracking-widest text-accent">hold states</div>
          <button onClick={onClose} className={dimButtonClass}>
            close
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 border border-danger px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="space-y-4 p-4">
          <p className="text-xs text-dim">
            Tickets put on hold (waiting on the client or a vendor) auto-close after a fixed
            number of calendar days, with an optional pre-close warning. The warning can feed a
            rule that emails the client (templates + rules — nothing sends by itself). Leave a
            field blank to turn that part off.
          </p>
          <div className="flex items-center gap-2">
            <span className="w-32 text-xs text-dim">auto-close after (days)</span>
            <input
              type="number"
              min={1}
              max={365}
              value={autoCloseDays}
              onChange={(event) => setAutoCloseDays(event.target.value)}
              placeholder="off"
              className={`${inputClass} w-24`}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-32 text-xs text-dim">warn (days before)</span>
            <input
              type="number"
              min={1}
              max={364}
              value={warnDays}
              onChange={(event) => setWarnDays(event.target.value)}
              placeholder="off"
              className={`${inputClass} w-24`}
            />
          </div>
          <div className="flex justify-end">
            <button onClick={() => void save()} disabled={busy} className={buttonClass}>
              save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
