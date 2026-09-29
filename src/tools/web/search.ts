/**
 * web_search tool.
 *
 * Searches the web using the configured provider (`web.provider`; `auto` picks
 * Brave, Tavily or Exa from the environment, else DuckDuckGo). Results are returned as a
 * formatted list with URLs, titles, and snippets.
 *
 * Risk: network-external, read-only. Safe to auto-approve.
 */

import { z } from 'zod'
import type { ActionDescription } from '../../permissions/types.js'
import type { Tool } from '../types.js'
import { errorResult, fail, ok, type ToolContext, type ToolResult } from '../types.js'
import { createSearchProvider } from './providers.js'
import type { SearchResult, WebSearchProvider } from './types.js'

const inputSchema = z.object({
  query: z.string().min(1).describe('The search query.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Maximum number of results (default 8, capped by web.maxResults).'),
  allow_domains: z
    .array(z.string())
    .optional()
    .describe('Only return results from these domains, e.g. ["docs.python.org"].'),
  block_domains: z
    .array(z.string())
    .optional()
    .describe('Never return results from these domains.'),
  locale: z
    .string()
    .optional()
    .describe('Two-letter locale, e.g. "en". Passed as a hint to the search provider.'),
})

export const webSearchTool: Tool<typeof inputSchema> = {
  name: 'web_search',
  description:
    'Search the web for current information. Use when you need up-to-date documentation, ' +
    'package versions, error messages, migration guides, or anything that may have changed ' +
    'since training. Returns a list of results with URL, title, and a short snippet. ' +
    'Follow up with web_fetch to read the full content of a specific page.',
  inputSchema,
  readOnly: true,
  category: 'web',
  promptGuidance:
    'Use web_search when information may be current, version-dependent, or not in the repository. ' +
    "Do not search for things you already know. When in doubt about a package's current API or " +
    'an error message you have not seen before, search first.',

  plan(input, _ctx): ActionDescription {
    return {
      tool: 'web_search',
      purpose: `search: ${input.query}`,
      input,
      network: [{ host: 'search-api', protocol: 'https' }],
    }
  },

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    ctx.emit({ type: 'status', text: `Searching: ${input.query}` })

    let provider: WebSearchProvider | null
    try {
      provider = createSearchProvider({ provider: ctx.web?.provider, apiKey: ctx.web?.apiKey })
    } catch (err) {
      return errorResult(err, 'search unavailable')
    }
    if (!provider)
      return fail('Web search is disabled (web.provider is "none").', 'search disabled')

    // Config domain lists always apply; the model's lists narrow further.
    const allowDomains = input.allow_domains?.length ? input.allow_domains : ctx.web?.allowedDomains
    const blockDomains = [...(ctx.web?.blockedDomains ?? []), ...(input.block_domains ?? [])]
    const limit = Math.min(input.limit ?? ctx.web?.maxResults ?? 8, ctx.web?.maxResults ?? 20)

    let results: SearchResult[]
    try {
      results = await provider.search(input.query, {
        limit,
        locale: input.locale,
        allowDomains,
        blockDomains,
      })
    } catch (err) {
      return errorResult(err, 'search failed')
    }

    if (results.length === 0) {
      return fail(`No results found for: ${input.query}`, 'no results')
    }

    const lines: string[] = [
      `Search results for: "${input.query}" (${results.length} results, via ${provider.label})`,
      '',
    ]

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (!r) continue
      lines.push(`${i + 1}. ${r.title}`)
      lines.push(`   URL: ${r.url}`)
      if (r.snippet) lines.push(`   ${r.snippet}`)
      if (r.freshness) lines.push(`   (${r.freshness})`)
      lines.push('')
    }

    lines.push('Use web_fetch to read the full content of a specific page.')

    return ok(lines.join('\n'), `${results.length} results for "${input.query.slice(0, 40)}"`)
  },
}
