# Flex

An autonomous coding agent for your terminal. `flex` launches a TUI; you tell
Pixel what you want; it reads, edits, and verifies your actual repository.

```bash
flex                              # interactive UI
flex --model claude-opus-5-5     # pick a model
flex --effort ultracode           # main xHigh + High subagents
flex --full-control               # no prompts, no sandbox (you asked for it)
```

Everything else is a slash command inside the session: `/help`, `/model`,
`/effort`, `/auto`, `/permissions`, `/sandbox`, `/diff`, `/review`, `/test`,
`/compact`, `/clear`, `/exit`.

## Model providers

Providers are selected from the model family or explicitly with `--provider`.
Inside a session, `/model google:gemini-2.5-flash` and `/model gpt-4o` switch
provider and model together without restarting the agent loop.

```bash
# Anthropic (default when no other provider is configured)
export ANTHROPIC_API_KEY=...
flex --model claude-opus-5-5

# OpenAI or any OpenAI-compatible endpoint
export OPENAI_API_KEY=...
# Optional for Ollama, vLLM, LM Studio, OpenRouter, or another compatible server:
export OPENAI_BASE_URL=http://localhost:11434/v1
flex --provider openai --model qwen2.5-coder

# Google AI Studio / Gemini
export GEMINI_API_KEY=...
flex --provider google --model gemini-2.5-flash
```

`FLEX_OPENAI_API_KEY`, `FLEX_OPENAI_BASE_URL`, `FLEX_OPENAI_MODEL`, and
`FLEX_GOOGLE_API_KEY`-style project-specific variables may be used alongside
the standard provider variables. Provider connections can also be configured
in `.flex/config.json` or `~/.flex/config.json` under `providers.anthropic`,
`providers.openai`, and `providers.google`. API keys passed through environment
variables are preferred so they are not written to disk.

---

## What is built and verified

This is a working vertical slice, not a mock. Each claim below is backed by a
test in `tests/` or by a command you can run.

| Area | State |
|---|---|
| Ink 7 TUI — header, transcript, input, status bar, Pixel Buddy | working |
| Multiline editor, slash + `@file` completion, history | working |
| Agent loop — stream, tool calls, parallel execution, stop-reason handling | working, 12 tests |
| Anthropic provider — streaming, tool use, effort, prompt caching | working |
| OpenAI-compatible provider — OpenAI/DeepSeek/Ollama/vLLM/LM Studio/OpenRouter | working, streaming/tool calls/usage covered by tests |
| Google AI Studio provider — Gemini REST/SSE, thinking, streaming/tool calls/usage | working, covered by tests |
| 21 built-in tools: read, write, edit, move, delete, list, glob, grep, regex, shell, background processes, git, memory, plan, web search/fetch | working |
| **Sandbox** — bubblewrap, real namespaces, verified by 11 isolation tests | working on this machine |
| **Risk classifier + permission engine** — 30+ command rules, path rules, network rules | working |
| Auto mode, full-control mode, informed permission dialog | working |
| Repository discovery, project instructions, project memory | working |
| **Subagent orchestration** — 11 roles, real parallel fan-out, Ultracode/Maxcode | working |
| **Plugins + Claude Code plugin import** | working |
| **MCP** — stdio servers adapted into the permission-gated tool path | working |
| **Web search / fetch** with SSRF guard | working |
| **Skills** — per-request activation, only matching ones enter context | working |
| **Config** — 5-layer hierarchy with per-key provenance | working |
| **Session persistence / resume** | working |
| Markdown + syntax highlighting rendered by Ink | working |

Run the checks:

```bash
pnpm typecheck    # 0 errors
pnpm test         # 38 passing across 6 files
pnpm lint         # 0 errors
```

### The live end-to-end test

`tests/live-smoke.ts` builds a throwaway repo with a real failing test, runs the
real agent loop against the real model through the real sandbox, and checks
that the agent found the bug, fixed it, and that the suite then passes.

It needs a credential, so it is not part of `pnpm test`:

```bash
cd ~/flex && pnpm exec tsx tests/live-smoke.ts
```

---

## What is NOT built yet

Stated plainly, because a checklist that hides gaps is worse than no checklist:

- **Code intelligence beyond text search.** No TypeScript Compiler API symbol
  resolution, no tree-sitter, no LSP. Grep and glob are what you get.
- **macOS/Windows sandboxes.** Only Linux via bubblewrap; elsewhere Flex reports
  `unsandboxed` in the status bar and says why rather than pretending.
