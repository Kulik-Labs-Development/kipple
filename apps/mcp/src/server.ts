import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { KippleClient } from './client'
import { MCP_TOOLS } from './tools'

// The MCP server proper: one shared tool registry, both transports. The
// advertised input schemas are generated from the same Zod objects used to
// validate calls, so what a client sees is what the server checks.

const SERVER_INFO = { name: 'kipple-mcp', version: '0.1.0' }

function advertisedTools(): Tool[] {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.input, {
      target: 'openApi3',
      $refStrategy: 'none',
    }) as Tool['inputSchema'],
  }))
}

export function buildServer(client: KippleClient): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertisedTools(),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === request.params.name)
    if (!tool) throw new Error(`unknown tool: ${request.params.name}`)
    const parsed = tool.input.safeParse(request.params.arguments ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(`invalid arguments for ${tool.name}: ${issue?.message ?? 'unknown'}`)
    }
    const text = await tool.run(client, parsed.data)
    return { content: [{ type: 'text', text }] }
  })

  return server
}
