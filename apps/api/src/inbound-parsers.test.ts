import { describe, expect, it } from 'vitest'
import {
  PARSERS,
  parseCustom,
  parseKuma,
  parseOnlineornot,
  parsePrtg,
  parseUptimerobot,
  parseWatcher,
  parseZabbix,
} from './inbound-parsers'

// All fixtures below are FAKE data (no real vendor accounts, monitors, or
// secrets). Parser contract provenance: see the header of inbound-parsers.ts
// and docs/DEPLOYMENT.md (which shapes are doc/source-verified vs contract).

describe('parseKuma (source-verified)', () => {
  it('maps a down heartbeat (status 0) to the normalized shape', () => {
    expect(
      parseKuma({
        heartbeat: { monitorID: 42, status: 0, msg: 'Ping failed: timeout' },
        monitor: { name: 'Acme Portal', url: 'https://portal.acme.test' },
        msg: 'Ping failed: timeout',
      }),
    ).toEqual({
      source: 'kuma',
      targetId: '42',
      name: 'Acme Portal',
      state: 'down',
      message: 'Ping failed: timeout',
      url: 'https://portal.acme.test',
    })
  })

  it('maps an up heartbeat (status 1)', () => {
    const alert = parseKuma({
      heartbeat: { monitorID: 42, status: 1, msg: 'Ping recovered' },
      monitor: { name: 'Acme Portal' },
    })
    expect(alert?.state).toBe('up')
    expect(alert?.name).toBe('Acme Portal')
    expect(alert?.message).toBe('Ping recovered')
  })

  it('ignores pending and maintenance heartbeats (not actionable)', () => {
    expect(parseKuma({ heartbeat: { monitorID: 42, status: 2 }, monitor: {} })).toBeNull()
    expect(parseKuma({ heartbeat: { monitorID: 42, status: 3 }, monitor: {} })).toBeNull()
  })

  it('rejects payloads without a monitor id and non-object bodies', () => {
    expect(parseKuma({ heartbeat: { status: 0 }, monitor: {} })).toBeNull()
    expect(parseKuma(null)).toBeNull()
    expect(parseKuma('nope')).toBeNull()
    expect(parseKuma([{ heartbeat: { monitorID: 1, status: 0 } }])).toBeNull()
  })
})

describe('parseUptimerobot (doc-verified; JSON or form-encoded)', () => {
  it('maps alertType 1 (down) with numeric and string fields', () => {
    expect(
      parseUptimerobot({
        monitorID: 90210,
        alertType: 1,
        monitorFriendlyName: 'Beta API',
        monitorURL: 'https://api.beta.test',
        alertDetails: 'HTTP 500',
      }),
    ).toEqual({
      source: 'uptimerobot',
      targetId: '90210',
      name: 'Beta API',
      state: 'down',
      message: 'HTTP 500',
      url: 'https://api.beta.test',
    })
    // form-encoded params arrive as strings
    expect(
      parseUptimerobot({ monitorID: '90210', alertType: '2', monitorFriendlyName: 'Beta API' }),
    ).toMatchObject({ state: 'up', targetId: '90210' })
  })

  it('maps alertType 3 (SSL / domain expiry) as an alerting down', () => {
    expect(parseUptimerobot({ monitorID: '90210', alertType: '3' })?.state).toBe('down')
  })

  it('falls back to a display name and rejects unknown alert types', () => {
    expect(parseUptimerobot({ monitorID: '90210', alertType: '1' })?.name).toBe('Monitor 90210')
    expect(parseUptimerobot({ monitorID: '90210', alertType: '9' })).toBeNull()
    expect(parseUptimerobot({ alertType: '1' })).toBeNull()
  })
})

describe('parseOnlineornot (doc-verified)', () => {
  it('maps uptime.down using the url as the stable target when no id is present', () => {
    expect(
      parseOnlineornot({
        event: 'uptime.down',
        name: 'Shopfront',
        url: 'https://shop.acme.test',
      }),
    ).toEqual({
      source: 'onlineornot',
      targetId: 'https://shop.acme.test',
      name: 'Shopfront',
      state: 'down',
      url: 'https://shop.acme.test',
    })
  })

  it('maps heartbeat events using the heartbeat id as the target', () => {
    const alert = parseOnlineornot({
      event: 'heartbeat.down',
      id: 'hb-7',
      url: 'https://shop.acme.test',
      name: 'Shopfront',
    })
    expect(alert?.targetId).toBe('hb-7')
    expect(alert?.state).toBe('down')
  })

  it('maps up events and alert_priority words', () => {
    expect(parseOnlineornot({ event: 'uptime.up', url: 'https://shop.acme.test' })?.state).toBe('up')
    expect(
      parseOnlineornot({ event: 'uptime.down', url: 'u', alert_priority: 'critical' })?.severity,
    ).toBe('urgent')
    expect(parseOnlineornot({ event: 'uptime.down', url: 'u', alert_priority: 'low' })?.severity).toBe(
      'low',
    )
  })

  it('ignores status-page events and payloads without a target', () => {
    expect(parseOnlineornot({ event: 'status_page.incident.created', name: 'x' })).toBeNull()
    expect(parseOnlineornot({ event: 'uptime.down' })).toBeNull()
  })
})

