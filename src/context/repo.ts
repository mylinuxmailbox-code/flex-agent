import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { execa } from 'execa'
import { flexDirs } from '../sandbox/index.js'

/**
 * Repository intelligence.
 *
 * Flex should know what kind of project it is in before the user says anything,
 * so the first token spent is not spent on `ls`. This reads manifests and config
 * — a few dozen small files — rather than walking the tree, because a blind
 * walk of a large monorepo is exactly the "do not read the entire repository"
 * failure the design calls out.
 */

const MANIFESTS: Record<string, string> = {
  'package.json': 'Node / TypeScript',
  'tsconfig.json': 'TypeScript project',
  'pnpm-workspace.yaml': 'pnpm monorepo',
  'deno.json': 'Deno',
  'pyproject.toml': 'Python (pyproject)',
  'requirements.txt': 'Python',
  'setup.py': 'Python',
  'Cargo.toml': 'Rust',
  'go.mod': 'Go',
  'pom.xml': 'Java (Maven)',
  'build.gradle': 'Java/Kotlin (Gradle)',
  Gemfile: 'Ruby',
  'composer.json': 'PHP',
  'mix.exs': 'Elixir',
  'pubspec.yaml': 'Dart/Flutter',
  'Package.swift': 'Swift',
  'CMakeLists.txt': 'C/C++ (CMake)',
}

const TOOLING_FILES: Record<string, string> = {
  'CLAUDE.md': 'project instructions for AI agents',
  'FLEX.md': 'Flex project instructions',
  'AGENTS.md': 'agent instructions',
  'README.md': 'documentation',
  'CONTRIBUTING.md': 'contribution guide',
  '.editorconfig': 'editor settings',
  'biome.json': 'Biome (lint + format)',
  '.eslintrc': 'ESLint',
  'eslint.config.js': 'ESLint (flat config)',
  '.prettierrc': 'Prettier',
  'docker-compose.yml': 'Docker Compose',
  Dockerfile: 'Docker',
  Makefile: 'Make',
  justfile: 'just',
}

interface Discovery {
  manifests: string[]
  tooling: string[]
  scripts: string[]
  dependencies: string[]
  devDependencies: string[]
  packageManager?: string
  testCommand?: string
  lintCommand?: string
  typecheckCommand?: string
  buildCommand?: string
  entryPoints: string[]
  topLevelDirs: string[]
}

export async function summariseRepository(root: string): Promise<string> {
  const found = await discover(root)
  const lines: string[] = []

  const kinds = found.manifests
    .map((file) => MANIFESTS[file])
    .filter((v): v is string => Boolean(v))
  if (kinds.length > 0) lines.push(`Project type: ${[...new Set(kinds)].join(', ')}.`)

  if (found.packageManager) lines.push(`Package manager: ${found.packageManager}.`)

  const deps = [...found.dependencies, ...found.devDependencies].slice(0, 25)
  if (deps.length > 0) {
    lines.push(
      `Notable dependencies: ${deps.slice(0, 20).join(', ')}${deps.length > 20 ? ', …' : ''}.`,
    )
  }

  if (found.scripts.length > 0) {
    lines.push(`package.json scripts: ${found.scripts.slice(0, 15).join(', ')}.`)
  }

  const commands: string[] = []
  if (found.testCommand) commands.push(`test: ${found.testCommand}`)
  if (found.typecheckCommand) commands.push(`typecheck: ${found.typecheckCommand}`)
  if (found.lintCommand) commands.push(`lint: ${found.lintCommand}`)
  if (found.buildCommand) commands.push(`build: ${found.buildCommand}`)
  if (commands.length > 0) lines.push(`Verification commands — ${commands.join(' · ')}.`)

  if (found.entryPoints.length > 0) {
    lines.push(`Likely entry points: ${found.entryPoints.slice(0, 6).join(', ')}.`)
  }
  if (found.topLevelDirs.length > 0) {
    lines.push(`Top-level directories: ${found.topLevelDirs.slice(0, 15).join(', ')}.`)
  }
  if (found.tooling.includes('CLAUDE.md') || found.tooling.includes('FLEX.md')) {
    lines.push('This project ships agent instructions — read them before making changes.')
  }

  const isRepo = await isGitRepository(root)
  if (!isRepo) lines.push('This directory is not a git repository.')

  return lines.join('\n')
}

