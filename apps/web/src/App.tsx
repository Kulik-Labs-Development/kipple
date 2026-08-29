import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type MeUser } from './lib/api'
import { LoginView } from './views/LoginView'
import { SetupView } from './views/SetupView'
import { WorkspaceView } from './views/WorkspaceView'

type Mode = 'loading' | 'setup' | 'login' | 'app'

export default function App() {
  const [mode, setMode] = useState<Mode>('loading')
  const [user, setUser] = useState<MeUser | null>(null)

  const refresh = useCallback(async () => {
    try {
      const me = await api.me()
      setUser(me.user)
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

  if (mode === 'loading') {
    return (
      <div className="grid min-h-full place-items-center text-xs tracking-widest text-dim">
        CONNECTING…
      </div>
    )
  }

  if (mode === 'setup') return <SetupView onDone={() => refresh()} />

  if (mode === 'login' || !user) return <LoginView onDone={() => refresh()} />

  return (
    <WorkspaceView
      user={user}
      onSignedOut={() => {
        setUser(null)
        setMode('login')
      }}
    />
  )
}
