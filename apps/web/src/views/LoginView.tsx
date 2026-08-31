import { useState } from 'react'
import { Field } from '../components/Field'
import { api, ApiError } from '../lib/api'

type Mode = 'client' | 'agent'

export function LoginView({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('client')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'client') {
        await api.requestMagicLink(email)
        setSentTo(email)
      } else {
        await api.signIn(email, password)
        onDone()
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setSentTo(null)
  }

  return (
    <div className="grid min-h-full place-items-center">
      <div className="w-full max-w-sm border border-line bg-panel p-6">
        <div>
          <h1 className="text-lg tracking-widest text-accent">KIPPLE</h1>
          <p className="mt-1 text-xs text-dim">
            {mode === 'client' ? 'client portal sign in' : 'agent workspace sign in'}
          </p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-1 text-xs">
          <button
            type="button"
            onClick={() => switchMode('client')}
            className={`border px-2 py-1 uppercase tracking-widest ${
              mode === 'client' ? 'border-accent text-accent' : 'border-line text-dim'
            }`}
          >
            client
          </button>
          <button
            type="button"
            onClick={() => switchMode('agent')}
            className={`border px-2 py-1 uppercase tracking-widest ${
              mode === 'agent' ? 'border-accent text-accent' : 'border-line text-dim'
            }`}
          >
            agent
          </button>
        </div>

        {sentTo ? (
          <div className="mt-4 border border-ok p-4 text-sm text-fg">
            <p>
              A sign-in link was sent to <span className="text-accent">{sentTo}</span>.
            </p>
            <p className="mt-2 text-xs text-dim">
              Check your inbox. The link expires in 10 minutes and works only once.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field
              label="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
            />
            {mode === 'agent' && (
              <Field
                label="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password"
                required
              />
            )}
            {error && <p className="text-xs text-danger">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full border border-accent bg-accent/10 py-2 text-sm tracking-widest text-accent disabled:opacity-50"
            >
              {busy
                ? 'WORKING…'
                : mode === 'client'
                  ? 'SEND SIGN-IN LINK'
                  : 'SIGN IN'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
