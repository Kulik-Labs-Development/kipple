import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type NotificationRow } from '../lib/api'
import { relativeTime } from '../lib/tickets'
import { PhosphorIcon } from './PhosphorIcon'

const POLL_MS = 30_000

// In-app notification center (PLAN §8d, item 11). Polling for v1 — the rest
// of the workspace polls on the same 30s cadence; SSE is a documented
// follow-up.
export function NotificationBell({ onOpenTicket }: { onOpenTicket: (ticketId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<NotificationRow[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [wiggling, setWiggling] = useState(false)
  const prevUnread = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const [count, rows] = await Promise.all([
        api.notificationCount(),
        api.listNotifications({ limit: 30 }),
      ])
      if (count.unread > 0 && prevUnread.current === 0) {
        setWiggling(true) // class added on arrival, cleared on animationend
      }
      prevUnread.current = count.unread
      setUnread(count.unread)
      setItems(rows)
    } catch {
      // the bell is non-critical; leave the last known state
    }
  }, [])

  useEffect(() => {
    void refresh()
    setNow(Date.now())
    const timer = setInterval(() => {
      void refresh()
      setNow(Date.now())
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  async function markAll() {
    try {
      await api.markNotificationsRead({ all: true })
      await refresh()
    } catch {
      // ignore — next poll retries
    }
  }

  async function openItem(row: NotificationRow) {
    setOpen(false)
    if (!row.read) {
      try {
        await api.markNotificationsRead({ ids: [row.id] })
        await refresh()
      } catch {
        // ignore
      }
    }
    if (row.ticketId) onOpenTicket(row.ticketId)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="notifications"
        aria-label="notifications"
        className={`border px-2 py-1 uppercase tracking-widest ${
          unread > 0 ? 'border-accent text-accent' : 'border-line text-dim'
        }`}
      >
        <PhosphorIcon
          name="bell"
          filled={unread > 0}
          size="sm"
          className={wiggling ? 'ph-bell-wiggle' : ''}
          onAnimationEnd={() => setWiggling(false)}
        />
        {unread > 0 && (
          <span className="ml-1 inline-block min-w-[1.25rem] rounded-sm bg-accent px-1 text-center text-ink tabular-nums">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-96 w-80 overflow-y-auto border border-line bg-panel shadow-lg">
          <header className="sticky top-0 flex items-center justify-between border-b border-line bg-panel px-3 py-2">
            <span className="text-xs uppercase tracking-widest text-dim">notifications</span>
            <button
              onClick={() => void markAll()}
              className="text-xs text-accent hover:underline"
            >
              mark all read
            </button>
          </header>
          {items.length === 0 ? (
            <p className="px-3 py-4 text-xs text-dim">nothing yet</p>
          ) : (
            items.map((row) => (
              <button
                key={row.id}
                onClick={() => void openItem(row)}
                className={`block w-full border-b border-line px-3 py-2 text-left text-xs hover:bg-ink ${
                  row.read ? 'text-dim' : 'text-fg'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`uppercase tracking-widest ${row.read ? 'text-dim' : 'text-accent'}`}>
                    {row.event}
                  </span>
                  <span className="text-dim tabular-nums">{relativeTime(row.createdAt, new Date(now))}</span>
                </div>
                <div className="mt-1 leading-snug">{row.message}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