describe('parseZabbix (contract: user-script driven JSON)', () => {
  it('maps PROBLEM (status 0) with the trigger id as target', () => {
    expect(
      parseZabbix({
        event: { id: 7001, status: 0 },
        host: { name: 'db-prod' },
        trigger: { id: 1005, name: 'High CPU' },
        severity: 'disaster',
      }),
    ).toEqual({
      source: 'zabbix',
      targetId: '1005',
      name: 'High CPU',
      state: 'down',
      severity: 'urgent',
    })
  })

  it('maps RESOLVED (status 1) and the host:trigger-name fallback target', () => {
    expect(
      parseZabbix({
        event: { id: 7001, status: 1 },
        host: { name: 'db-prod' },
        trigger: { id: 1005, name: 'High CPU' },
      })?.state,
    ).toBe('up')
    expect(
      parseZabbix({ event: { id: 2, status: 0 }, host: { name: 'web-1' }, trigger: { name: 'Disk full' } })?.targetId,
    ).toBe('web-1:Disk full')
  })

  it('accepts the flat macro shape and rejects payloads without a target', () => {
    expect(parseZabbix({ eventStatus: 0, hostName: 'web-2', triggerName: 'Down' })?.targetId).toBe(
      'web-2:Down',
    )
    expect(parseZabbix({ event: { id: 9, status: 0 } })).toBeNull()
    expect(
      parseZabbix({
        event: { id: 9, status: 2 },
        host: { name: 'h' },
        trigger: { id: 1, name: 't' },
      }),
    ).toBeNull()
  })
})

describe('parsePrtg (contract: notification-macro JSON)', () => {
  it('maps Down and Error as alerting, Up as recovery', () => {
    expect(
      parsePrtg({
        objectid: 55,
        objectname: 'Mail Gateway',
        state: 'Down',
        checkmessage: 'Service unreachable',
        mapUrl: 'https://prtg.acme.test/map/55',
      }),
    ).toEqual({
      source: 'prtg',
      targetId: '55',
      name: 'Mail Gateway',
      state: 'down',
      message: 'Service unreachable',
      url: 'https://prtg.acme.test/map/55',
    })
    expect(parsePrtg({ objectid: 55, state: 'Error' })?.state).toBe('down')
    expect(parsePrtg({ objectid: 55, state: 'Up' })?.state).toBe('up')
  })

  it('rejects unknown states and missing object ids', () => {
    expect(parsePrtg({ objectid: 55, state: 'Degraded' })).toBeNull()
    expect(parsePrtg({ objectname: 'x', state: 'Down' })).toBeNull()
  })
})

describe('parseWatcher (contract: minimal documented JSON)', () => {
  it('maps documented statuses', () => {
    expect(
      parseWatcher({
        target: 'chk-7',
        name: 'Status page',
        status: 'down',
        message: 'Timeout',
        url: 'https://st.acme.test',
      }),
    ).toEqual({
      source: 'watcher',
      targetId: 'chk-7',
      name: 'Status page',
      state: 'down',
      message: 'Timeout',
      url: 'https://st.acme.test',
    })
    expect(parseWatcher({ target: 'chk-7', status: 'alerting' })?.state).toBe('down')
    expect(parseWatcher({ target: 'chk-7', status: 'critical' })?.state).toBe('down')
    expect(parseWatcher({ target: 'chk-7', status: 'resolved' })?.state).toBe('up')
    expect(parseWatcher({ target: 'chk-7', status: 'ok' })?.state).toBe('up')
  })

  it('falls back to the id field and rejects unknown statuses', () => {
    expect(parseWatcher({ id: 'w-1', status: 'down' })?.targetId).toBe('w-1')
    expect(parseWatcher({ target: 'chk-7', status: 'flapping' })).toBeNull()
    expect(parseWatcher({ status: 'down' })).toBeNull()
  })
})

describe('parseCustom (generic escape hatch)', () => {
  it('maps the generic contract shape with severity mapping', () => {
    expect(
      parseCustom({
        target: 'svc-1',
        status: 'down',
        name: 'Search API',
        severity: 'critical',
        message: '502',
        url: 'https://search.acme.test',
      }),
    ).toEqual({
      source: 'custom',
      targetId: 'svc-1',
      name: 'Search API',
      state: 'down',
      severity: 'urgent',
      message: '502',
      url: 'https://search.acme.test',
    })
    expect(parseCustom({ target: 'svc-1', status: 'alerting' })?.state).toBe('down')
    expect(parseCustom({ target: 'svc-1', status: 'resolved' })?.state).toBe('up')
    expect(parseCustom({ target: 'svc-1', status: 'down', severity: 'medium' })?.severity).toBe(
      'normal',
    )
  })

  it('rejects unknown statuses, missing targets, and non-object bodies', () => {
    expect(parseCustom({ target: 'svc-1', status: 'warn' })).toBeNull()
    expect(parseCustom({ status: 'down' })).toBeNull()
    expect(parseCustom(['target'])).toBeNull()
    expect(parseCustom(42)).toBeNull()
  })
})

describe('PARSERS map', () => {
  it('covers all seven sources', () => {
    expect(Object.keys(PARSERS).sort()).toEqual([
      'custom',
      'kuma',
      'onlineornot',
      'prtg',
      'uptimerobot',
      'watcher',
      'zabbix',
    ])
    for (const parse of Object.values(PARSERS)) {
      expect(typeof parse).toBe('function')
    }
  })
})
