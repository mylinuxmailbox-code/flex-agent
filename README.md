# Flex

Flex is an autonomous coding agent for the terminal. It runs an Ink TUI, reads and edits the repository you point it at, executes tools through the permission engine, and shows streamed model output as it works.

> Flex is installable from a clone and is not published by this project to npm. Do not run `npm publish` for this repository.

## Install

Requirements:

- Git
- Node.js 22 or newer
- A terminal with a TTY for the first-run setup wizard

From a fresh clone, run the installer:

```bash
git clone https://github.com/mylinuxmailbox-code/flex-agent.git
cd flex-agent
./install.sh
```

`install.sh` checks Git and Node, installs dependencies from the frozen pnpm lockfile using pnpm/Corepack, builds the ESM CLI, and installs a user-owned `flex` command without `sudo`. It prefers a pnpm global link and falls back to `~/.local/bin/flex`. The final smoke test runs `flex --help` from outside the repository.

If `~/.local/bin` is not already on `PATH`, add it to your shell startup file:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

For development instead of a user install:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm dev
```

The package can also be packed and installed locally for a packaging smoke test:

```bash
npm pack
npm install --global ./flex-0.1.0.tgz
```

## First launch and provider setup

Run Flex from the repository you want to work on:

```bash
cd /path/to/project
flex
```

When no provider is configured, Flex opens a first-run Ink wizard. It supports:

- Google AI Studio / Gemini
- OpenAI
- Anthropic / Claude
- DeepSeek
- Mistral
- Hosted Llama, with an explicit endpoint for Groq, Together, Fireworks, or another host
- Any other OpenAI-compatible endpoint, including Ollama, vLLM, LM Studio, OpenRouter, and company-hosted APIs

The hosted Llama and custom paths deliberately ask for a base URL. Hosted Llama services are not treated as one interchangeable API: select the service's actual OpenAI-compatible endpoint and model ID.

The wizard remembers the provider, model, label, and base URL in the user-level config. API keys are stored separately in `~/.flex/config/credentials.json` with mode `0600`; they are never written by the wizard into a project config. Press Esc to cancel without saving. Environment variables remain supported and take precedence over stored values.

### Environment variables

For non-interactive or scripted use, configure a provider before launching:

```bash
# Anthropic
export ANTHROPIC_API_KEY='...'
flex --model claude-opus-5-5

# OpenAI
export OPENAI_API_KEY='...'
flex --provider openai --model gpt-4o

# Google AI Studio
export GEMINI_API_KEY='...'
flex --provider google --model gemini-2.5-flash

# Local OpenAI-compatible server; a key is usually unnecessary
export OPENAI_BASE_URL='http://localhost:11434/v1'
flex --provider openai --model qwen2.5-coder
```

Flex also accepts `FLEX_OPENAI_API_KEY`, `FLEX_OPENAI_BASE_URL`, `FLEX_OPENAI_MODEL`, `FLEX_GOOGLE_API_KEY`, `FLEX_GOOGLE_BASE_URL`, `FLEX_GEMINI_API_KEY`, and provider-specific compatible aliases such as `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, and `GROQ_API_KEY`.

Configuration precedence is:

1. Explicit CLI flags such as `--provider` and `--model`
2. Environment variables (`FLEX_*` and provider variables)
3. Project config at `.flex/config.json`
4. User config at `~/.flex/config/config.json`
5. Built-in defaults

For credentials, environment variables override user-local credentials, which override non-secret configured values. Flex never prints secret values in diagnostics or intentionally forwards them to model-run shell commands.

### Non-secret configuration

The wizard writes non-secret settings to `~/.flex/config/config.json`. A project may override them in `.flex/config.json`; keep API keys out of both files.

Example:

```json
{
  "provider": "openai-compatible",
  "model": "llama-3.3-70b-versatile",
  "providers": {
    "openai": {
      "label": "Groq",
      "baseURL": "https://api.groq.com/openai/v1"
    }
  }
}
```

Use `--show-config` to inspect the active provider, model, provenance, endpoints, and only configured/missing credential status:

