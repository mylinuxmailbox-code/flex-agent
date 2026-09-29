/**
 * Web tools barrel.
 *
 * Import from here, not from individual files, so the tool registration in
 * src/tools/index.ts has a single import point.
 */

export { webFetchTool } from './fetch.js'
export { createSearchProvider } from './providers.js'
export { webSearchTool } from './search.js'
export { checkUrl, checkUrlResolved, isBlockedAddress } from './ssrf-guard.js'
export type { SearchResult, WebCitation, WebSearchProvider } from './types.js'
