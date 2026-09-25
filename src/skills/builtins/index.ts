import type { Skill } from '../types.js'

export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    id: 'frontend-engineering',
    name: 'Frontend Engineering',
    description:
      'Expertise in modern web UI, component architecture, state management, CSS, and responsiveness.',
    keywords: [
      'react',
      'vue',
      'svelte',
      'css',
      'html',
      'ui',
      'component',
      'tailwind',
      'frontend',
      'layout',
      'dom',
    ],
    guidance:
      'Frontend guidance: keep components modular and declarative. Ensure accessibility (ARIA, semantic elements), ' +
      'responsive layout, and avoid unnecessary re-renders. Verify visual changes and UI state transitions carefully.',
  },
  {
    id: 'backend-engineering',
    name: 'Backend Engineering',
    description:
      'Expertise in server architecture, API design, data models, error handling, and concurrency.',
    keywords: [
      'api',
      'backend',
      'server',
      'endpoint',
      'rest',
      'graphql',
      'database',
      'sql',
      'prisma',
      'postgres',
      'route',
    ],
    guidance:
      'Backend guidance: maintain strict input validation, idempotent handlers where applicable, proper HTTP status codes, ' +
      'secure credential handling, and transactional database updates. Ensure error responses never leak stack traces.',
  },
  {
    id: 'debugging',
    name: 'Systematic Debugging',
    description: 'Disciplined root-cause analysis, hypothesis formation, and regression avoidance.',
    keywords: [
      'bug',
      'error',
      'fail',
      'failing',
      'crash',
      'broken',
      'exception',
      'stacktrace',
      'fix',
      'issue',
      'debug',
    ],
    guidance:
      'Debugging guidance: formulate a specific hypothesis before editing. Read the error and failing line verbatim. ' +
      'Reproduce minimally first, inspect the state, fix the root cause rather than treating the symptom, and verify the test passes.',
  },
  {
    id: 'security-review',
    name: 'Security Review',
    description:
      'Vulnerability assessment, credential hygiene, injection prevention, and safe defaults.',
    keywords: [
      'security',
      'auth',
      'token',
      'secret',
      'password',
      'jwt',
      'xss',
      'injection',
      'permission',
      'sanitize',
      'csrf',
    ],
    guidance:
      'Security guidance: practice defensive coding. Never log or store plain-text secrets. Sanitize external inputs before ' +
      'passing to databases, shells, or HTML. Enforce least-privilege permissions and audit all authorization checks.',
  },
  {
    id: 'testing',
    name: 'Testing & Verification',
    description:
      'Test authoring, test runner orchestration, regression test design, and fixture management.',
    keywords: [
      'test',
      'tests',
      'spec',
      'vitest',
      'jest',
      'pytest',
      'coverage',
      'assert',
      'fixture',
      'suite',
    ],
    guidance:
      'Testing guidance: write tests that verify behaviour and invariants, not internal implementation details. ' +
      'Ensure test cases cover happy path, edge cases (empty collections, null values, timeouts), and failure modes.',
  },
  {
    id: 'performance',
    name: 'Performance Optimization',
    description:
      'Algorithmic efficiency, latency reduction, memory profiling, and caching strategies.',
    keywords: [
      'perf',
      'performance',
      'slow',
      'latency',
      'optimize',
      'cache',
      'memory',
      'leak',
      'benchmark',
      'throughput',
    ],
    guidance:
      'Performance guidance: measure before and after optimizing. Profile bottlenecks before changing algorithms. ' +
      'Avoid premature optimization that degrades readability unless supported by benchmark evidence.',
  },
  {
    id: 'git-hygiene',
    name: 'Git Hygiene',
    description: 'Clean commit histories, atomic changes, and safe merge/rebase practices.',
    keywords: ['git', 'commit', 'branch', 'merge', 'rebase', 'diff', 'stash', 'pr', 'pull request'],
    guidance:
      'Git guidance: keep commits atomic and focused. Write clear, imperative commit messages. Never modify git metadata ' +
      'or commit unrelated user changes without explicit request.',
  },
  {
    id: 'research',
    name: 'Technical Research',
    description:
      'Investigating documentation, API specs, migration guides, and official repositories.',
    keywords: [
      'docs',
      'documentation',
      'learn',
      'research',
      'explore',
      'spec',
      'upgrade',
      'migrate',
      'version',
    ],
    guidance:
      'Research guidance: prioritize official documentation and repository examples over third-party blog posts. ' +
      'Cross-check version numbers and deprecation notices. Cite sources when presenting findings.',
  },
]
