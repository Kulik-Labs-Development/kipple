import { useEffect, useState } from 'react'
import { api, type ClientSummary, type InviteRow, type StaffUser } from '../lib/api'

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
  // Agent invites (issue #32): email token links with MFA on first login.
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [invitesEnabled, setInvitesEnabled] = useState(true)
  const [newInvite, setNewInvite] = useState({ email: '', role: 'agent' as 'admin' | 'agent' })
  const [busyInvite, setBusyInvite] = useState(false)
  const [busyRevokeId, setBusyRevokeId] = useState<string | null>(null)

  async function refresh() {
    try {
      const [staffRows, clientRows, inviteRows, inviteSwitch] = await Promise.all([
        api.listStaff(),
        api.listClients(),
        api.listInvites(),
        api.instanceInvites(),
      ])
      setStaff(staffRows)
      setClients(clientRows)
      setInvites(inviteRows)
      setInvitesEnabled(inviteSwitch.enabled)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load users')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Live presence dots (issue #96): the panel's rows update as agents change
  // presence while the panel is open.
  useEffect(() => {
    const source = new EventSource('/api/events')
    const onPresence = (event: MessageEvent) => {
      try {
        const { userId, presence: next } = JSON.parse(event.data) as {
          userId: string
          presence: string
        }
        setStaff((prev) =>
          prev.map((row) => (row.id === userId ? { ...row, presence: next } : row)),
        )
      } catch {
        /* malformed frame — ignore */
      }
    }
    source.addEventListener('presence', onPresence)
    return () => {
      source.removeEventListener('presence', onPresence)
      source.close()
    }
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

  async function sendInvite() {
    setBusyInvite(true)
    setError(null)
    try {
      await api.createInvite({ email: newInvite.email.trim(), role: newInvite.role })
      setNewInvite({ email: '', role: 'agent' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send invitation')
    } finally {
      setBusyInvite(false)
    }
  }

  async function revokeInvite(inviteId: string, email: string) {
    if (!window.confirm(`Revoke the invitation for ${email}?`)) return
    setBusyRevokeId(inviteId)
    setError(null)
    try {
      await api.revokeInvite(inviteId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to revoke invitation')
    } finally {
      setBusyRevokeId(null)
    }
  }

  async function toggleInvites(enabled: boolean) {
    setError(null)
    try {
      await api.setInstanceInvites({ enabled })
      setInvitesEnabled(enabled)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to update invitations')
    }
  }

  async function changeRole(userId: string, name: string, role: string) {
    const current = staff.find((user) => user.id === userId)?.role ?? 'agent'
    if (role !== current && (role === 'superuser' || current === 'superuser')) {
      const ok =
        role === 'superuser'
          ? window.confirm(`Make ${name} a superuser?`)
          : window.confirm(`Remove superuser from ${name}? The instance must keep at least one superuser.`)
      if (!ok) return
    }
    setBusyId(userId)
    setError(null)
    try {
      await api.setUserRole(userId, role)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to update user')
    } finally {
      setBusyId(null)
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
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-widest text-dim">invite a staff account</div>
              <label className="flex cursor-pointer items-center gap-1 text-[10px] uppercase tracking-widest text-dim">
                <input
                  type="checkbox"
                  checked={invitesEnabled}
                  onChange={(e) => void toggleInvites(e.target.checked)}
                  aria-label="allow invitations"
                />
                allow invitations
              </label>
            </div>
            {invitesEnabled ? (
              <>
                <p className="text-xs text-dim">
                  Sends an email with a one-time link (7 days). The invitee picks a password and
                  must set up two-factor authentication on first sign-in.
                </p>
                <div className="flex flex-wrap gap-2">
                  <input value={newInvite.email} onChange={(e) => setNewInvite((s) => ({ ...s, email: e.target.value }))} placeholder="email" className={`${inputClass} w-52`} aria-label="invite email" />
                  <select value={newInvite.role} onChange={(e) => setNewInvite((s) => ({ ...s, role: e.target.value as 'admin' | 'agent' }))} className={inputClass} aria-label="invite role">
                    <option value="agent">agent</option>
                    <option value="admin">admin</option>
                  </select>
                  <button onClick={() => void sendInvite()} disabled={busyInvite || !newInvite.email.includes('@')} className="border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent/10 disabled:opacity-50">
                    send invite
                  </button>
                </div>
                {invites.length > 0 && (
                  <ul className="space-y-1 border-t border-line pt-2">
                    {invites.map((invite) => (
                      <li key={invite.id} className="flex items-center gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate text-fg">{invite.email}</span>
                        <span className="uppercase tracking-widest text-dim">{invite.role}</span>
                        <span className="text-dim">expires {new Date(invite.expiresAt).toLocaleDateString()}</span>
                        <button
                          onClick={() => void revokeInvite(invite.id, invite.email)}
                          disabled={busyRevokeId === invite.id}
                          className={dimButtonClass}
                          aria-label={`revoke invitation for ${invite.email}`}
                        >
                          revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-xs text-dim">Invitations are disabled — new accounts can only be created directly.</p>
            )}
          </div>

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
                    value={user.role}
                    disabled={busyId === user.id}
                    onChange={(event) => void changeRole(user.id, user.name, event.target.value)}
                    className={`${inputClass} w-28`}
                    aria-label={`role for ${user.name}`}
                    title="grant/revoke superuser (superuser only)"
                  >
                    <option value="agent">agent</option>
                    <option value="admin">admin</option>
                    <option value="superuser">superuser</option>
                  </select>
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
