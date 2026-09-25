import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * `@`-mention and path completion.
 *
 * Completion is scoped to the token immediately before the cursor, so
 * `@src/au<tab>` completes a file while a bare `src` elsewhere in the sentence
 * is left alone. Results are ranked: exact prefix, then basename matches.
 */

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.turbo',
  'coverage',
  '.gradle',
])

export interface CompletionItem {
  /** The text to insert, relative to what is already typed. */
  value: string
  /** Text shown in the popup. */
  label: string
  /** Extra detail, e.g. a directory marker or file type. */
  hint?: string
  isDirectory: boolean
}

/** Find the `@token` under the cursor, if any. */
export function findAtToken(
  value: string,
  cursorOffset: number,
): { start: number; query: string } | null {
  const before = value.slice(0, cursorOffset)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  const token = match[1] ?? ''
  const start = cursorOffset - token.length - 1
  return { start, query: token }
}

export async function completePath(
  query: string,
  workspaceRoot: string,
  limit = 12,
): Promise<CompletionItem[]> {
  const isDirQuery = query.endsWith(sep) || query.endsWith('/')
  const dirPart = isDirQuery ? query : dirname(query)
  const basePart = isDirQuery ? '' : basename(query)

  const absoluteDir = isAbsolute(dirPart) ? dirPart : resolve(workspaceRoot, dirPart || '.')
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => [])
  if (entries.length === 0) return []

  const results: CompletionItem[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !basePart.startsWith('.')) continue
    if (IGNORED.has(entry.name)) continue
    if (basePart && !entry.name.toLowerCase().startsWith(basePart.toLowerCase())) continue

    const isDirectory = entry.isDirectory()
    const full = join(dirPart || '.', entry.name)
    results.push({
      value: isDirectory ? `${full}${sep}` : full,
      label: entry.name,
      hint: isDirectory ? 'dir' : undefined,
      isDirectory,
    })
  }

  // A directory that exactly matches the query is what the user meant; list it
  // before anything fuzzy.
  if (basePart) {
    results.sort((a, b) => {
      const aExact = a.label === basePart ? 0 : 1
      const bExact = b.label === basePart ? 0 : 1
      if (aExact !== bExact) return aExact - bExact
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.label.length - b.label.length
    })
  }

  return results.slice(0, limit)
}

/** Cheap file/dir existence check used to validate a pasted path. */
export async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
