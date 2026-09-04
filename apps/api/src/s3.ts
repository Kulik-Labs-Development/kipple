import { createHash, createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

// Zero-dependency S3-compatible storage backend (plan row 18, part 2 — issue
// #34). Implements AWS Signature V4 over the S3 REST API using only
// node:crypto + node:http(s) — no AWS SDK. Activated all-or-nothing by env:
// S3_ENDPOINT + S3_BUCKET + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY all set =
// S3 backend; anything missing/invalid = local disk under STORAGE_DIR (the
// routing lives in storage.ts). Works against AWS S3 and S3-compatible
// object stores (MinIO, R2, ...); for IP/non-DNS endpoints set
// S3_FORCE_PATH_STYLE=true.

export const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

// Default presigned-URL lifetime. Short on purpose: the attachment download
// route mints a fresh URL on every request, so an expired link just means
// one more click, not a standing bearer credential.
export const PRESIGN_EXPIRES_SEC = 900

const CONNECT_TIMEOUT_MS = 10_000
const RESPONSE_TIMEOUT_MS = 120_000

export type S3Config = {
  endpoint: URL
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  prefix: string
}

// Resolved on every call so tests (and config reloads) can flip the backend
// without restarting (same pattern as storageDir()).
export function s3Config(): S3Config | null {
  const endpoint = process.env.S3_ENDPOINT?.trim()
  const bucket = process.env.S3_BUCKET?.trim()
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim()
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const prefix = (process.env.S3_PATH_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '')
  return {
    endpoint: url,
    bucket,
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE?.trim().toLowerCase() === 'true',
    prefix,
  }
}

export function isS3Configured(): boolean {
  return s3Config() !== null
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  return hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${secret}`, dateStamp), region), 's3'),
    'aws4_request',
  )
}

export function toAmzDate(date: Date): string {
  // YYYYMMDDTHHMMSS'Z'
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// RFC 3986 path-segment encoding: unreserved (A-Z a-z 0-9 - _ . ~) pass,
// everything else percent-encoded in UTF-8.
function encodePathSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9\-_.~]/g, (ch) =>
    Array.from(Buffer.from(ch, 'utf8'))
      .map((b) => '%' + b.toString(16).toUpperCase())
      .join(''),
  )
}

// Query-name/value encoding per the SigV4 spec (RFC 3986; the four chars
// encodeURIComponent leaves bare get escaped too).
export function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeQueryComponent(key)}=${encodeQueryComponent(params[key])}`)
    .join('&')
}

// Where the object lives: path-style puts the bucket in the path (MinIO /
// IP endpoints), virtual-host puts it in the host (AWS default).
function objectTarget(config: S3Config, key: string): { path: string; host: string } {
  const fullKey = config.prefix ? `${config.prefix}/${key}` : key
  const encoded = '/' + fullKey.split('/').map(encodePathSegment).join('/')
  if (config.forcePathStyle) {
    return { path: `/${config.bucket}${encoded}`, host: config.endpoint.host }
  }
  return { path: encoded, host: `${config.bucket}.${config.endpoint.host}` }
}

function signedRequest(
  config: S3Config,
  method: string,
  path: string,
  host: string,
  extraHeaders: Record<string, string>,
  payloadHash: string,
): Record<string, string> {
  const date = new Date()
  const xAmzDate = toAmzDate(date)
  const headers: Record<string, string> = { host, 'x-amz-date': xAmzDate }
  for (const [name, value] of Object.entries(extraHeaders)) headers[name.toLowerCase()] = value
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join('')
  const dateStamp = xAmzDate.slice(0, 8)
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join(
    '\n',
  )
  const stringToSign = ['AWS4-HMAC-SHA256', xAmzDate, scope, sha256Hex(canonicalRequest)].join(
    '\n',
  )
  const signature = hmacSha256(
    signingKey(config.secretAccessKey, dateStamp, config.region),
    stringToSign,
  ).toString('hex')
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}

type S3Result = { status: number; headers: NodeJS.Dict<string | string[] | undefined>; body: Buffer }

