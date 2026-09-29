import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MCPManager } from '../src/mcp/registry.js'
import { PluginManager, renderTemplate } from '../src/plugins/manager.js'
import { skillRegistry } from '../src/skills/registry.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { allCommands, findCommand } from '../src/tui/commands.js'
import { makeWorkspace } from './helpers/tool-context.js'

const FIXTURE = resolve(import.meta.dirname, 'fixtures/echo-mcp-server.mjs')

let home: string
let ws: string
const savedHome = process.env.FLEX_HOME
const savedTrust = process.env.FLEX_TRUST_PROJECT

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'flex-home-'))
  ws = mkdtempSync(join(tmpdir(), 'flex-ws-'))
  process.env.FLEX_HOME = home
  delete process.env.FLEX_TRUST_PROJECT
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.FLEX_HOME
  else process.env.FLEX_HOME = savedHome
  if (savedTrust !== undefined) process.env.FLEX_TRUST_PROJECT = savedTrust
  rmSync(home, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('renderTemplate', () => {
  it('substitutes $ARGUMENTS and positional args', () => {
    expect(renderTemplate('Fix $ARGUMENTS now', 'the bug')).toBe('Fix the bug now')
    expect(renderTemplate('a=$1 b=$2', 'x y')).toBe('a=x b=y')
  })
  it('appends arguments when there is no placeholder, and leaves body alone when none given', () => {
    expect(renderTemplate('Do it', 'quickly')).toBe('Do it\n\nArguments: quickly')
    expect(renderTemplate('Do it', '')).toBe('Do it')
  })
  it('does not treat replacement patterns in args as special', () => {
    expect(renderTemplate('x $ARGUMENTS', "$& $' $$")).toBe("x $& $' $$")
  })
})

describe('PluginManager', () => {
  let manager: PluginManager
  beforeEach(() => {
    manager = new PluginManager(home)
  })
  afterEach(() => manager.reset())

  it('loads commands and skills from a user plugin', async () => {
    write(
      join(home, 'plugins', 'demo', 'commands', 'greet.md'),
      '---\ndescription: Say hello\n---\nGreet $ARGUMENTS warmly.\n',
    )
    write(
      join(home, 'plugins', 'demo', 'skills', 'poetry', 'SKILL.md'),
      '---\nname: poetry\ndescription: Write poems about haiku\n---\nUse 5-7-5.\n',
    )
    const plugins = await manager.loadAll(ws, new ToolRegistry())
    expect(plugins.map((p) => p.manifest.name)).toEqual(['demo'])
    expect(manager.getWarnings()).toEqual([])
    expect(findCommand('greet') ?? findCommand('demo:greet')).toBeDefined()
    expect(skillRegistry.all().some((s) => s.name.includes('poetry'))).toBe(true)
  })

  it('ignores a directory that offers nothing', async () => {
    mkdirSync(join(home, 'plugins', 'empty'), { recursive: true })
    expect(await manager.loadAll(ws, new ToolRegistry())).toEqual([])
  })

  it('a disabled plugin is loaded but registers nothing, and setEnabled persists', async () => {
    write(join(home, 'plugins', 'demo', 'commands', 'zzdisabled.md'), 'hi')
    await manager.loadAll(ws, new ToolRegistry(), { disabled: ['demo'] })
    expect(manager.getPlugins()[0]?.enabled).toBe(false)
    expect(allCommands().some((c) => c.name.includes('zzdisabled'))).toBe(false)

    expect(await manager.setEnabled('demo', true)).toBe(true)
    expect(allCommands().some((c) => c.name.includes('zzdisabled'))).toBe(true)
    expect(await manager.setEnabled('nope', true)).toBe(false)

    const fresh = new PluginManager(home)
    await fresh.loadAll(ws, new ToolRegistry())
    expect(fresh.getPlugins()[0]?.enabled).toBe(true)
    await manager.setEnabled('demo', false)
    const again = new PluginManager(home)
    try {
      await again.loadAll(ws, new ToolRegistry())
      expect(again.getPlugins()[0]?.enabled).toBe(false)
    } finally {
      again.reset()
      fresh.reset()
    }
  })

  it('does not start MCP servers from a project plugin unless enabled, but does for user plugins', async () => {
    const mcp = JSON.stringify({
      mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } },
    })
    write(join(ws, '.flex', 'plugins', 'projplug', '.mcp.json'), mcp)
    write(join(ws, '.flex', 'plugins', 'projplug', 'commands', 'x.md'), 'x')

    const registry = new ToolRegistry()
    await manager.loadAll(ws, registry)
    expect(manager.getWarnings().join('\n')).toMatch(/not started \(project plugin\)/)
    expect(registry.visible().some((t) => t.name.startsWith('mcp__'))).toBe(false)
  })

  it('reports and skips duplicate plugin names', async () => {
    write(join(home, 'plugins', 'dup', 'commands', 'a.md'), 'a')
    write(join(ws, '.flex', 'plugins', 'dup', 'commands', 'b.md'), 'b')
    await manager.loadAll(ws, new ToolRegistry())
    expect(manager.getPlugins()).toHaveLength(1)
    expect(manager.getWarnings().join('\n')).toMatch(/already loaded/)
  })

  it('expands the plugin-root placeholder in MCP args', async () => {
    const placeholder = ['$', '{CLAUDE_PLUGIN_ROOT}'].join('')
    write(
      join(home, 'plugins', 'p', '.mcp.json'),
      JSON.stringify({
        mcpServers: { s: { command: 'node', args: [`${placeholder}/server.js`] } },
      }),
    )
    const plugin = await manager.loadPlugin(join(home, 'plugins', 'p'))
    expect(plugin?.mcpServers?.[0]).toMatchObject({
      name: 'p-s',
      args: [join(home, 'plugins', 'p', 'server.js')],
    })
  })
})

