import { useState } from 'react'
import { Field } from '../components/Field'
import { api, ApiError } from '../lib/api'

export function SetupView({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    instanceName: '',
    ownerName: '',
    ownerEmail: '',
    password: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function update(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.setup(form)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'setup failed')
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-full place-items-center">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 border border-line bg-panel p-6"
      >
        <div>
          <h1 className="text-lg tracking-widest text-accent">KIPPLE</h1>
          <p className="mt-1 text-xs text-dim">
            first run — create the instance and owner account
          </p>
        </div>
        <Field
          label="instance name"
          value={form.instanceName}
          onChange={update('instanceName')}
          placeholder="Acme MSP Help Desk"
          required
        />
        <Field
          label="your name"
          value={form.ownerName}
          onChange={update('ownerName')}
          placeholder="Max Kulik"
          required
        />
        <Field
          label="email"
          type="email"
          value={form.ownerEmail}
          onChange={update('ownerEmail')}
          placeholder="you@company.com"
          required
        />
        <Field
          label="password"
          type="password"
          value={form.password}
          onChange={update('password')}
          placeholder="min 8 characters"
          minLength={8}
          required
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full border border-accent bg-accent/10 py-2 text-sm tracking-widest text-accent disabled:opacity-50"
        >
          {busy ? 'CREATING…' : 'SET UP INSTANCE'}
        </button>
      </form>
    </div>
  )
}
