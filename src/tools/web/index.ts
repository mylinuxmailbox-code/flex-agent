/**
 * Web tools barrel.
 *
 * Import from here, not from individual files, so the tool registration in
 * src/tools/index.ts has a single import point.
 */

export { webFetchTool } from './fetch.js'
export { webSearchTool } from './search.js'
export type { SearchResult, WebCitation, WebSearchProvider } from './types.js'
