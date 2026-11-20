# Gap analysis — Lynn CLI (`LynnMerkyor/Lynn`) vs. bitacode

Source: reviewed over the network only (GitHub contents API + raw file fetches).
Nothing was cloned or installed.

What was read: `cli/src` (118 entries, 151 files with `cli/src/commands` +
`cli/src/session` + `cli/src/tools`, **26.5k LOC**), `cli/README.md`,
`ROADMAP.md`, and the module headers / exported types of every file that
implements a capability bitacode does not have.

Scope note: Lynn is a much larger product (Electron GUI + hosted "Brain" router +
CLI worker fleet). Only the `cli/` surface is relevant here, and only the parts
that make sense for a standalone TUI/PCI CLI like bitacode. Vendor-specific
pieces (Brain routing, Fleet, voice, Ultra, Codex harness) are listed at the end
as **do not copy**.

---

## 1. Capability matrix

| Capability | Lynn CLI | bitacode | Gap |
|---|---|---|---|
| Agent loop, streaming, tool calls | `code-agent-loop*.ts` | `agentic-loop.ts`, `executor.ts` | parity |
| Parallel tool calls | `tool-scheduler.ts` (read-only parallel, **write = barrier**) | `executor.ts` (chunks of 4, **no barrier**) | **P0 correctness** |
| File tools | read/grep/glob/edit/write/apply-patch | same + rename/move/copy/mkdir/stat/diff | we are ahead |
| LSP tools | — | `tools/lsp.ts` (definition/references/diagnostics) | we are ahead |
| Sub-agents | Fleet worker + external CLIs | `sub-agent.ts` + task registry | different, ours is fine |
| MCP | not in `cli/src` | `mcp.ts` (stdio + http, parallel) | we are ahead |
| Approval | 3-tier mode + **rule engine** (allow/ask/deny globs) | 3-tier mode only | **P0** |
| Lifecycle hooks | **4 events, JSON stdin/stdout, project-trust gated** | — | **P0** |
| Headless / scriptable mode | `-p/--json/--jsonl`, `--cwd`, `--max-steps`, `--save-session` | none (TUI only) | **P0** |
| Tool-result overflow | **spill to disk + preview + path** | 50k head/tail truncation | **P0** |
| Context compaction | `code-compaction.ts`: 9-section prompt, files-refresh, boundary marker | `compactor.ts`: snapshot prompt, tail of 5 | **P1** |
| Conversation rewind | `code-rewind.ts` + workspace snapshots per turn + `sessions fork` | `/undo` for the last file edit only | **P1** |
| Session store | JSONL append, `proper-lockfile`, torn-line tolerance, replay, stats | single JSON file, whole-file rewrite | **P1** |
| Finish gate | `code-autoverify.ts` (lint/test/typecheck before "done"), `code-self-verify.ts` | — | **P1** |
| Background jobs | `background-jobs.ts` (timeout → background, `<task-notification>`) | `process.ts` polling only | **P1** |
| Input UX | persistent history, @-mention Tab, paste detection/summarisation, boxed multi-line | multi-line composer (new) | **P1** |
| Diagnostics | `doctor --offline` (effective config/env sources) | — | **P1** |
| Prefix-cache discipline | `context-layers.ts` (stable/resume/volatile/user + hash diagnostics) | system prompt rebuilt per turn | **P2** |
| Usage telemetry | cache hit/miss, TPS, per-session stats | tokens + cost | **P2** |
| Project slash commands | `custom-commands.ts` (markdown + frontmatter) | built-ins only | **P2** |
| Shell completion | `completion.ts` (+ bash/zsh/fish scripts) | — | **P2** |
| Skills | `skills.ts` progressive disclosure | `skills.ts` progressive disclosure | parity |
| Plan mode | `plan-tool.ts` + `code-plan-contract.ts` (exit gate) | plan mode + `tools/plan.ts` | near parity |
| Images | clipboard paste, terminal image, drag-drop paths | `read_image` only | **P3** |
| i18n | `i18n.ts` (46 KB, en/zh) | English only | P3 |
| OS sandbox | `os-sandbox.ts` (macOS seatbelt, opt-in) | path sandbox only | P3 (termux) |
| Self-update | manifest + sha256 + `--yes` | version check + `/update` notice | parity-ish |

---

## 2. What to add, in priority order

### P0 — do first (correctness, safety, automation)

