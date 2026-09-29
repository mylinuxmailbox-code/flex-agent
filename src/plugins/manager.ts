import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { mcpManager } from '../mcp/registry.js'
import type { MCPServerConfig } from '../mcp/types.js'
import { flexHome } from '../paths.js'
import { skillRegistry } from '../skills/registry.js'
import type { ToolRegistry } from '../tools/registry.js'
import { type Command, registerCommand, unregisterCommand } from '../tui/commands.js'
import { ClaudeCodeAdapter, type ClaudePluginRawManifest } from './claude-compat.js'
import { deriveKeywords, parseFrontmatter } from './frontmatter.js'
import type { FlexPlugin, PluginManifest } from './types.js'

/**
 * Plugins.
 *
 * A plugin is a directory. Flex reads three kinds of content from it, all of
 * them data rather than code:
 *
 *   commands/*.md          slash commands; the file body is a prompt template
 *   skills/<n>/SKILL.md    guidance injected when the request matches
 *   .mcp.json + manifest   MCP servers, which provide the tools
 *
 * Flex never executes JavaScript from a plugin. Tools come from MCP servers,
 * which run as separate processes behind the permission engine.
 *
 * Manifest formats accepted: `flex-plugin.json`, `.claude-plugin/plugin.json`,
 * `claude-plugin.json`, or a `package.json` that looks like a Claude plugin.
 * A directory with no manifest at all is still a plugin if it has commands or
 * skills.
 */

export interface LoadPluginsOptions {
  /** Plugin names to leave off (from config `plugins.disabled`). */
  disabled?: readonly string[]
  /** Extra directories, each containing plugin directories. */
  paths?: readonly string[]
  /** User-approved MCP server names, for servers that come from project plugins. */
  mcpEnabled?: readonly string[]
}

const MAX_SKILL_CHARS = 6000
// Literal placeholder text plugins write in their MCP args, not a template string.
const PLUGIN_ROOT_VAR = ['$', '{CLAUDE_PLUGIN_ROOT}'].join('')
const FLEX_PLUGIN_ROOT_VAR = ['$', '{FLEX_PLUGIN_ROOT}'].join('')

export class PluginManager {
  private plugins = new Map<string, FlexPlugin>()
  private readonly stateDir: string | undefined
  private warnings: string[] = []

  constructor(stateDir?: string) {
    this.stateDir = stateDir
  }

  private get stateFile(): string {
    return join(this.stateDir ?? flexHome(), 'plugins.json')
  }

  /** Problems found while loading, for `/plugins`. */
  getWarnings(): readonly string[] {
    return this.warnings
  }

  async loadAll(
    workspaceRoot: string,
    toolRegistry: ToolRegistry,
    options: LoadPluginsOptions = {},
  ): Promise<FlexPlugin[]> {
    this.warnings = []
    const disabled = new Set([...(await this.loadDisabledSet()), ...(options.disabled ?? [])])
    const userDir = join(flexHome(), 'plugins')
    const searchDirs: Array<{ dir: string; trusted: boolean }> = [
      { dir: userDir, trusted: true },
      ...(options.paths ?? []).map((dir) => ({ dir, trusted: true })),
      { dir: join(workspaceRoot, '.flex', 'plugins'), trusted: false },
    ]

    const mcpEnabled = new Set(options.mcpEnabled ?? [])
    const mcpToStart: MCPServerConfig[] = []

    for (const { dir, trusted } of searchDirs) {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue // directory does not exist
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const pluginDir = join(dir, entry.name)
        let plugin: FlexPlugin | null
        try {
          plugin = await this.loadPlugin(pluginDir)
        } catch (err) {
          this.warnings.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        if (!plugin) continue
        const name = plugin.manifest.name
        if (this.plugins.has(name)) {
          this.warnings.push(
            `${name}: a plugin with this name is already loaded; skipped ${pluginDir}`,
          )
          continue
        }
        plugin.enabled = !disabled.has(name)
        this.plugins.set(name, plugin)
        if (!plugin.enabled) continue

        for (const command of plugin.commands) {
          if (!registerCommand(command)) {
            this.warnings.push(`${name}: command /${command.name} already exists; skipped`)
          }
        }
        for (const skill of plugin.skills ?? []) skillRegistry.register(skill)

        for (const server of plugin.mcpServers ?? []) {
          // Servers shipped in a user-installed plugin were chosen by the user.
          // Servers in a repo's plugin folder were chosen by the repo.
          if (trusted || mcpEnabled.has(server.name) || process.env.FLEX_TRUST_PROJECT === '1') {
            mcpToStart.push({ ...server, source: trusted ? 'plugin' : 'project' })
          } else {
            this.warnings.push(
              `${name}: MCP server "${server.name}" not started (project plugin); add it to mcp.enabled to allow`,
            )
          }
        }
      }
    }

    if (mcpToStart.length > 0) {
      const result = await mcpManager.registerServers(mcpToStart, toolRegistry)
      for (const f of result.failed) this.warnings.push(`MCP server "${f.name}" failed: ${f.error}`)
    }
    return this.getPlugins() as FlexPlugin[]
  }

