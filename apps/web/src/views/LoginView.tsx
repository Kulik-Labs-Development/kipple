import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useI18n } from '../lib/i18n'

type Mode = 'client' | 'agent'

const STEPS = [
  { title: 'login.step1.title', desc: 'login.step1.desc' },
  { title: 'login.step2.title', desc: 'login.step2.desc' },
  { title: 'login.step3.title', desc: 'login.step3.desc' },
] as const

export function LoginView({ onDone }: { onDone: () => void }) {
  const { t } = useI18n()
  const [mode, setMode] = useState<Mode>('client')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [branding, setBranding] = useState<{
    clientName: string | null
    logoUrl: string | null
    selfRegister: boolean
  } | null>(null)
  const [logoBroken, setLogoBroken] = useState(false)
  const [selfRegName, setSelfRegName] = useState('')

  // The left branding rail shows the client's own name + logo once the email
  // matches a known portal contact. Debounced; invalid emails fall back to the
  // default KIPPLE monogram. The logo src comes pre-resolved from the api
  // (external URL as-is, uploaded logo via /api/portal/logo).
  useEffect(() => {
    const value = email.trim()
    if (mode !== 'client' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      setBranding(null)
      setLogoBroken(false)
      setSelfRegName('')
      return
    }
    let live = true
    const timer = setTimeout(async () => {
      try {
        const result = await api.portalBranding(value)
        if (live) setBranding(result)
      } catch {
        if (live) setBranding(null)
      }
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [email, mode])

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
      setError(err instanceof ApiError ? err.message : t('login.error.fallback'))
    } finally {
      setBusy(false)
    }
  }

  async function requestLink() {
    setBusy(true)
    setError(null)
    try {
      // Agent workspace sign-in via email link (issue #98): the API only
      // actually sends one when the account opted in via profile settings —
      // the response shape is identical either way (no enumeration).
      await api.requestMagicLink(email, '/')
      setSentTo(email)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('login.error.fallback'))
    } finally {
      setBusy(false)
    }
  }

  async function createAccount() {
    setBusy(true)
    setError(null)
    try {
      // Account creation is idempotent and silent (always {status:true}).
      // The magic-link request right after is the only mail that goes out,
      // and only when the account is a portal contact (the server-side
      // gate decides; unknown emails and staff get nothing).
      await api.selfRegister(email, selfRegName)
      await api.requestMagicLink(email)
      setSentTo(email)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'account creation failed')
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setSentTo(null)
  }

  const clientName = branding?.clientName ?? t('login.heading')

  return (
    <div className="flex h-full bg-ink">
      {/* Left: client branding rail */}
      <aside className="flex w-[420px] shrink-0 flex-col border-r-2 border-line bg-panel px-12 py-[60px]">
        {branding?.logoUrl && !logoBroken ? (
          <img
            src={branding.logoUrl}
            alt=""
            onError={() => setLogoBroken(true)}
            className="h-[72px] w-[72px] border-2 border-fg object-contain"
          />
        ) : (
          <div className="flex h-[72px] w-[72px] items-center justify-center border-2 border-fg text-3xl font-bold text-fg">
            {clientName.charAt(0).toUpperCase()}
          </div>
        )}
        <h1 className="mt-7 text-[22px] leading-tight font-bold text-fg">{clientName}</h1>
        <div className="mt-2 text-[9px] tracking-[.26em] text-dim uppercase">
          {t('login.clientPortal')}
        </div>
        <div className="my-7 h-0.5 bg-line" />
        <p className="text-[13px] leading-relaxed text-dim">{t('login.tagline')}</p>
        <div className="mt-auto pt-10 text-[9px] tracking-[.26em] text-dim uppercase">
          {t('login.poweredBy')} <span className="text-accent">KIPPLE</span>
        </div>
      </aside>

      {/* Right: sign-in (client = magic link + self-reg, agent = password) */}
      <div className="grid min-h-full min-w-0 flex-1 place-items-center">
        <div className="w-[460px] py-10">
          <div className="text-[9px] tracking-[.3em] text-dim uppercase">{t('login.kicker')}</div>
          <h2 className="mt-3 text-[32px] leading-[1.1] font-bold text-fg">{t('login.hero')}</h2>
          <p className="mt-3 text-[13px] leading-relaxed text-dim">{t('login.intro')}</p>

          {mode === 'client' && (
            <div className="mt-8 grid grid-cols-3">
              {STEPS.map((step, index) => (
                <div
                  key={step.title}
                  className={
                    index === 0 ? 'pr-4' : index === 1 ? 'border-l border-line pl-4 pr-4' : 'border-l border-line pl-4'
                  }
                >
                  <div className="text-[9px] font-bold tracking-[.2em] text-accent uppercase">
                    {t('login.stepNumber', { n: index + 1 })}
                  </div>
                  <div className="mt-1.5 text-[11px] font-bold uppercase text-fg">{t(step.title)}</div>
                  <p className="mt-1 text-[11px] leading-snug text-dim">{t(step.desc)}</p>
                </div>
              ))}
            </div>
          )}

          {sentTo ? (
            <div className="mt-8">
              <p className="text-[13px] text-fg">
                {t('login.linkSent.before')}
                <span className="font-bold text-accent">{sentTo}</span>
                {t('login.linkSent.after')}
              </p>
              <p className="mt-2 text-xs text-dim">
                {mode === 'agent' ? t('login.linkSent.agentNote') : t('login.linkSent.clientNote')}
              </p>
            </div>
          ) : mode === 'client' ? (
            <form onSubmit={submit} className="mt-8">
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('login.placeholder.email')}
                aria-label={t('login.field.email')}
                className="w-full border-b border-line bg-transparent py-2 text-[13px] text-fg outline-none placeholder:text-dim/70 focus:border-accent"
              />
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="mt-6 w-full bg-accent py-[13px] text-[10px] tracking-[.22em] text-ink uppercase disabled:opacity-50"
              >
                {busy ? t('login.submit.working') : t('login.button')}
              </button>
            </form>
          ) : (
            <form onSubmit={submit} className="mt-8">
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('login.placeholder.email')}
                aria-label={t('login.field.email')}
                className="w-full border-b border-line bg-transparent py-2 text-[13px] text-fg outline-none placeholder:text-dim/70 focus:border-accent"
              />
              <input
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('login.placeholder.password')}
                aria-label={t('login.field.password')}
                className="mt-4 w-full border-b border-line bg-transparent py-2 text-[13px] text-fg outline-none placeholder:text-dim/70 focus:border-accent"
              />
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="mt-6 w-full bg-accent py-[13px] text-[10px] tracking-[.22em] text-ink uppercase disabled:opacity-50"
              >
                {busy ? t('login.submit.working') : t('login.submit.agent')}
              </button>
              <button
                type="button"
                onClick={() => void requestLink()}
                disabled={busy}
                className="mt-3 w-full border border-line py-2.5 text-[10px] tracking-[.18em] text-dim uppercase hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {t('login.magicLinkButton')}
              </button>
              <p className="mt-2 text-center text-[10px] text-dim">{t('login.magicLinkNote')}</p>
            </form>
          )}

          <div className="mt-8 h-px bg-line" />

          {mode === 'client' ? (
            <>
              <div className="mt-4 flex items-baseline justify-between gap-3">
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="text-[10px] tracking-[.18em] text-dim uppercase">
                    {t('login.newHere')}
                  </span>
                  <button
                    type="button"
                    onClick={() => void createAccount()}
                    disabled={
                      busy || !branding?.selfRegister || !email.trim() || !selfRegName.trim()
                    }
                    className="text-[10px] tracking-[.18em] text-accent uppercase underline disabled:cursor-default disabled:text-dim/60 disabled:no-underline"
                  >
                    {t('login.createAccount')}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => switchMode('agent')}
                  className="shrink-0 text-[9px] tracking-[.18em] text-dim uppercase hover:text-fg"
                >
                  {t('login.staffLink')}
                </button>
              </div>
              {branding?.selfRegister && (
                <input
                  value={selfRegName}
                  onChange={(event) => setSelfRegName(event.target.value)}
                  placeholder={t('login.placeholder.name')}
                  aria-label={t('login.field.name')}
                  className="mt-4 w-full border-b border-line bg-transparent py-2 text-[13px] text-fg outline-none placeholder:text-dim/70 focus:border-accent"
                />
              )}
            </>
          ) : (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => switchMode('client')}
                className="text-[9px] tracking-[.18em] text-dim uppercase hover:text-fg"
              >
                {t('login.clientLink')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
