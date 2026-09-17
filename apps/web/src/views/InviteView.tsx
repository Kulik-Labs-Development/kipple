import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const primaryButtonClass =
  'border border-accent px-3 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent/10 disabled:opacity-50'

// Public invitation page (/invite/<token>, issue #32). The token is the
// credential: no session, no account yet. Invalid/expired/used tokens all
// render the same dead-link state on purpose.
export function InviteView({ token, onSignedOut }: { token: string; onSignedOut: () => void }) {
  const [state, setState] = useState<'loading' | 'form' | 'done' | 'dead'>('loading')
  const [role, setRole] = useState<string>('agent')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    api
      .inviteStatus(token)
      .then((status) => {
        setRole(status.role)
        setState('form')
      })
      .catch(() => setState('dead'))
  }, [token])

  async function accept() {
    setBusy(true)
    setError(null)
    try {
      await api.acceptInvite({ token, name, password })
      setState('done')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to accept the invitation')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-full place-items-center p-4">
      <div className="w-full max-w-sm border border-line bg-ink p-5">
        <div className="mb-1 text-sm tracking-widest text-accent">invitation</div>
        {state === 'loading' && <p className="text-xs text-dim">Checking your invitation…</p>}
        {state === 'dead' && (
          <div className="space-y-2">
            <p className="text-xs text-dim">
              This invitation is no longer valid — it may have expired, been used, or been
              revoked.
            </p>
            <p className="text-xs text-dim">Ask the administrator to send a new one.</p>
          </div>
        )}
        {state === 'form' && (
          <div className="space-y-2">
            <p className="text-xs text-dim">
              You are invited to join as a <span className="text-fg">{role}</span>. Create your
              account to accept.
            </p>
            {error && (
              <div className="border border-danger px-3 py-2 text-xs text-danger">{error}</div>
            )}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="full name"
              className={`${inputClass} w-full`}
              aria-label="full name"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="choose a password (min 8 characters)"
              className={`${inputClass} w-full`}
              aria-label="password"
            />
            <button
              onClick={() => void accept()}
              disabled={busy || name.trim().length < 2 || password.length < 8}
              className={primaryButtonClass}
            >
              create account
            </button>
          </div>
        )}
        {state === 'done' && (
          <div className="space-y-2">
            <p className="text-xs text-ok">Your account is ready.</p>
            <p className="text-xs text-dim">
              Sign in with your email and the password you just chose, then set up
              two-factor authentication.
            </p>
            <button onClick={onSignedOut} className={primaryButtonClass}>
              go to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
