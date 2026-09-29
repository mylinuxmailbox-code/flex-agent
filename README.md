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
`/providers`, `/effort`, `/auto`, `/permissions`, `/sandbox`, `/config`, `/context`,
`/diff`, `/review`, `/test`, `/undo`, `/redo`, `/plugins`, `/compact`, `/clear`, `/exit`.

---

## What is built and verified

This is a working vertical slice, not a mock. Each claim below is backed by a
test in `tests/` or by a command you can run.

| Area | State |
|---|---|
| Ink 7 TUI — header, transcript, input, status bar, Pixel Buddy | working |
| Multiline editor, slash + `@file` completion, history | working |
| Agent loop — stream, tool calls, parallel execution, stop-reason handling, orphan repair, compaction | working, tested with a scripted provider |
| Anthropic provider — streaming, tool use, effort, prompt caching | working |
| **Providers** — Anthropic, **OpenAI-compatible** (OpenAI, OpenRouter, DeepSeek, Ollama, LM Studio, vLLM, …) and **Google AI Studio** (Gemini), behind one router; `provider:model` addressing | working; wire behaviour tested against a local mock server, not a live account |
| 22 built-in tools: read, write, edit, move, delete, list, glob, text/regex search, `find_symbol`, shell, background processes, git, memory, plan, web search/fetch | working |
| **Sandbox** — bubblewrap, real namespaces, verified by 11 isolation tests | working on this machine |
| **Risk classifier + permission engine** — 30+ command rules, path rules, network rules | working |
| Auto mode, full-control mode, informed permission dialog | working |
| Repository discovery, project instructions, project memory | working |
| **Subagent orchestration** — 11 roles, real parallel fan-out, Ultracode/Maxcode | working |
| **Plugins + Claude Code plugin import** | working |
| **MCP** — stdio servers adapted into the permission-gated tool path | working |
| **Web search / fetch** — Brave, Tavily, Exa or DuckDuckGo; SSRF guard re-checked on every redirect hop | working |
| **Skills** — per-request activation, only matching ones enter context | working |
| **Config** — 5-layer hierarchy with per-key provenance | working |
| **Session persistence / resume** (atomic writes, pruning) | working |
| `/undo` `/redo` for agent file edits (in-memory, drift-checked) | working |
| Markdown + syntax highlighting rendered by Ink | working |

Run the checks:

