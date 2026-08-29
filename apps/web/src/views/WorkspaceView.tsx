import { useState } from 'react'
import { api, type MeUser } from '../lib/api'

const stats = [
  { label: 'assigned to me', value: 0 },
  { label: 'in queue', value: 0 },
  { label: 'opened today', value: 0 },
  { label: 'closed today', value: 0 },
]

export function WorkspaceView({
  user,
  onSignedOut,
}: {
  user: MeUser
  onSignedOut: () => void
}) {
  const [signingOut, setSigningOut] = useState(false)

  async function signOut() {
    setSigningOut(true)
    try {
      await api.signOut()
    } finally {
      onSignedOut()
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="tracking-widest text-accent">KIPPLE</span>
          <span className="text-xs text-dim">agent workspace</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span>
            <span className="text-dim">{user.name}</span>{' '}
            <span className="text-dim">·</span>{' '}
            <span className="uppercase text-dim">{user.role}</span>
          </span>
          <button
            onClick={signOut}
            disabled={signingOut}
            className="border border-line px-2 py-1 text-dim hover:border-danger hover:text-danger"
          >
            sign out
          </button>
        </div>
      </header>

      <main className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="border border-line bg-panel p-4">
              <div className="text-2xl text-fg tabular-nums">{stat.value}</div>
              <div className="mt-1 text-xs uppercase tracking-widest text-dim">
                {stat.label}
              </div>
            </div>
          ))}
        </div>

        <div className="border border-line bg-panel p-8 text-center">
          <div className="text-sm tracking-widest text-dim">QUEUE</div>
          <p className="mt-2 text-fg">No tickets. The board is clean.</p>
          <p className="mt-1 text-xs text-dim">
            tickets will appear here as they come in over email and the portal
          </p>
        </div>
      </main>

      <footer className="flex items-center justify-between border-t border-line bg-panel px-4 py-2 text-xs text-dim">
        <span>
          kipple v0.1.0 · presence: <span className="uppercase">{user.presence}</span>
        </span>
        <span>{user.email}</span>
      </footer>
    </div>
  )
}
