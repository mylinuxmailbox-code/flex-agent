import { useCallback, useSyncExternalStore } from 'react'
import type { AgentEvent, AgentState, PlanStep } from '../agent/events.js'
import type { AgentMessage, ContentBlock, EffortLevel, StopReason, Usage } from '../models/types.js'
import type { PermissionPrompt, RiskLevel } from '../permissions/types.js'

/**
 * UI state, as one immutable snapshot.
 *
 * The store is deliberately external to React rather than a pile of `useState`
 * calls: token deltas arrive far faster than a terminal can usefully repaint,
 * so updates are batched on a timer and the tree re-renders once per frame
 * instead of once per token. See `Store.batch`.
 */

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant'
      id: string
      text: string
      streaming: boolean
      citations: Array<{ url: string; title?: string }>
    }
  | {
      kind: 'tool'
      id: string
      name: string
      display: string
      status: 'running' | 'done' | 'error' | 'denied'
      summary: string
      durationMs: number
      output: string
    }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'plan'; id: string; steps: PlanStep[] }
  | { kind: 'diff'; id: string; path: string; diff: string }
  | { kind: 'divider'; id: string; text: string }

export interface StatusInfo {
  model: string
  modelLabel: string
  effort: EffortLevel
  permissionMode: 'ask' | 'auto' | 'full-control'
  sandboxBackend: string
  sandboxIsolated: boolean
  contextUsed: number
  contextWindow: number
  toolCount: number
  activeAgents: number
  cwd: string
  gitBranch?: string
  elapsedMs: number
}

export interface UIState {
  transcript: TranscriptItem[]
  agentState: AgentState
  status: StatusInfo
  plan: PlanStep[]
  busy: boolean
  /** The permission request currently blocking the loop, if any. */
  pendingPermission: PermissionPrompt | null
  lastError: string | null
  lastStopReason: StopReason | null
  /** Tools the user has expanded. */
  expandedTools: Set<string>
  /** Slash-command suggestions currently shown above the input. */
  suggestions: string[]
}

export const initialStatus: StatusInfo = {
  model: 'claude-opus-5-5',
  modelLabel: 'Opus 5.5',
  effort: 'high',
  permissionMode: 'ask',
  sandboxBackend: 'none',
  sandboxIsolated: false,
  contextUsed: 0,
  contextWindow: 200_000,
  toolCount: 0,
  activeAgents: 0,
  cwd: process.cwd(),
  elapsedMs: 0,
}

const initialState: UIState = {
  transcript: [],
  agentState: 'idle',
  status: initialStatus,
  plan: [],
  busy: false,
  pendingPermission: null,
  lastError: null,
  lastStopReason: null,
  expandedTools: new Set(),
  suggestions: [],
}

type Listener = () => void

