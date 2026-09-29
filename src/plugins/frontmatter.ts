/**
 * Minimal YAML-frontmatter reader for command and skill files.
 *
 * Supports the subset those files actually use: `key: value` lines, quoted
 * values, and inline `[a, b]` lists. It is deliberately not a YAML parser; a
 * plugin file should not be able to trip a full parser's edge cases.
 */
export interface Frontmatter {
  data: Record<string, string | string[]>
  body: string
}

export function parseFrontmatter(source: string): Frontmatter {
  const text = source.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text.trim() }
  const data: Record<string, string | string[]> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1] as string
    let value = (kv[2] ?? '').trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean)
      continue
    }
    value = unquote(value)
    data[key] = value
  }
  return { data, body: text.slice(match[0].length).trim() }
}

function unquote(value: string): string {
  if (value.length >= 2 && /^(["']).*\1$/.test(value)) return value.slice(1, -1)
  return value
}

const STOP_WORDS = new Set(
  'the and for with that this from your you are use when using into any all can will its not but has have been more than then them they their what which who how why where should would could about after before over under also only just like such each other some most may our out per via'.split(
    ' ',
  ),
)

/** Trigger keywords for a skill: explicit ones, else its name and significant description words. */
export function deriveKeywords(
  name: string,
  description: string,
  explicit?: string | string[],
): string[] {
  if (Array.isArray(explicit) && explicit.length > 0) return explicit
  if (typeof explicit === 'string' && explicit.trim())
    return explicit.split(',').map((s) => s.trim())
  const words = `${name.replace(/[-_]/g, ' ')} ${description}`
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  return [...new Set(words)].slice(0, 12)
}
