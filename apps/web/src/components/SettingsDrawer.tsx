import { useState } from 'react'
import { useI18n, type I18nKey } from '../lib/i18n'

/**
 * System settings drawer (Swiss layout, superuser only). Overlay on the
 * queue area — no dim. Items wire the existing superuser panels; unbuilt
 * rows render as honest stubs with a tag.
 */
export type DrawerPanel =
  | 'general'
  | 'appearance'
  | 'uploads'
  | 'users'
  | 'invites'
  | 'clients'
  | 'selfReg'
  | 'sla'
  | 'automation'
  | 'holds'

interface DrawerItem {
  id: DrawerPanel | 'mail' | 'notifications' | 'audit' | 'api' | 'webhooks'
  label: I18nKey
  stub?: 'drawer.stub' | 'drawer.phase2'
}

type DrawerGroupId = 'instance' | 'people' | 'clients' | 'ticketing' | 'integrations'
const GROUPS: { id: DrawerGroupId; items: DrawerItem[] }[] = [
  {
    id: 'instance',
    items: [
      { id: 'general', label: 'drawer.general' },
      { id: 'appearance', label: 'drawer.appearance' },
      { id: 'mail', label: 'drawer.mail', stub: 'drawer.stub' },
      { id: 'uploads', label: 'drawer.uploads' },
      { id: 'notifications', label: 'drawer.notifications', stub: 'drawer.stub' },
    ],
  },
  {
    id: 'people',
    items: [
      { id: 'users', label: 'drawer.users' },
      { id: 'invites', label: 'drawer.invites' },
    ],
  },
  {
    id: 'clients',
    items: [
      { id: 'clients', label: 'drawer.clientsBranding' },
      { id: 'selfReg', label: 'drawer.selfRegistration' },
    ],
  },
  {
    id: 'ticketing',
    items: [
      { id: 'sla', label: 'drawer.sla' },
      { id: 'automation', label: 'drawer.automation' },
      { id: 'holds', label: 'drawer.holds' },
      { id: 'audit', label: 'drawer.audit', stub: 'drawer.stub' },
    ],
  },
  {
    id: 'integrations',
    items: [
      { id: 'api', label: 'drawer.api', stub: 'drawer.phase2' },
      { id: 'webhooks', label: 'drawer.webhooks', stub: 'drawer.phase2' },
    ],
  },
]

export function SettingsDrawer({
  onOpen,
  onClose,
}: {
  onOpen: (panel: DrawerPanel) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [active, setActive] = useState<DrawerPanel | null>(null)

  // Type-level backstop for the onClick path: stub rows are disabled, but the
  // id union still carries the stub ids, so narrow before onOpen.
  const isPanel = (id: DrawerItem['id']): id is DrawerPanel =>
    id !== 'mail' && id !== 'notifications' && id !== 'audit' && id !== 'api' && id !== 'webhooks'

  return (
    <aside className="fixed left-0 top-14 bottom-10 z-20 flex w-[340px] flex-col border-r-2 border-line bg-panel">
      <div className="flex items-baseline justify-between border-b-2 border-line px-5 py-3">
        <span className="text-[11px] font-bold tracking-[.26em] text-fg uppercase">
          {t('drawer.title')}
        </span>
        <button
          onClick={onClose}
          className="text-[10px] tracking-[.18em] text-dim uppercase hover:text-fg"
        >
          {t('drawer.close')} ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {GROUPS.map((group) => (
          <div key={group.id}>
            <div className="px-5 pt-3.5 pb-1.5 text-[8px] tracking-[.3em] text-dim uppercase">
              {t(`drawer.group.${group.id}`)}
            </div>
            {group.items.map((item) => {
              const isActive = active === item.id
              return (
                <button
                  key={item.id}
                  disabled={item.stub !== undefined}
                  onClick={() => {
                    if (!isPanel(item.id)) return
                    setActive(item.id)
                    onOpen(item.id)
                  }}
                  className={`flex h-6 w-full items-center justify-between px-5 text-xs hover:bg-panel/60 ${
                    isActive
                      ? 'border-l-[3px] border-l-accent bg-ink pl-[17px] font-bold'
                      : 'border-l-[3px] border-l-transparent'
                  } ${item.stub ? 'cursor-default text-dim/70 hover:bg-transparent' : 'text-fg'}`}
                >
                  <span className="truncate">{t(item.label)}</span>
                  {item.stub && (
                    <span className="ml-2 shrink-0 text-[8px] tracking-[.2em] text-dim uppercase">
                      {t(item.stub)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </aside>
  )
}