- **Truncation guard in subagents.** A subagent that reaches its 24-turn limit
  returns a partial report rather than being retried.
- **`/undo` and `/redo`** are advisory, not implemented.
- **Destructive git mutations** are intentionally *not* structured tools. They go
  through `run_command` so the risk engine sees the real command text.

---

## Security model

Every tool call — built-in, plugin, or MCP — passes
`ToolAuthorizer.authorize` before it executes. There is no path from an agent
decision to a side effect that skips it.

```
model → Tool.plan() → RiskClassifier → PermissionEngine → Sandbox → execute
```

**The sandbox is real.** On Linux, commands run under `bwrap` with user, mount,
pid, ipc, uts and (when the network policy is `disabled`) network namespaces.
The host filesystem is read-only except for the granted roots. Deny-listed
paths are shadowed with an empty mount. Verified by tests that fail loudly if
isolation silently degrades — including one that asserts a command cannot write
outside the workspace and one that asserts `ANTHROPIC_API_KEY` is **not** visible
to a command the model chose to run (that test caught a real bug: bubblewrap
inherits the parent environment unless you pass `--clearenv`).

**Risk is declared, not guessed.** `delete_file` does not look risky to a
classifier that only sees a path, so tools declare their own signals in
`plan()`. A declared `destructive-delete` is on the never-auto list, which means
`delete_file` prompts even with auto mode on and the threshold set to `critical`.
(A test asserts exactly this; it also caught the bug where delete ran silently.)

**Secrets do not leak into commands.** The sandbox clears the environment and
re-adds only non-secret variables, and `$HOME` is remapped to a scratch
directory. Credentials cannot be read out of the environment by a test script
the model wrote, and credential paths are deny-listed and shadowed.

**Full control is honest.** `flex --full-control` prints a warning before the UI
starts, keeps a persistent `⚡ FULL CONTROL` indicator in the header and status
bar, and disables both prompts and isolation. It does not silently do less than
it says.

---

## Architecture

```
src/
  cli/           argument parsing, launch
  tui/           Ink components, Pixel Buddy, store, slash commands
  agent/
    runtime/     the loop — streams, authorizes, executes, feeds back
    orchestrator/  parallel subagent fan-out
    subagents/     11 role definitions with scoped tool allowlists
    system-prompt.ts
    events.ts    everything the runtime tells the outside world
  models/        provider abstraction + Anthropic + OpenAI-compatible + Google AI Studio adapters
  tools/         filesystem, search, shell, git, web, memory, planning, subagents
  mcp/           MCP client, tool adapter, server registry
  plugins/       manifest, manager, Claude Code compatibility adapter
  skills/        registry + built-in skills, per-request activation
  config/        five-layer configuration with provenance
  permissions/   classifier (rules) + policy engine (decisions)
  sandbox/       abstraction + bubblewrap backend + honest fallback
  session/       composition root
  context/       repository discovery, project memory
  observability/ structured logging with secret redaction
```

Two rules hold the shape together:

1. **The runtime never touches the terminal.** It emits `AgentEvent`s. That is
   why the same agent runs headless, under test, or behind a plugin UI.
2. **A tool under-reports at its peril.** `plan()` runs *before* authorization
   and is how a tool tells the security layer what it is about to touch. It must
   be conservative.

---

## Effort

`low · medium · high · xhigh · pro · max · ultracode · maxcode`

Effort changes real behaviour, not just a label: planning, exploration breadth,
verification depth, and research bias all come from `effortProfile()`.

One honest caveat: the Anthropic API accepts `low|medium|high|xhigh|max`, so
Flex's `pro` rides on `xhigh` at the wire level and is differentiated by
orchestration — broader research, a longer verification ladder, and a forced
self-review pass.

`ultracode` and `maxcode` are genuinely different: they expose a
`spawn_subagent` tool and pin a subagent effort, so the model can fan work out
and read structured reports back.

| Mode | Main | Subagents | Parallel cap |
|---|---|---|---|
| Ultracode | xHigh | High | 4 |
| Maxcode | Max | Pro | 6 |

The tool is only advertised when the profile has subagents, so single-agent
modes never see the option. Subagent tool calls go through the same permission
engine — being spawned is not a privilege level.

---

## Development

```bash
pnpm install
pnpm dev                      # run from source
pnpm build && pnpm start      # compile and run
pnpm check                    # typecheck + lint + test
```

Built with TypeScript 5.9 (strict, `noUncheckedIndexedAccess`), Ink 7, React 19,
Node ≥ 22.
