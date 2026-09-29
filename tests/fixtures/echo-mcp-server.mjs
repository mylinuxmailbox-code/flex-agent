// A minimal stdio MCP server used by the tests. Tools: echo, env_keys, slow.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo', version: '1.0.0' })
server.tool('echo', 'Echo text back', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo:${text}` }],
}))
server.tool('env_keys', 'List env var names visible to the server', {}, async () => ({
  content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }],
}))
server.tool('fail', 'Always fails', {}, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'boom' }],
}))
await server.connect(new StdioServerTransport())
