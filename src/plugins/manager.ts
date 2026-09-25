import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolRegistry } from '../tools/registry.js'
import { registerCommand } from '../tui/commands.js'
import { ClaudeCodeAdapter, type ClaudePluginRawManifest } from './claude-compat.js'
import type { FlexPlugin, PluginManifest } from './types.js'

export class PluginManager {
  private plugins = new Map<string, FlexPlugin>()
  private stateFile: string

  constructor(stateDir?: string) {
    this.stateFile = join(stateDir ?? join(homedir(), '.flex'), 'plugins.json')
  }

  async loadAll(workspaceRoot: string, toolRegistry: ToolRegistry): Promise<FlexPlugin[]> {
    const disabledSet = await this.loadDisabledSet()
    const searchDirs = [
      join(homedir(), '.flex', 'plugins'),
      join(workspaceRoot, '.flex', 'plugins'),
    ]

    for (const dir of searchDirs) {
      try {
        await mkdir(dir, { recursive: true })
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const pluginDir = join(dir, entry.name)
          const plugin = await this.loadPlugin(pluginDir)
          if (plugin) {
            plugin.enabled = !disabledSet.has(plugin.manifest.name)
            this.plugins.set(plugin.manifest.name, plugin)

            if (plugin.enabled) {
              // Register tools & commands
              for (const tool of plugin.tools) {
                toolRegistry.register(tool)
              }
              for (const cmd of plugin.commands) {
                registerCommand(cmd)
              }
            }
          }
        }
      } catch {
        // ignore missing dirs
      }
    }

    return Array.from(this.plugins.values())
  }

  async loadPlugin(pluginDir: string): Promise<FlexPlugin | null> {
    let manifest: PluginManifest | null = null

    // Try flex manifest
    try {
      const flexJson = await readFile(join(pluginDir, 'flex-plugin.json'), 'utf8')
      manifest = JSON.parse(flexJson) as PluginManifest
    } catch {
      // Try claude manifest
      try {
        const claudeJson = await readFile(join(pluginDir, 'claude-plugin.json'), 'utf8')
        const raw = JSON.parse(claudeJson) as ClaudePluginRawManifest
        manifest = ClaudeCodeAdapter.translate(raw, pluginDir.split('/').pop() ?? 'plugin')
      } catch {
        // Try package.json
        try {
          const pkgJson = await readFile(join(pluginDir, 'package.json'), 'utf8')
          const raw = JSON.parse(pkgJson) as Record<string, unknown>
          if (ClaudeCodeAdapter.isClaudePlugin(raw)) {
            manifest = ClaudeCodeAdapter.translate(
              raw as ClaudePluginRawManifest,
              raw.name as string,
            )
          }
        } catch {
          return null
        }
      }
    }

    if (!manifest) return null

    return {
      manifest,
      dir: pluginDir,
      enabled: true,
      tools: [],
      commands: [],
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    const plugin = this.plugins.get(name)
    if (!plugin) return false
    plugin.enabled = enabled
    await this.saveState()
    return true
  }

  getPlugins(): readonly FlexPlugin[] {
    return Array.from(this.plugins.values())
  }

  formatStatus(): string {
    const list = Array.from(this.plugins.values())
    if (list.length === 0) {
      return (
        'No plugins installed.\n\n' +
        'To install a plugin, drop its folder into ~/.flex/plugins/ or .flex/plugins/.\n' +
        'Claude Code plugins are automatically supported.'
      )
    }

    const lines = ['Installed Plugins:']
    for (const p of list) {
      const status = p.enabled ? '● enabled' : '○ disabled'
      lines.push(`  ${p.manifest.name} v${p.manifest.version} [${status}]`)
      lines.push(`    ${p.manifest.description}`)
    }
    return lines.join('\n')
  }

  private async loadDisabledSet(): Promise<Set<string>> {
    try {
      const data = await readFile(this.stateFile, 'utf8')
      const json = JSON.parse(data) as { disabled?: string[] }
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
      await writeFile(this.stateFile, JSON.stringify({ disabled }, null, 2), 'utf8')
    } catch {
      // non-fatal
    }
  }
}

export const pluginManager = new PluginManager()