export class UIStore {
  #state: UIState = initialState
  #listeners = new Set<Listener>()
  #pending: Array<(state: UIState) => UIState> = []
  #flushTimer: NodeJS.Timeout | null = null
  #seq = 0

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): UIState => this.#state

  nextId(prefix: string): string {
    return `${prefix}-${++this.#seq}`
  }

  /**
   * Apply a mutation.
   *
   * With `coalesce: true` the change is held until the end of the current
   * frame, so a burst of token deltas costs one render rather than fifty.
   */
  update(mutate: (state: UIState) => UIState, opts: { coalesce?: boolean } = {}): void {
    if (opts.coalesce) {
      // Keep every delta. Replacing the pending mutation here loses tokens when
      // a provider emits faster than the terminal frame rate.
      this.#pending.push(mutate)
      if (!this.#flushTimer) this.#flushTimer = setTimeout(() => this.flush(), 32)
      return
    }
    this.flush()
    this.#state = mutate(this.#state)
    this.#flush()
  }

  /** Apply every buffered mutation at once. */
  flush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }
    if (this.#pending.length === 0) return
    const pending = this.#pending
    this.#pending = []
    let next = this.#state
    for (const mutate of pending) next = mutate(next)
    this.#state = next
    this.#flush()
  }

  #flush(): void {
    for (const listener of this.#listeners) listener()
  }

  // -------------------------------------------------------------------------
  // event application
  // -------------------------------------------------------------------------

  /** Fold one agent event into the transcript. */
  apply(event: AgentEvent): void {
    const coalesce =
      event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'usage'

    this.update(
      (state) => {
        switch (event.type) {
          case 'turn_start':
            return {
              ...state,
              busy: true,
              agentState: 'thinking',
              lastError: null,
            }

          case 'text_delta':
            return withStreamingAssistant(state, event.text)

          case 'thinking_delta':
            return withStreamingAssistant(state, '')

          case 'citation': {
            const items = [...state.transcript]
            for (let i = items.length - 1; i >= 0; i--) {
              const item = items[i]
              if (item?.kind === 'assistant' && item.streaming) {
                items[i] = {
                  ...item,
                  citations: [...item.citations, { url: event.url, title: event.title }],
                }
                break
              }
            }
            return { ...state, transcript: items }
          }

          case 'tool_start':
            return {
              ...state,
              agentState: 'acting',
              transcript: [
                ...state.transcript,
                {
                  kind: 'tool',
                  id: event.id,
                  name: event.name,
                  display: event.display,
                  status: 'running',
                  summary: '',
                  durationMs: 0,
                  output: '',
                },
              ],
            }

          case 'tool_progress':
            return withTool(state, event.id, (tool) => {
              if (event.event.type === 'output') {
                return { ...tool, output: (tool.output + event.event.chunk).slice(-4000) }
              }
              if (event.event.type === 'diff') {
                return { ...tool, output: event.event.diff }
              }
              if (event.event.type === 'status') {
                return { ...tool, summary: event.event.text }
              }
              return tool
            })

          case 'tool_end':
            return withTool(state, event.id, (tool) => ({
              ...tool,
              status: event.isError ? 'error' : 'done',
              summary: event.summary,
              durationMs: event.durationMs,
              display: event.display,
            }))

          case 'permission_denied':
            return withTool(state, event.id, (tool) => ({
              ...tool,
              status: 'denied',
              summary: event.reason,
            }))

          case 'permission_request':
            return { ...state, agentState: 'waiting_permission', pendingPermission: event.prompt }

          case 'plan':
            return {
              ...state,
              plan: event.steps,
              transcript: [
                ...state.transcript,
                { kind: 'plan', id: this.nextId('plan'), steps: event.steps },
              ],
            }

          case 'status':
            return { ...state, agentState: event.state }

          case 'usage':
            return {
              ...state,
              status: {
                ...state.status,
                contextUsed: event.contextUsed,
                contextWindow: event.contextWindow,
                elapsedMs: Date.now() - startedAt(state),
              },
            }

          case 'context_compacted':
            return {
              ...state,
              transcript: [
                ...state.transcript,
                {
                  kind: 'notice',
                  id: this.nextId('compact'),
                  level: 'info',
                  text: `Context compacted: ${Math.round(event.beforeTokens / 1000)}k → ${Math.round(event.afterTokens / 1000)}k tokens.`,
                },
              ],
            }

          case 'notice':
            return {
              ...state,
              transcript: [
                ...state.transcript,
                {
                  kind: 'notice',
                  id: this.nextId('notice'),
                  level: event.level,
                  text: event.text,
                },
              ],
            }

          case 'error':
            return {
              ...state,
              busy: false,
              agentState: 'error',
              lastError: event.error.message,
              transcript: [
                ...state.transcript,
                {
                  kind: 'notice',
                  id: this.nextId('error'),
                  level: 'error',
                  text: event.error.message,
                },
              ],
            }

          case 'turn_end':
            return { ...state, lastStopReason: event.stopReason }

          case 'done':
            return {
              ...state,
              busy: false,
              agentState: event.stopReason === 'aborted' ? 'idle' : 'done',
              pendingPermission: null,
              lastStopReason: event.stopReason,
            }

          default:
            return state
        }
      },
      { coalesce },
    )
  }

  // --- direct UI actions ---------------------------------------------------

  addUserMessage(text: string): void {
    const id = this.nextId('user')
    this.update((state) => ({
      ...state,
      transcript: [...state.transcript, { kind: 'user', id, text }],
    }))
  }

  addNotice(level: 'info' | 'warn' | 'error', text: string): void {
    this.update((state) => ({
      ...state,
      transcript: [...state.transcript, { kind: 'notice', id: this.nextId('notice'), level, text }],
    }))
  }

  setBusy(busy: boolean): void {
    this.update((state) => ({ ...state, busy }))
  }

  setAgentState(agentState: AgentState): void {
    this.update((state) => ({ ...state, agentState }))
  }

  setSuggestions(suggestions: string[]): void {
    this.update((state) => ({ ...state, suggestions }))
  }

  patchStatus(patch: Partial<StatusInfo>): void {
    this.update((state) => ({ ...state, status: { ...state.status, ...patch } }))
  }

  setPendingPermission(prompt: PermissionPrompt | null): void {
    this.update((state) => ({ ...state, pendingPermission: prompt }))
  }

  restoreSession(messages: readonly AgentMessage[], plan: readonly PlanStep[]): void {
    const items: TranscriptItem[] = []
    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = msg.content
          .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
        if (text) items.push({ kind: 'user', id: this.nextId('user'), text })
      } else if (msg.role === 'assistant') {
        const text = msg.content
          .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
        if (text) {
          items.push({
            kind: 'assistant',
            id: this.nextId('assistant'),
            text,
            streaming: false,
            citations: [],
          })
        }
      }
    }
    this.update((state) => ({
      ...state,
      transcript: items,
      plan: [...plan],
    }))
  }

  toggleTool(id: string): void {
    this.update((state) => {
      const expanded = new Set(state.expandedTools)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      return { ...state, expandedTools: expanded }
    })
  }

  clearTranscript(): void {
    this.update((state) => ({
      ...state,
      transcript: [],
      plan: [],
      lastError: null,
      lastStopReason: null,
    }))
  }
}

function withStreamingAssistant(state: UIState, delta: string): UIState {
  const items = [...state.transcript]
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === 'assistant' && item.streaming) {
      items[i] = { ...item, text: item.text + delta }
      return { ...state, transcript: items }
    }
  }
  items.push({
    kind: 'assistant',
    id: `assistant-${items.length}`,
    text: delta,
    streaming: true,
    citations: [],
  })
  return { ...state, transcript: items }
}

function withTool(
  state: UIState,
  id: string,
  mutate: (
    tool: Extract<TranscriptItem, { kind: 'tool' }>,
  ) => Extract<TranscriptItem, { kind: 'tool' }>,
): UIState {
  const items = state.transcript.map((item) =>
    item.kind === 'tool' && item.id === id ? mutate(item) : item,
  )
  return { ...state, transcript: items }
}

/** Close off the open assistant block so the next one starts a new bubble. */
export function sealStreamingAssistant(state: UIState): UIState {
  const items = [...state.transcript]
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === 'assistant' && item.streaming) {
      items[i] = { ...item, streaming: false }
      break
    }
  }
  return { ...state, transcript: items }
}

function startedAt(state: UIState): number {
  return Date.now() - state.status.elapsedMs
}

/** `useSyncExternalStore` binding, so components only re-render on real changes. */
export function useUIState(store: UIStore): UIState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useUIStoreActions(store: UIStore) {
  return useCallback(() => store, [store])
}

export type { RiskLevel, Usage }
