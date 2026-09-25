import { z } from 'zod'
import type { NetworkTarget } from '../../permissions/types.js'
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
          stdin: ctx.signal ? undefined : undefined,
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

function runBackground(
  input: z.output<typeof inputSchema>,
  ctx: Parameters<Tool['execute']>[1],
  cwd: string,
): ToolResult {
  const { spawn } = require('node:child_process') as typeof import('node:child_process')
  const id = `bg-${Math.abs(hashString(input.command)) % 100000}`
  const child = spawn('bash', ['-lc', input.command], {
    cwd,
    env: { ...process.env },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state: BackgroundProcess = {
    id,
    command: input.command,
    child,
    startedAt: Date.now(),
    output: [],
    truncated: false,
    exitCode: null,
  }
  child.stdout?.on('data', (d: Buffer) => appendOutput(state, d, 'stdout', ctx))
  child.stderr?.on('data', (d: Buffer) => appendOutput(state, d, 'stderr', ctx))
  child.on('exit', (code) => {
    state.exitCode = code
  })
  backgroundProcesses.set(id, state)

  return ok(
    `Started background process ${id}: ${input.command}\nPID ${child.pid ?? '?'}\n` +
      `Poll with check_output({ process_id: "${id}" }) and stop with kill_process({ process_id: "${id}" }).`,
    `background ${id}`,
    { processId: id, pid: child.pid },
  )
}

// ---------------------------------------------------------------------------
// Background process registry
// ---------------------------------------------------------------------------

interface BackgroundProcess {
  id: string
  command: string
  child: import('node:child_process').ChildProcess
  startedAt: number
  output: string[]
  truncated: boolean
  exitCode: number | null
}

const backgroundProcesses = new Map<string, BackgroundProcess>()

const BG_OUTPUT_CAP = 200_000

function appendOutput(
  state: BackgroundProcess,
  chunk: Buffer,
  stream: 'stdout' | 'stderr',
  ctx: Parameters<Tool['execute']>[1],
): void {
  const text = chunk.toString('utf8')
  const used = state.output.reduce((n, s) => n + s.length, 0)
  if (used >= BG_OUTPUT_CAP) {
    state.truncated = true
    return
  }
  state.output.push(stream === 'stdout' ? text : `[stderr] ${text}`)
  ctx.emit({ type: 'output', stream, chunk: text })
}

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
    const running = state.exitCode === null
    const elapsed = Math.round((Date.now() - state.startedAt) / 1000)
    const status = running
      ? `still running (${elapsed}s elapsed)`
      : `finished with exit code ${state.exitCode} (${elapsed}s)`
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
    if (state.exitCode !== null) {
      return ok(
        `Process ${state.id} already exited with code ${state.exitCode}.`,
        `kill ${state.id}`,
      )
    }
    state.child.kill('SIGTERM')
    setTimeout(() => {
      if (state.exitCode === null) state.child.kill('SIGKILL')
    }, 3000).unref?.()
    return ok(`Sent SIGTERM to ${state.id}.`, `kill ${state.id}`)
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

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
