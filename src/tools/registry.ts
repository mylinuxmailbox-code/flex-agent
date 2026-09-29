import type { z } from 'zod'
import type { ModelTool } from '../models/types.js'
import type { Tool, ToolCategory } from './types.js'
import { toJsonSchema } from './types.js'

/**
 * The set of tools the agent can see.
 *
 * Registry order is the order tools are advertised to the model, so grouping
 * by category produces a stable, readable tool list. Plugins and MCP servers
 * register into the same registry, which is what makes them subject to the
 * same permission path as built-ins.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()
  /** Tool names hidden from the model but callable by other code. */
  readonly #internal = new Set<string>()

  register<TSchema extends z.ZodType>(
    tool: Tool<TSchema>,
    opts: { internal?: boolean } = {},
  ): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`)
    }
    this.#tools.set(tool.name, tool as Tool)
    if (opts.internal) this.#internal.add(tool.name)
    return this
  }

  registerAll(tools: readonly Tool[], opts: { internal?: boolean } = {}): this {
    for (const t of tools) this.register(t, opts)
    return this
  }

  unregister(name: string): boolean {
    this.#internal.delete(name)
    return this.#tools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }

  has(name: string): boolean {
    return this.#tools.has(name)
  }

  isInternal(name: string): boolean {
    return this.#internal.has(name)
  }

  get size(): number {
    return this.#tools.size
  }

  /** Visible tools, in registration order. */
  visible(): Tool[] {
    return [...this.#tools.values()].filter((t) => !this.#internal.has(t.name))
  }

  byCategory(): Map<ToolCategory, Tool[]> {
    const grouped = new Map<ToolCategory, Tool[]>()
    for (const tool of this.visible()) {
      const list = grouped.get(tool.category)
      if (list) list.push(tool)
      else grouped.set(tool.category, [tool])
    }
    return grouped
  }

  /**
   * The model-facing tool list.
   *
   * `enabled` lets a session hide tools the user disabled via `/permissions`
   * without unregistering them (a subagent may still call them internally).
   */
  modelTools(enabled?: ReadonlySet<string>): ModelTool[] {
    return this.visible()
      .filter((t) => !enabled || enabled.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.jsonSchema ?? toJsonSchema(t.inputSchema),
        ...(t.strictSchema === false ? { strict: false } : {}),
      }))
  }

  /** Prompt guidance, deduplicated and ordered, for the system prompt. */
  promptGuidance(): string[] {
    return this.visible()
      .map((t) => t.promptGuidance)
      .filter((g): g is string => typeof g === 'string' && g.length > 0)
  }
}
