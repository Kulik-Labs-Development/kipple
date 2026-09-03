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
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'agent' as 'admin' | 'agent' })
  const [busyAdd, setBusyAdd] = useState(false)

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

  async function addStaff() {
    setBusyAdd(true)
    setError(null)
    try {
      await api.createUser(newUser)
      setNewUser({ name: '', email: '', password: '', role: 'agent' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create user')
    } finally {
      setBusyAdd(false)
    }
  }

  async function remove(userId: string, name: string) {
    if (!window.confirm(`Remove ${name}? They will no longer be able to sign in.`)) return
    setBusyId(userId)
    setError(null)
    try {
      await api.deleteUser(userId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to remove user')
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
          <div className="text-sm tracking-widest text-accent">company settings</div>
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

          <div className="mb-3 space-y-2 border border-line bg-panel p-3">
            <div className="text-xs uppercase tracking-widest text-dim">add a staff account</div>
            <div className="flex flex-wrap gap-2">
              <input value={newUser.name} onChange={(e) => setNewUser((s) => ({ ...s, name: e.target.value }))} placeholder="name" className={`${inputClass} w-40`} aria-label="new user name" />
              <input value={newUser.email} onChange={(e) => setNewUser((s) => ({ ...s, email: e.target.value }))} placeholder="email" className={`${inputClass} w-48`} aria-label="new user email" />
              <input type="password" value={newUser.password} onChange={(e) => setNewUser((s) => ({ ...s, password: e.target.value }))} placeholder="password" className={`${inputClass} w-40`} aria-label="new user password" />
              <select value={newUser.role} onChange={(e) => setNewUser((s) => ({ ...s, role: e.target.value as 'admin' | 'agent' }))} className={inputClass} aria-label="new user role">
                <option value="agent">agent</option>
                <option value="admin">admin</option>
              </select>
              <button onClick={() => void addStaff()} disabled={busyAdd || !newUser.name || !newUser.email || !newUser.password} className="border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent/10 disabled:opacity-50">
                add
              </button>
            </div>
          </div>
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
                  <button onClick={() => void remove(user.id, user.name)} disabled={busyId === user.id} className={dimButtonClass} aria-label={`remove ${user.name}`}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
