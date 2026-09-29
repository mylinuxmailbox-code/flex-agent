import { spawn as spawnChild } from 'node:child_process'
import type { SpawnedProcess } from './types.js'

/** True when `child` is `parent` or lives beneath it. Handles parent === '/'. */
export function isUnder(child: string, parent: string): boolean {
  if (parent === '/') return child.startsWith('/')
  if (child === parent) return true
  return child.startsWith(`${parent}/`)
}

/**
 * Start a process in its own process group so `kill` reaches its children too
 * (a dev server started through `npm run dev` is three processes deep).
 */
export function spawnDetached(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
  onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void,
): SpawnedProcess {
  const child = spawnChild(argv[0] as string, argv.slice(1), {
    cwd,
    env: env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (c: Buffer) => onOutput(c.toString('utf8'), 'stdout'))
  child.stderr?.on('data', (c: Buffer) => onOutput(c.toString('utf8'), 'stderr'))
  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.on('error', (err) => {
      onOutput(`failed to start: ${err.message}\n`, 'stderr')
      resolve({ exitCode: null, signal: null })
    })
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  return {
    pid: child.pid,
    exited,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      try {
        if (child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          /* already gone */
        }
      }
    },
  }
}
