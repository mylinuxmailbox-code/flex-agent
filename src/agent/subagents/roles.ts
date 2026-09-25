/**
 * Subagent roles.
 *
 * A role is a system-prompt fragment plus a default tool allowlist. Roles
 * exist so the orchestrator can delegate *specific* work rather than "ask
 * another model to help", which is what makes parallel fan-out useful: a
 * Reviewer that cannot edit files is a genuinely independent check on the
 * Implementer that can.
 *
 * Adding a role is data, not code — a plugin can ship more.
 */

export type SubagentRole =
  | 'explorer'
  | 'researcher'
  | 'architect'
  | 'debugger'
  | 'implementer'
  | 'reviewer'
  | 'tester'
  | 'security-reviewer'
  | 'performance-analyst'
  | 'dependency-analyst'
  | 'documentation-researcher'

export interface RoleDefinition {
  readonly role: SubagentRole
  readonly label: string
  /** The one-sentence brief shown in the parallel-agents panel. */
  readonly objective: string
  readonly instructions: string
  /** `null` means every tool. */
  readonly allowedTools: readonly string[] | null
  /**
   * True for roles whose value is a second opinion. These run even when the
   * main agent is confident, which is the entire point of spawning them.
   */
  readonly independent: boolean
}

const READ_TOOLS = [
  'read_file',
  'list_directory',
  'glob',
  'search_text',
  'search_regex',
  'file_info',
  'git_status',
  'git_diff',
  'git_log',
  'recall',
] as const

export const SUBAGENT_ROLES: Readonly<Record<SubagentRole, RoleDefinition>> = {
  explorer: {
    role: 'explorer',
    label: 'Explorer',
    objective: 'Map how the relevant code works',
    instructions:
      'Find and report the structure of the area relevant to the task: which files matter, how they connect, where the entry points are, and what the current implementation does. Report findings, do not change anything. Be specific with file:line references.',
    allowedTools: READ_TOOLS,
    independent: false,
  },

  researcher: {
    role: 'researcher',
    label: 'Researcher',
    objective: 'Find authoritative documentation',
    instructions:
      'Research the external question: official documentation first, then official repositories, standards, and primary sources. Prefer current information over recollection, and say when a source is undated. Return conclusions with URLs, not a link dump.',
    allowedTools: null,
    independent: false,
  },

  architect: {
    role: 'architect',
    label: 'Architect',
    objective: 'Propose the structure of a change',
    instructions:
      'Design how the change should be structured and why. Consider the existing conventions before proposing new ones, identify the blast radius, and name the trade-offs of each viable option. Recommend one.',
    allowedTools: READ_TOOLS,
    independent: true,
  },

  debugger: {
    role: 'debugger',
    label: 'Debugger',
    objective: 'Find the actual cause of a failure',
    instructions:
      'Find the root cause, not the symptom. Form a hypothesis, gather evidence that would falsify it, and report what the evidence shows. If the cause cannot be confirmed, say what is still unknown rather than guessing.',
    allowedTools: READ_TOOLS,
    independent: true,
  },

  implementer: {
    role: 'implementer',
    label: 'Implementer',
    objective: 'Write the code for a scoped change',
    instructions:
      'Implement exactly the described change, matching the conventions of the surrounding code. Verify your own work. Do not widen the scope — if you find something else that needs fixing, report it instead of doing it.',
    allowedTools: null,
    independent: false,
  },

  reviewer: {
    role: 'reviewer',
    label: 'Reviewer',
    objective: 'Critique a change adversarially',
    instructions:
      'Review the described change for correctness bugs, missed callers, broken invariants, and anything a reviewer would push back on. Rank findings by severity. Report problems; do not fix them and do not pad the list.',
    allowedTools: READ_TOOLS,
    independent: true,
  },

  tester: {
    role: 'tester',
    label: 'Tester',
    objective: 'Analyse and run the test suite',
    instructions:
      'Identify how this project is tested, run the smallest useful scope, and report exactly what passed and what failed. When something fails, diagnose the cause rather than retrying. Never weaken a test to make it pass.',
    allowedTools: null,
    independent: true,
  },

  'security-reviewer': {
    role: 'security-reviewer',
    label: 'Security Reviewer',
    objective: 'Look for vulnerabilities in a change',
    instructions:
      'Look for injection, path traversal, unsafe deserialisation, secret handling, authorization gaps, and anything that trusts unvalidated input. Report concrete attack paths, not generic advice. State clearly if you find nothing.',
    allowedTools: READ_TOOLS,
    independent: true,
  },

  'performance-analyst': {
    role: 'performance-analyst',
    label: 'Performance Analyst',
    objective: 'Find the real cost centre',
    instructions:
      'Identify what actually costs time or memory here: complexity, allocation, repeated I/O, or an algorithmic problem. Distinguish measured facts from speculation. Propose the change with the best ratio of impact to risk.',
    allowedTools: READ_TOOLS,
    independent: true,
  },

  'dependency-analyst': {
    role: 'dependency-analyst',
    label: 'Dependency Analyst',
    objective: 'Assess external dependencies and compatibility',
    instructions:
      'Report which dependencies are involved, what versions are in use, and what compatibility or upgrade constraints apply. Check the project manifest rather than assuming.',
    allowedTools: READ_TOOLS,
    independent: false,
  },

  'documentation-researcher': {
    role: 'documentation-researcher',
    label: 'Documentation Researcher',
    objective: 'Establish the current external API behaviour',
    instructions:
      'Establish how the external API actually behaves today, not how it is usually described. Prefer official sources, note version-specific behaviour, and flag anything the project assumes that is no longer true.',
    allowedTools: null,
    independent: false,
  },
}

export function roleDefinition(role: SubagentRole): RoleDefinition {
  return SUBAGENT_ROLES[role]
}

export function allRoles(): readonly RoleDefinition[] {
  return Object.values(SUBAGENT_ROLES)
}

/** The system-prompt fragment injected into a subagent's turn. */
export function roleSystemPrompt(role: SubagentRole, task: string): string {
  const definition = roleDefinition(role)
  return [
    `You are a ${definition.label} subagent working inside Flex.`,
    '',
    definition.objective,
    '',
    definition.instructions,
    '',
    `## Your task\n\n${task}`,
    '',
    '## Reporting back',
    '',
    'Your final message is the only thing the main agent sees. Structure it as:',
    '- **Summary** — one or two sentences.',
    '- **Findings** — the substance, with file:line references.',
    '- **Recommendation** — what you would do about it.',
    '- **Risks / unknowns** — what you could not determine.',
    '- **Confidence** — high, medium, or low, and why.',
    '',
    'Do not dump raw file contents or transcripts. Report conclusions and the evidence for them.',
  ].join('\n')
}
