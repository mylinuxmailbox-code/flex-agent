import { z } from 'zod'
import type { NetworkTarget } from '../../permissions/types.js'
import type { SpawnedProcess } from '../../sandbox/types.js'
import { isInside, resolvePath } from '../filesystem/paths.js'
import type { Tool, ToolResult } from '../types.js'
import { errorResult, fail, ok } from '../types.js'

const MAX_TIMEOUT_MS = 600_000
const DEFAULT_TIMEOUT_MS = 120_000

const inputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      'Shell command to run, e.g. `npm test -- auth` or `git status --short`. Runs through a shell so pipes and && work. Prefer a single specific command over a chain of unrelated ones.',
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory, absolute or relative to the workspace root. Defaults to the workspace root.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Kill the command after this long. Default ${DEFAULT_TIMEOUT_MS}ms.`),
  background: z
    .boolean()
    .optional()
    .describe(
      'Start the command without waiting. Use for long-running processes like dev servers. Returns a handle to poll with check_output and stop with kill_process.',
    ),
})

export const runCommandTool: Tool<typeof inputSchema> = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace and return its output and exit code. Output is streamed and truncated; long-running commands should use `background: true` and be polled with check_output. A non-zero exit is returned as evidence, not as a hard failure — read the output and decide what to do next.',
  inputSchema,
  readOnly: false,
  category: 'shell',
  promptGuidance: [
    'A failing command is information, not a dead end: read the actual error text and fix the cause.',
    'Never re-run a command that just failed unchanged. Change something first, or gather more evidence.',
    'Do not use the shell for file reads or edits — use read_file, edit_file, glob and search_text, which are safer and give you line numbers.',
  ].join(' '),

  plan(input, ctx) {
    let cwd = ctx.workspaceRoot
    try {
      cwd = resolvePath(input.cwd ?? '.', ctx)
    } catch {
      /* the classifier still sees the raw command */
    }
    return {
      tool: this.name,
      input,
      command: input.command,
      cwd,
      readPaths: [],
      writePaths: [],
      network: extractNetworkTargets(input.command),
      purpose: input.command,
    }
  },

  async execute(input, ctx): Promise<ToolResult> {
    let cwd: string
    try {
      cwd = resolvePath(input.cwd ?? '.', ctx)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 'run (bad cwd)')
    }
    if (
      !isInside(cwd, ctx.workspaceRoot) &&
      !ctx.sandbox.writableRoots().some((r) => isInside(cwd, r))
    ) {
      return fail(`Working directory is outside the workspace: ${input.cwd}`, 'run (bad cwd)')
    }

    if (input.background) {
      return runBackground(input, ctx, cwd)
    }

    const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS
    let started = 0
    try {
      started = Date.now()
      const handle = await ctx.sandbox.exec(
        {
          command: 'bash',
          args: ['-lc', input.command],
          cwd,
          timeoutMs: timeout,
          signal: ctx.signal,
        },
        (chunk, stream) => ctx.emit({ type: 'output', stream, chunk }),
      )
      const elapsed = Date.now() - started
      return formatResult(handle, elapsed, input.command, ctx.sandbox.policy.limits.outputBytes)
    } catch (err) {
      return errorResult(err, 'run failed')
    }
  },
}

const MAX_BACKGROUND = 8

function runBackground(
  input: z.output<typeof inputSchema>,
  ctx: Parameters<Tool['execute']>[1],
  cwd: string,
): ToolResult {
  const running = [...backgroundProcesses.values()].filter((p) => p.exitCode === undefined).length
  if (running >= MAX_BACKGROUND) {
    return fail(
      `${running} background processes are already running (limit ${MAX_BACKGROUND}). Stop one with kill_process first.`,
      'background (limit)',
    )
  }
  const id = `bg-${++backgroundSeq}`
  const state: BackgroundProcess = {
    id,
    command: input.command,
    startedAt: Date.now(),
    output: [],
    size: 0,
    truncated: false,
    exitCode: undefined,
    proc: undefined,
  }
  // Goes through the sandbox like every other command: same isolation, same
  // scrubbed environment. Output is buffered for check_output, not streamed to
  // the UI, because the tool call that started it has already returned.
  state.proc = ctx.sandbox.spawn(
    { command: 'bash', args: ['-lc', input.command], cwd },
    (text, stream) => appendOutput(state, text, stream),
  )
  void state.proc.exited.then((result) => {
    state.exitCode = result.exitCode ?? (result.signal ? -1 : null)
    state.signal = result.signal ?? undefined
  })
  backgroundProcesses.set(id, state)

  return ok(
    `Started background process ${id}: ${input.command}\nPID ${state.proc.pid ?? '?'}\n` +
      `Poll with check_output({ process_id: "${id}" }) and stop with kill_process({ process_id: "${id}" }).`,
    `background ${id}`,
    { processId: id, pid: state.proc.pid },
  )
}

// ---------------------------------------------------------------------------
// Background process registry
// ---------------------------------------------------------------------------

interface BackgroundProcess {
  id: string
  command: string
  startedAt: number
  output: string[]
  size: number
  truncated: boolean
  /** undefined while running; a number (or null if unknown) once finished. */
  exitCode: number | null | undefined
  signal?: string
  proc: SpawnedProcess | undefined
}

const backgroundProcesses = new Map<string, BackgroundProcess>()
let backgroundSeq = 0

const BG_OUTPUT_CAP = 200_000

function appendOutput(state: BackgroundProcess, text: string, stream: 'stdout' | 'stderr'): void {
  if (state.size >= BG_OUTPUT_CAP) {
    state.truncated = true
    return
  }
  const chunk = stream === 'stdout' ? text : `[stderr] ${text}`
  state.output.push(chunk)
  state.size += chunk.length
}

/** Stop every background process. Called when the session ends. */
export function killAllBackground(): void {
  for (const state of backgroundProcesses.values()) {
    if (state.exitCode === undefined) state.proc?.kill('SIGKILL')
  }
}

// Whatever ends the CLI, do not leave dev servers behind.
process.once('exit', killAllBackground)

const checkOutputSchema = z.object({
  process_id: z.string().describe('The process_id returned when the command was started.'),
})

export const checkOutputTool: Tool<typeof checkOutputSchema> = {
  name: 'check_output',
  description:
    'Check a background process started with run_command: whether it is still running, its accumulated output, and its exit code once finished.',
  inputSchema: checkOutputSchema,
  readOnly: true,
  category: 'shell',

  plan(input) {
    return { tool: this.name, input, purpose: `check ${input.process_id}` }
  },

  async execute(input) {
    const state = backgroundProcesses.get(input.process_id)
    if (!state) {
      return fail(`No background process with id ${input.process_id}.`, 'check_output')
    }
    const running = state.exitCode === undefined
    const elapsed = Math.round((Date.now() - state.startedAt) / 1000)
    const status = running
      ? `still running (${elapsed}s elapsed)`
      : `finished with exit code ${state.exitCode ?? 'unknown'}${state.signal ? ` (${state.signal})` : ''} (${elapsed}s)`
    const output = state.output.join('').slice(-8000) || '(no output yet)'
    return ok(
      `Process ${state.id}: ${status}\nCommand: ${state.command}\n\n${output}${state.truncated ? '\n[output truncated]' : ''}`,
      `check ${state.id} (${running ? 'running' : 'done'})`,
      { running, exitCode: state.exitCode },
    )
  },
}

const killSchema = z.object({
  process_id: z.string().describe('The process_id to terminate.'),
})

export const killProcessTool: Tool<typeof killSchema> = {
  name: 'kill_process',
  description: 'Terminate a background process started by run_command.',
  inputSchema: killSchema,
  readOnly: false,
  category: 'shell',

  plan(input) {
    return { tool: this.name, input, purpose: `kill ${input.process_id}` }
  },

  async execute(input) {
    const state = backgroundProcesses.get(input.process_id)
    if (!state) return fail(`No background process with id ${input.process_id}.`, 'kill')
    if (state.exitCode !== undefined) {
      return ok(
        `Process ${state.id} already exited with code ${state.exitCode}.`,
        `kill ${state.id}`,
      )
    }
    state.proc?.kill('SIGTERM')
    setTimeout(() => {
      if (state.exitCode === undefined) state.proc?.kill('SIGKILL')
    }, 3000).unref?.()
    return ok(`Sent SIGTERM to ${state.id} and its child processes.`, `kill ${state.id}`)
  },
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatResult(
  handle: Awaited<ReturnType<Parameters<Tool['execute']>[1]['sandbox']['exec']>>,
  elapsed: number,
  command: string,
  cap: number,
): ToolResult {
  const parts: string[] = []
  parts.push(`$ ${command}`)
  parts.push(`exit code: ${handle.exitCode ?? 'killed by signal'} (${elapsed}ms)`)
  if (handle.timedOut) parts.push('*** command timed out and was terminated ***')
  if (handle.stdout.trim()) parts.push(`\n--- stdout ---\n${handle.stdout}`)
  if (handle.stderr.trim()) parts.push(`\n--- stderr ---\n${handle.stderr}`)
  if (!handle.stdout.trim() && !handle.stderr.trim()) parts.push('\n(no output)')
  if (handle.truncated) {
    parts.push(`\n[output exceeded ${Math.round(cap / 1024)}KB and was truncated]`)
  }

  return {
    content: parts.join('\n'),
    isError: handle.exitCode !== 0,
    display: `run ${command.slice(0, 60)}${command.length > 60 ? '…' : ''} → ${handle.exitCode ?? 'signal'}`,
    metadata: { exitCode: handle.exitCode, durationMs: elapsed, timedOut: handle.timedOut },
  }
}

/**
 * Best-effort host extraction for the risk engine.
 *
 * This never blocks the request — the classifier's command rules are the real
 * defence. It only lets the permission dialog say "contacts api.github.com"
 * instead of "runs a shell command".
 */
export function extractNetworkTargets(command: string): NetworkTarget[] {
  const hosts = new Set<string>()
  const urlRe = /\b(?:https?|wss?):\/\/([^\s/:@'"]+)/g
  for (const m of command.matchAll(urlRe)) {
    if (m[1]) hosts.add(m[1])
  }
  const scpRe = /\b(?:ssh|scp|rsync)\s+(?:-\S+\s+)*([\w.-]+)@([\w.-]+)/g
  for (const m of command.matchAll(scpRe)) {
    if (m[2]) hosts.add(m[2])
  }
  const curlHostRe =
    /\b(?:curl|wget)\b[^|;&]*?(?:--header\s+)?(?:https?:\/\/)?([\w-]+(?:\.[\w-]+)+)/g
  for (const m of command.matchAll(curlHostRe)) {
    if (m[1] && !/^\d+$/.test(m[1])) hosts.add(m[1])
  }
  return [...hosts].slice(0, 20).map((host) => ({ host, protocol: 'other' as const }))
}
