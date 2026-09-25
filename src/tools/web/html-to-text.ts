/**
 * HTML → clean text converter.
 *
 * Strips scripts, styles, nav, footer, and ad regions. Converts semantic
 * elements (h1–h6, li, pre, code) into readable Markdown-ish text. The result
 * is what we give the model — compact, citable, and free of cruft.
 */

/** Max characters returned to the model. Content beyond this is truncated. */
const MAX_CHARS = 50_000

export function htmlToText(html: string, sourceUrl: string): string {
  // Remove full elements that are never useful.
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(
      /<[^>]+class="[^"]*(?:ad|banner|cookie|popup|modal|overlay|sidebar)[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/gi,
      '',
    )
    // Block-level structure → newlines
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
      const prefix = '#'.repeat(Number(level))
      return `\n\n${prefix} ${stripInlineTags(content).trim()}\n\n`
    })
    .replace(/<p[^>]*>/gi, '\n\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<ul[^>]*>|<\/ul>/gi, '\n')
    .replace(/<ol[^>]*>|<\/ol>/gi, '\n')
    .replace(/<blockquote[^>]*>/gi, '\n> ')
    .replace(/<\/blockquote>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n---\n')
    // Code blocks
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => {
      return `\n\`\`\`\n${decodeHtmlEntities(stripInlineTags(code))}\n\`\`\`\n`
    })
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
      return `\`${decodeHtmlEntities(stripInlineTags(code))}\``
    })
    // Links — keep the text, optionally the href
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
      const linkText = stripInlineTags(content).trim()
      if (!linkText) return ''
      if (href.startsWith('http')) return `[${linkText}](${href})`
      return linkText
    })
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')

  text = decodeHtmlEntities(text)
    // Normalise whitespace — collapse runs of blanks but keep paragraph breaks
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const citation = `\n\n---\nSource: ${sourceUrl}`

  if (text.length + citation.length > MAX_CHARS) {
    const truncated = text.slice(0, MAX_CHARS - citation.length - 100)
    const lastPara = truncated.lastIndexOf('\n\n')
    return (
      (lastPara > MAX_CHARS / 2 ? truncated.slice(0, lastPara) : truncated) +
      '\n\n[… content truncated …]' +
      citation
    )
  }

  return text + citation
}

function stripInlineTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&copy;/g, '©')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}
