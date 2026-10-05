import { useEffect, useState } from 'react'
import { api, type EmailSettingsInput, type ProviderStatusView } from '../lib/api'
import { useI18n } from '../lib/i18n'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const buttonClass =
  'border border-accent px-2 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink'
const dimButtonClass =
  'border border-line px-2 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

function toggleClass(active: boolean, uppercase: boolean): string {
  return `border px-2 py-1 text-xs ${uppercase ? 'uppercase tracking-widest' : ''} ${
    active
      ? 'border-accent bg-ink font-bold text-accent'
      : 'border-line text-dim hover:border-accent hover:text-fg'
  }`
}

export function MailManager({
  onClose,
  embedded = false,
}: {
  onClose: () => void
  embedded?: boolean
}) {
  const { t } = useI18n()
  const [provider, setProvider] = useState<'smtp' | 'm365'>('smtp')
  const [domain, setDomain] = useState('kipple.local')

  // smtp fields (port stays a string so the input can be blank while editing)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [secure, setSecure] = useState(false)
  const [startTls, setStartTls] = useState(true)
  const [from, setFrom] = useState('')
  const [fromName, setFromName] = useState('')
  const [authUser, setAuthUser] = useState('')
  const [authPass, setAuthPass] = useState('')

  // m365 fields
  const [tenant, setTenant] = useState('')
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [sender, setSender] = useState('')
  const [mode, setMode] = useState<'graph' | 'smtp'>('graph')

  // Masked-credential flags from the loaded view: when true, a blank
  // password/secret field shows the "keep the stored value" hint.
  const [hasStoredAuth, setHasStoredAuth] = useState(false)
  const [hasStoredSecret, setHasStoredSecret] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<ProviderStatusView | null>(null)
  const [testTo, setTestTo] = useState('')
  const [testSent, setTestSent] = useState<string | null>(null)

  useEffect(() => {
    api
      .emailSettings()
      .then((s) => {
        setDomain(s.domain)
        if (s.smtp) {
          setHost(s.smtp.host)
          setPort(String(s.smtp.port))
          setSecure(s.smtp.secure)
          setStartTls(s.smtp.startTls)
          setFrom(s.smtp.from)
          setFromName(s.smtp.fromName)
          setHasStoredAuth(s.smtp.hasAuth)
        }
        if (s.m365) {
          setTenant(s.m365.tenantId)
          setClientId(s.m365.clientId)
          setSender(s.m365.senderAddress)
          setMode(s.m365.mode)
          setHasStoredSecret(s.m365.hasSecret)
        }
        if (s.provider === 'm365') setProvider('m365')
        else if (s.provider === 'smtp') setProvider('smtp')
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'failed to load mail settings'),
      )
  }, [])

  // Form -> save/test payload. A blank password/client secret is sent as
  // "keep the stored value" (the API resolves that against the stored
  // identity); validation errors throw and surface in the error banner.
  function payload(): EmailSettingsInput {
    const trimmed = {
      domain: domain.trim(),
      host: host.trim(),
      port: port.trim(),
      from: from.trim(),
      fromName: fromName.trim(),
      authUser: authUser.trim(),
      authPass: authPass.trim(),
      tenant: tenant.trim(),
      clientId: clientId.trim(),
      secret: secret.trim(),
      sender: sender.trim(),
    }
    const portValue = trimmed.port === '' ? 587 : Number(trimmed.port)
    if (provider === 'm365') {
      if (!trimmed.tenant || !trimmed.clientId || !trimmed.sender) {
        throw new Error(t('mail.error.m365Fields'))
      }
      return {
        domain: trimmed.domain,
        provider: 'm365',
        smtp: null,
        m365: {
          tenantId: trimmed.tenant,
          clientId: trimmed.clientId,
          ...(trimmed.secret ? { clientSecret: trimmed.secret } : {}),
          senderAddress: trimmed.sender,
          mode,
        },
      }
    }
    if (!trimmed.host || !trimmed.from) throw new Error(t('mail.error.smtpFields'))
    if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
      throw new Error(t('mail.error.port'))
    }
    return {
      domain: trimmed.domain,
      provider: 'smtp',
      m365: null,
      smtp: {
        host: trimmed.host,
        port: portValue,
        secure,
        startTls,
        from: trimmed.from,
        ...(trimmed.fromName ? { fromName: trimmed.fromName } : {}),
        auth: trimmed.authUser
          ? {
              username: trimmed.authUser,
              ...(trimmed.authPass ? { password: trimmed.authPass } : {}),
            }
          : null,
      },
    }
  }

  async function save() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.saveEmailSettings(payload())
      setDomain(res.domain)
      if (res.smtp) setHasStoredAuth(res.smtp.hasAuth)
      if (res.m365) setHasStoredSecret(res.m365.hasSecret)
      setNotice(t('mail.saved'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mail.error.fallback'))
    } finally {
      setBusy(false)
    }
  }

  async function testConnection() {
    setBusy(true)
    setError(null)
    setTestStatus(null)
    try {
      setTestStatus(await api.testEmailConnection(payload()))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mail.error.fallback'))
    } finally {
      setBusy(false)
    }
  }

  // Test send uses the SAVED configuration (it goes through the outbox), not
  // the form — save first, then send a test.
  async function testSend() {
    const to = testTo.trim()
    setBusy(true)
    setError(null)
    setTestSent(null)
    try {
      const res = await api.outboxTestSend(to)
      setTestSent(t('mail.testQueued', { id: res.id }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mail.error.fallback'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={
        embedded
          ? 'flex h-full min-h-0 min-w-0 flex-1 flex-col bg-ink'
          : 'fixed inset-0 z-50 grid place-items-center bg-black/60 p-4'
      }
      onMouseDown={embedded ? undefined : onClose}
    >
      <div
        className={
          embedded
            ? 'min-h-0 flex-1 overflow-y-auto'
            : 'w-full max-w-md border border-line bg-ink'
        }
        onMouseDown={embedded ? undefined : (event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm tracking-widest text-accent">{t('mail.heading')}</div>
          <button onClick={onClose} className={dimButtonClass}>
            {t('mail.close')}
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 border border-danger px-3 py-2 text-xs text-danger">{error}</div>
        )}
        {notice && (
          <div className="mx-4 mt-3 border border-ok px-3 py-2 text-xs text-ok">{notice}</div>
        )}

        <div className="space-y-4 p-4">
          <p className="text-xs text-dim">{t('mail.intro')}</p>

          <div className="flex items-center gap-2">
            <span className="w-32 text-xs text-dim">{t('mail.domain')}</span>
            <input
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className={`${inputClass} w-52`}
            />
          </div>

          <div className="space-y-2">
            <span className="block text-xs text-dim">{t('mail.provider')}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setProvider('smtp')}
                className={toggleClass(provider === 'smtp', true)}
              >
                {t('mail.provider.smtp')}
              </button>
              <button
                onClick={() => setProvider('m365')}
                className={toggleClass(provider === 'm365', true)}
              >
                {t('mail.provider.m365')}
              </button>
            </div>
          </div>

          {provider === 'smtp' ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.smtp.host')}</span>
                <input
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  className={`${inputClass} w-52`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.smtp.port')}</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  className={`${inputClass} w-24`}
                />
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1.5 text-xs text-dim">
                  <input
                    type="checkbox"
                    checked={secure}
                    onChange={(event) => setSecure(event.target.checked)}
                  />
                  {t('mail.smtp.secure')}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-dim">
                  <input
                    type="checkbox"
                    checked={startTls}
                    onChange={(event) => setStartTls(event.target.checked)}
                  />
                  {t('mail.smtp.startTls')}
                </label>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.smtp.from')}</span>
                <input
                  type="email"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  className={`${inputClass} w-52`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.smtp.fromName')}</span>
                <input
                  value={fromName}
                  onChange={(event) => setFromName(event.target.value)}
                  className={`${inputClass} w-52`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.smtp.authUser')}</span>
                <input
                  value={authUser}
                  onChange={(event) => setAuthUser(event.target.value)}
                  className={`${inputClass} w-52`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.smtp.authPass')}</span>
                <input
                  type="password"
                  value={authPass}
                  onChange={(event) => setAuthPass(event.target.value)}
                  placeholder={hasStoredAuth ? t('mail.keepSecret') : ''}
                  className={`${inputClass} w-52`}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.m365.tenant')}</span>
                <input
                  value={tenant}
                  onChange={(event) => setTenant(event.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className={`${inputClass} w-56`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.m365.client')}</span>
                <input
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className={`${inputClass} w-56`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.m365.secret')}</span>
                <input
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder={hasStoredSecret ? t('mail.keepSecret') : ''}
                  className={`${inputClass} w-56`}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-32 text-xs text-dim">{t('mail.m365.sender')}</span>
                <input
                  type="email"
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  className={`${inputClass} w-56`}
                />
              </div>
              <div className="space-y-1.5 pt-1">
                <span className="block text-xs text-dim">{t('mail.m365.mode')}</span>
                <div className="flex gap-2">
                  <button onClick={() => setMode('graph')} className={toggleClass(mode === 'graph', false)}>
                    {t('mail.mode.graph')}
                  </button>
                  <button onClick={() => setMode('smtp')} className={toggleClass(mode === 'smtp', false)}>
                    {t('mail.mode.smtp')}
                  </button>
                </div>
                <p className="text-xs text-dim">
                  {mode === 'graph' ? t('mail.mode.graphHelp') : t('mail.mode.smtpHelp')}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-dim">
                {t('mail.test')}
                {testStatus && (
                  <span className={testStatus.ok ? 'text-ok' : 'text-danger'}>
                    {' '}
                    — {testStatus.ok ? t('mail.result.ok') : t('mail.result.fail')}: {testStatus.detail}
                  </span>
                )}
              </span>
              <button onClick={() => void testConnection()} disabled={busy} className={buttonClass}>
                {t('mail.test')}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-dim">
                {t('mail.testSend')} ({t('mail.testSendNote')})
              </span>
              <button onClick={() => void testSend()} disabled={busy} className={buttonClass}>
                {t('mail.testSendTo')}
              </button>
            </div>
            <input
              type="email"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
              placeholder="you@company.com"
              className={`${inputClass} w-52`}
            />
            {testSent && <div className="text-xs text-ok">{testSent}</div>}
          </div>

          <div className="flex justify-end">
            <button onClick={() => void save()} disabled={busy} className={buttonClass}>
              {busy ? t('mail.saving') : t('mail.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
