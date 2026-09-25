import { z } from 'zod'
import { looksSecret, type MemoryFact, readMemory, writeMemory } from '../../context/repo.js'
import type { Tool } from '../types.js'
import { fail, ok } from '../types.js'

/**
 * Project memory.
 *
 * Deliberately tiny and deliberately inspectable: a JSON file the user can
 * read, edit and delete. Memory that cannot be audited becomes a liability the
 * first time it goes wrong.
 */

const recallSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Substring to match. Omit to list everything remembered for this project.'),
})

export const recallTool: Tool<typeof recallSchema> = {
  name: 'recall',
  description:
    'Read project memory: conventions, test commands, constraints and preferences recorded in earlier sessions. Call this before asking the user something the project may already have answered.',
  inputSchema: recallSchema,
  readOnly: true,
  category: 'memory',

  plan(input) {
    return { tool: this.name, input, purpose: `recall ${input.query ?? 'all'}` }
  },

  async execute(input, ctx) {
    const facts = await readMemory(ctx.workspaceRoot)
    if (facts.length === 0) {
      return ok('No project memory recorded yet.', 'recall (empty)')
    }
    const query = input.query?.toLowerCase()
    const matched = query
      ? facts.filter(
          (f) => f.key.toLowerCase().includes(query) || f.value.toLowerCase().includes(query),
        )
      : facts
    if (matched.length === 0) {
      return ok(`No memory matches "${input.query}".`, 'recall (no match)')
    }
    return ok(
      matched.map((f) => `${f.key}: ${f.value}  (recorded ${f.createdAt.slice(0, 10)})`).join('\n'),
      `recall (${matched.length})`,
    )
  },
}

const rememberSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(80)
    .describe('Short stable identifier, e.g. `test-command` or `no-direct-sql`.'),
  value: z.string().min(1).max(2000).describe('The fact itself. Keep it specific and actionable.'),
})

export const rememberTool: Tool<typeof rememberSchema> = {
  name: 'remember',
  description:
    'Record a durable project fact: a convention, the real test command, a constraint, or a user preference. Record facts that will still be true next week. Never record credentials or secrets.',
  inputSchema: rememberSchema,
  readOnly: false,
  category: 'memory',
  promptGuidance:
    'Remember architectural conventions, the actual build/test commands, and constraints you were told about. Do not remember transient state or anything secret.',

  plan(input) {
    return { tool: this.name, input, purpose: `remember ${input.key}` }
  },

  async execute(input, ctx) {
    // Refuse secrets outright. A memory store is the last place you want a
    // credential sitting in plaintext outside the credential store.
    if (looksSecret(input.value)) {
      return fail(
        'Refusing to store that: it looks like a credential. Keep secrets in your credential store, not in project memory.',
        `remember ${input.key} (refused)`,
      )
    }

    const existing = await readMemory(ctx.workspaceRoot)
    const fact: MemoryFact = {
      key: input.key,
      value: input.value,
      source: 'agent',
      createdAt: new Date().toISOString(),
    }
    const index = existing.findIndex((f) => f.key === input.key)
    const updated =
      index >= 0 ? existing.map((f, i) => (i === index ? fact : f)) : [...existing, fact]
    await writeMemory(ctx.workspaceRoot, updated)

    return ok(
      index >= 0 ? `Updated memory "${input.key}".` : `Remembered "${input.key}".`,
      `remember ${input.key}`,
    )
  },
}
