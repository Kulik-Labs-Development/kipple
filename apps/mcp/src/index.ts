import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const pingInput = z.object({ note: z.string().optional() })

const server = new Server(
  { name: 'kipple-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'server_info',
      description: 'Kipple MCP server info (scaffold placeholder)',
      inputSchema: {
        type: 'object',
        properties: { note: { type: 'string' } },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'server_info') {
    throw new Error(`unknown tool: ${req.params.name}`)
  }
  const input = pingInput.parse(req.params.arguments ?? {})
  return {
    content: [
      {
        type: 'text',
        text: input.note
          ? `Kipple MCP 0.1.0 — ${input.note}`
          : 'Kipple MCP 0.1.0 (scaffold placeholder)',
      },
    ],
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('kipple-mcp failed to start', error)
  process.exit(1)
})
