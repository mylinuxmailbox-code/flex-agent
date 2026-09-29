#!/usr/bin/env node
import { resolve } from 'node:path'
import { defineCommand, runMain } from 'citty'
import type { PlanStep } from '../agent/events.js'
import { type AgentMessage, type EffortLevel, effortProfile } from '../models/types.js'
import { sessionPersistence } from '../session/persistence.js'
import { Session } from '../session/session.js'
import { mountUI } from '../tui/render.js'
import { UIStore } from '../tui/store.js'

/**
 * The CLI.
 *
 * Three flags, by design: launch, pick a model, drop the safety rails. Anything
 * else is a slash command inside the session, because a user should not have to
 * memorise a subcommand surface to work with the agent.
 */

const main = defineCommand({
  meta: {
    name: 'flex',
    version: '0.1.0',
    description: 'Flex — an autonomous coding agent for your terminal.',
  },
  args: {
    model: {
      type: 'string',
      description:
        'Model to use: claude-opus-5-5, sonnet, gemini-2.5-pro, gpt-5, or provider:model (e.g. ollama:qwen2.5-coder). Defaults to config, then the first provider with a key.',
      placeholder: 'model',
    },
    effort: {
      type: 'string',
      description: 'low | medium | high | xhigh | pro | max | ultracode | maxcode',
      placeholder: 'level',
    },
    'full-control': {
      type: 'boolean',
      description:
        'Disable permission prompts and sandbox isolation. You are granting unrestricted control.',
      default: false,
    },
    debug: {
      type: 'boolean',
      description: 'Log model calls, tool calls and permission decisions to stderr.',
      default: false,
    },
    cwd: {
      type: 'string',
      description: 'Directory to work in. Defaults to the current directory.',
      placeholder: 'path',
    },
    'no-sandbox': {
      type: 'boolean',
      description: 'Run commands without isolation, even where a sandbox is available.',
      default: false,
    },
    continue: {
      type: 'boolean',
      description: 'Resume the most recent session in this workspace.',
      default: false,
    },
  },
  async run({ args }) {
    const workspaceRoot = resolve(args.cwd ?? process.cwd())

    const effort = normaliseEffort(args.effort ?? process.env.FLEX_EFFORT)
    if (effort === null) {
      process.stderr.write(
        `Unknown effort "${args.effort}". Valid levels: low, medium, high, xhigh, pro, max, ultracode, maxcode.\n`,
      )
      process.exit(2)
    }

    // Only what was actually passed goes in. Anything left unset falls through to
    // config files and then to the first provider that has credentials.
    const model = args.model ?? process.env.FLEX_MODEL
    const base = {
      model,
      effort: effort ?? undefined,
      fullControl: args['full-control'] || args['no-sandbox'],
      debug: args.debug,
      workspaceRoot,
    }

    let session: Session
    let resumedMessages: readonly AgentMessage[] = []
    let resumedPlan: readonly PlanStep[] = []

    try {
      const latest = args.continue ? await sessionPersistence.findLatest(workspaceRoot) : null
      if (latest) {
        session = await Session.resume(latest, {
          ...base,
          permissionMode: args['full-control'] ? 'full-control' : undefined,
        })
        resumedMessages = latest.messages
        resumedPlan = latest.plan
        process.stdout.write(
          `Resumed session ${latest.id} (${latest.messages.length} messages).\n\n`,
        )
      } else {
        if (args.continue) {
          process.stdout.write(`No saved session found for ${workspaceRoot}. Starting fresh.\n\n`)
        }
        session = await Session.create({
          ...base,
          permissionMode: args['full-control'] ? 'full-control' : undefined,
        })
      }
    } catch (err) {
      process.stderr.write(
        `flex: could not start: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(1)
    }

    for (const notice of session.startupNotices) process.stdout.write(`! ${notice}\n`)
    if (session.startupNotices.length > 0) process.stdout.write('\n')

    if (args['full-control']) {
      // Printed before the UI starts so it lands in the scrollback and stays
      // visible after the interface takes over.
      process.stdout.write(
        '⚡ FULL CONTROL — permission prompts and sandbox isolation are off.\n\n',
      )
    } else if (!session.sandbox.info.isolated) {
      process.stdout.write(
        `⚠ No sandbox available here: ${session.sandbox.info.detail}\n` +
          '  Use --full-control to disable prompts entirely.\n\n',
      )
    }

    const store = new UIStore()
    if (resumedMessages.length > 0) {
      store.restoreSession(resumedMessages, resumedPlan)
    }
    store.patchStatus({
      model: session.model,
      modelLabel: session.modelLabel,
      effort: session.effort,
      permissionMode: session.config.permissionMode,
      sandboxBackend: session.sandbox.info.backend,
      sandboxIsolated: session.sandbox.info.isolated,
      contextWindow: session.contextWindow,
      toolCount: session.tools.visible().length,
      cwd: workspaceRoot,
    })

    const instance = mountUI(session, store)
    try {
      await instance.waitUntilExit()
    } finally {
      // MCP servers are child processes; leaving them running leaks them.
      await session.close()
    }
  },
})

function normaliseEffort(value: string | undefined): EffortLevel | null | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase() as EffortLevel
  const valid: EffortLevel[] = [
    'low',
    'medium',
    'high',
    'xhigh',
    'pro',
    'max',
    'ultracode',
    'maxcode',
  ]
  return valid.includes(normalized) ? normalized : null
}

export { effortProfile, main }

runMain(main)
