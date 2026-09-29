import { z } from 'zod'
import type { Tool } from '../types.js'
import { fail } from '../types.js'
import { resolvePath } from './paths.js'
import { runSearch } from './search.js'

/**
 * Lightweight code navigation: find where a symbol is defined, and where it is used.
 *
 * This is deliberately not a language server. It is ripgrep with definition-shaped
 * patterns that cover the declaration syntax of the mainstream languages
 * (TS/JS, Python, Go, Rust, Java/Kotlin/C#/Swift, Ruby, PHP, C/C++). It answers
 * "where is `foo` defined?" in one call instead of a guess-and-grep loop, and it is
 * honest about what it is: text-based, so it can return a same-named symbol from
 * another scope. Use it to get to the right file fast, then read the code.
 */

const MODIFIERS =
  '(?:(?:export|pub(?:\\([^)]*\\))?|public|private|protected|internal|static|async|abstract|final|sealed|open|override|default|declare|unsafe|extern|const|readonly|inline|virtual|partial)\\s+)*'

const KEYWORDS =
  '(?:function\\*?|class|interface|type|enum|namespace|module|struct|union|trait|impl|fn|def|func|fun|object|record|protocol|extension|actor|let|const|var|val|static|macro_rules!|typedef)'

/** Regex (Rust syntax) matching a declaration of `symbol`. */
export function definitionPattern(symbol: string): string {
  const s = symbol.replace(/[$]/g, '\\$')
  return [
    // `export async function foo`, `pub struct Foo`, `def foo`, `let foo`, `const foo`
    `(?:^|[^\\w$.])${MODIFIERS}${KEYWORDS}\\s+${s}\\b`,
    // Go methods: `func (r *T) Name(`
    `func\\s*\\([^)]*\\)\\s*${s}\\b`,
    // class/object methods: `  async foo(a, b) {` / `public int foo(String x) {`
    `^\\s*${MODIFIERS}(?:get\\s+|set\\s+)?(?:[\\w<>\\[\\],.?\\s*&]+\\s+)?${s}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^={;]+)?\\s*\\{`,
    // `foo = (…) =>`, `foo = function`, `foo: (…) =>`, `this.foo = …`
    `(?:^|[^\\w$.])${s}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::\\s*[^=]+)?=>|[\\w$]+\\s*=>)`,
    // Python/Ruby-style class attribute or assignment at line start
    `^\\s*${s}\\s*(?::\\s*[\\w\\[\\], .|]+)?=[^=]`,
  ].join('|')
}

const inputSchema = z.object({
  symbol: z
    .string()
    .regex(/^[A-Za-z_$][\w$]*$/, 'symbol must be a single identifier')
    .describe('The identifier to look up, e.g. `createSession`. No dots, spaces or wildcards.'),
  mode: z
    .enum(['definition', 'references'])
    .optional()
    .describe(
      '`definition` (default) finds where it is declared; `references` finds every word-boundary occurrence.',
    ),
  path: z.string().optional().describe('Directory or file to search. Defaults to the workspace.'),
  glob: z.string().optional().describe('Restrict to files matching this glob, e.g. `*.ts`.'),
  max_results: z.number().int().min(1).max(300).optional().describe('Default 50.'),
})

export const findSymbolTool: Tool<typeof inputSchema> = {
  name: 'find_symbol',
  description:
    'Find where a function, class, type, variable or method is defined (mode "definition") or every place it is mentioned (mode "references"). Text-based across languages, not a language server: it may include a same-named symbol from another scope, so read the hit before relying on it.',
  inputSchema,
  readOnly: true,
  category: 'search',
  promptGuidance:
    'To find where something is defined, use find_symbol rather than guessing file names. It is faster than search_regex for declarations.',

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
      purpose: `find ${input.mode ?? 'definition'} of ${input.symbol}`,
    }
  },

  async execute(input, ctx) {
    const mode = input.mode ?? 'definition'
    const pattern =
      mode === 'references'
        ? `(?:^|[^\\w$])${input.symbol.replace(/[$]/g, '\\$')}(?:[^\\w$]|$)`
        : definitionPattern(input.symbol)
    const result = await runSearch(
      {
        pattern,
        path: input.path,
        glob: input.glob,
        case_sensitive: true,
        max_results: input.max_results ?? 50,
        context_lines: 0,
      },
      ctx,
      false,
      `find_symbol(${mode})`,
    )
    if (!result.isError && result.metadata?.count === 0) {
      return fail(
        `No ${mode} found for ${input.symbol}. It may be defined dynamically, generated, or live in a dependency (try search_text).`,
        `find_symbol: 0 ${mode}`,
      )
    }
    return result
  },
}