```bash
flex --show-config
flex --cwd /path/to/project --show-config
```

The output is JSON with secrets redacted. It is safe to attach when diagnosing configuration, but still review endpoint names and paths before sharing it.

## Usage

```bash
flex                              # launch the TUI
flex --model claude-opus-5-5     # choose a model
flex --provider google            # choose a provider
flex --effort ultracode           # enable the subagent profile
flex --full-control               # disable prompts and sandbox; use deliberately
flex --no-sandbox                 # disable isolation but keep permission prompts
flex --continue                   # resume the latest saved session
flex --help
flex --version
```

Inside a session, slash commands include:

- `/help` — command help
- `/model [provider:]model` — inspect or switch provider/model, including custom IDs
- `/effort [level]` — change effort (`low`, `medium`, `high`, `xhigh`, `pro`, `max`, `ultracode`, `maxcode`)
- `/auto` and `/permissions` — inspect or change permission behavior
- `/sandbox` — inspect or change sandbox behavior
- `/diff`, `/review`, `/test` — review and verify work
- `/compact`, `/clear`, `/exit` — manage context and the session

Model providers retain their native behavior at the adapter boundary: Anthropic tool streaming and caching, Gemini streaming/thinking/tool calls, and OpenAI-compatible streaming, tool calls, usage chunks, cancellation, custom model IDs, and normalized base URLs.

## Security model

The normal execution path is:

```text
model → tool plan → risk classifier → permission engine → sandbox → execute
```

Every built-in, plugin, and MCP tool is authorized before it can cause a side effect. On Linux, Flex uses bubblewrap when available with mount, user, PID, IPC, UTS, and optional network namespaces. The workspace and approved scratch roots are writable; the rest of the host filesystem is read-only. Protected credential locations, project dotenv files, and project Flex config are denied to model-directed filesystem tools.

Commands run by the model receive a scrubbed environment and a scratch `HOME`; API keys from the Flex process are not passed through. Structured logs redact common token and credential formats. `--full-control` is an explicit escape hatch: it disables both permission prompts and isolation and prints a persistent warning in the UI. On systems without a usable sandbox, Flex reports the degraded state instead of pretending that isolation is active.

## Features

- Ink 7 terminal UI with streamed transcript, markdown, syntax highlighting, status bar, completion, history, and Pixel Buddy
- Anthropic, Google AI Studio, OpenAI, DeepSeek, Mistral, hosted Llama, and arbitrary OpenAI-compatible model adapters
- Provider/model switching, provider-prefixed model IDs, model discovery hooks, structured errors, usage, replay, and cancellation
- Filesystem, shell, git, memory, planning, web, background-process, MCP, plugin, skills, and subagent tools
- Permission policies, risk classification, sandbox backends, output limits, secret scrubbing, and SSRF protection
- Repository discovery, project instructions, context compaction, session persistence, resume, and configuration provenance
- Ultracode and Maxcode subagent orchestration with the same permission path as the main agent

## Checks

Run the required local checks before sharing a change:

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
npm pack --dry-run
```

The deterministic suite does not contact paid model APIs. The optional live smoke test needs a real credential and is intentionally not part of the normal test command:

```bash
corepack pnpm exec tsx tests/live-smoke.ts
```

Do not fabricate credential-dependent results and do not publish the package to npm.

## Development layout

```text
src/
  cli/           argument parsing, first-run setup, diagnostics
  tui/           Ink components, setup wizard, store, slash commands
  models/        provider abstraction and Anthropic/Google/OpenAI-compatible adapters
  agent/         streaming runtime, orchestration, subagents, system prompt
  tools/         filesystem, shell, git, web, memory, MCP, plugins, skills
  config/        layered config and user-local credentials
  permissions/   risk classifier and authorization policy
  sandbox/       bubblewrap backend and honest fallback
  session/       composition root and persistence integration
  context/       repository discovery and project memory
  observability/ structured logging with redaction
```

Flex is strict TypeScript, ESM-only, Node 22+, Ink 7, and React 19. The runtime does not write directly to the terminal; it emits events so the same loop remains testable and usable by other front ends.
