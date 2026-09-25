import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from '../src/plugins/claude-compat.js'
import { PluginManager } from '../src/plugins/manager.js'

describe('ClaudeCodeAdapter', () => {
  it('detects and translates a Claude Code plugin manifest', () => {
    const raw = {
      name: 'super-linter',
      version: '1.2.0',
      description: 'Lints everything',
      commands: [{ name: 'lint', description: 'Run linter' }],
      skills: ['linting'],
      permissions: {
        filesystem: 'workspace',
        terminal: true,
      },
    }

    expect(ClaudeCodeAdapter.isClaudePlugin(raw)).toBe(true)

    const translated = ClaudeCodeAdapter.translate(raw)
    expect(translated.name).toBe('super-linter')
    expect(translated.version).toBe('1.2.0')
    expect(translated.capabilities?.filesystem).toBe('workspace')
    expect(translated.capabilities?.shell).toBe(true)
    expect(translated.commands).toContain('lint')
  })
})

describe('PluginManager', () => {
  it('formats status nicely when no plugins are installed', () => {
    const manager = new PluginManager('/tmp/non-existent-dir')
    const status = manager.formatStatus()
    expect(status).toContain('No plugins installed')
  })
})
