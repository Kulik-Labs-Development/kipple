import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { SMTPServer } from 'smtp-server'
import { createSmtpProvider } from './smtp'
import { isPermanentMailError } from '../deliver'

interface Captured {
  mailFrom: string
  rcptTo: string[]
  data: string
  user: string | null
}

function startServer(opts: { requireAuth: boolean; username?: string; password?: string }) {
  const captured: Captured = { mailFrom: '', rcptTo: [], data: '', user: null }
  const server = new SMTPServer({
    authOptional: !opts.requireAuth,
    allowInsecureAuth: true,
    secure: false,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      if (auth.username === opts.username && auth.password === opts.password) {
        callback(null, { user: auth.username })
      } else {
        callback(new Error('Invalid login'))
      }
    },
    onMailFrom(address, _session, callback) {
      captured.mailFrom = address.address
      callback()
    },
    onRcptTo(address, _session, callback) {
      captured.rcptTo.push(address.address)
      callback()
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        captured.data = Buffer.concat(chunks).toString('utf8')
        callback(null, 'OK')
      })
    },
  })
  return new Promise<{ server: SMTPServer; port: number; captured: Captured; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.server.address()
        resolve({
          server,
          port: typeof address === 'object' && address ? address.port : 0,
          captured,
          close: () => new Promise((done) => server.close(done)),
        })
      })
    },
  )
}

describe('SmtpProvider', () => {
  let close: (() => Promise<void>) | null = null

  beforeEach(() => {
    close = null
  })

  afterAll(async () => {
    await close?.()
  })

  it('sends a message with from/to/reply-to/subject/message-id', async () => {
    const { port, captured, close: serverClose } = await startServer({
      requireAuth: true,
      username: 'relay',
      password: 'secret',
    })
    close = serverClose
    const provider = createSmtpProvider({
      host: '127.0.0.1',
      port,
      secure: false,
      startTls: false,
      auth: { username: 'relay', password: 'secret' },
      from: 'support@msp.test',
      fromName: 'MSP, Support',
    })

    const result = await provider.send({
      to: 'ada@acme.test',
      from: 'support@msp.test',
      fromName: 'MSP, Support',
      subject: 'Re: [KIP-12] Printer is on fire',
      body: 'Let us know when the smoke clears.',
      replyTo: 'support+12@msp.test',
      messageId: '<12@msp.test>',
    })
    expect(result.ok).toBe(true)

    expect(captured.mailFrom).toBe('support@msp.test')
    expect(captured.rcptTo).toEqual(['ada@acme.test'])
    expect(captured.data).toContain('To: ada@acme.test')
    expect(captured.data).toContain('From: "MSP, Support" <support@msp.test>')
    expect(captured.data).toContain('Reply-To: support+12@msp.test')
    expect(captured.data).toContain('Subject: Re: [KIP-12] Printer is on fire')
    expect(captured.data).toContain('Message-ID: <12@msp.test>')
    expect(captured.data).toContain('Let us know when the smoke clears.')
  })

  it('sends without auth when none is configured', async () => {
    const { port, captured, close: serverClose } = await startServer({ requireAuth: false })
    close = serverClose
    const provider = createSmtpProvider({
      host: '127.0.0.1',
      port,
      secure: false,
      startTls: false,
      from: 'support@msp.test',
    })
    const result = await provider.send({
      to: 'ada@acme.test',
      from: 'support@msp.test',
      subject: 'hello',
      body: 'body',
    })
    expect(result.ok).toBe(true)
    expect(captured.rcptTo).toEqual(['ada@acme.test'])
  })

  it('testConnection reports success and failure', async () => {
    const { port, close: serverClose } = await startServer({
      requireAuth: true,
      username: 'relay',
      password: 'secret',
    })
    close = serverClose
    const good = createSmtpProvider({
      host: '127.0.0.1',
      port,
      secure: false,
      startTls: false,
      auth: { username: 'relay', password: 'secret' },
      from: 'support@msp.test',
    })
    expect((await good.testConnection()).ok).toBe(true)

    const bad = createSmtpProvider({
      host: '127.0.0.1',
      port,
      secure: false,
      startTls: false,
      auth: { username: 'relay', password: 'wrong' },
      from: 'support@msp.test',
    })
    const badResult = await bad.testConnection()
    expect(badResult.ok).toBe(false)
    expect(badResult.detail).toBeTruthy()
  })

  it('surfaces auth failures as permanent errors', async () => {
    const { port, close: serverClose } = await startServer({
      requireAuth: true,
      username: 'relay',
      password: 'secret',
    })
    close = serverClose
    const provider = createSmtpProvider({
      host: '127.0.0.1',
      port,
      secure: false,
      startTls: false,
      auth: { username: 'relay', password: 'wrong' },
      from: 'support@msp.test',
    })
    let caught: unknown
    try {
      await provider.send({
        to: 'ada@acme.test',
        from: 'support@msp.test',
        subject: 'x',
        body: 'y',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(isPermanentMailError(caught)).toBe(true)
  })
})

describe('isPermanentMailError', () => {
  it('flags auth and hard-reject codes', () => {
    expect(isPermanentMailError({ responseCode: 535, message: '5.7.8 Authentication credentials invalid' })).toBe(true)
    expect(isPermanentMailError({ responseCode: 550, message: '550 5.1.1 User unknown' })).toBe(true)
    expect(isPermanentMailError(new Error('Invalid login: 5.7.8'))).toBe(true)
    expect(isPermanentMailError(new Error('Authentication failed'))).toBe(true)
  })

  it('treats transport errors as retryable', () => {
    expect(isPermanentMailError({ responseCode: 421, message: '421 try again' })).toBe(false)
    expect(isPermanentMailError(new Error('connect ECONNREFUSED 127.0.0.1:25'))).toBe(false)
    expect(isPermanentMailError(new Error('timeout') as Error)).toBe(false)
  })
})
