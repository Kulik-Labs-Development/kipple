import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { MeUser } from '../lib/api'

const inputClass =
  'border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const primaryButtonClass =
  'border border-accent px-3 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent/10 disabled:opacity-50'

// MFA on first login (issue #32): the invited account is locked to this
// screen until a TOTP device is enrolled. Enroll (password required by
// better-auth) → enter the code from the authenticator app → the API gate
// lifts and the workspace opens.
export function MfaSetupView({ user, onDone }: { user: MeUser; onDone: () => void }) {
  const [step, setStep] = useState<'password' | 'confirm' | 'done'>('password')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [totpURI, setTotpURI] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function enroll() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.enableTwoFactor(password)
      setTotpURI(res.totpURI ?? null)
      setBackupCodes(res.backupCodes ?? null)
      setStep('confirm')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to start two-factor setup')
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    setBusy(true)
    setError(null)
    try {
      await api.verifyTwoFactor(code)
      setStep('done')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'invalid code, try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-full place-items-center p-4">
      <div className="w-full max-w-sm border border-line bg-ink p-5">
        <div className="mb-1 text-sm tracking-widest text-accent">two-factor setup</div>
        <p className="mb-3 text-xs text-dim">
          This account was created from an invitation, so two-factor authentication is required
          before you can sign in normally.
        </p>

        {error && (
          <div className="mb-2 border border-danger px-3 py-2 text-xs text-danger">{error}</div>
        )}

        {step === 'password' && (
          <div className="space-y-2">
            <p className="text-xs text-dim">
              Confirm your password ({user.email}) to set up an authenticator app.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="your password"
              className={`${inputClass} w-full`}
              aria-label="password"
            />
            <button onClick={() => void enroll()} disabled={busy || !password} className={primaryButtonClass}>
              continue
            </button>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-2">
            <p className="text-xs text-dim">
              Add this key to your authenticator app (Google Authenticator, 1Password, …), then
              enter the 6-digit code it shows.
            </p>
            <textarea
              readOnly
              value={totpURI ?? ''}
              rows={3}
              className={`${inputClass} w-full resize-none font-mono text-[10px]`}
              aria-label="authenticator key"
              onFocus={(e) => e.target.select()}
            />
            {backupCodes && backupCodes.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-widest text-dim">
                  backup codes — save these, each works once
                </div>
                <div className="border border-line bg-panel p-2 font-mono text-[10px] leading-relaxed">
                  {backupCodes.join('\n')}
                </div>
              </div>
            )}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="6-digit code"
              maxLength={6}
              inputMode="numeric"
              className={`${inputClass} w-full`}
              aria-label="authenticator code"
            />
            <button onClick={() => void verify()} disabled={busy || code.length !== 6} className={primaryButtonClass}>
              verify
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-2">
            <p className="text-xs text-ok">Two-factor authentication is on.</p>
            <button onClick={onDone} className={primaryButtonClass}>
              open workspace
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
