import { useCallback, useEffect, useState } from 'react'
import type { ClientBranding } from '@kipple/shared/themes'
import { api, ApiError, type MeUser } from './lib/api'
import { applyTheme, resolveThemeChoice, watchSystemScheme } from './lib/theme'
import { InviteView } from './views/InviteView'
import { LoginView } from './views/LoginView'
import { MfaSetupView } from './views/MfaSetupView'
import { PortalView } from './views/PortalView'
import { SetupView } from './views/SetupView'
import { WorkspaceView } from './views/WorkspaceView'

type Mode = 'loading' | 'setup' | 'login' | 'app'

// Agent invites (issue #32): /invite/<token> is a public page (no session,
// no account yet), so it renders before the auth check.
function inviteToken(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

export default function App() {
  const [mode, setMode] = useState<Mode>('loading')
  const [user, setUser] = useState<MeUser | null>(null)
  const [preferences, setPreferences] = useState<{
    theme: string | null
    colorMode: string
  } | null>(null)
  const [primaryClient, setPrimaryClient] = useState<{
    id: string
    name: string
    domain: string | null
    branding: ClientBranding | null
  } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const me = await api.me()
      const choice = resolveThemeChoice(
        me.preferences,
        me.instanceTheme,
        me.user.role,
        me.primaryClient?.branding ?? null,
        me.agentDefaultTheme,
      )
      applyTheme(choice)
      if (choice.colorMode === 'system') {
        watchSystemScheme((dark) => {
          document.documentElement.dataset.mode = dark ? 'dark' : 'light'
        })
      }
      setUser(me.user)
      setPrimaryClient(me.primaryClient)
      setPreferences(me.preferences)
      setMode('app')
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        const { setupRequired } = await api.setupStatus()
        setMode(setupRequired ? 'setup' : 'login')
      } else {
        throw err
      }
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => setMode('login'))
  }, [refresh])

  const signedOut = () => {
    setUser(null)
    setPrimaryClient(null)
    setPreferences(null)
    setMode('login')
  }

  if (mode === 'loading') {
    return (
      <div className="grid min-h-full place-items-center text-xs tracking-widest text-dim">
        CONNECTING…
      </div>
    )
  }

  if (mode === 'setup') return <SetupView onDone={() => refresh()} />

  const token = inviteToken()
  if (token) return <InviteView token={token} onSignedOut={() => window.location.assign('/')} />

  if (mode === 'login' || !user) return <LoginView onDone={() => refresh()} />

  // MFA on first login (issue #32): an invited account with no verified
  // TOTP device yet is locked to the setup screen (the API enforces the
  // same gate on every endpoint but /api/me + two-factor setup).
  if (user.mfaRequired) {
    return (
      <MfaSetupView
        user={user}
        onDone={() =>
          refresh().then(() => window.location.assign(window.location.pathname)).catch(() => undefined)
        }
      />
    )
  }

  if (user.role === 'contact') {
    return <PortalView user={user} primaryClient={primaryClient} onSignedOut={signedOut} />
  }

  return (
    <WorkspaceView
      user={user}
      preferences={preferences ?? { theme: null, colorMode: 'system' }}
      onSignedOut={signedOut}
      onUserUpdated={(next) => setUser(next)}
    />
  )
}
