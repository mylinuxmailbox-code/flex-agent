import type { EffortLevel } from '../models/types.js'

/**
 * Slash commands.
 *
 * A flat registry rather than a switch statement, so plugins can add entries
 * at runtime and completion, `/help`, and dispatch all read from one source.
 * A command that needs no arguments and does not touch the agent is marked
 * `local: true` and runs without a model round trip.
 */

export interface CommandContext {
  /** Send a message to the agent as if the user typed it. */
  send(text: string): void
  /** Run a local action. */
  clear(): void
  setEffort(effort: EffortLevel): void
  setModel(model: string): void
  toggleAuto(): void
  /** `/permissions` — with no argument shows state; with `ask|auto|full-control` switches. */
  permissions(arg: string): void
  showStatus(): void
  showDiff(): void
  showPlan(): void
  runTests(): void
  compact(): void
  review(): void
  undo(force: boolean): void
  redo(force: boolean): void
  exit(): void
  listAgents(): void
  plugins(args: string): void | Promise<void>
  webSearch(): void
  showSandbox(): void
  listModels(): void | Promise<void>
  showProviders(): void | Promise<void>
  showConfig(): void
  showHelp(): void
}

export interface Command {
  name: string
  /** One-line description, shown in `/help` and completion. */
  summary: string
  /** Argument hint, e.g. `<level>`. */
  args?: string
  aliases?: string[]
  /** Set for commands contributed by a plugin. */
  source?: string
  /** Detailed help shown when the command is run bare. */
  detail?: string
  run(args: string, ctx: CommandContext): void | Promise<void>
}

const COMMAND_LIST: Command[] = [
  {
    name: 'help',
    summary: 'Show the command reference',
    aliases: ['?'],
    run: (_args, ctx) => ctx.showHelp(),
  },
  {
    name: 'exit',
    summary: 'Leave Flex',
    aliases: ['quit', 'q'],
    detail: 'Ends the session. Resumable sessions can be continued with `flex --continue`.',
    run: (_args, ctx) => ctx.exit(),
  },
  {
    name: 'clear',
    summary: 'Clear the conversation',
    detail: 'Starts a fresh conversation. Configuration, model and effort are unchanged.',
    run: (_args, ctx) => ctx.clear(),
  },
  {
    name: 'model',
    summary: 'Switch model',
    args: '[name]',
    detail:
      'Accepts a full id (claude-opus-5-5, gemini-2.5-pro, gpt-5), a short alias (opus, sonnet, flash), ' +
      'or provider:model to pick the endpoint explicitly (google:gemini-2.5-pro, ollama:qwen2.5-coder).',
    run: (args, ctx) => {
      if (!args.trim()) ctx.listModels()
      else ctx.setModel(args.trim())
    },
  },
  {
    name: 'effort',
    summary: 'Change reasoning effort',
    args: '<level>',
    detail:
      'Levels: low, medium, high, xhigh, pro, max, ultracode, maxcode.\n' +
      'Ultracode runs the main agent at xhigh with High subagents.\n' +
      'Maxcode runs the main agent at max with Pro subagents.',
    run: (args, ctx) => {
      const level = args.trim().toLowerCase()
      if (!level) {
        ctx.send('/effort')
        return
      }
      ctx.setEffort(level as EffortLevel)
    },
  },
  {
    name: 'auto',
    summary: 'Toggle auto mode',
    detail:
      'Auto mode approves anything the risk classifier rates safe or low, and asks about anything with ' +
      'meaningful risk. Deletes, publishes, credential access and the like always ask. It is not "allow everything".',
    run: (_args, ctx) => ctx.toggleAuto(),
  },
  {
    name: 'permissions',
    summary: 'Show or change the permission mode',
    args: '[ask|auto|full-control]',
    detail:
      'ask: prompts for anything above trivial risk. auto: also lets low-risk work (like installing dependencies) proceed.\n' +
      'full-control: no prompts. The sandbox stays as it was started; use --full-control at launch to also drop it.',
    run: (args, ctx) => ctx.permissions(args.trim().toLowerCase()),
  },
  {
    name: 'providers',
    summary: 'Show model providers and whether each is ready',
    run: (_args, ctx) => ctx.showProviders(),
  },
  {
    name: 'config',
    summary: 'Show the effective configuration and where each value came from',
    run: (_args, ctx) => ctx.showConfig(),
  },
  {
    name: 'sandbox',
    summary: 'Show sandbox status and policy',
    run: (_args, ctx) => ctx.showSandbox(),
  },
  {
    name: 'context',
    summary: 'Show context usage',
    run: (_args, ctx) => ctx.showStatus(),
  },
  {
    name: 'status',
    summary: 'Show session status',
    run: (_args, ctx) => ctx.showStatus(),
  },
  {
    name: 'agents',
    summary: 'Show active subagents',
    run: (_args, ctx) => ctx.listAgents(),
  },
  {
    name: 'plan',
    summary: 'Show the current plan',
    run: (_args, ctx) => ctx.showPlan(),
  },
  {
    name: 'diff',
    summary: 'Show the working-tree diff',
    run: (_args, ctx) => ctx.showDiff(),
  },
  {
    name: 'review',
    summary: 'Review the changes made in this session',
    run: (_args, ctx) => ctx.review(),
  },
  {
    name: 'test',
    summary: 'Run the project test suite',
    run: (_args, ctx) => ctx.runTests(),
  },
  {
    name: 'undo',
    summary: 'Revert the last file change',
    args: '[force]',
    detail: 'Refuses if the file changed since the edit; `/undo force` overrides that.',
    run: (args, ctx) => ctx.undo(args.trim() === 'force'),
  },
  {
    name: 'redo',
    summary: 'Re-apply the last undone change',
    args: '[force]',
    run: (args, ctx) => ctx.redo(args.trim() === 'force'),
  },
  {
    name: 'compact',
    summary: 'Compact the conversation to free context',
    detail: 'Replaces older turns with a short digest while keeping recent tool results verbatim.',
    run: (_args, ctx) => ctx.compact(),
  },
  {
    name: 'plugins',
    summary: 'List plugins, or enable/disable one',
    args: '[enable|disable <name>]',
    run: (args, ctx) => ctx.plugins(args.trim()),
  },
  {
    name: 'web',
    summary: 'Search the web',
    args: '<query>',
    run: (args, ctx) => {
      if (!args.trim()) ctx.webSearch()
      else ctx.send(`Search the web for: ${args.trim()}`)
    },
  },
]

