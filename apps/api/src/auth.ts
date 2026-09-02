import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { magicLink, twoFactor } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import { db } from './db'
import * as schema from './db/schema'
import { sendMagicLinkEmail } from './mail'

const baseURL = process.env.PUBLIC_URL ?? 'http://localhost:3000'

export const auth = betterAuth({
  baseURL,
  secret: process.env.AUTH_SECRET,
  appName: 'Kipple',
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      ...schema,
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  user: {
    additionalFields: {
      role: {
        type: ['superuser', 'admin', 'agent', 'contact'],
        required: true,
        defaultValue: 'agent',
        input: false,
      },
      presence: {
        type: ['online', 'away', 'busy', 'offline'],
        required: true,
        defaultValue: 'offline',
        input: false,
      },
      authSource: {
        type: 'string',
        required: true,
        defaultValue: 'local',
        input: false,
      },
      // Profile fields (user settings page). `input: false` keeps them out of
      // better-auth's own sign-up/sign-in payloads — they are written through
      // /api/me/profile only.
      phone: { type: 'string', required: false, input: false },
      address: { type: 'string', required: false, input: false },
      office: { type: 'string', required: false, input: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Staff start every session online — a fresh authentication resets
        // presence to online (the topbar picker stays the override). Contacts
        // are portal users, not staff, so their presence is left untouched.
        after: async (session) => {
          const [row] = await db
            .select({ role: schema.users.role })
            .from(schema.users)
            .where(eq(schema.users.id, session.userId))
          if (row && row.role !== 'contact') {
            await db
              .update(schema.users)
              .set({ presence: 'online' })
              .where(eq(schema.users.id, session.userId))
          }
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  trustedOrigins: [
    baseURL,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ],
  plugins: [
    twoFactor({ issuer: 'Kipple' }),
    // Passwordless sign-in for client portal accounts. The hook below decides
    // who actually receives an email (local contacts only); the plugin's
    // request response is identical either way, so it cannot be used to
    // probe which emails are accounts.
    magicLink({
      expiresIn: 600,
      storeToken: 'hashed',
      disableSignUp: true,
      rateLimit: { window: 600, max: 5 },
      sendMagicLink: async ({ email, url }) => {
        await sendMagicLinkEmail(email, url)
      },
    }),
  ],
})
