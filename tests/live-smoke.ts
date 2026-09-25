/**
 * Live end-to-end check.
 *
 * Builds a throwaway repository with a real bug and a real failing test, runs
 * the actual agent loop against the configured model through the real sandbox,
 * and verifies the agent fixed the bug by running the test suite itself.
 *
 * Not part of `pnpm test` — it costs money and needs a real credential. Run it
 * with:  pnpm exec tsx tests/live-smoke.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { AgentRuntime } from '../src/agent/runtime/loop.js'
import { summariseRepository } from '../src/context/repo.js'
import { AnthropicProvider } from '../src/models/anthropic.js'
import { effortProfile } from '../src/models/types.js'
import { createLogger } from '../src/observability/logger.js'
import { RiskClassifier } from '../src/permissions/classifier.js'
import { PermissionEngine } from '../src/permissions/policy.js'
import type { PermissionChoice } from '../src/permissions/types.js'
import { createSandbox } from '../src/sandbox/index.js'
import { registerBuiltinTools } from '../src/tools/index.js'
import { ToolRegistry } from '../src/tools/registry.js'

const workspace = mkdtempSync(join(tmpdir(), 'flex-live-'))
mkdirSync(join(workspace, 'src'), { recursive: true })

// A genuine off-by-one: the test asserts inclusive bounds.
writeFileSync(
  join(workspace, 'src', 'clamp.ts'),
  `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

// Retries stop one attempt short of the limit.
export function attemptsRemaining(retriesUsed: number, retryLimit: number): number {
  return retryLimit - retriesUsed - 1
}
`,
)

writeFileSync(
  join(workspace, 'src', 'clamp.test.ts'),
  `import { describe, expect, it } from 'vitest'
import { attemptsRemaining, clamp } from './clamp.js'

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 1, 3)).toBe(3)
    expect(clamp(0, 1, 3)).toBe(1)
  })
})

describe('attemptsRemaining', () => {
  it('reports the correct number of remaining retries', () => {
    expect(attemptsRemaining(0, 3)).toBe(3)
    expect(attemptsRemaining(2, 3)).toBe(1)
    expect(attemptsRemaining(3, 3)).toBe(0)
  })
})
`,
)

writeFileSync(
  join(workspace, 'package.json'),
  JSON.stringify(
    {
      name: 'clamp-repro',
      type: 'module',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^5.0.0' },
    },
    null,
    2,
  ),
)

// The bug test must fail before the agent runs, or the check proves nothing.
const failing = await execa('npx', ['--yes', 'vitest@5', 'run'], {
  cwd: workspace,
  reject: false,
  timeout: 180_000,
}).catch((err) => ({ stdout: String(err), exitCode: 1 }))
console.log('--- test suite BEFORE the agent (expected to fail) ---')
console.log((failing.stdout ?? '').split('\n').slice(-12).join('\n'))

const provider = new AnthropicProvider()
const available = await provider.available()
if (!available.ok) {
  console.error(`\nSkipping live test: ${available.reason}`)
  rmSync(workspace, { recursive: true, force: true })
  process.exit(2)
}

const logger = createLogger({ level: 'debug', dir: join(workspace, '.logs') })
const { sandbox, reason } = await createSandbox({ workspaceRoot: workspace, logger })
console.log(
  `\nSandbox: ${sandbox.info.backend} — ${sandbox.info.isolated ? 'ISOLATED' : 'NOT ISOLATED'} (${reason})`,
)

const registry = new ToolRegistry()
registerBuiltinTools(registry)
console.log(`Tools registered: ${registry.visible().length}`)

const approvals: PermissionChoice[] = []
const permissions = new PermissionEngine({
  mode: 'ask',
  classifier: new RiskClassifier({
    workspaceRoot: workspace,
    tempDir: join(workspace, '.tmp'),
    cacheDir: join(workspace, '.cache'),
  }),
  // Auto-approve for the smoke test, but keep the decision trail so we can
  // assert that nothing genuinely dangerous slipped through unasked.
  prompter: {
    prompt: async (p) => {
      console.log(`  [permission] ${p.risk.level}: ${p.preview} -> allow-once`)
      approvals.push('allow-once')
      return 'allow-once'
    },
  },
})

const runtime = new AgentRuntime({
  provider,
  tools: registry,
  permissions,
  sandbox,
  logger,
  model: 'claude-sonnet-5',
  effort: effortProfile('high'),
  sessionId: 'live-smoke',
  promptContext: {
    workspaceRoot: workspace,
    repoSummary: await summariseRepository(workspace),
    projectInstructions: '',
    notices: [],
    platform: `${process.platform} ${process.arch}`,
    today: new Date().toISOString().slice(0, 10),
    sandboxNote: sandbox.info.detail,
  },
})

console.log('\n--- agent run ---')
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 6 * 60_000)
let turns = 0
let toolCalls = 0

try {
  for await (const event of runtime.run(
    'The test suite is failing. Find the bug, fix it, and verify the fix by running the tests.',
    { signal: controller.signal },
  )) {
    switch (event.type) {
      case 'turn_start':
        turns = event.turn
        break
      case 'tool_start':
        toolCalls++
        process.stdout.write(`  ⚙ ${event.display} …`)
        break
      case 'tool_end':
        process.stdout.write(` ${event.isError ? '✗' : '✓'} ${event.durationMs}ms\n`)
        break
      case 'notice':
        console.log(`  ! ${event.text}`)
        break
      case 'error':
        console.log(`  ✗ error: ${event.error.message}`)
        break
      default:
        break
    }
  }
} finally {
  clearTimeout(timer)
}

console.log(`\nTurns: ${turns} · tool calls: ${toolCalls}`)

const source = readFileSync(join(workspace, 'src', 'clamp.ts'), 'utf8')
console.log(`\n--- resulting source ---\n${source}`)

console.log('\n--- test suite AFTER the agent ---')
const passing = await execa('npx', ['--yes', 'vitest@5', 'run'], {
  cwd: workspace,
  reject: false,
  timeout: 180_000,
}).catch((err) => ({ stdout: String(err.message), exitCode: 1 }))
console.log((passing.stdout ?? '').split('\n').slice(-10).join('\n'))

const fixed = /return retryLimit - retriesUsed/.test(source)
const testsPass =
  /Test Files.*passed/.test(passing.stdout ?? '') && !/failed/.test(passing.stdout ?? '')

console.log('\n================ RESULT ================')
console.log(`bug fixed in source:      ${fixed ? 'YES' : 'NO'}`)
console.log(`test suite passing:      ${testsPass ? 'YES' : 'NO'}`)
console.log(`files changed by agent:  ${runtime.changedFiles.length}`)
console.log(`permission prompts:      ${approvals.length}`)
console.log('======================================')

rmSync(workspace, { recursive: true, force: true })
process.exit(fixed && testsPass ? 0 : 1)
