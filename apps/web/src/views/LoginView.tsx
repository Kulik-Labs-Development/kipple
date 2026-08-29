import { useState } from 'react'
import { Field } from '../components/Field'
import { api, ApiError } from '../lib/api'

export function LoginView({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.signIn(email, password)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'sign-in failed')
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-full place-items-center">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 border border-line bg-panel p-6">
        <div>
          <h1 className="text-lg tracking-widest text-accent">KIPPLE</h1>
          <p className="mt-1 text-xs text-dim">sign in to the agent workspace</p>
        </div>
        <Field
          label="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          required
        />
        <Field
          label="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          required
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full border border-accent bg-accent/10 py-2 text-sm tracking-widest text-accent disabled:opacity-50"
        >
          {busy ? 'SIGNING IN…' : 'SIGN IN'}
        </button>
      </form>
    </div>
  )
}
