import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '../agent/events.js'
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

  const runTurn = useCallback(
    (text: string) => {
      if (runningRef.current || store.getSnapshot().busy) return
      runningRef.current = true

      const isCommand = text.startsWith('/')
      if (isCommand) {
        const [name, ...rest] = text.slice(1).split(/\s+/)
        const command = findCommand(name ?? '')
        if (command) {
          void command.run(rest.join(' '), commandContext(session, store, exit))
          runningRef.current = false
          return
        }
        store.addNotice('error', `Unknown command /${name}. Try /help.`)
        runningRef.current = false
        return
      }

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
    [exit, session, store],
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
function commandContext(session: Session, store: UIStore, exit: () => void): CommandContext {
  const send = (text: string) => {
    store.addUserMessage(text)
    store.setBusy(true)
    store.patchStatus({ elapsedMs: 0 })
    void (async () => {
      try {
        for await (const event of session.runTurn(text)) store.apply(event)
      } catch (err) {
        store.apply({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      } finally {
        store.update((state) => sealStreamingAssistant(state))
        store.setBusy(false)
      }
    })()
  }

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
      if (result.ok) store.addNotice('info', `Model set to ${result.label}.`)
      else store.addNotice('error', result.reason)
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

    cyclePermissionMode() {
      const order = ['ask', 'auto', 'full-control'] as const
      const current = order.indexOf(session.config.permissionMode)
      const next = order[(current + 1) % order.length] ?? 'ask'
      session.setPermissionMode(next)
      store.addNotice(
        next === 'full-control' ? 'warn' : 'info',
        next === 'full-control'
          ? 'Permission prompts disabled for this session. Sandbox isolation is unchanged; use --full-control before launch to disable it too.'
          : `Permission mode: ${next}`,
      )
    },

    showStatus() {
      const info = session.sandbox.info
      const grants = session.permissions.activeGrants()
      store.addNotice(
        'info',
        [
          `Model: ${session.modelLabel} (${session.model})`,
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
          `${stat.files} file(s) changed  +${stat.insertions} -${stat.deletions}\nAsk Pixel to show a specific diff, or run git_diff on a path.`,
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
      store.addNotice(
        'info',
        'Compaction runs automatically when context fills. Use /clear to start fresh.',
      )
    },

    review() {
      send(
        'Review the changes made in this session. Look for correctness bugs, missed callers, and anything that would surprise a reviewer. Report findings; do not change code yet.',
      )
    },

    undo() {
      void SnapshotManager.get()
        .undo()
        .then((res) => {
          store.addNotice(res.success ? 'info' : 'warn', res.message)
        })
    },

    redo() {
      void SnapshotManager.get()
        .redo()
        .then((res) => {
          store.addNotice(res.success ? 'info' : 'warn', res.message)
        })
    },

    exit,

    listAgents() {
      store.addNotice(
        'info',
        'No subagents are running. Switch to /effort ultracode (main xHigh + High subagents) or /effort maxcode (main Max + Pro subagents) to fan out.',
      )
    },

    openPlugins() {
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

    listModels() {
      const models = session.providers.flatMap((p) =>
        p
          .listModels()
          .map((m) => `${m.id}  —  ${m.label}, ${Math.round(m.contextWindow / 1000)}k ctx`),
      )
      store.addNotice(
        'info',
        `Available models:\n${models.join('\n')}\n\nSet one with /model <name>.`,
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