**1. Write barrier in the tool scheduler** — `src/agentic-loop/executor.ts`
Our loop runs every call in chunks of 4 concurrently. Two writes, or a write
followed by a read, can interleave and the read can observe the pre-write tree.
Lynn's rule (`tool-scheduler.ts`): consecutive read-only calls run in parallel,
any mutating call is a barrier (previous batch drains, it runs alone), results are
always applied in declaration order.
Shape: `planBatches(calls) -> [{mode:'parallel'|'serial', indexes}]` +
`READ_ONLY_TOOLS` set (`read_file`, `list_directory`, `search_files`, `glob`,
`stat`, `diff`, `web_search`, `webfetch`, plan/todo meta-tools). Pure function,
unit-testable, no behaviour change for all-read or all-write turns. **S**

**2. Permission rule engine** — new `src/utils/permission-rules.ts`
Today: three coarse modes (`manual`/`auto`/`yolo`) and a per-turn approval card.
Lynn adds rules with Claude-Code syntax — `bash(git status *)`,
`write_file(src/**)`, `webfetch(domain:docs.rs)` — with precedence
**deny > ask > allow > mode default** and **fail-closed on a bad rule**.
This is the difference between "approve every npm command forever" and a
workable policy, and it composes with our existing fail-closed approval.
Shape: parse rules from `settings.permissions` and
`<repo>/.bitacode/permissions.jsonc` (only when the project is trusted);
evaluate in `gateCommand()` and at the top of `handleToolCall()`; surface the
verdict (and the matched rule) in the approval card. **M**

