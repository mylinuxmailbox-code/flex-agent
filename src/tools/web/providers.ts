/**
 * Web search providers.
 *
 * Two implementations:
 *   1. BraveSearchProvider  — real API, requires BRAVE_API_KEY
 *   2. DuckDuckGoProvider   — HTML scraper, no key required (slower, fewer results)
 *
 * The tool picks whichever is available at runtime.
 */

import type { SearchOptions, SearchResult, WebSearchProvider } from './types.js'

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

export class BraveSearchProvider implements WebSearchProvider {
  readonly id = 'brave'
  readonly label = 'Brave Search'
  readonly #apiKey: string

  constructor(apiKey: string) {
    this.#apiKey = apiKey
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = Math.min(opts.limit ?? 10, 20)
    const params = new URLSearchParams({
      q: query,
      count: String(limit),
      ...(opts.locale ? { country: opts.locale } : {}),
    })

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': this.#apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      throw new Error(`Brave Search API error ${response.status}: ${await response.text()}`)
    }

    const data = (await response.json()) as BraveResponse
    const results: SearchResult[] = []

    for (const item of data.web?.results ?? []) {
      const domain = extractDomain(item.url)
      if (opts.allowDomains && !opts.allowDomains.some((d) => domain.endsWith(d))) continue
      if (opts.blockDomains?.some((d) => domain.endsWith(d))) continue
      results.push({
        url: item.url,
        title: item.title,
        snippet: item.description ?? '',
        domain,
        freshness: item.age,
      })
    }

    return results
  }
}

interface BraveResponse {
  web?: {
    results?: Array<{
      url: string
      title: string
      description?: string
      age?: string
    }>
  }
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML scraper (no-key fallback)
// ---------------------------------------------------------------------------

export class DuckDuckGoProvider implements WebSearchProvider {
  readonly id = 'duckduckgo'
  readonly label = 'DuckDuckGo'

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 8

    // DDG's HTML endpoint — stable enough for a fallback.
    const params = new URLSearchParams({ q: query, kl: opts.locale ?? 'en-us' })
    const response = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      throw new Error(`DuckDuckGo error ${response.status}`)
    }

    const html = await response.text()
    return parseDdgHtml(html, limit, opts)
  }
}

/**
 * Minimal DDG HTML parser.
 *
 * DDG's HTML output is stable: results are in `.result` divs with `a.result__a`
 * links and `.result__snippet` snippets. No heavy HTML parser needed.
 */
function parseDdgHtml(html: string, limit: number, opts: SearchOptions): SearchResult[] {
  const results: SearchResult[] = []

  // Match result blocks
  const blockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g

  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard while-loop pattern
  while ((match = blockRe.exec(html)) !== null && results.length < limit) {
    const [, rawUrl, titleHtml, snippetHtml] = match
    if (!rawUrl) continue

    let url = rawUrl
    // DDG wraps URLs in a redirect — extract the real `uddg` param when present.
    try {
      const u = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl)
      url = u.searchParams.get('uddg') ?? u.searchParams.get('u') ?? rawUrl
    } catch {
      /* keep raw */
    }

    const title = stripTags(titleHtml ?? '').trim()
    const snippet = stripTags(snippetHtml ?? '').trim()
    const domain = extractDomain(url)

    if (!title || !url.startsWith('http')) continue
    if (opts.allowDomains && !opts.allowDomains.some((d) => domain.endsWith(d))) continue
    if (opts.blockDomains?.some((d) => domain.endsWith(d))) continue

    results.push({ url, title, snippet, domain })
  }

  return results
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Pick the best available provider. */
export function createSearchProvider(): WebSearchProvider {
  const braveKey = process.env.BRAVE_API_KEY
  if (braveKey) return new BraveSearchProvider(braveKey)
  return new DuckDuckGoProvider()
}
