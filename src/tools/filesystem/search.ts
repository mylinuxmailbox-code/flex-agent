import { execa } from 'execa'
import { z } from 'zod'
import type { Tool, ToolResult } from '../types.js'
import { errorResult, fail, ok } from '../types.js'
import { PathError, resolvePath, toDisplayPath } from './paths.js'

/**
 * Text search via ripgrep.
 *
 * rg is fast enough on large repos that we never need our own index, and it
 * already respects .gitignore. `--json` gives us a line-oriented stream we can
 * truncate and format deterministically instead of scraping human output.
 */

const MAX_RESULTS = 300

function searchInput(description: string) {
  return z.object({
    pattern: z.string().describe(description),
    path: z
      .string()
      .optional()
      .describe('Directory or file to search. Defaults to the workspace root.'),
    glob: z
      .string()
      .optional()
      .describe('Restrict to files matching this glob, e.g. `*.ts` or `src/**/*.{ts,tsx}`.'),
    case_sensitive: z
      .boolean()
      .optional()
      .describe(
        'Match case exactly. Default: smart-case (case-insensitive unless the pattern has an uppercase letter).',
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS)
      .optional()
      .describe(`Maximum matching lines to return. Default 100.`),
    context_lines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Lines of surrounding context to include. Default 0.'),
  })
}

type SearchInput = z.output<ReturnType<typeof searchInput>>

async function runSearch(
  input: SearchInput,
  ctx: Parameters<Tool['execute']>[1],
  fixedStrings: boolean,
  label: string,
): Promise<ToolResult> {
  let root: string
  try {
    root = resolvePath(input.path ?? '.', ctx, { mustExist: true })
  } catch (err) {
    return fail(err instanceof PathError ? err.message : String(err), label)
  }

  const max = input.max_results ?? 100
  const args = [
    '--json',
    // Per file, not overall: the overall cap is applied below.
    '--max-count',
    String(Math.min(MAX_RESULTS, max)),
    // A minified bundle's single 2MB line would otherwise flood the context.
    '--max-columns',
    '300',
    input.case_sensitive ? '--case-sensitive' : '--smart-case',
    '--hidden',
    '--glob',
    '!**/.git/**',
  ]
  if (fixedStrings) args.push('--fixed-strings')
  if (input.glob) args.push('--glob', input.glob)
  if (input.context_lines) args.push('--context', String(input.context_lines))
  // `-e` so a pattern that starts with `-` is a pattern, not a flag.
  args.push('-e', input.pattern, '--', root)

  let stdout: string
  try {
    const result = await execa('rg', args, {
      cwd: ctx.workspaceRoot,
      cancelSignal: ctx.signal,
      maxBuffer: 32 * 1024 * 1024,
      reject: false,
    })
    stdout = result.stdout
    // rg exits 1 for "no matches" and 2 for a real error.
    if (result.exitCode === 2) {
      return fail(`rg failed: ${result.stderr || 'unknown error'}`, label)
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))) {
      return { content: 'Search cancelled.', isError: true, display: `${label} (cancelled)` }
    }
    return errorResult(err, label)
  }

  const base = toDisplayPath(root, ctx.workspaceRoot) || '.'
  const hits = parseRgJson(stdout, base)
  if (hits.length === 0) {
    return ok(
      `No matches for ${JSON.stringify(input.pattern)} under ${base}.`,
      `${label}: 0 matches`,
      { count: 0 },
    )
  }

  const shown = hits.slice(0, max)
  const body = shown
    .map((h) =>
      h.isContext ? `  ${h.path}:${h.line}: ${h.text}` : `${h.path}:${h.line}: ${h.text}`,
    )
    .join('\n')
  const more =
    hits.length > shown.length
      ? `\n\n[${hits.length - shown.length} more matches not shown. Refine the pattern or narrow ` +
        `the path/glob to see them.]`
      : ''

  const fileCount = new Set(hits.map((h) => h.path)).size
  return ok(
    `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}:\n\n${body}${more}`,
    `${label} ${input.pattern} (${hits.length})`,
    { count: hits.length, files: fileCount },
  )
}

interface RgHit {
  path: string
  line: number
  text: string
  /** True for `--context` lines that surround a match rather than being one. */
  isContext: boolean
}

function parseRgJson(stdout: string, base: string): RgHit[] {
  const hits: RgHit[] = []
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue
    let event: {
      type?: string
      data?: {
        path?: { text?: string }
        line_number?: number
        lines?: { text?: string }
        submatches?: Array<{ match_text?: { text?: string } }>
      }
    }
    try {
      event = JSON.parse(raw)
    } catch {
      continue
    }
    if (event.type !== 'match' && event.type !== 'context') continue
    const data = event.data
    if (!data?.path?.text) continue
    const full = data.path.text
    const rel = full.startsWith(base) ? full.slice(base.length).replace(/^\//, '') : full
    hits.push({
      path: rel,
      line: data.line_number ?? 0,
      text: (data.lines?.text ?? '').replace(/\n$/, ''),
      isContext: event.type === 'context',
    })
  }
  return hits
}

const textSchema = searchInput(
  'Literal text to find. Matched case-insensitively by default; not a regular expression.',
)

export const searchTextTool: Tool<typeof textSchema> = {
  name: 'search_text',
  description:
    'Search file contents for literal text. Returns file:line:line for every match. Faster and safer than search_regex when you are not sure of the exact syntax, and immune to regex metacharacters in your query.',
  inputSchema: textSchema,
  readOnly: true,
  category: 'search',
  promptGuidance:
    'Prefer search_text over search_regex unless you genuinely need alternation, anchors or repetition. Literal search is far less likely to silently match the wrong thing.',

  plan(input, ctx) {
    let abs = input.path ?? ctx.workspaceRoot
    try {
      abs = resolvePath(input.path ?? '.', ctx)
    } catch {
      /* classify the raw path when resolution fails */
    }
    return {
      tool: this.name,
      input,
      readPaths: [abs],
      cwd: ctx.cwd,
      purpose: `search "${input.pattern}"`,
    }
  },

  execute: (input, ctx) => runSearch(input, ctx, true, 'search'),
} as Tool<typeof textSchema>

const regexSchema = searchInput('Regular expression to find. Uses ripgrep/Rust regex syntax.')

export const searchRegexTool: Tool<typeof regexSchema> = {
  name: 'search_regex',
  description:
    'Search file contents with a regular expression (Rust regex syntax, as used by ripgrep). Use search_text for plain strings. An invalid pattern returns an error rather than partial results.',
  inputSchema: regexSchema,
  readOnly: true,
  category: 'search',

  plan(input, ctx) {
    let abs = input.path ?? ctx.workspaceRoot
    try {
      abs = resolvePath(input.path ?? '.', ctx)
    } catch {
      /* classify the raw path when resolution fails */
    }
    return {
      tool: this.name,
      input,
      readPaths: [abs],
      cwd: ctx.cwd,
      purpose: `regex "${input.pattern}"`,
    }
  },

  execute: (input, ctx) => runSearch(input, ctx, false, 'regex'),
} as Tool<typeof regexSchema>
