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
        'Model to use, e.g. claude-opus-5-5, gemini-2.5-pro, or any OpenAI-compatible model id',
      placeholder: 'model',
    },
    provider: {
      type: 'string',
      description: 'Provider: anthropic | openai | google (also configurable with FLEX_PROVIDER)',
      placeholder: 'provider',
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

    const effort = normaliseEffort(args.effort)
    if (effort === null) {
      process.stderr.write(
        `Unknown effort "${args.effort}". Valid levels: low, medium, high, xhigh, pro, max, ultracode, maxcode.\n`,
      )
      process.exit(2)
    }

    let session: Session
    let resumedMessages: readonly AgentMessage[] = []
    let resumedPlan: readonly PlanStep[] = []

    if (args.continue) {
      const latest = await sessionPersistence.findLatest(workspaceRoot)
      if (latest) {
        session = await Session.resume(latest, {
          model: args.model,
          effort,
          permissionMode: args['full-control'] ? 'full-control' : undefined,
          fullControl: args['full-control'],
          noSandbox: args['no-sandbox'],
          providerId: args.provider ?? process.env.FLEX_PROVIDER,
          debug: args.debug,
          workspaceRoot,
        })
        resumedMessages = latest.messages
        resumedPlan = latest.plan
        process.stdout.write(
          `Resumed session ${latest.id} (${latest.messages.length} messages).\n\n`,
        )
      } else {
        process.stdout.write(`No saved session found for ${workspaceRoot}. Starting fresh.\n\n`)
        session = await Session.create({
          model: args.model ?? process.env.FLEX_MODEL ?? '',
          effort,
          permissionMode: args['full-control'] ? 'full-control' : 'ask',
          fullControl: args['full-control'],
          noSandbox: args['no-sandbox'],
          providerId: args.provider ?? process.env.FLEX_PROVIDER,
          debug: args.debug,
          workspaceRoot,
        })
      }
    } else {
      session = await Session.create({
        model: args.model ?? process.env.FLEX_MODEL ?? '',
        effort,
        permissionMode: args['full-control'] ? 'full-control' : 'ask',
        fullControl: args['full-control'],
        noSandbox: args['no-sandbox'],
        providerId: args.provider ?? process.env.FLEX_PROVIDER,
        debug: args.debug,
        workspaceRoot,
      })
    }

    if (args['full-control']) {
      // Printed before the UI starts so it lands in the scrollback and stays
      // visible after the interface takes over.
      process.stdout.write(
        '⚡ FULL CONTROL — permission prompts and sandbox isolation are off.\n\n',
      )
    } else if (!session.sandbox.info.isolated) {
      process.stdout.write(
        `⚠ No sandbox available here: ${session.sandbox.info.detail}\n` +
          '  Permission prompts still apply. Use --full-control to disable them.\n\n',
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
    await instance.waitUntilExit()
  },
})

function normaliseEffort(value: string | undefined): EffortLevel | null {
  if (!value) return 'high'
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
