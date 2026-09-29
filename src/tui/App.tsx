import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '../agent/events.js'
import { describeConfig } from '../config/index.js'
import type { EffortLevel } from '../models/types.js'
import { EFFORT_LEVELS, effortProfile } from '../models/types.js'
import type { PermissionChoice, PermissionPrompt } from '../permissions/types.js'
import { pluginManager } from '../plugins/manager.js'
import type { Session } from '../session/session.js'
import { SnapshotManager } from '../tools/filesystem/snapshots.js'
import { allCommands, type CommandContext, findCommand } from './commands.js'
import { Header, StatusBar } from './components/Chrome.jsx'
import { Input } from './components/Input.jsx'
import { PermissionDialog } from './components/PermissionDialog.jsx'
import { Transcript } from './components/Transcript.jsx'
import { sealStreamingAssistant, type UIStore, useUIState } from './store.js'
import { theme } from './theme.js'

/**
 * The root component.
 *
 * Ink owns the terminal; this component owns the conversation. It holds no
 * agent logic — every action is a call into `Session`, and every update is an
 * `AgentEvent` folded through the store — so the UI can be tested with a fake
 * session and the runtime can be tested with no UI at all.
 */

export interface AppProps {
  session: Session
  store: UIStore
}

export function App({ session, store }: AppProps) {
  const state = useUIState(store)
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [tick, setTick] = useState(0)
  const [permission, setPermission] = useState<{
    prompt: PermissionPrompt
    resolve: (choice: PermissionChoice) => void
  } | null>(null)
  const runningRef = useRef(false)

  // One shared animation tick for the whole UI. A per-component interval would
  // mean N timers and N re-render sources for one visual clock.
  //
  // It only runs while the agent is actually working: an idle terminal that
  // repaints four times a second forever is a laptop fan problem, and there is
  // no animation to show when nothing is happening.
  const animating = state.busy || state.agentState === 'thinking'
  useEffect(() => {
    if (!animating) return
    const timer = setInterval(() => setTick((t) => t + 1), 220)
    return () => clearInterval(timer)
  }, [animating])

  // Wire the permission engine to this component's dialog.
  useEffect(() => {
    session.setPrompter((request) => setPermission(request))
    return () => session.setPrompter(null)
  }, [session])

  // --- running a turn ------------------------------------------------------

  const startTurn = useCallback(
    (text: string) => {
      if (runningRef.current) {
        store.addNotice('warn', 'Still working. Press Esc to interrupt first.')
        return
      }
      runningRef.current = true
      store.addUserMessage(text)
      store.setBusy(true)
      store.patchStatus({ elapsedMs: 0 })

      void (async () => {
        try {
          for await (const event of session.runTurn(text)) {
            store.apply(event)
          }
        } catch (err) {
          store.apply({
            type: 'error',
            error: err instanceof Error ? err : new Error(String(err)),
          })
        } finally {
          store.update((s) => sealStreamingAssistant(s))
          store.setBusy(false)
          runningRef.current = false
        }
      })()
    },
    [session, store],
  )

  // Slash commands run immediately, even while the agent is working; only a
  // command that starts a new turn (via `send`) is held back until it is idle.
  const runTurn = useCallback(
    (text: string) => {
      if (!text.startsWith('/')) {
        startTurn(text)
        return
      }
      const [name, ...rest] = text.slice(1).split(/\s+/)
      const command = findCommand(name ?? '')
      if (!command) {
        store.addNotice('error', `Unknown command /${name}. Try /help.`)
        return
      }
      Promise.resolve(
        command.run(rest.join(' '), commandContext(session, store, exit, startTurn)),
      ).catch((err) =>
        store.addNotice(
          'error',
          `/${command.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
    },
    [exit, session, startTurn, store],
  )

  // --- global keys ---------------------------------------------------------

  useInput((_inputChar, key) => {
    if (key.escape && session.isBusy) {
      session.interrupt()
      store.addNotice('warn', 'Interrupted.')
    }
  })

  // --- render --------------------------------------------------------------

  const width = Math.max(40, columns - 2)
  // Reserve the header, the input, the status bar and a little breathing room.
  const transcriptHeight = Math.max(6, rows - 14)

  const commands = allCommands().length

  // Session facts are synced in an effect, never during render: writing to the
  // store while React is rendering this same component is a setState-in-render
  // error, and the update gets discarded.
  const model = session.model
  const effort = session.effort
  const permissionMode = session.config.permissionMode
  const sandboxBackend = session.sandbox.info.backend
  const sandboxIsolated = session.sandbox.info.isolated
  const contextWindow = session.contextWindow
  const toolCount = session.tools.visible().length
  const cwd = session.config.workspaceRoot

  useEffect(() => {
    store.patchStatus({
      model,
      modelLabel: session.modelLabel,
      effort,
      permissionMode,
      sandboxBackend,
      sandboxIsolated,
      contextWindow,
      toolCount,
      cwd,
    })
  }, [
    contextWindow,
    cwd,
    effort,
    model,
    permissionMode,
    sandboxBackend,
    sandboxIsolated,
    session,
    store,
    toolCount,
  ])

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header status={state.status} agentState={state.agentState} tick={tick} />

      <Box flexDirection="column" height={transcriptHeight} overflow="hidden">
        <Transcript
          items={state.transcript}
          width={width}
          expanded={state.expandedTools}
          onToggle={(id) => store.toggleTool(id)}
        />
      </Box>

      {permission ? (
        <PermissionDialog
          prompt={permission.prompt}
          width={width}
          onChoice={(choice) => {
            permission.resolve(choice)
            setPermission(null)
          }}
        />
      ) : (
        <Input
          workspaceRoot={session.config.workspaceRoot}
          busy={state.busy}
          onSubmit={runTurn}
          onInterrupt={() => {
            if (session.isBusy) {
              session.interrupt()
              store.addNotice('warn', 'Interrupted.')
            }
          }}
          onExit={exit}
        />
      )}

      <StatusBar
        status={state.status}
        width={width}
        hint={state.busy ? `${commands} commands · esc interrupts` : `${commands} commands · /help`}
      />

      {state.busy && !permission ? (
        <Box marginTop={0}>
          <Text color={theme.brand}>{'◆ '}</Text>
          <Text color={theme.textDim}>
            {state.agentState === 'acting'
              ? 'Pixel is working…'
              : state.agentState === 'verifying'
                ? 'Pixel is verifying the change…'
                : 'Pixel is thinking…'}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * Command dispatch context.
 *
 * Local commands act on the store directly; anything that needs the model is
 * routed back through the normal turn pipeline so it appears in the
 * conversation like everything else the agent does.
 */
function commandContext(
  session: Session,
  store: UIStore,
  exit: () => void,
  send: (text: string) => void,
): CommandContext {
  return {
    send,

    clear() {
      session.runtime.reset()
      store.clearTranscript()
      store.addNotice('info', 'Conversation cleared.')
    },

    setEffort(effort: EffortLevel) {
      if (!EFFORT_LEVELS.includes(effort)) {
        store.addNotice('error', `Unknown effort "${effort}". Try: ${EFFORT_LEVELS.join(', ')}.`)
        return
      }
      session.setEffort(effort)
      const profile = effortProfile(effort)
      const detail = profile.subagents
        ? `Main agent: ${profile.main}. Subagents: ${profile.subagents} (up to ${profile.maxSubagents} at once).`
        : `Main agent: ${profile.main}. Single-agent mode.`
      store.addNotice('info', `${formatEffortLabel(effort)} enabled — ${detail}`)
    },

    setModel(spec: string) {
      const result = session.setModel(spec)
      if (result.ok) {
        const missing = session.provider?.configured?.() === false
        store.addNotice(
          missing ? 'warn' : 'info',
          missing
            ? `Model set to ${result.label}, but ${session.provider?.label} has no credentials yet. See /providers.`
            : `Model set to ${result.label}${session.provider ? ` (${session.provider.id})` : ''}.`,
        )
      } else store.addNotice('error', result.reason)
    },

    toggleAuto() {
      const next = session.config.permissionMode === 'auto' ? 'ask' : 'auto'
      session.setPermissionMode(next)
      store.addNotice(
        'info',
        next === 'auto'
          ? 'Auto mode on: safe operations proceed automatically; anything risky will still ask.'
          : 'Auto mode off: you will be asked about every operation above trivial risk.',
      )
    },

    permissions(arg: string) {
      const modes = ['ask', 'auto', 'full-control'] as const
      if (arg) {
        const next = modes.find((m) => m === arg)
        if (!next) {
          store.addNotice('error', `Unknown mode "${arg}". Use ask, auto or full-control.`)
          return
        }
        session.setPermissionMode(next)
        store.patchStatus({ permissionMode: next })
        store.addNotice(
          next === 'full-control' ? 'warn' : 'info',
          next === 'full-control'
            ? 'Full control: no permission prompts for the rest of this session. Sandbox isolation is unchanged.'
            : `Permission mode: ${next}`,
        )
        return
      }
      const grants = session.permissions.activeGrants()
      store.addNotice(
        'info',
        [
          `Permission mode: ${session.config.permissionMode}`,
          grants.length > 0
            ? `Approved for this task:\n${grants.map((g) => `  • ${g.description}`).join('\n')}`
            : 'Nothing is pre-approved for this task.',
          'Change it with /permissions ask | auto | full-control.',
        ].join('\n'),
      )
    },

    async showProviders() {
      store.addNotice('info', 'Checking providers…')
      const providers = await session.describeProviders(true)
      const lines = providers.map((p) => {
        const mark = p.ok ? '●' : p.configured ? '◐' : '○'
        const state = p.ok ? 'ready' : (p.reason ?? 'not available')
        const first = p.models
          .slice(0, 3)
          .map((m) => m.id)
          .join(', ')
        const more = p.models.length > 3 ? `, +${p.models.length - 3} more` : ''
        return `${mark} ${p.id}${p.active ? ' (active)' : ''} — ${state}${first ? `\n    ${first}${more}` : ''}`
      })
      store.addNotice(
        'info',
        [
          ...lines,
          '',
          'Providers: anthropic, google (AI Studio), openai, or any OpenAI-compatible endpoint from config.',
          'Use provider:model with /model to pick one explicitly.',
        ].join('\n'),
      )
    },

    showConfig() {
      store.addNotice('info', describeConfig(session.resolvedConfig))
    },

    showStatus() {
      const info = session.sandbox.info
      const grants = session.permissions.activeGrants()
      store.addNotice(
        'info',
        [
          `Model: ${session.modelLabel} (${session.model})${session.provider ? ` via ${session.provider.id}` : ''}`,
          `Effort: ${formatEffortLabel(session.effort)}`,
          `Permissions: ${session.config.permissionMode}`,
          `Sandbox: ${info.backend} — ${info.isolated ? 'active' : 'NOT ACTIVE'}`,
          `Tools: ${session.tools.visible().length}`,
          grants.length > 0
            ? `Task grants: ${grants.map((g) => g.description).join(', ')}`
            : 'Task grants: none',
        ].join('\n'),
      )
    },

    showDiff() {
      void session.gitStatus().then((stat) => {
        if (!stat) {
          store.addNotice('error', 'Could not read git state — is this a git repository?')
          return
        }
        if (stat.files === 0) {
          store.addNotice('info', 'No unstaged changes.')
          return
        }
        store.addNotice(
          'info',
          `${stat.files} file(s) changed  +${stat.insertions} -${stat.deletions}\nAsk the agent to show a specific diff, or use \`git diff <path>\` in another terminal.`,
        )
      })
    },

    showPlan() {
      const plan = session.runtime.plan
      if (plan.length === 0) {
        store.addNotice('info', 'No active plan.')
        return
      }
      store.addNotice(
        'info',
        plan
          .map((s) => `${s.status === 'done' ? '✓' : s.status === 'active' ? '◆' : '◇'} ${s.text}`)
          .join('\n'),
      )
    },

    runTests() {
      send(
        'Run the project test suite. Start with the smallest useful scope, and report exactly what passed and what failed.',
      )
    },

    compact() {
      const result = session.compact()
      store.addNotice(
        result.didCompact ? 'info' : 'warn',
        result.didCompact
          ? `Compacted the conversation: ~${result.beforeTokens.toLocaleString()} → ~${result.afterTokens.toLocaleString()} tokens.`
          : 'Nothing to compact yet; the conversation is already short.',
      )
    },

    review() {
      send(
        'Review the changes made in this session. Look for correctness bugs, missed callers, and anything that would surprise a reviewer. Report findings; do not change code yet.',
      )
    },

    undo(force: boolean) {
      void SnapshotManager.get()
        .undo({ force })
        .then((res) => {
          store.addNotice(res.success ? 'info' : 'warn', res.message)
        })
    },

    redo(force: boolean) {
      void SnapshotManager.get()
        .redo({ force })
        .then((res) => {
          store.addNotice(res.success ? 'info' : 'warn', res.message)
        })
    },

    exit,

    listAgents() {
      const profile = effortProfile(session.effort)
      if (!profile.subagents) {
        store.addNotice(
          'info',
          'Single-agent mode. /effort ultracode (main xHigh + High subagents) or /effort maxcode (main Max + Pro subagents) lets the agent fan out.',
        )
        return
      }
      store.addNotice(
        'info',
        `Subagents are on: up to ${profile.maxSubagents} run at once at ${profile.subagents} effort. ` +
          'They start when the agent calls spawn_subagent, and their tool calls appear in the transcript with a sub-N prefix.',
      )
    },

    async plugins(args: string) {
      const [verb, name] = args.split(/\s+/)
      if (verb === 'enable' || verb === 'disable') {
        if (!name) {
          store.addNotice('error', `Usage: /plugins ${verb} <name>`)
          return
        }
        const ok = await pluginManager.setEnabled(name, verb === 'enable')
        store.addNotice(
          ok ? 'info' : 'error',
          ok
            ? `Plugin ${name} ${verb}d. MCP servers change on next start.`
            : `No plugin named "${name}".`,
        )
        return
      }
      store.addNotice('info', pluginManager.formatStatus())
    },

    webSearch() {
      store.addNotice('info', 'Web search: try `/web <query>`, or just ask for something current.')
    },

    showSandbox() {
      const info = session.sandbox.info
      const policy = session.sandbox.policy
      store.addNotice(
        info.isolated ? 'info' : 'warn',
        [
          `Backend: ${info.backend}`,
          `Status: ${info.isolated ? 'ACTIVE' : 'NOT ACTIVE'}`,
          `Detail: ${info.detail}`,
          `Writable roots: ${policy.writeRoots.join(', ')}`,
          `Network: ${policy.network.mode}`,
          `Denied: ${policy.denyPaths.slice(0, 6).join(', ')}…`,
        ].join('\n'),
      )
    },

    async listModels() {
      const providers = await session.describeProviders(true)
      const blocks = providers
        .filter((p) => p.models.length > 0)
        .map((p) => {
          const rows = p.models.map(
            (m) =>
              `  ${m.id.padEnd(30)} ${m.label}, ${Math.round(m.contextWindow / 1000)}k ctx${m.id === session.model ? '  ← current' : ''}`,
          )
          return `${p.label}${p.configured ? '' : ' (no credentials)'}\n${rows.join('\n')}`
        })
      store.addNotice(
        'info',
        `${blocks.join('\n\n')}\n\nSet one with /model <name>. Any model id your endpoint serves works as provider:model.`,
      )
    },

    showHelp() {
      const rows = allCommands().map(
        (c) => `/${c.name.padEnd(12)} ${c.summary}${c.args ? `  ${c.args}` : ''}`,
      )
      store.addNotice(
        'info',
        [
          'Talk naturally to the agent — that is the main interface.',
          '',
          ...rows,
          '',
          'Enter sends · Shift+Enter newline · @file completes paths · Esc interrupts · Ctrl+D exits',
        ].join('\n'),
      )
    },
  }
}

function formatEffortLabel(effort: EffortLevel): string {
  if (effort === 'xhigh') return 'xHigh'
  if (effort === 'ultracode') return 'Ultracode'
  if (effort === 'maxcode') return 'Maxcode'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export type { AgentEvent }
