import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { KippleClient } from './client'
import { buildServer } from './server'

// Entry point. The server talks to the Kipple REST API over HTTP with an API
// key (env KIPPLE_API_URL + KIPPLE_API_KEY) and never reaches in-process into
// the domain layer — it dogfoods the REST API it fronts.
//
// Transports (the repo's existing claims, both live):
//   - stdio (default) — for local MCP clients: `kipple-mcp` on stdin/stdout
//   - streamable HTTP — for remote MCP clients: KIPPLE_MCP_TRANSPORT=http,
//     KIPPLE_MCP_HTTP_PORT (default 8080), KIPPLE_MCP_HTTP_PATH (default
//     /mcp). Stateless mode (a fresh server per request): the stack is
//     stateless at rest, so there is nothing to persist between requests.

export function resolveConfig() {
  const baseUrl = process.env.KIPPLE_API_URL ?? 'http://localhost:3000'
  const apiKey = process.env.KIPPLE_API_KEY
  if (!apiKey) {
    throw new Error(
      'KIPPLE_API_KEY is required (create one in the Kipple superuser settings, "API & MCP" panel)',
    )
  }
  return { baseUrl, apiKey }
}

export async function connectStdio(client: KippleClient): Promise<void> {
  const transport = new StdioServerTransport()
  await buildServer(client).connect(transport)
}

export async function serveHttp(client: KippleClient, port: number, path: string) {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url !== path && url !== `${path}/`) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    if (req.method === 'POST') {
      // Stateless: a fresh transport + server for every request.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await buildServer(client).connect(transport)
      await transport.handleRequest(req, res)
      return
    }
    // GET (server-initiated SSE) and DELETE (session teardown) are unused in
    // stateless mode.
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({ error: 'method not allowed (stateless mode; use POST)' }))
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })
  return httpServer
}

async function main() {
  const { baseUrl, apiKey } = resolveConfig()
  const client = new KippleClient(baseUrl, apiKey)
  if (process.env.KIPPLE_MCP_TRANSPORT === 'http') {
    const port = Number(process.env.KIPPLE_MCP_HTTP_PORT ?? 8080)
    await serveHttp(client, port, process.env.KIPPLE_MCP_HTTP_PATH ?? '/mcp')
    process.stderr.write(`kipple-mcp: streamable HTTP on :${port}${process.env.KIPPLE_MCP_HTTP_PATH ?? '/mcp'}\n`)
    return
  }
  await connectStdio(client)
}

main().catch((error) => {
  process.stderr.write(`kipple-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