const BY_NAME = new Map<string, Command>()
for (const command of COMMAND_LIST) {
  BY_NAME.set(command.name, command)
  for (const alias of command.aliases ?? []) BY_NAME.set(alias, command)
}

/** Plugins register here at runtime; completion picks them up immediately. */
export function registerCommand(command: Command): boolean {
  // A plugin must not be able to shadow a built-in or another plugin's command.
  if (BY_NAME.has(command.name)) return false
  COMMAND_LIST.push(command)
  BY_NAME.set(command.name, command)
  for (const alias of command.aliases ?? []) {
    if (!BY_NAME.has(alias)) BY_NAME.set(alias, command)
  }
  return true
}

export function unregisterCommand(name: string): void {
  const command = BY_NAME.get(name)
  if (!command?.source) return // built-ins cannot be removed
  const index = COMMAND_LIST.indexOf(command)
  if (index >= 0) COMMAND_LIST.splice(index, 1)
  for (const [key, value] of BY_NAME) if (value === command) BY_NAME.delete(key)
}

export function findCommand(name: string): Command | undefined {
  return BY_NAME.get(name.replace(/^\//, '').toLowerCase())
}

export function allCommands(): readonly Command[] {
  return COMMAND_LIST
}

/** Prefix-filtered completion candidates, best match first. */
export function completeCommand(prefix: string, limit = 8): Command[] {
  const needle = prefix.replace(/^\//, '').toLowerCase()
  if (!needle) return COMMAND_LIST.slice(0, limit)
  const starts: Command[] = []
  const contains: Command[] = []
  for (const command of COMMAND_LIST) {
    if (command.name.startsWith(needle)) starts.push(command)
    else if (command.name.includes(needle)) contains.push(command)
  }
  return [...starts, ...contains].slice(0, limit)
}

export function isSlashCommand(text: string): boolean {
  return text.startsWith('/')
}
