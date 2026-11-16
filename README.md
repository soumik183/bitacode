```
█▄▄ █ ▀█▀ ▄▀█ █▀▀ █▀█ █▀▄ █▀▀
█▄█ █  █  █▀█ █▄▄ █▄█ █▄▀ ██▄
```

[![CI](https://github.com/soumik183/bitacode/actions/workflows/ci.yml/badge.svg)](https://github.com/soumik183/bitacode/actions/workflows/ci.yml)
[![Security](https://github.com/soumik183/bitacode/actions/workflows/security.yml/badge.svg)](https://github.com/soumik183/bitacode/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A minimal, educational AI coding agent CLI written in TypeScript. It stays small enough to read in an afternoon, but it still has the core pieces you expect from a real coding agent: a streaming tool-use loop, approvals, sessions, MCP, skills, sub-agents, and cost tracking.

Ask it to build something and it will read your code, edit files, run commands, and ask you questions when a decision is genuinely yours to make.

## Features

- **Multi-provider chat** — OpenAI, Anthropic, Google Gemini, and OpenRouter via the OpenAI SDK
- **Built-in tools** — Read, write, edit, list, find files by glob, search contents, run shell commands, manage todos, fetch web pages with `webfetch`, and ask you questions with `ask_user`
- **Approval system** — Inline confirmation for file writes, file edits, and non-safe shell commands
- **Session persistence** — Conversations and TODO state are saved automatically and can be resumed with `--session`
<!-- - **Dynamic extensions** — Load skills on demand and add external tools through MCP servers -->
- **Sub-agents** — Delegate self-contained tasks to isolated child conversations
- **Usage tracking** — Live token, context, and estimated cost display in the TUI

## Quick Start

Not yet published to npm. From a clone:

```bash
git clone https://github.com/soumik183/bitacode.git
cd bitacode
npm install
npm run dev
```

`dist/` is committed, so you can also run the compiled build directly:

```bash
node dist/cli.js
```

On first run, Bitacode creates the shared config folder and shows an inline setup flow where you pick a provider/model pair and enter an API key. The selection is saved to the shared user `bitacode.jsonc`; use `bitacode configure --project` if you want a project-local file instead.

Runtime config lookup is simple:

- if `<cwd>/.bitacode/bitacode.jsonc` exists, Bitacode uses it
- otherwise it falls back to the shared user config at `~/.config/bitacode/bitacode.jsonc` on macOS/Linux and `~/AppData/Local/bitacode/bitacode.jsonc` on Windows

You can also run the standalone wizard directly:

```bash
bitacode configure
```

Or configure a specific target non-interactively:

```bash
bitacode configure --project --provider openai --model gpt-5-mini
bitacode configure --user --provider anthropic --model claude-sonnet-4-6
```

To create a runtime config file for the current project or your shared user config, run:

```bash
bitacode init
```

`bitacode init` creates `bitacode.jsonc` in either `<cwd>/.bitacode/bitacode.jsonc` or your shared user config location and prints the exact path it used.

For scripts or non-interactive setup, use:

```bash
bitacode init --project
bitacode init --user
bitacode init --project --force
```

## Interactive Commands

- `/help` — Show available slash commands
- `/new` — Start a fresh session
- `/session` — Resume a saved session (`/session <id>` also works); press `d` in the picker to delete one, or use `/session delete <id>`
- `/model` — Switch model
- `/provider` — Switch API provider
- `/variant` — Set reasoning variant
- `/settings` — Toggle animations and mouse clicks
- `/quit` or `/exit` — Save and exit

Other useful shortcuts:

- `Esc` — Abort the current in-flight completion, or close `/help`
- `Ctrl+T` — Expand or collapse the thinking block
- `PageUp` / `PageDown` — Scroll the transcript a page at a time
- `↑` / `↓` — Scroll the transcript one row (`Shift` for three)
- `Home` / `End` — Jump to the start or the newest output
- `Ctrl+C` — Exit immediately

The agent can pause and ask you a question with the `ask_user` tool. The prompt
takes over the composer area: pick an option with `1`-`9` or `↑`/`↓` and press
`enter`, press `tab` to type your own answer instead, and press `esc` to skip.
When the agent offers choices, its own pick is marked `recommended` and listed
first. Several questions can arrive at once; they are asked one at a time with a
progress counter, and the answers are returned to the agent together.

Thinking is driven entirely by the provider. When the model streams reasoning
the block opens on its own and shows the live animated header; when reasoning
ends it folds back to a plain `Thought · 3s` line. If the provider sends no
reasoning, no thinking block appears at all — there is no preset state.
`Ctrl+T` or a click on the header still overrides it for that thought.

A one-column scrollbar on the right edge of the transcript shows where you are
in the history; it appears only once the transcript is taller than the visible
viewport. The layout is responsive: on narrow or short terminals the footer
drops the variant and cost columns, the composer uses a tighter margin, and
panels show fewer rows so the composer always stays on screen.

The transcript resizes automatically. When the todo panel or the thinking block
appears it takes rows from the transcript, and when they go away the space is
handed straight back, so the composer is always visible without manual
adjustment. The root frame is kept one row shorter than the terminal because
Ink repaints the whole screen whenever its output reaches the terminal height,
which is what made scrolling blink.

The composer is a borderless text area with a single vertical blue accent bar on
the left. It is bright when the input has focus and dimmer when it does not. There is
no horizontal rule between the chat and the composer, so the bar is the only
border in that area and the two do not read as a double edge.

## Building From Source

```bash
npm install
npm run build        # compile to dist/ (tracked - commit after building)
npm run dev          # run from source with tsx
npm run typecheck    # tsc --noEmit
npm test             # 131 tests
npm run lint         # eslint
```

CI runs all of the above on Node 20, 22, and 24, and fails if the committed
`dist/` no longer matches `src/`.

## Releasing

Merging a PR into `main` builds and publishes the package automatically. The
workflow checks the version is new, runs the full suite, packs the tarball,
installs it into a clean directory to prove it works, then publishes.

It waits for approval first: the job uses the `npm-release` environment, so a
required reviewer must approve each publish in the Actions tab. To configure it,
go to Settings → Environments → `npm-release` and add reviewers.

Two prerequisites on the repository:

- `NPM_TOKEN` secret — an npm automation token with publish rights.
- The `npm-release` environment with a required reviewer.

To cut a new version, run **Actions → Publish → Run workflow** and choose the
bump (`patch`/`minor`/`major`), or tick `dry_run` to build and pack without
publishing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through
[SECURITY.md](SECURITY.md), not a public issue.

## Documentation

Technical references live in the repository root:

- `SPEC.md` — current implementation specification
- `ARCHITECTURE.md` — current runtime architecture and module relationships

## Bitacode Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ USER INTERFACE (Ink/React)                                                                      │
│ ┌───────────────────────────────────────────────────────────────────────────────────────────┐   │
│ │ App.tsx: Banner | History | Streaming | Loading | Approval | Usage Info                   │   │
│ │ • Manages React state (messages, streaming, loading)                                      │   │
│ │ • Event router → State updates → Re-render                                                │   │
│ └───────────────────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ AGENTIC LOOP (src/agentic-loop/)                                                                │
│ ┌───────────────────────────────────────────────────────────────────────────────────────────┐   │
│ │ INITIALIZATION (once per session)                                                         │   │
│ │ • generateSystemPrompt() (src/system-prompt.ts)                                           │   │
│ │ • initializeMcp() (src/mcp.ts) → listTools() → registerDynamicTool()                      │   │
│ │ • initializeSkillsSupport() (src/skills.ts) → discover → loadSKILL.md → inject prompt     │   │
│ └───────────────────────────────────────────────────────────────────────────────────────────┘   │
│                                              ▼                                                  │
│ ┌───────────────────────────────────────────────────────────────────────────────────────────┐   │
│ │ while (iteration < maxIterations) {                                                       │   │
│ │                                                                                           │   │
│ │   1. CHECK ABORT → Emit 'done' → Return                                                   │   │
│ │                                                                                           │   │
│ │   2. CHECK COMPACT → Context ≥ 90%? → compactIfNeeded()                                   │   │
│ │                                                                                           │   │
│ │   3. CALL LLM → client.chat.completions.create({stream: true, tools})                     │   │
│ │      ├─ processStream() → accumulate content, build tool_calls[], emit text_delta         │   │
│ │      └─ Response type?                                                                    │   │
│ │         │                                                                                 │   │
│ │         ├─ Tool Calls → executeToolCalls()                                                │   │
│ │         │   │                                                                             │   │
│ │         │   ├─ CORE TOOLS (src/tools/*.ts):                                               │   │
│ │         │   │  ├─ read_file, write_file, edit_file, list_directory, bash, etc.            │   │
│ │         │   │  └─ Emit: tool_call, tool_result events                                     │   │
│ │         │   │                                                                             │   │
│ │         │   ├─ DYNAMIC TOOLS (Runtime registered):                                        │   │
│ │         │   │  ├─ MCP tools (mcp_{server}_{tool})                                         │   │
│ │         │   │  ├─ activate_skill(name) → loads skill, injects into prompt                 │   │
│ │         │   │  └─ Emit: tool_call, tool_result events                                     │   │
│ │         │   │                                                                             │   │
│ │         │   └─ SUB-AGENT TOOL (src/sub-agent.ts):                                         │   │
│ │         │      ├─ runSubAgent() → Isolated conversation                                   │   │
│ │         │      ├─ • Own system prompt + task prompt                                       │   │
│ │         │      ├─ • Own message history                                                   │   │
│ │         │      ├─ • Access same tools as parent                                           │   │
│ │         │      ├─ • Separate usage tracking                                               │   │
│ │         │      ├─ • Returns summary + events                                              │   │
│ │         │      └─ Emit: sub_agent_iteration, tool_result events                           │   │
│ │         │                                                                                 │   │
│ │         │   → Loop back with tool results                                                 │   │
│ │         │                                                                                 │   │
│ │         └─ Text Response → Add to messages, emit 'done', return                           │   │
│ │                                                                                           │   │
│ │   4. ERROR HANDLING (src/agentic-loop/errors.ts):                                         │   │
│ │      └─ 400 repairs (JSON/orphaned/truncate) | 429 backoff | 5xx retry | context compact  │   │
│ │                                                                                           │   │
│ │   5. SESSION PERSISTENCE (src/sessions.ts):                                               │   │
│ │      └─ saveSession() → ~/.local/share/bitacode/sessions/                               │   │
│ │                                                                                           │   │
│ │ }                                                                                         │   │
│ └───────────────────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The codebase is organized so each part is easy to trace:

- `src/cli.tsx` — CLI flags and the `configure` subcommand
- `src/App.tsx` — Ink app shell, runtime orchestration, slash commands, approvals, session display
- `src/agentic-loop.ts` — Streaming tool-use loop and error handling
- `src/tools/` — Built-in tools such as file I/O, shell, todo tracking, `webfetch`, and `ask_user`
- `src/config.tsx` — Config persistence and setup wizard
- `src/providers/` — One file per built-in provider, plus the merged provider/model catalog
- `src/sessions.ts` — Session save/load and TODO persistence
- `src/skills.ts` — Skill discovery and dynamic `activate_skill` tool registration
- `src/mcp.ts` — MCP server loading and dynamic tool registration
- `src/sub-agent.ts` — Isolated child agent execution

## Supported Providers

### OpenAI
- GPT-5.4
- GPT-5 Mini
- GPT-4.1

### Anthropic Claude
- Claude Opus 4.6
- Claude Sonnet 4.6
- Claude Haiku 4.5

### Google Gemini
- Gemini 3 Flash (Preview)
- Gemini 3.1 Pro (Preview)
- Gemini 2.5 Flash
- Gemini 2.5 Pro

### OpenRouter
- GPT-4o
- Claude Sonnet 4.5
- Gemini 2.5 Flash
- DeepSeek Chat

OpenRouter uses the OpenAI-compatible endpoint at `https://openrouter.ai/api/v1`. Add any other OpenRouter model through `bitacode.jsonc` under `providers.openrouter.models`.

## Why Bitacode?

Bitacode is not trying to be a giant framework. It is a compact reference implementation for how coding agents work in practice: configuration, dynamic system prompts, a streaming agent loop, tool registries, approvals, sessions, MCP, skills, and delegated sub-agents.

If you want to learn by reading source instead of magic abstractions, this repo is built for that.

## License

MIT
