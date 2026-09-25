/**
 * web_fetch tool.
 *
 * Downloads a URL, converts the HTML to readable text, and returns it with a
 * citation. The SSRF guard runs before the request is made.
 *
 * Risk: network-external, read-only. Safe to auto-approve.
 */

import { z } from 'zod'
import type { ActionDescription } from '../../permissions/types.js'
import { errorResult, fail, ok, type Tool, type ToolContext, type ToolResult } from '../types.js'
import { htmlToText } from './html-to-text.js'
import { canonicalUrl, checkUrl } from './ssrf-guard.js'

const inputSchema = z.object({
  url: z.string().url().describe('The URL to fetch.'),
  selector: z
    .string()
    .optional()
    .describe(
      'Optional CSS-like path hint to focus on a section, e.g. "main", "article", "#content". ' +
        'When provided, the tool attempts to extract only that region before converting to text.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .optional()
    .default(15_000)
    .describe('Request timeout in milliseconds (default 15 000).'),
})

export const webFetchTool: Tool<typeof inputSchema> = {
  name: 'web_fetch',
  description:
    'Download a web page and return its content as readable text. ' +
    'Use after web_search to read the full content of a result. ' +
    'Also use directly when you have a specific documentation URL. ' +
    'Returns extracted text with a source citation.',
  inputSchema,
  readOnly: true,
  category: 'web',

  plan(input, _ctx): ActionDescription {
    let host = input.url
    try {
      host = new URL(input.url).hostname
    } catch {
      /* ok */
    }
    return {
      tool: 'web_fetch',
      purpose: `fetch ${input.url}`,
      input,
      network: [{ host, protocol: 'https', transmits: 'none (read-only fetch)' }],
    }
  },

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const canonical = canonicalUrl(input.url)
    const check = checkUrl(canonical)
    if (!check.allowed) {
      return fail(`Blocked: ${check.reason}`, 'ssrf-blocked')
    }

    ctx.emit({ type: 'status', text: `Fetching ${canonical}` })

    let html: string
    try {
      const response = await fetch(canonical, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(input.timeout_ms),
        redirect: 'follow',
      })

      if (!response.ok) {
        return fail(`HTTP ${response.status} from ${canonical}`, `http-${response.status}`)
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const json = await response.text()
        const trimmed = json.length > 50_000 ? `${json.slice(0, 50_000)}\n[… truncated …]` : json
        return ok(
          `${trimmed}\n\n---\nSource: ${canonical}`,
          `fetched ${new URL(canonical).hostname}`,
        )
      }

      if (!contentType.includes('text/')) {
        return fail(
          `Content-Type "${contentType}" is not text — cannot extract readable content.`,
          'unsupported-content-type',
        )
      }

      html = await response.text()
    } catch (err) {
      return errorResult(err, 'fetch failed')
    }

    // Optional: focus on a specific region by looking for the selector hint.
    let focused = html
    if (input.selector) {
      const region = extractRegion(html, input.selector)
      if (region) focused = region
    }

    const text = htmlToText(focused, canonical)
    const hostname = new URL(canonical).hostname

    return ok(text, `fetched ${hostname}`)
  },
}

/**
 * Very lightweight region extractor.
 *
 * Real CSS selectors require a full DOM parser. We handle the common cases
 * (id, tag name, class) with regex and fall back to the full document when the
 * hint does not match.
 */
function extractRegion(html: string, selector: string): string | null {
  const s = selector.trim()

  // id selector: #content, #main-content
  const idMatch = s.match(/^#([\w-]+)$/)
  if (idMatch) {
    const id = idMatch[1]
    const re = new RegExp(`<[a-z][^>]+id="${id}"[^>]*>([\\s\\S]*?)</[a-z]+>`, 'i')
    return re.exec(html)?.[1] ?? null
  }

  // tag selector: main, article, section
  const tagMatch = s.match(/^([a-z][a-z0-9]*)$/)
  if (tagMatch) {
    const tag = tagMatch[1]
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
    return re.exec(html)?.[1] ?? null
  }

  // class selector: .content, .article-body
  const classMatch = s.match(/^\.([\w-]+)$/)
  if (classMatch) {
    const cls = classMatch[1]
    const re = new RegExp(`<[a-z][^>]+class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</[a-z]+>`, 'i')
    return re.exec(html)?.[1] ?? null
  }

  return null
}