function rawRequest(
  config: S3Config,
  method: string,
  path: string,
  host: string,
  headers: Record<string, string>,
  body: Buffer | null,
): Promise<S3Result> {
  const isHttps = config.endpoint.protocol === 'https:'
  const doRequest = isHttps ? httpsRequest : httpRequest
  // host is the full Host header value (may carry :port, may be a
  // virtual-host bucket prefix) — split it for the socket address. The
  // port is numeric-or-absent; anything else is the hostname itself.
  const lastColon = host.lastIndexOf(':')
  const hasPort = lastColon > -1 && /^\d+$/.test(host.slice(lastColon + 1))
  const hostname = hasPort ? host.slice(0, lastColon) : host
  const port = hasPort ? Number(host.slice(lastColon + 1)) : undefined
  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        protocol: config.endpoint.protocol,
        hostname,
        port: port ?? (isHttps ? 443 : 80),
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        )
        res.on('error', reject)
      },
    )
    req.setTimeout(CONNECT_TIMEOUT_MS + RESPONSE_TIMEOUT_MS, () =>
      req.destroy(new Error(`S3 request timed out (${method} ${path})`)),
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function failWith(status: number, body: Buffer, context: string): never {
  const snippet = body.toString('utf8').slice(0, 300)
  throw new Error(`S3 ${context} failed (HTTP ${status}): ${snippet}`)
}

function requireConfig(): S3Config {
  const config = s3Config()
  if (!config) throw new Error('S3 is not configured (storage backend is local disk)')
  return config
}

// PUT an object. The object's content-type is deliberately NOT stored: kipple
// never trusts stored mimes (image mimes are magic-sniffed on serve;
// attachment mimes live in the DB row), so there is nothing to write.
export async function s3PutObject(storageKey: string, bytes: Buffer): Promise<void> {
  const config = requireConfig()
  const { path, host } = objectTarget(config, storageKey)
  const headers = signedRequest(
    config,
    'PUT',
    path,
    host,
    { 'content-length': String(bytes.length) },
    sha256Hex(bytes),
  )
  const result = await rawRequest(config, 'PUT', path, host, headers, bytes)
  if (result.status !== 200) failWith(result.status, result.body, `PUT ${storageKey}`)
}

// GET an object, or null when it does not exist (404 NoSuchKey).
export async function s3GetObject(storageKey: string): Promise<Buffer | null> {
  const config = requireConfig()
  const { path, host } = objectTarget(config, storageKey)
  const headers = signedRequest(config, 'GET', path, host, {}, EMPTY_SHA256)
  const result = await rawRequest(config, 'GET', path, host, headers, null)
  if (result.status === 404) return null
  if (result.status !== 200) failWith(result.status, result.body, `GET ${storageKey}`)
  return result.body
}

// HEAD an object: { size } or null when it does not exist.
export async function s3HeadObject(storageKey: string): Promise<{ size: number } | null> {
  const config = requireConfig()
  const { path, host } = objectTarget(config, storageKey)
  const headers = signedRequest(config, 'HEAD', path, host, {}, EMPTY_SHA256)
  const result = await rawRequest(config, 'HEAD', path, host, headers, null)
  if (result.status === 404) return null
  if (result.status !== 200) failWith(result.status, result.body, `HEAD ${storageKey}`)
  const length = result.headers['content-length']
  const size = Number(Array.isArray(length) ? length[0] : length)
  if (!Number.isFinite(size)) throw new Error(`S3 HEAD ${storageKey} had no usable Content-Length`)
  return { size }
}

// DELETE an object. Missing objects are a no-op (same semantics as the local
// deleteAttachmentFile, which never throws on an already-gone file).
export async function s3DeleteObject(storageKey: string): Promise<void> {
  const config = requireConfig()
  const { path, host } = objectTarget(config, storageKey)
  const headers = signedRequest(config, 'DELETE', path, host, {}, EMPTY_SHA256)
  const result = await rawRequest(config, 'DELETE', path, host, headers, null)
  if (result.status !== 204 && result.status !== 404) {
    failWith(result.status, result.body, `DELETE ${storageKey}`)
  }
}

export type PresignOptions = {
  expiresSec?: number
  // S3 response-override params (signed into the URL). Used so the download
  // keeps its DB mime / content-disposition when it is served straight from
  // the bucket instead of through the API.
  responseContentType?: string
  responseContentDisposition?: string
}

// Mint a presigned GET URL (query-string SigV4) for direct browser→bucket
// downloads. The scope check happens in the route BEFORE the URL is minted,
// so the URL is only ever issued for a file the caller may see.
export function s3PresignGet(storageKey: string, options: PresignOptions = {}): string {
  const config = requireConfig()
  const expiresSec = options.expiresSec ?? PRESIGN_EXPIRES_SEC
  const date = new Date()
  const xAmzDate = toAmzDate(date)
  const scope = `${xAmzDate.slice(0, 8)}/${config.region}/s3/aws4_request`
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': xAmzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  }
  if (options.responseContentType) params['response-content-type'] = options.responseContentType
  if (options.responseContentDisposition) {
    params['response-content-disposition'] = options.responseContentDisposition
  }
  const { path, host } = objectTarget(config, storageKey)
  const query = canonicalQuery(params)
  const canonicalRequest = ['GET', path, query, `host:${host}\n`, 'host', EMPTY_SHA256].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', xAmzDate, scope, sha256Hex(canonicalRequest)].join(
    '\n',
  )
  const signature = hmacSha256(signingKey(config.secretAccessKey, xAmzDate.slice(0, 8), config.region), stringToSign).toString('hex')
  // Built as a plain string (no URL re-serialization): the signed query must
  // hit the wire byte-identical to what was signed.
  return `${config.endpoint.protocol}//${host}${path}?${query}&X-Amz-Signature=${signature}`
}
