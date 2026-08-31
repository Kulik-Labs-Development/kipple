import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type MeUser } from './lib/api'
import { applyTheme, resolveThemeChoice, watchSystemScheme } from './lib/theme'
import { LoginView } from './views/LoginView'
import { PortalView } from './views/PortalView'
import { SetupView } from './views/SetupView'
import { WorkspaceView } from './views/WorkspaceView'

type Mode = 'loading' | 'setup' | 'login' | 'app'

export default function App() {
  const [mode, setMode] = useState<Mode>('loading')
  const [user, setUser] = useState<MeUser | null>(null)
  const [primaryClient, setPrimaryClient] = useState<{
    id: string
    name: string
    domain: string | null
  } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const me = await api.me()
      const choice = resolveThemeChoice(me.preferences, me.instanceTheme, me.user.role)
      applyTheme(choice)
      if (choice.colorMode === 'system') {
        watchSystemScheme((dark) => {
          document.documentElement.dataset.mode = dark ? 'dark' : 'light'
        })
      }
      setUser(me.user)
      setPrimaryClient(me.primaryClient)
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

  if (mode === 'login' || !user) return <LoginView onDone={() => refresh()} />

  if (user.role === 'contact') {
    return <PortalView user={user} primaryClient={primaryClient} onSignedOut={signedOut} />
  }

  return <WorkspaceView user={user} onSignedOut={signedOut} />
}