  async loadPlugin(pluginDir: string): Promise<FlexPlugin | null> {
    const fallbackName = basename(pluginDir)
    const manifest = await this.#readManifest(pluginDir, fallbackName)
    const commands = await this.#loadCommands(pluginDir, manifest?.name ?? fallbackName)
    const skills = await this.#loadSkills(pluginDir, manifest?.name ?? fallbackName)
    const mcpServers = await this.#loadMcp(pluginDir, manifest)

    // A directory that offers nothing is not a plugin; ignore it quietly.
    if (!manifest && commands.length === 0 && skills.length === 0 && mcpServers.length === 0) {
      return null
    }
    const resolved: PluginManifest = manifest ?? {
      name: fallbackName,
      version: '0.0.0',
      description: `Plugin ${fallbackName}`,
    }
    return {
      manifest: resolved,
      dir: pluginDir,
      enabled: true,
      tools: [],
      commands,
      skills,
      mcpServers,
    }
  }

  async #readManifest(pluginDir: string, fallbackName: string): Promise<PluginManifest | null> {
    const readJson = async (rel: string): Promise<Record<string, unknown> | null> => {
      try {
        return JSON.parse(await readFile(join(pluginDir, rel), 'utf8')) as Record<string, unknown>
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error(`${rel} is not valid JSON`)
      }
    }

    const flex = await readJson('flex-plugin.json')
    if (flex)
      return { name: fallbackName, version: '0.0.0', description: '', ...flex } as PluginManifest

