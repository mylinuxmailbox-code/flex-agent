import hljs from 'highlight.js/lib/common'
import { Box, Text } from 'ink'
import { marked, type Token, type Tokens, type TokensList } from 'marked'
import { Fragment, type ReactNode } from 'react'
import { theme } from '../theme.js'

/**
 * Markdown rendering for the terminal.
 *
 * Deliberately not `cli-highlight`: that pipes through chalk, which strips all
 * colour when stdout is not a TTY, and Ink wants to own styling so it can
 * compose with the rest of the layout. Here we take highlight.js tokens and
 * map their classes onto Ink colours, which works identically in a terminal, a
 * pipe, or a test.
 */

const HLJS_COLORS: Record<string, string> = {
  'hljs-keyword': theme.brand,
  'hljs-built_in': theme.brand,
  'hljs-type': theme.info,
  'hljs-literal': theme.info,
  'hljs-number': '#F0A868',
  'hljs-string': theme.accent,
  'hljs-title': theme.brand,
  'hljs-title.function_': theme.brand,
  'hljs-title.class_': '#F0A868',
  'hljs-attr': theme.text,
  'hljs-variable': theme.text,
  'hljs-variable.language_': theme.brand,
  'hljs-variable.constant_': '#F0A868',
  'hljs-comment': theme.textFaint,
  'hljs-quote': theme.textDim,
  'hljs-meta': theme.textDim,
  'hljs-symbol': '#F0A868',
  'hljs-params': theme.text,
  'hljs-property': theme.info,
  'hljs-tag': theme.error,
  'hljs-name': theme.brand,
  'hljs-attr-name': theme.info,
  'hljs-attribute': theme.info,
  'hljs-addition': theme.accent,
  'hljs-deletion': theme.error,
  'hljs-operator': theme.text,
  'hljs-punctuation': theme.textDim,
  'hljs-regexp': theme.accent,
  'hljs-doctag': theme.textFaint,
  'hljs-section': theme.brand,
  'hljs-bullet': theme.warn,
  'hljs-emphasis': theme.textDim,
  'hljs-strong': theme.text,
}

export interface MarkdownProps {
  text: string
  /** Wrap to this width. 0 disables wrapping. */
  width?: number
  dim?: boolean
}

/** Parse once per render pass; `marked.lexer` is synchronous and cheap. */
export function Markdown({ text, width = 0, dim }: MarkdownProps) {
  let tokens: TokensList
  try {
    tokens = marked.lexer(text)
  } catch {
    // Never let a malformed model response blank the transcript.
    return <Text color={dim ? theme.textDim : theme.text}>{text}</Text>
  }
  return <Box flexDirection="column">{renderTokens(tokens, width, dim === true)}</Box>
}

function renderTokens(tokens: readonly Token[], width: number, dim: boolean): ReactNode[] {
  return tokens.map((token, index) => renderToken(token, width, dim, index))
}

