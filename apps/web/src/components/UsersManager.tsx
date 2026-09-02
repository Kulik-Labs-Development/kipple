import { useEffect, useState } from 'react'
import { api, type ClientSummary, type StaffUser } from '../lib/api'

const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'
const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'

const PRESENCE_DOT: Record<string, string> = {
  online: 'bg-ok',
  away: 'bg-warn',
  busy: 'bg-danger',
  offline: 'bg-dim',
}

export function UsersManager({ onClose }: { onClose: () => void }) {
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [clients, setClients] = useState<ClientSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function refresh() {
    try {
      const [staffRows, clientRows] = await Promise.all([api.listStaff(), api.listClients()])
      setStaff(staffRows)
      setClients(clientRows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load users')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function assign(userId: string, clientId: string) {
    setBusyId(userId)
    setError(null)
    try {
      await api.assignUserClient(userId, clientId || null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to update user')
    } finally {
      setBusyId(null)
    }
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
          <div className="text-sm tracking-widest text-accent">users &amp; client assignment</div>
          <button onClick={onClose} className={dimButtonClass}>
            close
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 border border-danger px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="space-y-2 p-4">
          <p className="text-xs text-dim">
            Which client each staff account belongs to. Association only — it does not change
            what staff can see (client restriction is a separate feature).
          </p>
          {staff.length === 0 ? (
            <p className="text-xs text-dim">No staff accounts yet.</p>
          ) : (
            <ul className="space-y-1">
              {staff.map((user) => (
                <li key={user.id} className="flex items-center gap-3 border border-line px-3 py-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT[user.presence] ?? 'bg-dim'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-fg">
                      {user.name}
                      {user.role !== 'agent' && (
                        <span className="ml-2 text-xs uppercase tracking-widest text-dim">
                          {user.role}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-dim">{user.email}</div>
                  </div>
                  <select
                    value={user.clientId ?? ''}
                    disabled={busyId === user.id}
                    onChange={(event) => void assign(user.id, event.target.value)}
                    className={`${inputClass} w-48 ${user.clientId ? '' : 'text-dim'}`}
                    aria-label={`client for ${user.name}`}
                  >
                    <option value="">no client</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
