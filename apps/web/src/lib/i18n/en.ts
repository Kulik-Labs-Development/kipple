// The English catalog — the default (and for now, only) locale (#141).
//
// Conventions:
// - Flat dotted keys, namespaced by surface (login.*, queue.*, …).
// - Typed: `keyof typeof en` is the key space — a typo in t('…') is a
//   typecheck error, so the catalog doubles as the API of the UI strings.
// - New user-facing strings land in this file in the SAME change as the
//   component that uses them (i18n-ready from day one — the whole point of
//   #141: starting now so later locales don't mean re-mining the codebase).
// - Casing in values matches the rendered source (CSS `uppercase` classes
//   still uppercase their buttons; literals that are typed uppercase stay
//   uppercase here).
export const en = {
  // app shell
  'app.connecting': 'CONNECTING…',

  // login
  'login.heading': 'KIPPLE',
  'login.sub.client': 'client portal sign in',
  'login.sub.agent': 'agent workspace sign in',
  'login.tab.client': 'client',
  'login.tab.agent': 'agent',
  'login.linkSent.before': 'A sign-in link was sent to ',
  'login.linkSent.after': '.',
  'login.linkSent.agentNote':
    'A link is only sent if you enabled magic-link login in your profile settings. It expires in 10 minutes and works only once.',
  'login.linkSent.clientNote':
    'Check your inbox. The link expires in 10 minutes and works only once.',
  'login.field.email': 'email',
  'login.placeholder.email': 'you@company.com',
  'login.field.password': 'password',
  'login.placeholder.password': 'password',
  'login.submit.working': 'WORKING…',
  'login.submit.client': 'SEND SIGN-IN LINK',
  'login.submit.agent': 'SIGN IN',
  'login.magicLinkButton': 'sign in with email link',
  'login.magicLinkNote':
    'only sent if you enabled magic-link login in your profile settings',
  'login.error.fallback': 'sign-in failed',
  // domain words (statuses / priorities / SLA states — shared across surfaces)
  'status.all': 'all',
  'status.open': 'open',
  'status.pending': 'pending',
  'status.hold': 'hold',
  'status.closed': 'closed',
  'priority.low': 'low',
  'priority.normal': 'normal',
  'priority.high': 'high',
  'priority.urgent': 'urgent',
  'sla.pending': 'open',
  'sla.at_risk': 'at risk',
  'sla.breached': 'breached',
  'sla.met': 'met',

  // queue
  'queue.aria.clientFilter': 'filter by client',
  'queue.allClients': 'all clients',
  'queue.searchPlaceholder': 'search subject…  ( / )',
  'queue.new': 'new',
  'queue.emptyHeading': 'queue',
  'queue.empty': 'No tickets. The board is clean.',
  'queue.unknownClient': 'unknown client',
  'queue.sla.label': 'sla {state}',
  'queue.sla.title': 'SLA {state}',
  'queue.row.openedTitle': 'opened {at}',

  // setup (first run)
  'setup.sub': 'first run — create the instance and owner account',
  'setup.field.instanceName': 'instance name',
  'setup.placeholder.instanceName': 'Acme Help Desk',
  'setup.field.ownerName': 'your name',
  'setup.placeholder.ownerName': 'Your Name',
  'setup.placeholder.password': 'min 8 characters',
  'setup.error.fallback': 'setup failed',
  'setup.submit.working': 'CREATING…',
  'setup.submit.create': 'SET UP INSTANCE',
  // presence
  'presence.online': 'online',
  'presence.away': 'away',
  'presence.busy': 'busy',
  'presence.offline': 'offline',

  // workspace shell
  'workspace.settings': 'settings',
  'workspace.sub': 'agent workspace',
  'workspace.sla.title': 'SLA settings (superuser)',
  'workspace.sla.label': 'sla',
  'workspace.auto.titleSuperuser': 'email templates + rules (superuser)',
  'workspace.auto.titleStaff': 'automation (superuser only)',
  'workspace.auto.label': 'auto',
  'workspace.tickets.title': 'ticket queue',
  'workspace.tickets.label': 'tickets',
  'workspace.clients.title': 'clients + portal branding',
  'workspace.clients.titleStaff': 'clients (admin or superuser only)',
  'workspace.clients.label': 'clients',
  'workspace.users.title': 'users + client assignment (superuser)',
  'workspace.users.label': 'users',
  'workspace.defaults.title': 'instance defaults (superuser)',
  'workspace.defaults.label': 'defaults',
  'workspace.holds.title': 'hold states — auto-close + pre-close warning (superuser)',
  'workspace.holds.label': 'holds',
  'workspace.timer.stop': 'stop timer (T)',
  'workspace.timer.label': 'TIMER',
  'workspace.presence.title': 'presence',
  'workspace.presence.label': 'presence: {presence}',
  'workspace.theme.title': 'theme (default = company setting)',
  'workspace.theme.default': 'default',
  'workspace.signOut': 'sign out',
  'workspace.stat.assignedToMe': 'assigned to me',
  'workspace.stat.inQueue': 'in queue',
  'workspace.stat.openedToday': 'opened today',
  'workspace.stat.closedToday': 'closed today',
  'workspace.stat.overdue': 'overdue',
  'workspace.days14': '14 days',
  'workspace.sparkline.opened': 'opened',
  'workspace.sparkline.closed': 'closed',
  'workspace.empty.heading': 'QUEUE',
  'workspace.empty.select': 'Select a ticket to open it.',
  'workspace.empty.searchHint': 'press / to search',
  'workspace.footer.presence': 'presence: {presence}',
  'workspace.error.loadTickets': 'failed to load tickets',
  'workspace.error.loadData': 'failed to load workspace data',
  'workspace.error.timer': 'timer action failed',
  'workspace.error.presence': 'failed to update presence',
  'workspace.error.theme': 'failed to update theme',
  'workspace.error.patchTicket': 'failed to update ticket',
  'workspace.error.reply': 'failed to send update',
  'workspace.error.createTicket': 'failed to create ticket',
  'workspace.error.deleteTicket': 'failed to delete ticket',

  // portal (client-side)
  'portal.title.withClient': '{client} · Client Portal',
  'portal.title.fallback': 'Kipple',
  'portal.fallbackClient': 'Support',
  'portal.sub': 'client portal',
  'portal.yourRequests': 'your requests',
  'portal.newRequest': '+ new request',
  'portal.searchPlaceholder': 'search ( / )',
  'portal.empty': 'No requests here.',
  'portal.waitingOn': 'waiting on {who}',
  'portal.supportTeam': 'Support team',
  'portal.replyPlaceholder': 'Write a reply…',
  'portal.attach': 'attach',
  'portal.removeFile': 'remove {file}',
  'portal.sendReply': 'send reply',
  'portal.emptyDetail.none': "You don't have any requests yet.",
  'portal.emptyDetail.select': 'Select a request to open it.',
  'portal.emptyDetail.emailNote': 'You can also reply by email to your ticket address.',
  'portal.modal.heading': 'new request',
  'portal.modal.field.subject': 'subject',
  'portal.modal.placeholder.subject': 'What do you need help with?',
  'portal.modal.field.description': 'description',
  'portal.modal.placeholder.description': 'Tell us what happened (optional)',
  'portal.modal.cancel': 'cancel',
  'portal.modal.create': 'create request',
  'portal.modal.noClient': 'No company is linked to your account yet. Ask your MSP to link it.',
  'portal.error.load': 'failed to load requests',
  'portal.error.reply': 'failed to send reply',
  'portal.error.create': 'failed to create request',
} as const

// The key space of the catalog — t() is typed against this, so an unknown
// key is a typecheck error, not a runtime surprise.
export type I18nKey = keyof typeof en
