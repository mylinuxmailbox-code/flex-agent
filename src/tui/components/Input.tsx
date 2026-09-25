import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TextArea, type TextAreaHandle } from 'react-ink-textarea'
import { completeCommand } from '../commands.js'
import { type CompletionItem, completePath, findAtToken } from '../completion.js'
import { theme } from '../theme.js'

/**
 * The input box.
 *
 * Enter submits and Shift+Enter inserts a newline, which is the mapping every
 * coding agent uses: you send a thought far more often than you compose a
 * multi-line one. History lives on Ctrl+P/Ctrl+N rather than the arrow keys,
 * because Up and Down belong to the cursor once the text has more than one line.
 */

export interface InputProps {
  workspaceRoot: string
  busy: boolean
  disabled?: boolean
  placeholder?: string
  onSubmit: (value: string) => void
  /** Ctrl+C pressed. Clear if there is text, otherwise cancel the run. */
  onInterrupt: () => void
  /** Ctrl+D pressed. */
  onExit: () => void
  /** Esc pressed while idle — used to clear suggestions. */
  onEscape?: () => void
}

interface Suggestion {
  kind: 'command' | 'path'
  label: string
  detail?: string
  value: string
  /** How many characters before the cursor this suggestion replaces. */
  replaceFrom: number
  isDirectory?: boolean
}