    for (const rel of [join('.claude-plugin', 'plugin.json'), 'claude-plugin.json']) {
      const raw = await readJson(rel)
      if (raw) return ClaudeCodeAdapter.translate(raw as ClaudePluginRawManifest, fallbackName)
    }
    const pkg = await readJson('package.json')
    if (pkg && ClaudeCodeAdapter.isClaudePlugin(pkg)) {
      return ClaudeCodeAdapter.translate(
        pkg as ClaudePluginRawManifest,
        typeof pkg.name === 'string' ? pkg.name : fallbackName,
      )
    }
    return null
  }

  async #loadCommands(pluginDir: string, pluginName: string): Promise<Command[]> {
    const dir = join(pluginDir, 'commands')
    const commands: Command[] = []
    for (const file of await listFiles(dir, '.md')) {
      const source = await readFile(join(dir, file), 'utf8')
      const { data, body } = parseFrontmatter(source)
      if (!body) continue
      const name = `${slug(pluginName)}:${slug(file.replace(/\.md$/, ''))}`
      const description = typeof data.description === 'string' ? data.description : ''
      commands.push({
        name,
        summary: description || `Plugin command from ${pluginName}`,
        args: typeof data['argument-hint'] === 'string' ? data['argument-hint'] : undefined,
        source: pluginName,
        run: (args, ctx) => ctx.send(renderTemplate(body, args)),
      })
    }
    return commands
  }

  async #loadSkills(pluginDir: string, pluginName: string) {
    const dir = join(pluginDir, 'skills')
    const skills: NonNullable<FlexPlugin['skills']> = []
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return skills
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      const { data, body } = parseFrontmatter(await readFile(file, 'utf8'))
      if (!body) continue
      const name = typeof data.name === 'string' && data.name ? data.name : entry.name
      const description = typeof data.description === 'string' ? data.description : ''
      skills.push({
        id: `plugin:${slug(pluginName)}:${slug(name)}`,
        name,
        description,
        keywords: deriveKeywords(name, description, data.keywords),
        guidance:
          body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS)}\n…(truncated)` : body,
      })
    }
    return skills
  }

  async #loadMcp(pluginDir: string, manifest: PluginManifest | null): Promise<MCPServerConfig[]> {
    const declared: Record<string, Omit<MCPServerConfig, 'name'>> = {
      ...((manifest?.mcpServers as Record<string, Omit<MCPServerConfig, 'name'>> | undefined) ??
        {}),
    }
    try {
      const file = JSON.parse(await readFile(join(pluginDir, '.mcp.json'), 'utf8')) as {
        mcpServers?: Record<string, Omit<MCPServerConfig, 'name'>>
      }
      Object.assign(declared, file.mcpServers ?? {})
    } catch {
      /* no .mcp.json */
    }
    const prefix = slug(manifest?.name ?? basename(pluginDir))
    return Object.entries(declared)
      .filter(([, server]) => typeof server?.command === 'string')
      .map(([name, server]) => ({
        ...server,
        // `${CLAUDE_PLUGIN_ROOT}` is the convention plugins use to find their own files.
        args: server.args?.map((a) =>
          a.replaceAll(PLUGIN_ROOT_VAR, pluginDir).replaceAll(FLEX_PLUGIN_ROOT_VAR, pluginDir),
        ),
        cwd: server.cwd ?? pluginDir,
        name: `${prefix}-${name}`,
      }))
  }

  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    const plugin = this.plugins.get(name)
    if (!plugin) return false
    plugin.enabled = enabled
    if (!enabled) {
      for (const c of plugin.commands) unregisterCommand(c.name)
    } else {
      for (const c of plugin.commands) registerCommand(c)
    }
    await this.saveState()
    return true
  }

  getPlugins(): readonly FlexPlugin[] {
    return Array.from(this.plugins.values())
  }

  /** Forget everything loaded. Tests, and a full reload. */
  reset(): void {
    for (const plugin of this.plugins.values()) {
      for (const c of plugin.commands) unregisterCommand(c.name)
    }
    this.plugins.clear()
    this.warnings = []
  }

  formatStatus(): string {
    const list = Array.from(this.plugins.values())
    if (list.length === 0) {
      return (
        'No plugins installed.\n\n' +
        'To install one, put its folder in ~/.flex/plugins/ or .flex/plugins/.\n' +
        'A plugin contributes commands/*.md, skills/*/SKILL.md and MCP servers (.mcp.json).\n' +
        'Claude Code plugins load as they are.'
      )
    }

    const lines = ['Plugins:']
    for (const p of list) {
      const status = p.enabled ? '● enabled' : '○ disabled'
      lines.push(`  ${p.manifest.name} v${p.manifest.version} [${status}]`)
      if (p.manifest.description) lines.push(`    ${p.manifest.description}`)
      const parts = [
        p.commands.length
          ? `${p.commands.length} command(s): ${p.commands.map((c) => `/${c.name}`).join(', ')}`
          : '',
        p.skills?.length ? `${p.skills.length} skill(s)` : '',
        p.mcpServers?.length ? `${p.mcpServers.length} MCP server(s)` : '',
      ].filter(Boolean)
      if (parts.length) lines.push(`    ${parts.join(' · ')}`)
      if (p.manifest.tools?.length) {
        lines.push(
          '    note: manifest "tools" entries are ignored — Flex does not run plugin code; use an MCP server',
        )
      }
    }
    for (const w of this.warnings) lines.push(`  ! ${w}`)
    lines.push(
      '',
      'Use /plugins enable <name> or /plugins disable <name>. Changes to MCP servers apply next session.',
    )
    return lines.join('\n')
  }

  private async loadDisabledSet(): Promise<Set<string>> {
    try {
      const json = JSON.parse(await readFile(this.stateFile, 'utf8')) as { disabled?: string[] }
      return new Set(json.disabled ?? [])
    } catch {
      return new Set()
    }
  }

  private async saveState(): Promise<void> {
    try {
      const disabled = Array.from(this.plugins.values())
        .filter((p) => !p.enabled)
        .map((p) => p.manifest.name)
      await mkdir(this.stateDir ?? flexHome(), { recursive: true })
      await writeFile(this.stateFile, JSON.stringify({ disabled }, null, 2), 'utf8')
    } catch {
      // non-fatal: the toggle still applies to this session
    }
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  )
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(ext)).sort()
  } catch {
    return []
  }
}

/** `$ARGUMENTS` (and `$1`…`$9`) substitution; args with no placeholder are appended. */
export function renderTemplate(body: string, args: string): string {
  const trimmed = args.trim()
  const words = trimmed ? trimmed.split(/\s+/) : []
  let used = false
  const out = body
    .replace(/\$ARGUMENTS/g, () => {
      used = true
      return trimmed
    })
    .replace(/\$([1-9])/g, (_m, n: string) => {
      used = true
      return words[Number(n) - 1] ?? ''
    })
  return used || !trimmed ? out : `${out}\n\nArguments: ${trimmed}`
}

export const pluginManager = new PluginManager()
