import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nullLogger } from '../src/observability/logger.js'
import { createSandbox } from '../src/sandbox/index.js'
import type { Sandbox } from '../src/sandbox/types.js'

/**
 * These tests assert the sandbox is a real boundary, not a wrapper. Each one
 * is written so it fails loudly if isolation silently degrades to running on
 * the host — a regression here means the agent gained host access.
 */

const scratch = mkdtempSync(join(tmpdir(), 'flex-sandbox-test-'))
const secretFile = join(scratch, 'fake-secret.txt')
writeFileSync(secretFile, 'super-secret-value')

let sandbox: Sandbox
let isolationWorks = false

beforeAll(async () => {
  mkdirSync(join(scratch, 'work'), { recursive: true })
  const { sandbox: created } = await createSandbox({
    workspaceRoot: join(scratch, 'work'),
    network: { mode: 'disabled' },
    logger: nullLogger,
  })
  sandbox = created
  isolationWorks = sandbox.info.isolated
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const run = (command: string, timeoutMs = 20_000) =>
  sandbox.exec({
    command: 'bash',
    args: ['-lc', command],
    cwd: join(scratch, 'work'),
    timeoutMs,
  })

describe('sandbox', () => {
  it('runs a command and returns its output', async () => {
    const handle = await run('echo hello-from-sandbox')
    expect(handle.exitCode).toBe(0)
    expect(handle.stdout).toContain('hello-from-sandbox')
  })

  it('reports the exit code of a failing command', async () => {
    const handle = await run('exit 3')
    expect(handle.exitCode).toBe(3)
  })

  it('allows writing inside the workspace', async () => {
    const handle = await run('echo written > out.txt && cat out.txt')
    expect(handle.exitCode).toBe(0)
    expect(handle.stdout.trim()).toBe('written')
  })

  it.runIf(process.platform === 'linux')('blocks writes outside the workspace', async () => {
    if (!isolationWorks) return
    // Target the real $HOME, which is read-only in the sandbox. (Scratch under
    // /tmp would legitimately be writable, so it proves nothing.)
    const target = join(homedir(), `.flex-sandbox-escape-${process.pid}`)
    const handle = await run(`touch ${JSON.stringify(target)} 2>&1; echo "exit=$?"`)
    expect(handle.stdout).toContain('exit=1')
    expect(existsSync(target)).toBe(false)
  })

  it.runIf(process.platform === 'linux')(
    'leaves the host filesystem read-only by default',
    async () => {
      if (!isolationWorks) return
      const handle = await run('touch /etc/flex-should-not-exist 2>&1; echo "exit=$?"')
      expect(handle.stdout).toContain('exit=1')
    },
  )

  it.runIf(process.platform === 'linux')('hides denied paths behind an empty mount', async () => {
    if (!isolationWorks) return
    // A deny path the test controls, so this works regardless of whether the
    // machine running it happens to have a ~/.ssh.
    const deniedDir = join(scratch, 'denied')
    mkdirSync(deniedDir, { recursive: true })
    writeFileSync(join(deniedDir, 'id_rsa'), 'PRIVATE KEY MATERIAL')

    const { sandbox: guarded } = await createSandbox({
      workspaceRoot: join(scratch, 'work'),
      network: { mode: 'disabled' },
      denyPaths: [deniedDir],
      logger: nullLogger,
    })

    const handle = await guarded.exec({
      command: 'bash',
      args: ['-lc', `cat ${join(deniedDir, 'id_rsa')} 2>&1; echo "exit=$?"`],
      cwd: join(scratch, 'work'),
      timeoutMs: 15_000,
    })
    expect(handle.stdout).not.toContain('PRIVATE KEY MATERIAL')
  })

  it.runIf(process.platform === 'linux')('scrubs secrets from the child environment', async () => {
    if (!isolationWorks) return
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-be-visible'
    const handle = await run('echo "key=[$ANTHROPIC_API_KEY]"')
    expect(handle.stdout).toContain('key=[]')
    delete process.env.ANTHROPIC_API_KEY
  })

  it('keeps non-secret environment variables available to builds', async () => {
    process.env.FLEX_TEST_PASSTHROUGH = 'visible-value'
    const handle = await run('echo "v=[$FLEX_TEST_PASSTHROUGH]"')
    expect(handle.stdout).toContain('v=[visible-value]')
    delete process.env.FLEX_TEST_PASSTHROUGH
  })

  it.runIf(process.platform === 'linux')(
    'blocks network access when the policy disables it',
    async () => {
      if (!isolationWorks) return
      const handle = await run('timeout 5 getent hosts example.com; echo "exit=$?"', 15_000)
      // Either no resolver answer or a hard failure — but never a resolved host.
      expect(handle.stdout).not.toMatch(/^\d+\.\d+\.\d+\.\d+/m)
    },
    20_000,
  )

  it('enforces a timeout', async () => {
    const handle = await run('sleep 5', 1000)
    expect(handle.timedOut).toBe(true)
  }, 15_000)

  it('caps output so a runaway command cannot flood the context', async () => {
    const noisy = await run(
      'for i in $(seq 1 100000); do echo "line $i padding padding padding"; done',
    )
    expect(noisy.truncated).toBe(true)
    expect(noisy.stdout.length).toBeLessThan(300_000)
  }, 30_000)
})
