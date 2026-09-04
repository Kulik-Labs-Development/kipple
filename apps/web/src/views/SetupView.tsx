import { useState } from 'react'
import { Field } from '../components/Field'
import { api, ApiError } from '../lib/api'
import { useI18n } from '../lib/i18n'

export function SetupView({ onDone }: { onDone: () => void }) {
  const { t } = useI18n()
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
      setError(err instanceof ApiError ? err.message : t('setup.error.fallback'))
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
          <h1 className="text-lg tracking-widest text-accent">{t('login.heading')}</h1>
          <p className="mt-1 text-xs text-dim">
            {t('setup.sub')}
          </p>
        </div>
        <Field
          label={t('setup.field.instanceName')}
          value={form.instanceName}
          onChange={update('instanceName')}
          placeholder={t('setup.placeholder.instanceName')}
          required
        />
        <Field
          label={t('setup.field.ownerName')}
          value={form.ownerName}
          onChange={update('ownerName')}
          placeholder={t('setup.placeholder.ownerName')}
          required
        />
        <Field
          label={t('login.field.email')}
          type="email"
          value={form.ownerEmail}
          onChange={update('ownerEmail')}
          placeholder={t('login.placeholder.email')}
          required
        />
        <Field
          label={t('login.field.password')}
          type="password"
          value={form.password}
          onChange={update('password')}
          placeholder={t('setup.placeholder.password')}
          minLength={8}
          required
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full border border-accent bg-accent/10 py-2 text-sm tracking-widest text-accent disabled:opacity-50"
        >
          {busy ? t('setup.submit.working') : t('setup.submit.create')}
        </button>
      </form>
    </div>
  )
}
