import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

// At-rest encryption for instance settings that carry credentials
// (SMTP/IMAP passwords, integration tokens). AES-256-GCM, key derived from
// AUTH_SECRET so no extra secret has to be provisioned.
const PREFIX = 'enc1'
const KDF_SALT = 'kipple.settings.v1'

export function encryptAtRest(plaintext: string, secret: string): string {
  const key = scryptSync(secret, KDF_SALT, 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decryptAtRest(stored: string, secret: string): string {
  if (!stored.startsWith(PREFIX)) return stored
  const parts = stored.split(':')
  if (parts.length !== 4 || !parts[1] || !parts[2]) {
    throw new Error('malformed encrypted value')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const key = scryptSync(secret, KDF_SALT, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(PREFIX)
}
