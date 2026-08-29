import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://kipple:kipple@localhost:5432/kipple_test',
      AUTH_SECRET:
        process.env.AUTH_SECRET ?? 'test-auth-secret-0123456789abcdef0123456789abcdef',
      PUBLIC_URL: 'http://localhost:3000',
    },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
})