```bash
pnpm typecheck    # 0 errors
pnpm test         # 255 passing across 14 files
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

- **Semantic code intelligence.** `find_symbol` finds definitions and references
  with language-aware ripgrep patterns (TS/JS, Python, Go, Rust, Java/Kotlin/C#,
  Ruby, PHP, C/C++). It is text-based: it can return a same-named symbol from
  another scope and cannot follow types. There is no LSP or tree-sitter.
- **macOS/Windows sandboxes.** Only Linux via bubblewrap; elsewhere Flex reports
  `unsandboxed` in the status bar and says why rather than pretending. Permission
  prompts and environment scrubbing still apply there.
- **Live-verified providers.** The OpenAI-compatible and Google AI Studio
  providers are tested end to end against a local mock HTTP server (request
  shape, SSE parsing, tool calls, errors). They have not been run against a
  paid account in CI; use `tests/live-smoke.ts` with your own key to check.
- **Destructive git mutations** are intentionally *not* structured tools. They go
  through `run_command` so the risk engine sees the real command text.
- **DNS-rebinding-proof fetch.** `web_fetch` resolves and checks every address
  before connecting, but does not pin the connection to that address, so a DNS
  answer that changes between the check and the connect is not covered.

---

## Providers

Flex talks to models through a router. A model is addressed as `model-id` (when
exactly one provider knows it) or `provider:model-id` (always unambiguous).
`/providers` shows what is configured and ready; `/model` lists and switches.

| Provider | Credential | Endpoint override |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| `google` (AI Studio / Gemini) | `GEMINI_API_KEY`, `GOOGLE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` | `GEMINI_BASE_URL` |
| `openai` (any OpenAI-compatible server) | `OPENAI_API_KEY` or `FLEX_OPENAI_API_KEY` | `OPENAI_BASE_URL` / `FLEX_OPENAI_BASE_URL` |

With no `--model` and no configured model, Flex starts on the first provider that
actually has a credential rather than on one that would fail its first request.

Add any number of extra OpenAI-compatible endpoints in your **user** config
(`~/.flex/config/config.json`; `FLEX_HOME` relocates it):

```json
{
  "providers": {
    "ollama":     { "baseURL": "http://localhost:11434/v1", "models": ["qwen2.5-coder"] },
    "openrouter": { "baseURL": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY",
                    "models": ["anthropic/claude-sonnet-4.5"] },
    "aistudio2":  { "type": "google", "apiKeyEnv": "MY_SECOND_GEMINI_KEY" }
  }
}
```

then `flex --model ollama:qwen2.5-coder` or `/model openrouter:anthropic/claude-sonnet-4.5`.
A provider with no `models` list asks the server (`GET /models`) at startup.

Per-provider knobs: `headers`, `defaultModel`, `contextWindow`, `maxOutputTokens`,
`timeoutMs`, `maxTokensParam` (`max_tokens` vs `max_completion_tokens`),
`reasoningEffort`, `enabled: false`.

Provider notes:

- **OpenAI-compatible** streams over SSE, accumulates fragmented tool-call
  arguments, tolerates servers that omit `usage` or tool-call ids, retries
  transient errors, maps HTTP 429/5xx/timeouts to distinct error classes, and
  sends `reasoning_effort` only to models known to accept it.
- **Google AI Studio** uses `streamGenerateContent?alt=sse` with the key in the
  `x-goog-api-key` header (never in the URL), maps tool schemas to Gemini's
  OpenAPI subset, preserves `thoughtSignature` on function calls so multi-turn
  tool use works with thinking models, and maps effort to `thinkingConfig`.
- A **project's** `.flex/config.json` may pick models and tune providers but
  cannot set `baseURL`, `apiKey`, `apiKeyEnv` or `headers`: a repository you just
  cloned must not be able to redirect your credentials.

---

## Configuration

Five layers, later wins, with per-key provenance shown by `/config`:
defaults → user (`~/.flex/config/config.json`) → project (`.flex/config.json`)
→ CLI flags / environment (`FLEX_MODEL`, `FLEX_EFFORT`) → the running session.

A project file is untrusted. It **cannot**: add MCP servers, set provider
endpoints or keys, set `permissions.mode: "full-control"`, raise
`permissions.autoThreshold`, or disable/loosen the sandbox. Ignored keys are
reported once on stderr. Put those in your user config.

```jsonc
{
  "model": "gemini-2.5-pro",
  "effort": "high",
  "permissions": { "mode": "ask" },              // ask | auto | full-control (user config only)
  "sandbox": { "enabled": true, "network": "disabled" },
  "web": { "provider": "auto",                   // auto | brave | tavily | exa | duckduckgo | none
           "maxResults": 10,
           "allowedDomains": [], "blockedDomains": ["pinterest.com"] },
  "mcp": { "servers": { "files": { "command": "npx", "args": ["-y", "some-mcp-server"] } } },
  "plugins": { "disabled": [], "paths": [] }
}
```

Web search keys come from `BRAVE_API_KEY`, `TAVILY_API_KEY` or `EXA_API_KEY`
(`web.apiKey` in user config for an explicit provider). `auto` prefers Brave, then
Tavily, then Exa, else DuckDuckGo (no key, scraped, fewer results). An explicit
provider without a key is an error, not a silent downgrade. `web.*Domains` apply to
both search results and `web_fetch`.

## Plugins and MCP

A plugin is a directory in `~/.flex/plugins/<name>/` (trusted), a path listed in
`plugins.paths` (trusted), or `.flex/plugins/<name>/` in a repository (untrusted).
Flex never executes JavaScript from a plugin. It reads:

- `commands/*.md` → slash commands (body is a prompt; `$ARGUMENTS`, `$1`…`$9`)
- `skills/<name>/SKILL.md` → guidance injected when the request matches
- `.mcp.json` (or `mcpServers` in the manifest) → MCP servers, the way plugins add tools

Manifests: `flex-plugin.json`, `.claude-plugin/plugin.json`, `claude-plugin.json`,
or a Claude-style `package.json`. `/plugins` lists them; `/plugins enable|disable
<name>` persists. MCP servers from an untrusted source (a repo's `.mcp.json`,
`.flex/mcp.json`, or a project plugin) only start when you list them in
`mcp.enabled` (project-plugin servers are named `<plugin>-<server>`) or set
`FLEX_TRUST_PROJECT=1`. MCP servers are started with a minimal environment, not
your API keys, and every MCP tool call goes through the permission engine.

## Undo

`/undo` and `/redo` cover file changes the agent made through `edit_file`,
`write_file`, `move_file` and `delete_file`. The history is **in memory** for the
current process only (snapshots hold whole file contents, so they are not written
to disk); use git for anything durable. Undo refuses to overwrite a file that
changed since the edit, so it cannot destroy your own work; `/undo force` and
`/redo force` override that. Files that were binary or too large to snapshot are
reported as not undoable at the time of the edit.

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

**Secrets do not leak into commands.** Commands the model runs get a scrubbed
environment — names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`,
`CREDENTIAL`… and provider prefixes (`OPENAI_`, `ANTHROPIC_`, `GEMINI_`, `AWS_`,
`GITHUB_`…) are dropped — in the bubblewrap sandbox *and* in the no-sandbox
fallback, foreground and background alike. (`SSH_AUTH_SOCK` is scrubbed too; the
user-config `sandbox.envPassthrough: ["NAME"]` re-allows a name; a project config cannot.) In the sandbox `$HOME` is
remapped to a scratch directory. Credentials cannot be read out of the environment by a test script
the model wrote, and credential paths are deny-listed and shadowed.

**Paths are judged by where they really are.** A symlink inside the workspace
that points at `~/.ssh` is not inside the workspace: containment is checked on
the resolved real path (of the deepest existing ancestor, for files that do not
exist yet), against both the workspace roots and the protected-path list.

**`web_fetch` cannot be aimed inward.** Every hop — the URL you gave and every
redirect — is checked for scheme, embedded credentials, private/reserved names,
IP literals in any spelling (`2130706433`, `[::ffff:7f00:1]`, NAT64/6to4, CGNAT,
`0.0.0.0/8`), and DNS answers. Redirects are followed by hand (max 5) and the body
is capped at 2 MB.

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
  models/        provider abstraction, router, Anthropic / OpenAI-compatible / Google adapters
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
