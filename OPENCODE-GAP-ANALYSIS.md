# Gap analysis — OpenCode v2 (`anomalyco/opencode`) vs. bitacode

Review date: 2026-11-24
Method: read-only. Reviewed bitacode `src/` (≈140 TS/TSX files) plus the existing
`REVIEW.md` and `GAP-ANALYSIS-LYNN.md`, and read OpenCode's `dev` branch over the
GitHub API/raw files: root README, `specs/v2/{session,tools,event-stream-architecture,
catalog-config-plugin-lifecycle}.md`, `packages/core/src/**` (tool, permission,
session, config, mcp, worktree, codemode, automation, plugin provider), `packages/cli/src/**`,
`packages/tui/src/**`, and `.opencode/{command,agent,skills,themes}`.

Runtime note: `npm test` could not be used as a baseline in this environment —
`node_modules` is not installed (`ERR_MODULE_NOT_FOUND: tsx`). No code was changed.
All findings here are static, plus what the two existing review docs already verified.

Scope note: OpenCode v2 is a much larger product (Rust CLI + Electron desktop + web
app + remote machines + SQLite event store). This report only proposes pieces that fit
bitacode's stated goal: a small, readable, provider-agnostic TUI coding agent. The
"do not copy" section at the end is as important as the rest.

---

## 1. Review verdict

Bitacode is mechanically healthy and already far beyond a toy agent. Your own
`REVIEW.md` and `GAP-ANALYSIS-LYNN.md` document 607 passing tests, zero lint errors,
and the full P0/P1 burn-down (write barrier, permission rules, hooks, headless mode,
tool-result spill, compaction, memory, rewind, doctor, completion, etc.). This report
does **not** repeat those; it looks at what OpenCode v2 has that you don't.

Strengths worth protecting:

- The tool set is genuinely rich for a CLI of this size (file ops, git, LSP-ish symbol
  search, process control, web, memory, todos, teams, sub-agents, MCP, skills).
- Safety is layered and fail-closed: path gate, shared command gate, permission rules,
  project trust, hooks, approval modes, spill budget.
- Provider abstraction is clean — custom providers/models are config, not code.
- Docs are unusually good (`README`, `SPEC`, `ARCHITECTURE`, two review docs).

Review findings (new, not in your existing reports):

1. **Documentation drift — HIGH for onboarding.** `SPEC.md` and `ARCHITECTURE.md`
   describe an older product: 3 CLI entry points, 3 flags, 7 slash commands, 10 tools,
   "no built-in web search", "MCP OAuth not implemented", "no session branching".
   The code now has `-p/--json`, ~25 CLI commands, 55+ tools, hooks, rules, trust,
   web search, session fork, etc. A contributor following `SPEC.md` will build the
   wrong thing. Fix: regenerate both docs from the current code, or at minimum add a
   "last verified at commit X" header and a pointer to `README`/this report.
2. **Test-count claim is inconsistent and unverifiable.** `README.md:200` says
   "800+ tests"; `REVIEW.md:25` says 560, then `:328` says 607. Pin the claim to CI
   (badge or a generated number) instead of a hand-edited figure.
3. **Tool-schema bloat is now your biggest per-turn cost** (already flagged in
   `REVIEW.md` §3.2: ~55 tools, ~6.8k tokens of schema on *every* request). OpenCode v2
   solves this structurally with per-placement scoped registration and Code Mode
   (§2.1 below). This is now the clearest reason to act.
4. **`App.tsx` is still the coordinator** (3.5k lines). OpenCode v2 pushed session
   state into routes/contexts and tools into plugins. Your existing split suggestion
   (`useSessionLifecycle`, `useComposer`, `usePickers`, `useKeyboard`, `useStreaming`)
   is still the right one; it is a prerequisite for suggestions 2.3, 2.5 and 3.1.
5. **MCP stdio servers still inherit the full `process.env`** (`src/mcp.ts`), as
   flagged in `REVIEW.md` §2 gap 2. OpenCode v2 has explicit OAuth + per-connection
   credential handling; at minimum add an `env` allowlist to `bitacode.jsonc`.