export function Input({
  workspaceRoot,
  busy,
  disabled,
  placeholder,
  onSubmit,
  onInterrupt,
  onExit,
  onEscape,
}: InputProps) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(0)
  const areaRef = useRef<TextAreaHandle>(null)
  const cursorRef = useRef(0)

  // --- completion ---------------------------------------------------------

  const refreshSuggestions = useCallback(
    async (text: string, cursor: number) => {
      // Slash commands only complete at the start of the line — `/` mid-sentence
      // is a path more often than it is a command.
      if (cursor === 0 && text.startsWith('/')) {
        const [query, ...rest] = text.slice(1).split(' ')
        if (rest.length === 0) {
          const matches = completeCommand(`/${query}`).map((command) => ({
            kind: 'command' as const,
            label: `/${command.name}`,
            detail: command.summary,
            value: `/${command.name} `,
            replaceFrom: 0,
          }))
          setSuggestions(matches)
          setSelected(0)
          return
        }
        setSuggestions([])
        return
      }

      const at = findAtToken(text, cursor)
      if (!at) {
        setSuggestions([])
        return
      }
      const items: CompletionItem[] = await completePath(at.query, workspaceRoot)
      setSuggestions(
        items.map((item) => ({
          kind: 'path' as const,
          label: item.label,
          detail: item.hint,
          value: item.value,
          replaceFrom: at.start,
          isDirectory: item.isDirectory,
        })),
      )
      setSelected(0)
    },
    [workspaceRoot],
  )

  const applySuggestion = useCallback(() => {
    const suggestion = suggestions[selected]
    if (!suggestion) return
    const before = value.slice(0, suggestion.replaceFrom)
    const after = value.slice(cursorRef.current)
    const next = `${before}${suggestion.value}${after}`
    setValue(next)
    setSuggestions([])
    // The component exposes only `insert()`, not a caret setter, so after a
    // completion we nudge the caret to the end of the inserted text. That is
    // exact for the common case (the token being completed is the last thing
    // typed); a completion in the middle of a line lands the caret at the end,
    // which the user fixes with a single arrow press.
    setTimeout(() => {
      areaRef.current?.insert('')
      cursorRef.current = next.length
    }, 0)
  }, [selected, suggestions, value])

  // --- submit -------------------------------------------------------------

  const submit = useCallback(() => {
    const text = value.trim()
    setValue('')
    setSuggestions([])
    if (text.length === 0) return
    setHistory((prev) => [...prev.filter((h) => h !== text), text].slice(-100))
    setHistoryIndex(null)
    onSubmit(text)
  }, [onSubmit, value])

  // --- keys ---------------------------------------------------------------

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (value.length > 0) {
        setValue('')
        setSuggestions([])
        return
      }
      onInterrupt()
      return
    }
    if (key.ctrl && inputChar === 'd') {
      onExit()
      return
    }
    if (key.escape) {
      if (suggestions.length > 0) {
        setSuggestions([])
        return
      }
      onEscape?.()
      return
    }

    // Suggestion navigation takes priority over history while the popup is up.
    if (suggestions.length > 0) {
      if (key.upArrow) {
        setSelected((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (key.downArrow) {
        setSelected((i) => (i + 1) % suggestions.length)
        return
      }
      if (key.tab || (key.return && suggestions[selected])) {
        applySuggestion()
        return
      }
    }

    // History on Ctrl+P / Ctrl+N; Up/Down stay with the caret.
    if (key.ctrl && inputChar === 'p') {
      if (history.length === 0) return
      setHistoryIndex((i) => {
        const next = i === null ? history.length - 1 : Math.max(0, i - 1)
        setValue(history[next] ?? '')
        return next
      })
      return
    }
    if (key.ctrl && inputChar === 'n' && historyIndex !== null) {
      const from = historyIndex
      const next = from + 1
      if (next >= history.length) {
        setValue('')
        setHistoryIndex(null)
        return
      }
      setHistoryIndex(next)
      setValue(history[next] ?? '')
    }
  })

  useEffect(() => {
    void refreshSuggestions(value, cursorRef.current)
  }, [refreshSuggestions, value])

  const showPopup = suggestions.length > 0
  const height = useMemo(() => Math.min(8, suggestions.length), [suggestions.length])

  return (
    <Box flexDirection="column">
      {showPopup ? (
        <Box flexDirection="column" marginBottom={1}>
          {suggestions.slice(0, height).map((suggestion, i) => (
            <Box key={`${suggestion.kind}-${suggestion.label}-${i}`}>
              <Text color={i === selected ? theme.brand : theme.border}>
                {i === selected ? ' ❯ ' : '   '}
              </Text>
              <Text color={i === selected ? theme.text : theme.textDim} bold={i === selected}>
                {suggestion.label}
              </Text>
              {suggestion.detail ? <Text color={theme.textFaint}> {suggestion.detail}</Text> : null}
            </Box>
          ))}
          {suggestions.length > height ? (
            <Text color={theme.textFaint}> … {suggestions.length - height} more</Text>
          ) : null}
        </Box>
      ) : null}

      <Box
        borderStyle="round"
        borderColor={busy ? theme.brandDim : theme.border}
        paddingX={1}
        flexDirection="column"
      >
        <TextArea
          ref={areaRef}
          focus={!disabled}
          value={value}
          onChange={setValue}
          onSubmit={submit}
          onTab={() => applySuggestion()}
          onCursorChange={(position) => {
            // @-completion needs the caret offset in characters, not a
            // [line, col] pair, so convert through the current value.
            const lines = value.split('\n')
            let offset = 0
            for (let i = 0; i < position[0] && i < lines.length; i++) {
              offset += (lines[i]?.length ?? 0) + 1
            }
            cursorRef.current = Math.min(value.length, offset + position[1])
          }}
          placeholder={
            placeholder ??
            (busy
              ? 'Working — Esc to interrupt'
              : 'Tell Pixel what to do…  (Shift+Enter for a new line)')
          }
          viewportLines={6}
          disableCursorBlink={false}
          highlightActiveLine={false}
          keybindings={{
            Enter: true,
            'Shift+Enter': true,
            'Alt+Enter': true,
            // Ctrl+J and Ctrl+Enter are byte-identical to Enter in raw mode;
            // leaving them bound would submit when the user meant a newline.
            'Ctrl+J': false,
            'Ctrl+Enter': false,
          }}
        />
      </Box>
    </Box>
  )
}