function renderToken(token: Token, width: number, dim: boolean, key: number): ReactNode {
  const base = dim ? theme.textDim : theme.text

  switch (token.type) {
    case 'space':
      return null

    case 'heading': {
      const t = token as Tokens.Heading
      const text = plainText(t.tokens)
      const marker = t.depth <= 2 ? theme.brand : theme.text
      return (
        <Box key={key} marginTop={key === 0 ? 0 : 1}>
          <Text color={marker} bold>
            {t.depth <= 2 ? '▌ ' : '  '}
            {text}
          </Text>
        </Box>
      )
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph
      return (
        <Text key={key} color={base} wrap="wrap">
          {renderInline(t.tokens, dim)}
        </Text>
      )
    }

    case 'code':
      return (
        <CodeBlock
          key={key}
          code={(token as Tokens.Code).text}
          lang={(token as Tokens.Code).lang}
        />
      )

    case 'blockquote': {
      const t = token as Tokens.Blockquote
      return (
        <Box
          key={key}
          paddingLeft={2}
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={theme.border}
        >
          {renderTokens(t.tokens, width, true)}
        </Box>
      )
    }

    case 'list': {
      const t = token as Tokens.List
      let index = typeof t.start === 'number' ? t.start : 1
      return (
        <Box key={key} flexDirection="column">
          {t.items.map((item: Tokens.ListItem, i: number) => {
            const bullet = t.ordered ? `${index}.` : item.task ? (item.checked ? '☑' : '☐') : '•'
            if (t.ordered) index++
            return (
              <Box key={i} flexDirection="row">
                <Text color={item.checked ? theme.accent : theme.textDim}>{`${bullet} `}</Text>
                <Box flexDirection="column" flexGrow={1}>
                  {renderTokens(item.tokens, 0, dim)}
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }

    case 'hr':
      return (
        <Text key={key} color={theme.border}>
          {'─'.repeat(Math.max(4, Math.min(60, width || 60)))}
        </Text>
      )

    case 'table': {
      const t = token as Tokens.Table
      return (
        <Box key={key} flexDirection="column">
          <Text color={theme.textFaint}>
            [table: {t.header.length} columns × {t.rows.length} rows]
          </Text>
        </Box>
      )
    }

    case 'html': {
      // Model-authored HTML in a terminal is almost always a mistake; show it
      // escaped rather than guessing at intent.
      return (
        <Text key={key} color={theme.textFaint} wrap="wrap">
          {(token as { text: string }).text.slice(0, 500)}
        </Text>
      )
    }

    default:
      return (
        <Text key={key} color={base} wrap="wrap">
          {'raw' in token ? String((token as { raw: string }).raw) : ''}
        </Text>
      )
  }
}

function renderInline(tokens: readonly Token[] | undefined, dim: boolean): ReactNode {
  if (!tokens) return null
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'text':
        return <Fragment key={i}>{(token as Tokens.Text).text}</Fragment>
      case 'strong':
        return (
          <Text key={i} bold color={dim ? theme.textDim : theme.text}>
            {plainText((token as Tokens.Strong).tokens)}
          </Text>
        )
      case 'em':
        return (
          <Text key={i} italic color={theme.textDim}>
            {plainText((token as Tokens.Em).tokens)}
          </Text>
        )
      case 'del':
        return (
          <Text key={i} strikethrough color={theme.textFaint}>
            {plainText((token as Tokens.Del).tokens)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={i} color={theme.accent}>
            {(token as Tokens.Codespan).text}
          </Text>
        )
      case 'link': {
        const t = token as Tokens.Link
        return (
          <Text key={i} color={theme.info}>
            {t.text || t.href}
          </Text>
        )
      }
      case 'br':
        return <Fragment key={i}> {'\n'} </Fragment>
      case 'escape':
        return <Fragment key={i}>{(token as { text: string }).text}</Fragment>
      case 'image': {
        const t = token as Tokens.Image
        return (
          <Text key={i} color={theme.textFaint}>
            [image: {t.text || t.href}]
          </Text>
        )
      }
      default:
        return <Fragment key={i}>{plainText([token])}</Fragment>
    }
  })
}

function plainText(tokens: readonly Token[] | undefined): string {
  if (!tokens) return ''
  return tokens
    .map((token) => {
      if ('tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
        return plainText((token as { tokens: Token[] }).tokens)
      }
      if ('text' in token) return String((token as { text: string }).text)
      if ('raw' in token) return String((token as { raw: string }).raw)
      return ''
    })
    .join('')
}

// ---------------------------------------------------------------------------
// code blocks
// ---------------------------------------------------------------------------

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const language = resolveLanguage(lang)
  const highlighted = language ? tokenize(code, language) : [{ text: code, color: theme.text }]

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderColor={theme.border}
    >
      {language ? <Text color={theme.textFaint}>{language}</Text> : null}
      {highlighted.map((part, i) => (
        <Text key={i} color={part.color}>
          {part.text}
        </Text>
      ))}
    </Box>
  )
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  cs: 'csharp',
}

function resolveLanguage(lang?: string): string | null {
  if (!lang) return null
  const normalized = lang.toLowerCase().trim()
  const mapped = LANGUAGE_ALIASES[normalized] ?? normalized
  return hljs.getLanguage(mapped) ? mapped : null
}

interface TokenPart {
  text: string
  color: string
}

/**
 * Turn highlight.js's HTML-ish output into styled spans.
 *
 * `hljs.highlight` returns `<span class="hljs-keyword">…</span>` markup; we
 * walk it rather than handing it to a terminal, so colours come from Ink and
 * survive a non-TTY stdout.
 */
function tokenize(code: string, language: string): TokenPart[] {
  let html: string
  try {
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return [{ text: code, color: theme.text }]
  }

  const parts: TokenPart[] = []
  const spanRe = /<span class="([^"]+)">([\s\S]*?)<\/span>|([^<]+)/g
  let match: RegExpExecArray | null
  let lastIndex = 0
  const push = (text: string, color: string) => {
    if (!text) return
    const previous = parts[parts.length - 1]
    if (previous && previous.color === color) {
      previous.text += text
    } else {
      parts.push({ text, color })
    }
  }

  for (;;) {
    match = spanRe.exec(html)
    if (match === null) break
    if (match.index > lastIndex)
      push(decodeEntities(html.slice(lastIndex, match.index)), theme.text)
    if (match[1] !== undefined && match[2] !== undefined) {
      const cls = `hljs-${match[1].split(/\s+/).pop() ?? ''}`
      push(decodeEntities(match[2]), HLJS_COLORS[cls] ?? theme.text)
    } else if (match[3] !== undefined) {
      push(decodeEntities(match[3]), theme.text)
    }
    lastIndex = spanRe.lastIndex
  }
  if (lastIndex < html.length) push(decodeEntities(html.slice(lastIndex)), theme.text)

  return parts.length > 0 ? parts : [{ text: code, color: theme.text }]
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
