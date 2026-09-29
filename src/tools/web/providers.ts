/**
 * Web search providers.
 *
 *   - Brave Search  (BRAVE_API_KEY)
 *   - Tavily        (TAVILY_API_KEY)
 *   - Exa           (EXA_API_KEY)
 *   - DuckDuckGo    (HTML scraper, no key — slower, fewer results)
 *
 * `createSearchProvider` picks one from `web.provider` config and the
 * environment. Domain allow/block filtering is applied once, centrally, by
 * `filterResults`, so a provider only has to fetch and map.
 */

import type { SearchOptions, SearchResult, WebSearchProvider } from './types.js'

export type FetchLike = typeof fetch

/** `example.com` matches itself and `docs.example.com`, but not `notexample.com`. */
export function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  const d = domain
    .toLowerCase()
    .replace(/^\*?\./, '')
    .replace(/^www\./, '')
  return h === d || h.endsWith(`.${d}`)
}

export function filterResults(results: SearchResult[], opts: SearchOptions): SearchResult[] {
  return results.filter((r) => {
    if (opts.allowDomains?.length && !opts.allowDomains.some((d) => domainMatches(r.domain, d))) {
      return false
    }
    if (opts.blockDomains?.some((d) => domainMatches(r.domain, d))) return false
    return true
  })
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`${label} error ${response.status}${text ? `: ${text}` : ''}`)
  }
  return (await response.json()) as T
}

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

export class BraveSearchProvider implements WebSearchProvider {
  readonly id = 'brave'
  readonly label = 'Brave Search'
  readonly #apiKey: string
  readonly #fetch: FetchLike

  constructor(apiKey: string, fetchImpl: FetchLike = fetch) {
    this.#apiKey = apiKey
    this.#fetch = fetchImpl
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = Math.min(opts.limit ?? 10, 20)
    const params = new URLSearchParams({
      q: query,
      // Over-fetch when filtering by domain so filters do not starve the result set.
      count: String(opts.allowDomains?.length || opts.blockDomains?.length ? 20 : limit),
      ...(opts.locale ? { search_lang: opts.locale.slice(0, 2).toLowerCase() } : {}),
    })
    const response = await this.#fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.#apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    })
    const data = await readJson<BraveResponse>(response, 'Brave Search API')
    const results: SearchResult[] = (data.web?.results ?? []).map((item) => ({
      url: item.url,
      title: item.title,
      snippet: item.description ?? '',
      domain: extractDomain(item.url),
      freshness: item.age,
    }))
    return filterResults(results, opts).slice(0, limit)
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
  readonly #fetch: FetchLike

  constructor(fetchImpl: FetchLike = fetch) {
    this.#fetch = fetchImpl
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 8

    // DDG's HTML endpoint — stable enough for a fallback.
    const params = new URLSearchParams({ q: query, kl: opts.locale ?? 'en-us' })
    const response = await this.#fetch(`https://html.duckduckgo.com/html/?${params}`, {
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
  while ((match = blockRe.exec(html)) !== null && results.length < 50) {
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

    results.push({ url, title, snippet, domain })
  }

  return filterResults(results, opts).slice(0, limit)
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
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
// Tavily
// ---------------------------------------------------------------------------

export class TavilyProvider implements WebSearchProvider {
  readonly id = 'tavily'
  readonly label = 'Tavily'
  readonly #apiKey: string
  readonly #fetch: FetchLike

  constructor(apiKey: string, fetchImpl: FetchLike = fetch) {
    this.#apiKey = apiKey
    this.#fetch = fetchImpl
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = Math.min(opts.limit ?? 10, 20)
    const response = await this.#fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({
        query,
        max_results: limit,
        include_answer: false,
        ...(opts.allowDomains?.length ? { include_domains: opts.allowDomains } : {}),
        ...(opts.blockDomains?.length ? { exclude_domains: opts.blockDomains } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = await readJson<{
      results?: Array<{ url: string; title?: string; content?: string; published_date?: string }>
    }>(response, 'Tavily API')
    const results: SearchResult[] = (data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: (r.content ?? '').slice(0, 400),
      domain: extractDomain(r.url),
      freshness: r.published_date,
    }))
    return filterResults(results, opts).slice(0, limit)
  }
}

// ---------------------------------------------------------------------------
// Exa
// ---------------------------------------------------------------------------

export class ExaProvider implements WebSearchProvider {
  readonly id = 'exa'
  readonly label = 'Exa'
  readonly #apiKey: string
  readonly #fetch: FetchLike

  constructor(apiKey: string, fetchImpl: FetchLike = fetch) {
    this.#apiKey = apiKey
    this.#fetch = fetchImpl
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = Math.min(opts.limit ?? 10, 20)
    const response = await this.#fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.#apiKey },
      body: JSON.stringify({
        query,
        numResults: limit,
        contents: { text: { maxCharacters: 400 } },
        ...(opts.allowDomains?.length ? { includeDomains: opts.allowDomains } : {}),
        ...(opts.blockDomains?.length ? { excludeDomains: opts.blockDomains } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = await readJson<{
      results?: Array<{ url: string; title?: string | null; text?: string; publishedDate?: string }>
    }>(response, 'Exa API')
    const results: SearchResult[] = (data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title || r.url,
      snippet: (r.text ?? '').replace(/\s+/g, ' ').trim(),
      domain: extractDomain(r.url),
      freshness: r.publishedDate,
    }))
    return filterResults(results, opts).slice(0, limit)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ProviderSelection {
  provider?: 'auto' | 'anthropic' | 'brave' | 'exa' | 'tavily' | 'duckduckgo' | 'none'
  apiKey?: string
}

const KEY_ENV = {
  brave: 'BRAVE_API_KEY',
  tavily: 'TAVILY_API_KEY',
  exa: 'EXA_API_KEY',
} as const

/**
 * Choose a provider.
 *
 * `auto` (and `anthropic`, which has no client-side equivalent here) prefers a
 * keyed provider found in the environment — Brave, then Tavily, then Exa — and
 * falls back to DuckDuckGo. An explicit provider that needs a key but has none
 * is an error rather than a silent downgrade. Returns null for `none`.
 */
export function createSearchProvider(
  selection: ProviderSelection = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): WebSearchProvider | null {
  const choice = selection.provider ?? 'auto'
  if (choice === 'none') return null
  if (choice === 'duckduckgo') return new DuckDuckGoProvider(fetchImpl)

  if (choice === 'brave' || choice === 'tavily' || choice === 'exa') {
    const key = selection.apiKey || env[KEY_ENV[choice]]
    if (!key) {
      throw new Error(
        `web.provider is "${choice}" but no API key was found. Set ${KEY_ENV[choice]} or web.apiKey.`,
      )
    }
    if (choice === 'brave') return new BraveSearchProvider(key, fetchImpl)
    if (choice === 'tavily') return new TavilyProvider(key, fetchImpl)
    return new ExaProvider(key, fetchImpl)
  }

  if (env.BRAVE_API_KEY) return new BraveSearchProvider(env.BRAVE_API_KEY, fetchImpl)
  if (env.TAVILY_API_KEY) return new TavilyProvider(env.TAVILY_API_KEY, fetchImpl)
  if (env.EXA_API_KEY) return new ExaProvider(env.EXA_API_KEY, fetchImpl)
  return new DuckDuckGoProvider(fetchImpl)
}