**3. Lifecycle hooks** — new `src/hooks/events.ts` (do not collide with
`src/hooks/useAgentEventHandler.tsx`)
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`; one shell command
per hook, JSON on stdin → optional JSON on stdout; exit 2 blocks (fail-closed for
`PreToolUse`/`UserPromptSubmit`), other non-zero = warning. Project hooks
(`<repo>/.bitacode/hooks.json`) only run when the checkout is trusted.
This is the extension point users actually ask for (format on write, block
`rm -rf`, inject repo conventions) and it costs one process per event.
Wire into `agentic-loop.ts` (prompt submit, session start) and
`executor.ts` (around `runOne`). **M**

**4. Headless / machine-readable mode** — `src/cli.tsx` + `src/headless.ts`
`bitacode -p "task" --json [--cwd DIR] [--max-steps N] [--save-session]
[--approval ask|auto|yolo]`. Emits line-delimited events
(`task.started`, `reasoning.delta`, `tool.requested`, `tool.result`, `task.finished`)
and exits non-zero on failure. Without it the CLI cannot be used from CI, from
another agent, or from our own integration tests — and this repo is a coding CLI
whose own tests would benefit most. Reuse the existing `AgentEventHandler`
stream; it is already the perfect seam. **M**

**5. Tool-result spill-to-disk** — `src/tools/index.ts` (`truncateToolResult`)
Today a 2 MB `npm test` log is cut to 50k head+tail and the middle is gone
forever. Lynn writes the full text under a per-run directory and returns
`preview + "full output at <path>"`, so the model can `read_file`/`grep` it.
Cheap (one `fs.writeFile` + path), big win on long test/build output. Add a
`/tmp`-style cleanup policy (keep N runs) and never spill outside the data dir. **S**

### P1 — next (quality of long sessions)

**6. Compaction upgrade** — `src/utils/compactor.ts`
Our summary prompt is 5 sections; Lynn's is 9 (goal, constraints, decisions,
files read/changed, commands run and their results, errors and fixes, current
plan, next step, open questions) and it re-injects the recently-read file list
(`tools/read-state.ts`) after the summary so the model does not re-read them.
Also keep the boundary marker (`<compaction_boundary turn=N>`) so post-compaction
reasoning knows context was dropped. **S/M**

**7. Workspace snapshots + conversation rewind** — extend `src/utils/checkpoint.ts`
Ours snapshots one path per mutating call and `/undo` replays the last one.
Lynn snapshots every touched path per *turn* into a manifest, so `rewind` can go
back N turns and also truncate the transcript to that point (`code-rewind.ts`,
`code-snapshot.ts`). Shape: turn manifest `{turn, entries:[{path, existed, data}]}`,
`/rewind [n]`, `--resume-at <turn>`, and a `session fork` that copies the prefix.
Keep the existing per-file checkpoints for `/undo`. **M/L**

**8. Session store hardening** — `src/sessions.ts`
Append-only JSONL (`{type, ts, content, data}`) with `fs.appendFile` + a lock
file, tolerant of a torn last line, one index file for listing, plus
`bitacode sessions list|show|replay|stats|fork`. We already found and fixed the
non-atomic-rewrite bug; JSONL removes the class entirely and gives replay for
free. **M**

**9. Finish gates (autoverify + self-verify)** — new `src/utils/autoverify.ts`
When the model says "done", run the repo's cheap checks (detected from
`package.json` scripts / `Makefile` / `pyproject.toml`: `typecheck`, `lint`,
`test` — in that order) and if one fails, feed the failure back as a user turn
once (max 1 retry per check). Optional `LYNN_CLI_SELF_VERIFY`-style second pass:
ask the model to adversarially review its own diff before the final answer
(`VERDICT: PASS|ISSUES`). This is what turns "it says it fixed it" into "the
suite passes". **M**

**10. Background jobs that notify the loop** — extend `src/tools/process.ts`
Our `start_process` requires the model to poll. Lynn escalates a bash call that
exceeds its timeout into a background job, keeps a log file, and injects
`<task-notification>` as a later message so the model continues instead of
blocking. Add: `bash` timeout → background (opt-in per tool call), completion
notifications consumed at the top of the next iteration, and the existing
`stopAllProcesses()` cleanup. **M**

**11. Input UX trio** — `src/components/PromptInput.tsx`, `src/App.tsx`
(a) persistent history in `~/.local/share/bitacode/history` with ↑/↓ when the
composer is single-line (they move the caret when multi-line, which the new
textarea already handles); (b) `@path` Tab completion (shallow walk of the
token's directory, never escaping the workspace) that expands to a path the
`read_file` tool is likely to need; (c) paste detection: a paste longer than N
lines/large block is stored, and the prompt gets `[pasted 214 lines]` + a file
path instead of flooding the composer. **M**

**12. `bitacode doctor`** — new `src/commands/doctor.ts`
`--offline` prints what the process actually resolved: version, node, config
paths and which layer each value came from (flag/env/project/user/default),
provider + model + context window, approval mode, allowed roots, MCP server
status, log path, session dir. Our config has four merge layers
(`runtime-config`, project `.bitacode`, user, defaults) and "which file won" is
currently unknowable without reading the logs. **S**

### P2 — worth doing, lower urgency

**13. Prefix-cache stability + telemetry** — `src/system-prompt.ts`,
`src/utils/cost-tracker.ts`
Assemble the prompt as `stable_prefix` (identity/tools/safety, byte-identical
across turns) → `resume_history` (summary/checkpoint) → `volatile_runtime`
(cwd, mode, todos, time) → `current_user`. Log a hash of the stable prefix and
the provider's `cached_tokens`/`cache_read_input_tokens` per request, and show
cache hit ratio + TPS in `UsageDisplay`. Directly reduces cost on Anthropic/
DeepSeek/OpenAI-compatible routes; requires a small refactor of how the system
prompt is built each turn. **M**

**14. Project slash commands** — new `src/utils/custom-commands.ts`
`<repo>/.bitacode/commands/*.md` and `~/.config/bitacode/commands/*.md` with
frontmatter (`description`), `$1..$9` and `$ARGUMENTS` substitution. Prompt text
only, never executed — which is why project commands are safe to load without
trust. Shows up in the existing slash palette. **S**

**15. Shell completion** — new `src/utils/completion.ts` + `bitacode completion
bash|zsh|fish` printing a script for subcommands/flags/session ids. Pure string
logic + `commonPrefix`, easy to test. **S**

**16. Usage metrics per session** — extend `src/utils/cost-tracker.ts`
Per-turn TPS, cache hit ratio, tool call counts, tokens by role; `/stats` plus a
line in the session footer. **S**

### P3 — dependency-heavy or environment-specific

- **Clipboard image paste / terminal images** (`clipboard-image.ts`,
  `terminal-image.ts`, `media.ts`): on Termux this means `termux-clipboard-get`
  and the kitty/iTerm escape protocols; nice but platform-specific. Our
  `read_image` + `/image` path already covers the core need.
- **i18n** (`i18n.ts`): 46 KB of key-value tables for en/zh; only worth it if
  there is real demand. Our UI strings are inline and short.
- **OS sandbox** (`os-sandbox.ts`): macOS seatbelt. Not available on Android;
  would need `bwrap`/`proot` and a fallback story. Our path sandbox +
  `command-gate.ts` covers the realistic threat model for this environment.
- **Local server / web UI** (`local-server.ts`): out of scope for a TUI CLI.

---

## 2b. Second pass — items found on a deeper read

These came from modules that are not in the first matrix: `tools/read-state.ts`,
`json-boundary.ts`, `code-context.ts`, `code-working-checkpoint.ts`,
`session/memory.ts`, `runtime-answer.ts`, `local-command.ts`,
`terminal-safety.ts`, `decode-speed.ts`, `code-tool-verify.ts`,
`ink-static-history.ts`, `ink-placeholders.ts`.

### P0 additions

**A. Read-state guard (anti-blind-rewrite)** — `tools/read-state.ts`
Two behaviours, both cheap and both fix real failure modes:
- **Read dedupe**: re-reading a file whose `mtime`+`size` are unchanged returns a
  short stub ("unchanged since your last read, N lines") instead of the whole
  body. Long sessions stop paying for the same bytes twice.
- **Edit safety**: `edit`/`write_file` (overwrite mode) refuse to touch a path the
  model has *not* read in this session. This is the single cheapest guard
  against a hallucinated rewrite, and it composes with the approval card.
State is per-session (`AsyncLocalStorage` in Lynn, a `Map<sessionId, Map<path,
{mtimeMs,size}>>` in ours) and is cleared at a compaction boundary, because the
bytes are no longer in context at that point. **S/M**

**B. Stream-native tool execution** — `json-boundary.ts` + `executor.ts`
We wait for the whole assistant stream to finish, then run tools. Lynn finds the
point where a tool call's argument JSON becomes complete and starts the call
*while* the rest of the stream is still arriving. On a multi-call turn this
removes a large slice of dead time. Needs a brace/string-aware scanner (that is
all `completeJsonBoundary` is), a rule that a call may only start once its
arguments parse, and the same abort/cancel semantics we already have. **M**
Risk: higher than the rest of P0 — do it after the write barrier lands.

### P1 additions

**C. Repo context frame** — new `src/utils/repo-context.ts`
At task start, collect `git status --short`, `git diff --stat`, top-level files,
`package.json` scripts and the current branch, and inject them as a *volatile*
runtime frame (not into the static system prompt, so the prefix cache still
hits). Today the model learns the repo by spending tool calls on it. **S**

**D. Model working checkpoint** — new `src/tools/working-checkpoint.ts`
A model-curated notepad (capped at ~4k chars) written with
`update_working_checkpoint`, re-injected before every request, surviving
compaction. Different from `todo` (task list) and from `/undo` (file history):
it is the durable "what I learned / what is next" note that stops a long task
from re-deriving its own context. **S**

**E. Session memory** — new `src/utils/memory.ts` + `/memory`
Persistent entries typed `fact | preference | decision | constraint | note`,
appended to `~/.local/share/bitacode/memory.jsonl`, listed/forgotten from the
palette, and injected as a small frame when present. This is the difference
between "the agent forgets my conventions every session" and not. **M**

**F. Local fast-path answers** — `src/App.tsx` submit handler
Answer `/version`, `/pwd`, `/mode`, `/model` and `pwd`/`ls`-style queries
locally instead of paying a model round trip (`runtime-answer.ts`,
`local-command.ts`). Also keeps those answers correct when the network is down. **S**

**G. Terminal capability profile** — `src/utils/terminal.ts`
Probe once: ANSI level, whether inline images exist, whether the terminal is
known-buggy for rapid repaints (Apple Terminal), `--legacy-tui`/`--no-ink`
escape hatches. Feed it into `layout.ts` and `stable-render.ts` so a slow
terminal degrades (fewer animations, no shimmer) instead of corrupting frames. **S**

**H. Live decode TPS + steady metrics in the footer** — `decode-speed.ts`
Show tokens/sec while streaming (estimate from delta chars, correct with
`usage.completion_tokens` at the end), plus cache hit ratio when the provider
reports it. We already show tokens after the fact; live TPS is the cheap half of
P2 #13. **S**

**I. Postcondition verification for edits** — `code-tool-verify.ts`
After a write/edit, re-read the target and report `ok | warn | fail` with a short
note (file missing, content unchanged, siblings show a likely wrong path).
Attach it to the tool result so the model sees the check without another turn.
Complements autoverify (P1 #9), which runs project-wide checks at the end. **S/M**

**J. Rotating mode-aware placeholder** — `ink-placeholders.ts`
Placeholder reflects the current mode (`approval yolo · edits are ungated`,
`plan mode · nothing will be written`). One line of UX that prevents the most
common "why did it write that" surprise. **S**

### P2 additions

**K. `<Static>` transcript split** — `ink-static-history.ts`
If the transcript ever moves to Ink's append-only `<Static>` (we currently do
full repaints with `stable-render.ts`), keep every item after the first pending
one in the live area so an out-of-order tool completion can never insert into
already-printed history. Only relevant if we change the rendering strategy. **S**

**L. `bitacode permissions trust <dir>`** — prerequisite for #2 and #3
A per-project trust flag stored under the data dir, so `PreToolUse` hooks and
project permission rules never run from a freshly cloned repo. Include
`permissions show` (effective rules + source) in the same command. **S**

---

## 3. Do not copy

- **Vendor routing** (`brain-*`, `codex-*`, `code-ultra*`, `worker-*`, `voice-*`,
  `fleet-*`): locked to Lynn's hosted router and to specific vendor binaries.
  bitacode is provider-agnostic; keep it that way.
- **File-size discipline**: `i18n.ts` 46 KB, `code-agent-loop-core.ts` 44 KB,
  `ink-code.ts` 37 KB, `ink-chat.ts` 36 KB. That is the `App.tsx` problem we
  already have (3.5k lines) repeated four times over. Any module we add should
  stay under ~500 lines with a pure core + a thin renderer.
- **Workspace snapshots of 5 MB files** (`code-snapshot.ts` `MAX_FILE_BYTES`):
  storing full file bodies per turn will blow up a phone's storage. Cap by total
  bytes per turn and fall back to per-file checkpoints for big files.
- **Chinese-first user-facing strings mixed into code paths**: keep UI text in
  one place so it can be translated or grepped.

---

## 4. Suggested sequencing

1. Write barrier (P0 #1) — small, pure, removes a real class of wrong behaviour.
2. Tool-result spill (P0 #5) + `doctor` (P1 #12) — both tiny, both immediately
   useful while debugging the rest.
3. Permission rules (P0 #2) — biggest safety upgrade; feeds the hook work.
4. Hooks (P0 #3) — depends on the trust gate introduced with permission rules.
5. Headless `-p --json` (P0 #4) — unlocks CI and self-testing.
6. Session JSONL + rewind (P1 #7/#8) — one storage change, two features.
7. Compaction upgrade + finish gates (P1 #6/#9).
8. Background notifications, input UX, prefix-cache (P1 #10/#11, P2 #13).

Estimated total for P0: ~4 focused days. P1: ~1 week. P2: ~2–3 days.

---

## 5. Implementation status

All six P0 items are implemented, plus most of P1. Each landed as a separate module
rather than an edit inside an existing file, so the units stay reviewable:

- **#1 write barrier** — `src/agentic-loop/scheduler.ts` (`planToolBatches`, caller
  predicate for dynamic/MCP tools via `isDynamicToolName`).
- **#2 permission rules** — `src/utils/permission-rules.ts` + `project-trust.ts`,
  surfaced by `bitacode permissions show|trust|untrust|list`.
- **#3 hooks** — `src/utils/hooks.ts` (SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse; exit 2 blocks; 126/127 fail closed on blocking events; project hooks
  ignored until trusted).
- **#4 headless** — `src/headless.ts` + `src/providers/client.ts`; `-p/--print`,
  `--json`, `--approval`, exit codes 0/1/2/3/4.
- **#5 tool-result spill** — `src/utils/tool-result-budget.ts` (head/tail preview +
  on-disk path, 32 MB cap, stale-file pruning).
- **#6 compaction upgrade** — nine-section `COMPRESSION_PROMPT` in `compactor.ts`.
- **P1** — working checkpoint + memory (`working-checkpoint.ts`, `memory.ts`, five new
  tools), read dedupe / edit guard (`read-state.ts`), postcondition verify
  (`tool-verify.ts`), autoverify finish gate (`autoverify.ts`), session journal
  (`session-journal.ts`), turn snapshots/rewind (`turn-snapshots.ts`), doctor
  (`doctor.ts`), sessions/permissions subcommands.
- **P2** — input history, paste storage, `@file` mentions, Tab completion, shell
  completion scripts, local answers, layered context frames with a stable cache prefix,
  decode-speed meter, terminal capability probe.

Verification: `npm test` 607 pass, `npx tsc --noEmit` clean, `npm run lint` 0 errors.

Still open from this report: background-task notifications (#10) as a UI surface,
per-subagent model routing, and the "compact summary quality" benchmark.