---

## 2. Capability matrix

| Capability | OpenCode v2 | bitacode today | Gap |
|---|---|---|---|
| Streaming agent loop, tools, sub-agents | yes | yes | parity |
| Write barrier / parallel reads | yes | `agentic-loop/scheduler.ts` | parity |
| 3-tier approval + rules + trust | policy + saved rules, shell AST scan | 3 modes + rules + trust (regex gate) | partial |
| Named agents (`build`, `plan`, `general`, custom `.md`), per-agent model/tools | first-class (`agent.ts`, `dialog-agent`) | plan mode + `sub_agent` tool | **P1** |
| Session steering / queued prompts while running | inbox, `steer` vs `queue`, idempotent admission | abort/retry only | **P1** |
| Session tabs / multi-workspace | tabs rail, workspaces, worktree per session | single session | **P1/P2** |
| Git worktree isolation | `core/src/worktree/*` | git tools only | **P2** |
| Tool-schema cost / Code Mode | scoped registration + `packages/codemode` | 55 tools always advertised | **P1** |
| Durable event log + crash recovery | event-sourced, write-ahead claims, orphan reconciliation | atomic JSON + journal + sanitising | P2 |
| Full-text session search | indexed `session/search*` | `search_history` tool only (model-facing) | P2 |
| Session import / timeline / message nav / draft stash | CLI + TUI dialogs | export/fork/replay/journal/stats | P2 |
| Background shell jobs → notifications | synthetic input on completion | `background`/`notify` tools, no UI surface | P1 (carry-over) |
| MCP OAuth, pool, resources/prompts, CLI management | `mcp/oauth.ts`, handlers/mcp/* | stdio + http, no OAuth, no CLI | P2 |
| Auth: multi-account, import/export/switch, OAuth | `handlers/auth/*`, credential store | one key per provider | P2 |
| Provider breadth (Bedrock, Azure, Vertex, Copilot, Ollama, local…) | ~25 built-in providers | OpenAI/Anthropic/Gemini/OpenRouter + custom baseURL | P2/P3 |
| Provider policy (allow/deny models) + model retry | `managed-policy.ts`, `model-retry.ts` | fixed retry schedule | P2 |
| Config hot reload / watch | `config/watch.ts`, location watcher | read once at startup | P2 |
| Keybinding customization | `config/keybind.ts` | fixed shortcuts | P2 |
| Theme discovery from JSON | `theme/discovery.ts`, ~30 themes | 7 built-in palettes | P2 (small) |
| Automation / scheduled prompts | `core/src/automation/*`, jobs | none | P3 |
| Goal/supervisor mode | `plugin/goal.ts`, `supervisor.ts` | autoverify + working checkpoint | P3 |
| Structured forms / question tool | `form.ts`, `tool/plugin/question.ts` | `ask_user` (options + free text) | P3 |
| HTTP/ACP server, pair, desktop, web, machines | first-class | headless `-p` only | **do not copy** |
| Image/video generation, voice | tools + media pipeline | `read_image` + `/image` | do not copy (yet) |

---

## 3. Feature suggestions

Effort: **S** ≤ half a day, **M** 1–3 days, **L** > a week.
Each suggestion names the OpenCode evidence so you can go read the real implementation.

### P0 — do first (cheap, removes real cost/risk)

**1. Tool groups + deferred tool listing — S/M**
OpenCode evidence: `specs/v2/tools.md` (scoped registration, `tools.register()`,
captured per-request snapshots), `packages/codemode`.
Today every one of ~55 schemas is sent on every turn, including `notify`, `progress`,
`agent_status`, `task_result`, `open_url`, `command_exists`, `which`, `env`, `kill`.
Add a `BITACODE_TOOL_GROUPS` setting with `core | files | web | process | agents | all`
(default `core` + the groups in use), plus a `list_tools` meta-tool that reveals the
long tail on demand. Keep dynamic MCP/skill tools always visible when registered.
Measure schema bytes before/after; this is the single highest ROI change in the list.

**2. MCP environment allowlist — S**
Evidence: `REVIEW.md` §2.2 (still open), OpenCode `core/src/mcp/{oauth,client}.ts`.
Add `mcp.servers.<name>.env` (explicit key list) and pass only those plus a minimal
baseline to `stdio` children. Document the change in `bitacode.jsonc` template.

**3. Fix documentation drift + test-count claim — S**
Evidence: `SPEC.md` §3, `ARCHITECTURE.md` §2 vs `src/cli.tsx` and `src/tools/index.ts`.
Regenerate the tool/command tables from source (a small script in `script/` would keep
them honest) and pin the test number to CI rather than prose.

### P1 — high value, fits the current architecture

**4. Named agents with per-agent model and tool profile — M**
Evidence: `core/src/agent.ts`, `config/plugin/agent.ts`, `.opencode/agent/translator.md`,
`tui/component/dialog-agent.tsx`, README (`build`/`plan`/`general`, `@general`).
Shape: `.bitacode/agents/*.md` and `~/.config/bitacode/agents/*.md` with frontmatter
`description`, `model`, `tools: [allow…]`, `deny: [..]`, `approval`. Add `/agent <name>`
to switch, `@name` to delegate, and make `sub_agent` accept an `agent` argument.
You already have `tools/agent-define/agent-message/team` plumbing — this is mostly a
config + dispatch layer, and it upgrades sub-agent model routing (the one carry-over
item your Lynn analysis left open).

**5. Session steering and queueing — M**
Evidence: `specs/v2/session.md` ("Prompt Admission Precedes Execution"),
`core/src/session/inbox.ts`, `session/session.ts`.
Today a running turn can only be aborted (`Esc`). Add: while streaming, typed input is
**steered** (delivered at the next safe step boundary) or **queued** (`/queue`, delivered
when idle). Assign an idempotency key to each admission so a retried Enter cannot run
the prompt twice. Delivery must stop before compaction/rewind control items. This is a
noticeable UX upgrade and composes with `parallel`/`team` tools.

**6. Complete background-job notifications (carry-over from your Lynn report) — S/M**
Evidence: `core/src/session/background.ts`, `background-result.ts`, `session/command.ts`.
`!cmd` already runs locally; make long-running shells become background jobs with a log
path, and inject a `<task-notification>` synthetic user message at the top of the next
iteration instead of leaving the model to poll. Reuse `notify.ts` and the inbox from #5.

**7. Git worktree sandboxes for a task — M**
Evidence: `core/src/worktree/{directory,git,strategies}.ts`,
`tui/component/dialog-worktree-name.tsx`.
Add `bitacode worktree <name>` / `/worktree` that creates `git worktree add`, switches
the session's cwd (your `validatePath` root is captured at module load — fix that too),
and offers cleanup on session close. This is what makes two agents work on the same repo
without clobbering each other, and it needs no server.

**8. `bitacode mcp` and `bitacode models` CLI commands — S**
Evidence: `packages/cli/src/commands/handlers/{mcp,models}.ts`.
`mcp add|list|test|remove` edits `bitacode.jsonc` and probes a server; `models` prints
the merged provider/model catalog with the layer each value came from (user/project/
env/built-in). Both are string/JSON work with direct tests, and they remove the
"edit JSON by hand" tax.

**9. Config watch / hot reload — M**
Evidence: `core/src/config/watch.ts`, `config/plugin/location-watcher.ts`.
Watch `bitacode.jsonc`, permissions, hooks and themes; on change, show a toast
"config changed — reload?" and re-initialize only the affected registries. This pairs
with #4 and #8 and removes the current restart-to-take-effect behaviour.

### P2 — strategic, do after P1

**10. Event-sourced sessions + crash recovery — L**
Evidence: `specs/v2/session.md`, `core/src/session/{event,execution/restart}.ts`.
Replace the whole-file JSON save with an append-only event log (`user`, `assistant`,
`tool_call`, `tool_result`, `compaction`) plus a snapshot every N events. Gives you
replay for free, torn-write tolerance, and bounded auto-resume of a claimed session
after a crash. Keep the current `sessions show/replay/journal` commands as views over
the log. Big change — only do it if you want long-running/background work to be robust.

**11. Full-text search across all sessions, user-facing — S/M**
Evidence: `core/src/session/{search,search-index,search-build}.ts`,
`tool/plugin/session-search.ts`.
You have `search_history` as a model tool; expose it as `/search <text>` in the palette
with session id, snippet and Enter-to-resume. Add a tiny in-memory index built at
startup instead of rescanning JSON per query.

**12. Session import, timeline, message navigation, draft stash — S each**
Evidence: `cli/handlers/session/import.ts`, `tui/routes/session/{dialog-timeline,
message-navigation,history}.ts`, `tui/component/prompt/{stash,draft-stash}.ts`.
Small independent quality-of-life features that round out your already-strong
`sessions` subcommand set. Draft stash is especially cheap: `Ctrl+S` saves the composer
buffer, `/stash` lists them.

**13. Multiple session tabs — M/L**
Evidence: `tui/component/session-tabs.tsx`, `session-tabs-rail.tsx`, `context/session-tabs.tsx`.
OpenCode runs several sessions in one process. This is the natural consumer of #4, #7
and #5: one tab per agent/worktree, each with its own approval cache and usage meter.
It requires the `App.tsx` split from review finding 4 first.

**14. MCP OAuth + resources/prompts + per-server permission gating — M/L**
Evidence: `core/src/mcp/{oauth,pool,socket-client,instructions}.ts`,
`tool/plugin/{mcp-resource,mcp-events}.ts`, `cli/handlers/mcp/auth.ts`.
Your `SPEC.md` lists OAuth as a known omission; it is now common for hosted MCP
servers. Do auth first, then resources (`mcp_read_resource`) and prompt templates.

**15. Multi-account auth: import/export/switch — M**
Evidence: `cli/handlers/auth/{import,export,switch,list,login,logout}.ts`,
`core/src/credential.ts`.
Store credentials by `(provider, account)` and add `/connect`, `bitacode auth list|switch`.
Header-based providers (your Cloudflare-style config) should not require a fake key.

**16. Provider policy + smarter retry — S/M**
Evidence: `core/src/managed-policy.ts`, `model-retry.ts`, `model-resolver.ts`,
`plugin/provider/prompt-cache-key.ts`.
Allow `allowedModels`/`deniedModels` globs in config so a project cannot silently
switch to an expensive model; add jitter to your fixed 1/3/5/10/15s schedule and
distinguish "incomplete stream" from "429" (OpenCode retries the former with a
synthetic continuation under the same budget).

**17. AST-aware shell permission scanning — M**
Evidence: `core/src/shell/{parse,scan,permissions}.ts`.
Your `command-gate.ts` tokenizes regex-style. OpenCode parses shell syntax, so
`git status && rm -rf x` or `$(...)` cannot slip past an allow rule for `git status`.
This is the natural next hardening step after your P0 rule engine.

**18. Theme discovery + keybinding config — S each**
Evidence: `tui/theme/discovery.ts`, `theme/assets/*.json`, `tui/config/keybind.ts`.
Load `~/.config/bitacode/themes/*.json` in addition to the 7 built-ins, and allow a
`keybindings` map in settings. Pure data work, high user visibility, low risk.

**19. Structured `form` tool + PostToolUse formatting — S/M**
Evidence: `core/src/form.ts`, `tool/plugin/question.ts`, `config/plugin/formatter.ts`.
`ask_user` covers single questions; a form tool (2–5 labelled fields, validated) makes
"ask before scaffolding" flows much better, and a formatter hook closes the loop after
writes. Your hook system already has `PostToolUse`.

**20. Local provider presets (Ollama / LM Studio / vLLM) — S**
Evidence: `core/src/plugin/provider/{ollama,lmstudio,vllm,local}.ts`.
Your custom-provider config can already express these; ship ready-made presets plus
`/model` auto-discovery from `/api/tags`. Useful offline and for privacy-sensitive users.

### P3 — only if you want to grow the scope

**21. Code Mode (tools-as-code)** — `packages/codemode`, `specs/v2/tools.md`.
Generate a small script that calls typed tool APIs in one round trip instead of many
tool-call messages. Powerful, but it changes your loop and safety model substantially;
do #1 first and re-measure. If groups solve the token cost, stop here.

**22. Automation / scheduled prompts** — `core/src/automation/*`, `job.ts`.
`/schedule "check CI" every 30m` with local persistence. Needs a background runner and
a notification surface (#6).

**23. Goal/supervisor mode** — `core/src/plugin/{goal,supervisor,optimize}.ts`.
A bounded loop that keeps working until a judge prompt says the objective is met.
Your `autoverify` + working checkpoint are the seed of this; cap it hard.

**24. VCS-native snapshots** — `core/src/plugin/vcs/{git,hg}.ts`, `vcs/patch.ts`.
Use a scratch git ref for per-turn snapshots instead of raw bytes in the data dir.
Careful: this couples you to git and to repo cleanliness; your current checkpoint
system is simpler and may be the right trade-off.

**25. Attention sounds / mini mode / diff file tree / activity summary** —
`tui/{attention,mini/**,feature-plugins/system/diff-viewer-file-tree.tsx,
routes/session/activity-summary.ts}`. Pick one or two if you enjoy TUI work; none
change what the agent can do.

---

## 4. Do not copy from OpenCode v2

- **Server/desktop/web/machine fleet** (`serve`, `pair`, `api`, `service`, `machine/*`,
  `packages/app`, `packages/desktop`, `packages/data`). A local server multiplies your
  security surface (auth, CORS, SSE overflow, per-queue backpressure) and contradicts
  "small and readable". Keep `-p/--json` as your integration boundary.
- **Effect + generated protocol + SQLite stack**. OpenCode's durability and plugin
  system rest on Effect, codegen and ~60 migrations. Copy the *semantics* (inbox,
  compaction boundaries, durable identity), not the machinery.
- **~55 built-in providers and image/video/voice pipelines.** Your config-driven
  provider registry + 4 built-ins is the right size; add presets, not a provider
  framework.
- **i18n (20+ README translations, glossary).** Only worth it with real demand.
- **File size.** OpenCode's `CHANGELOG.md` is 216 KB and `TUI` has 200+ components.
  Keep new modules under ~500 lines with a pure core and a thin renderer — this is the
  same discipline your Lynn analysis recommended.

---

## 5. Suggested sequencing

1. **Week 1:** #1 tool groups, #2 MCP env allowlist, #3 docs, #8 `mcp`/`models` CLI.
2. **Week 2:** #4 named agents, #5 steering/queueing, #6 background notifications.
3. **Week 3:** #7 worktrees, #9 config reload, #11 session search, #18 themes/keys.
4. **Later, only if needed:** #10 event-sourced sessions, #13 tabs, #14 MCP OAuth,
   #21 Code Mode. #12/#17/#19/#20 can be slotted in wherever they fit.

Success metrics for the first two weeks: schema tokens per request down >50%,
`bitacode -p --json` unchanged, zero new tool schemas, and a new contributor able to
reconcile `SPEC.md` with `src/` in under ten minutes.

---

## 6. Questions worth answering before you start

1. Do you want bitacode to stay single-session/single-workspace, or is parallelism
   (tabs + worktrees) an explicit goal? That decides #7 and #13.
2. Is the ~6.8k-token tool schema cost actually hurting you, or is quality the
   priority? If quality, #4/#5 beat #1.
3. Should sessions survive a hard kill with zero manual recovery? If yes, #10 moves
   from P2 to P1 and #6 becomes a prerequisite.
4. How much do you value provider breadth? Local presets (#20) are cheap; a full
   multi-account auth system (#15) is not.
