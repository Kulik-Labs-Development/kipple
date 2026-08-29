import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { APIError, betterAuth } from 'better-auth'
import { twoFactor } from 'better-auth/plugins'
import { db } from './db'
import * as schema from './db/schema'
import { users } from './db/schema'

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
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          const [existing] = await db.select({ id: users.id }).from(users).limit(1)
          if (existing) {
            throw new APIError('FORBIDDEN', {
              message: 'Signups are closed on this instance',
            })
          }
        },
      },
    },
  },
  trustedOrigins: [
    baseURL,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ],
  plugins: [twoFactor({ issuer: 'Kipple' })],
})
