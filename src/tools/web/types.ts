/**
 * Web research types.
 *
 * The provider interface keeps the tool implementations independent of any
 * specific search API. Switching from Brave to SerpAPI, or adding a second
 * provider, is a provider swap, not a tool change.
 */

export interface SearchResult {
  url: string
  title: string
  snippet: string
  domain: string
  /** ISO 8601 date string when the source reports it. */
  freshness?: string
}

export interface SearchOptions {
  /** Max results to return. Provider may return fewer. */
  limit?: number
  /** ISO 639-1 locale hint, e.g. "en". */
  locale?: string
  /** Only return results from these domains. */
  allowDomains?: string[]
  /** Never return results from these domains. */
  blockDomains?: string[]
}

export interface WebSearchProvider {
  readonly id: string
  readonly label: string
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>
}

/** Citation attached to an assistant turn after web research. */
export interface WebCitation {
  url: string
  title: string
  domain: string
}

/** SSRF guard result. */
export interface HostCheckResult {
  allowed: boolean
  reason?: string
}