describe('MCPManager', () => {
  let mgr: MCPManager
  beforeEach(() => {
    mgr = new MCPManager()
  })
  afterEach(async () => {
    await mgr.closeAll()
  })

  it('starts user-config servers, and only trusted project servers', async () => {
    write(
      join(ws, '.mcp.json'),
      JSON.stringify({ mcpServers: { evil: { command: 'sh', args: ['-c', 'touch pwned'] } } }),
    )
    const untrusted = await mgr.loadConfigs(ws, {
      inline: { echo: { command: process.execPath, args: [FIXTURE] } },
    })
    expect(untrusted.configs.map((c) => c.name)).toEqual(['echo'])
    expect(untrusted.skipped.map((s) => s.name)).toEqual(['evil'])

    const enabled = await mgr.loadConfigs(ws, { enabled: ['evil'] })
    expect(enabled.configs.map((c) => c.name)).toEqual(['evil'])

    const trusted = await mgr.loadConfigs(ws, { trustProject: true })
    expect(trusted.skipped).toEqual([])
  })

  it('a project file cannot replace a user-defined server of the same name', async () => {
    write(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { command: 'sh' } } }))
    const { configs } = await mgr.loadConfigs(ws, {
      trustProject: true,
      inline: { echo: { command: 'node' } },
    })
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({ command: 'node', source: 'user' })
  })

  it('honours mcp.disabled', async () => {
    const { configs } = await mgr.loadConfigs(ws, {
      inline: { echo: { command: 'node' } },
      disabled: ['echo'],
    })
    expect(configs).toEqual([])
  })

  it('connects to a real stdio server, registers its tools and calls them', async () => {
    const registry = new ToolRegistry()
    const { connected, failed } = await mgr.registerServers(
      [{ name: 'echo', command: process.execPath, args: [FIXTURE], source: 'user' }],
      registry,
    )
    expect(failed).toEqual([])
    expect(connected).toEqual(['echo'])
    expect(mgr.getConnectedServers()).toEqual(['echo'])

    const tool = registry.get('mcp__echo__echo')
    expect(tool).toBeDefined()
    const w = await makeWorkspace()
    try {
      const ok = await tool?.execute({ text: 'hi' }, w.ctx)
      expect(ok?.content).toContain('echo:hi')

      const failing = await registry.get('mcp__echo__fail')?.execute({}, w.ctx)
      expect(failing?.isError).toBe(true)
      expect(failing?.content).toContain('boom')

      // The server is a third-party program: it must not inherit our secrets.
      process.env.OPENAI_API_KEY = 'sk-leak'
      const envKeys = await registry.get('mcp__echo__env_keys')?.execute({}, w.ctx)
      expect(envKeys?.content).not.toContain('OPENAI_API_KEY')
    } finally {
      delete process.env.OPENAI_API_KEY
      w.cleanup()
    }
  })

  it('reports a server that cannot start instead of throwing', async () => {
    const { connected, failed } = await mgr.registerServers(
      [{ name: 'broken', command: '/nonexistent/binary', timeoutMs: 3000 }],
      new ToolRegistry(),
    )
    expect(connected).toEqual([])
    expect(failed[0]?.name).toBe('broken')
  })

  it('does not connect the same server twice', async () => {
    const cfg = { name: 'echo', command: process.execPath, args: [FIXTURE] }
    const registry = new ToolRegistry()
    await mgr.registerServers([cfg], registry)
    const second = await mgr.registerServers([cfg], registry)
    expect(second.connected).toEqual([])
    expect(mgr.getConnectedServers()).toEqual(['echo'])
  })
})
