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
import { canonicalUrl, checkUrl, checkUrlResolved } from './ssrf-guard.js'

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
      network: [{ host, protocol: input.url.startsWith('http:') ? 'http' : 'https' }],
    }
  },

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const canonical = canonicalUrl(input.url)
    ctx.emit({ type: 'status', text: `Fetching ${canonical}` })

    let page: FetchedPage
    try {
      page = await guardedFetch(canonical, {
        timeoutMs: input.timeout_ms,
        signal: ctx.signal,
        allowedDomains: ctx.web?.allowedDomains,
        blockedDomains: ctx.web?.blockedDomains,
      })
    } catch (err) {
      if (err instanceof FetchBlockedError) return fail(`Blocked: ${err.message}`, 'blocked')
      return errorResult(err, 'fetch failed')
    }

    const { finalUrl, contentType, body, truncated } = page
    const hostname = new URL(finalUrl).hostname
    const note = truncated ? `\n\n[… response truncated at ${MAX_BODY_BYTES} bytes …]` : ''
    const redirected = finalUrl !== canonical ? `\nRedirected to: ${finalUrl}` : ''

    if (contentType.includes('json')) {
      const trimmed = body.length > 50_000 ? `${body.slice(0, 50_000)}\n[… truncated …]` : body
      return ok(`${trimmed}${note}\n\n---\nSource: ${finalUrl}${redirected}`, `fetched ${hostname}`)
    }

    if (!isTextual(contentType)) {
      return fail(
        `Content-Type "${contentType || 'unknown'}" is not text — cannot extract readable content.`,
        'unsupported-content-type',
      )
    }

    // Plain text and markdown are already readable; only HTML needs conversion.
    if (!/html|xml/.test(contentType)) {
      const trimmed = body.length > 50_000 ? `${body.slice(0, 50_000)}\n[… truncated …]` : body
      return ok(`${trimmed}${note}\n\n---\nSource: ${finalUrl}${redirected}`, `fetched ${hostname}`)
    }

    let focused = body
    if (input.selector) {
      const region = extractRegion(body, input.selector)
      if (region) focused = region
    }

    return ok(`${htmlToText(focused, finalUrl)}${note}${redirected}`, `fetched ${hostname}`)
  },
}

function isTextual(contentType: string): boolean {
  return (
    contentType === '' || contentType.includes('text/') || /(json|xml|javascript)/.test(contentType)
  )
}

// ---------------------------------------------------------------------------
// Guarded fetch
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5

export class FetchBlockedError extends Error {}

export interface FetchedPage {
  finalUrl: string
  status: number
  contentType: string
  body: string
  truncated: boolean
}

export interface GuardedFetchOptions {
  timeoutMs?: number
  signal?: AbortSignal
  maxRedirects?: number
  maxBytes?: number
  allowedDomains?: string[]
  blockedDomains?: string[]
  /** Injection seams for tests. */
  fetchImpl?: typeof fetch
  /** Resolve DNS and check every answer (default true). */
  resolveDns?: boolean
}

function domainMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\*?\./, '')
  return host === d || host.endsWith(`.${d}`)
}

/**
 * Fetch with the SSRF guard applied to *every* hop.
 *
 * `redirect: 'follow'` would let a public page 302 to http://169.254.169.254/,
 * so redirects are followed by hand, re-checking scheme, host, DNS and the
 * domain allow/block lists each time. The body is read as a stream and cut at
 * `maxBytes` so a hostile or huge response cannot exhaust memory.
 */
export async function guardedFetch(
  startUrl: string,
  opts: GuardedFetchOptions = {},
): Promise<FetchedPage> {
  const doFetch = opts.fetchImpl ?? fetch
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  let url = startUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = opts.resolveDns === false ? checkUrl(url) : await checkUrlResolved(url)
    if (!verdict.allowed) {
      throw new FetchBlockedError(
        hop === 0 ? (verdict.reason ?? 'not allowed') : `redirect to ${url}: ${verdict.reason}`,
      )
    }
    const host = new URL(url).hostname.toLowerCase()
    if (opts.blockedDomains?.some((d) => domainMatches(host, d))) {
      throw new FetchBlockedError(`${host} is in web.blockedDomains.`)
    }
    if (opts.allowedDomains?.length && !opts.allowedDomains.some((d) => domainMatches(host, d))) {
      throw new FetchBlockedError(`${host} is not in web.allowedDomains.`)
    }

    const response = await doFetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal,
      redirect: 'manual',
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new Error(`HTTP ${response.status} without a Location header`)
      url = new URL(location, url).toString()
      continue
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`HTTP ${response.status} from ${url}`)
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    const { text, truncated } = await readCapped(response, maxBytes, contentType)
    return { finalUrl: url, status: response.status, contentType, body: text, truncated }
  }
  throw new Error(`Too many redirects (more than ${maxRedirects}) starting at ${startUrl}`)
}

async function readCapped(
  response: Response,
  maxBytes: number,
  contentType: string,
): Promise<{ text: string; truncated: boolean }> {
  const charset = /charset=["']?([\w-]+)/.exec(contentType)?.[1] ?? 'utf-8'
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  if (!response.body) return { text: '', truncated: false }

  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(value)
      total += value.length
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }
  return { text: decoder.decode(merged), truncated }
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