async function discover(root: string): Promise<Discovery> {
  const empty: Discovery = {
    manifests: [],
    tooling: [],
    scripts: [],
    dependencies: [],
    devDependencies: [],
    entryPoints: [],
    topLevelDirs: [],
  }

  const names = new Set<string>()
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return empty
  }

  for (const entry of entries) {
    if (entry.isFile()) names.add(entry.name)
    else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      empty.topLevelDirs.push(entry.name)
    }
  }

  for (const file of Object.keys(MANIFESTS)) if (names.has(file)) empty.manifests.push(file)
  for (const file of Object.keys(TOOLING_FILES)) if (names.has(file)) empty.tooling.push(file)

  // Language breakdown by extension, shallow only.
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name)
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }

  if (names.has('package.json')) {
    const pkg = await readFile(join(root, 'package.json'), 'utf8')
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => null)
    if (pkg) {
      empty.scripts = Object.keys((pkg.scripts as Record<string, string>) ?? {})
      empty.dependencies = Object.keys((pkg.dependencies as Record<string, string>) ?? {})
      empty.devDependencies = Object.keys((pkg.devDependencies as Record<string, string>) ?? {})
      const pm = (pkg.packageManager as string | undefined)?.split('@')[0]
      empty.packageManager = pm
      empty.testCommand = pickScript(empty.scripts, ['test', 'unit', 'jest', 'vitest'])
      empty.lintCommand = pickScript(empty.scripts, ['lint'])
      empty.typecheckCommand = pickScript(empty.scripts, ['typecheck', 'types', 'check-types'])
      empty.buildCommand = pickScript(empty.scripts, ['build'])
      const main = pkg.main as string | undefined
      if (typeof main === 'string') empty.entryPoints.push(main)
    }
  }

  for (const candidate of [
    'src/index.ts',
    'src/main.ts',
    'src/cli/main.ts',
    'src/index.js',
    'index.ts',
    'main.py',
    'src/main.py',
  ]) {
    if (names.has(candidate) || (await exists(join(root, candidate)))) {
      empty.entryPoints.push(candidate)
    }
  }

  if (empty.manifests.includes('pyproject.toml') && !empty.testCommand) {
    empty.testCommand = 'pytest'
  }
  if (empty.manifests.includes('Cargo.toml') && !empty.testCommand) {
    empty.testCommand = 'cargo test'
  }
  if (empty.manifests.includes('go.mod') && !empty.testCommand) {
    empty.testCommand = 'go test ./...'
  }

  return empty
}

function pickScript(scripts: readonly string[], candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const match = scripts.find((s) => s === candidate || s.startsWith(`${candidate}:`))
    if (match) return `npm run ${match}`
  }
  return undefined
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function isGitRepository(root: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    reject: false,
    timeout: 5000,
  })
  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

/**
 * Project instructions.
 *
 * Precedence: FLEX.md (ours) beats CLAUDE.md (Claude Code's) beats AGENTS.md,
 * because a project that maintains both has already said which one it wants.
 */
export async function readProjectInstructions(root: string): Promise<string> {
  for (const file of ['FLEX.md', 'CLAUDE.md', 'AGENTS.md']) {
    try {
      const text = await readFile(join(root, file), 'utf8')
      if (text.trim()) {
        return `From ${file}:\n\n${text.trim().slice(0, 8000)}`
      }
    } catch {
      /* try the next one */
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// project memory
// ---------------------------------------------------------------------------

/**
 * Project memory: small, inspectable facts the agent chooses to keep.
 *
 * Stored as one JSON file per project so it can be read, diffed and deleted by
 * a human without tooling. Secrets are refused at write time rather than
 * filtered at read time, because a filter that misses is worse than no filter.
 */

export interface MemoryFact {
  key: string
  value: string
  /** Who wrote it, and when. */
  source: string
  createdAt: string
}

export function memoryPath(root: string): string {
  return join(flexDirs().stateDir, 'memory', `${sanitizeKey(root)}.json`)
}

function sanitizeKey(root: string): string {
  return (
    root
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'root'
  )
}

export async function readMemory(root: string): Promise<MemoryFact[]> {
  try {
    const text = await readFile(memoryPath(root), 'utf8')
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as MemoryFact[]) : []
  } catch {
    return []
  }
}

export async function writeMemory(root: string, facts: MemoryFact[]): Promise<void> {
  const path = memoryPath(root)
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`, { mode: 0o600 })
}

const SECRET_LIKE =
  /\b(sk-[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-|AIza[0-9A-Za-z_-]{20,})/

/** Refuse anything that looks like a credential. */
export function looksSecret(value: string): boolean {
  return (
    SECRET_LIKE.test(value) ||
    /\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*\S+/i.test(value)
  )
}

export { relative }
