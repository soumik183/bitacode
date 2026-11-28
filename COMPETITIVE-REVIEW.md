# Competitive Gap Analysis — bitacode vs. the most popular AI coding CLIs

Date: 2026-11-28
Scope: bitacode `main` (v0.1.25, ~26.5k LOC in `src/`) vs. the current feature sets of the
most popular AI coding terminal tools, surveyed over the network by four parallel research
sub-agents (official docs + READMEs + repo source, nothing cloned/installed).

Reviewed against:
- Anthropic **Claude Code**
- Google **Gemini CLI**
- OpenAI **Codex CLI**
- **Aider**
- Block **Goose**
- Charm **Crush**
- **Amp**
- **OpenCode** (SST)
- **Cline**
- **Continue**

Each capability row states bitacode status as `HAS` / `PARTIAL` / `MISSING` and a suggested
home module + size (S/M/L). The consolidated build list is at the bottom under
**Consolidated backlog** — recommended implementation order, each item as its own module.

---

## 1. Capability inventory — bitacode today (baseline)

Everything below already exists in `src/` and is used as the HAS baseline for the matrices.

### 1.1 Agent loop & tooling
| Capability | Where |
|---|---|
| Streaming tool-use loop with retries (429/5xx/network) | `src/agentic-loop.ts`, `src/agentic-loop/stream.ts` |
| Parallel tool execution with write barrier (batches) | `src/agentic-loop/scheduler.ts` |
| Stream-native early tool start (JSON boundary scan) | `src/utils/json-boundary.ts` |
| Sub-agents, isolated child loops, task registry, teams | `src/sub-agent.ts`, `src/tools/task-registry.ts`, `src/tools/team.ts` |
| Headless `-p/--json/--approval`, exit codes 0–4 | `src/headless.ts` |
| Context compaction (9-section prompt, boundary marker, tail keep) | `src/utils/compactor.ts` |
| Context layers (stable/resume/volatile/user) + cache-friendly prefix | `src/utils/context-layers.ts` |

### 1.2 Tool set (55+ tools)
| Category | Tools |
|---|---|
| File ops | read_file, read_lines, write_file, edit_file, multiedit, apply_patch, delete, rename, move, copy, mkdir, stat, diff, undo |
| Search | grep/search_files, glob, codesearch, search_docs, find_symbol, search_history |
| Shell/process | bash (3-tier gate), start_process, poll/write/stop process, watch, background, kill, env, which, command_exists |
| Git | status, diff, add, commit, stash |
| Web | webfetch (SSRF-safe), web_search (parallel), read_image (validated) |
| Coordination | plan, todo_read/write, parallel, ask_user, agent_status, agent_message, team_*, task_result, notify, progress, open_url |
| LSP | go_to_definition, find_references, diagnostics |
| Memory | working_checkpoint (curated notepad), memory add/list/forget (fact/preference/decision/constraint) |
| Verify | verify_project (typecheck/lint/test) |
| Meta | read_subagent (subagent-session transcript read) |

### 1.3 Safety & policy
| Capability | Where |
|---|---|
| 3-tier shell gate + shared command gate | `src/utils/command-gate.ts` |
| Path sandbox (cwd + symlink-resolved + skill roots) | `src/utils/path-validation.ts` |
| Permission rule engine (`bash(git status *)`, deny>ask>allow) | `src/utils/permission-rules.ts`, `src/commands/permissions.ts` |
| Project trust gate | `src/utils/project-trust.ts` |
| Lifecycle hooks (SessionStart, UserPromptSubmit, Pre/PostToolUse, exit-2 block) | `src/utils/hooks.ts` |
| Fail-closed approval, approval modes (manual/auto/yolo) | `src/utils/approval.ts` |
| Tool-result spill-to-disk (head/tail + path, 32 MB cap) | `src/utils/tool-result-budget.ts` |
| Read dedupe + edit guard (no blind rewrite) | `src/utils/read-state.ts` |
| Postcondition verify after edits | `src/utils/tool-verify.ts` |
| Autoverify finish gate | `src/utils/autoverify.ts` |

### 1.4 Persistence & sessions
| Capability | Where |
|---|---|
| Sessions: create/load/save/list/delete/fork/rename/pin/export/replay/stats/journal | `src/sessions.ts`, `src/commands/sessions.ts`, `src/utils/session-journal.ts` |
| Atomic session writes (tmp+rename) | `src/sessions.ts` |
| Turn snapshots + `/rewind [n]` + `/undo` | `src/utils/turn-snapshots.ts`, `src/utils/checkpoint.ts` |
| Session exit format + resume command | `src/utils/session-exit-format.ts` |

### 1.5 Extensibility
| Capability | Where |
|---|---|
| MCP (stdio + Streamable HTTP, parallel connect) | `src/mcp.ts` |
| Skills (SKILL.md discovery, activate_skill, progressive disclosure) | `src/skills.ts` |
| Plugins (discover/list/enable/disable/info) | `src/utils/plugins.ts`, `src/commands/plugins.ts` |
| Custom commands (markdown + frontmatter, `$1..$9`) | `src/utils/custom-commands.ts` |
| Providers (OpenAI/Anthropic/Gemini/OpenRouter + any OpenAI-compatible) | `src/providers/` |
| Model list cache on disk | `src/utils/model-cache.ts`, `src/utils/provider-models.ts` |

### 1.6 UX
| Capability | Where |
|---|---|
| Ink TUI, themes (7), dialogs, palette, mouse, picker-click | `src/theme/`, `src/components/` |
| Input history, `@`-mentions picker, Tab completion, paste detection | `src/utils/input-history.ts`, `mentions.ts`, `paste.ts` |
| Local answers (`/version`, `/pwd`, `pwd`, `ls`) | `src/utils/local-answers.ts` |
| Decode-speed (live TPS) + usage footer | `src/utils/decode-speed.ts`, `src/components/UsageDisplay.tsx` |
| Stable renderer, terminal capability probe, scroll/scrollbar | `src/utils/stable-render.ts`, `terminal.ts`, `scroll.ts` |
| Shell completion (bash/zsh/fish), update check, doctor | `src/utils/completion.ts`, `version-check.ts`, `doctor.ts` |

---

## 2. Claude Code + Gemini CLI

### 2.1 Modes & permissions
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| `default/acceptEdits/plan/auto/dontAsk/bypass` modes + `Shift+Tab` cycle | Claude modes + cycle; Gemini `--approval-mode`, `/settings` default | PARTIAL — manual/auto/yolo + plan↔build; no `acceptEdits` (auto edits, still gate shell) or `dontAsk` (allowlist-only) | M — `utils/approval.ts`, `settings.ts`, `App.tsx` |
| Classifier-based auto mode | Claude: second model judges action risk | MISSING — "auto" is blanket approve | L — `agentic-loop.ts` + classifier module |
| Scoped permission rules `Bash(git push *)` / policy TOML | Claude allow/deny/ask + `--allowedTools`; Gemini policy engine | HAS — per-tool/command/path rules; missing scoped matcher + headless `--allowedTools` | S/M — `utils/permission-rules.ts` |
| Path / write-block controls (`--add-dir`, block outside cwd) | Claude `--add-dir`, `/add-dir` | PARTIAL — `--cwd`, strict cwd validation; no runtime add-dir | M — `utils/path-validation.ts` |
| Protected read-only paths | Claude protected paths prompt in every mode | MISSING | S — `utils/path-validation.ts` |
| Permission comments on approvals | Claude Tab comment field (audit) | MISSING | S — `components/ApprovalPrompt.tsx` |
| Trusted folders / workspace trust | Both first-run trust prompt | HAS — `/trust`, project trust | — |

### 2.2 Planning
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Plan mode (read-only research) | Claude plan mode + Plan subagent; Gemini `enter_plan_mode` tools, `/plan` | HAS — plan↔build toggle, read-only | — |
| Plan artifact + approval flow | Gemini writes `plans/*.md`, "Yes auto-accept / Yes manual / iterate"; Claude approve→implement | MISSING — no plan file, no explicit approve step | M — `utils/plan-file.ts`, `components/PlanPrompt.tsx` |
| Collaborative plan editing | Gemini `Ctrl+X` editor; Claude `Ctrl+G` | MISSING | S/M — `App.tsx` |
| Plan-driven model routing | Gemini Pro for plan, Flash for impl | MISSING — static model | S — `agentic-loop.ts` |
| `/plan copy` + plan retention | Gemini | MISSING | S — `commands/` |

### 2.3 Agents & parallelism
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| **Custom named subagents** (frontmatter: tools/model/permissionMode/background/isolation) | Claude `.claude/agents/*.md`; Gemini custom subagent frontmatter | MISSING — one generic sub_agent | M — new `src/agents.ts` + `sub-agent.ts` |
| Subagent built-ins (Explore/Plan read-only) | Claude auto-delegated restricted agents | MISSING | M — `src/agents.ts` |
| Foreground/background subagents | Claude background default + `TaskStop`; Gemini flag | PARTIAL — background tool + panels; no per-agent flag | M — `sub-agent.ts`, `SubAgentActivity.tsx` |
| Agent view (many sessions) + daemon | Claude `claude agents` supervisor | MISSING | L — new daemon + UI |
| Agent teams / cross-session messaging | Claude SendMessage/ListAgents | MISSING | L — new transport |
| Dynamic workflows (script orchestration) | Claude Workflow tool | MISSING | L |
| Worktree isolation | Claude `--worktree`; Gemini experimental | MISSING | M/L — `sub-agent.ts` + git |
| Parallel tool calls + write barrier | Both batch | HAS (ahead) — `tools/parallel.ts` | — |
| Nested subagents | Claude depth-limited; Gemini supported | PARTIAL — children don't re-expose sub_agent | S — `sub-agent.ts` |

### 2.4 Sessions, memory, context
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Project instruction files (`CLAUDE.md`/`GEMINI.md`/`AGENTS.md`, tree-load, `@import`, path-scoped rules) | Claude cwd→root + `.claude/rules/*.md`; Gemini same | PARTIAL — auto repo-context only, no editable instruction file/imports | S/M — `system-prompt.ts`, `utils/repo-context.ts` |
| Auto memory (LLM-written, `MEMORY.md` + topics, review inbox) | Claude on by default; Gemini reviewable `.patch` inbox | PARTIAL — typed memory exists; no auto-extraction/inbox | M — `utils/memory.ts`, `tools/memory-tools.ts` |
| Resume/branch/naming | Claude `-c`, `-r`, `--fork-session`, `/branch`, `--name`; Gemini `/resume` | HAS — `--session`, sessions fork/rename/pin/export | — |
| `/continue` most recent in cwd | Claude `-c` | MISSING | S — `cli.tsx` |
| Session retention/cleanup (30d) | Claude `cleanupPeriodDays`; Gemini retention maxAge | MISSING | S — `sessions.ts` |
| Manual `/compact` + configurable threshold | Claude `/compact`; Gemini `compressionThreshold` | PARTIAL — auto 90%, no manual/threshold | S — `utils/compactor.ts`, `settings.ts` |
| History recall (↑/Ctrl+R, drafts) | Both | HAS — `input-history.ts`, `search-history.ts` | — |

### 2.5 Hooks & automation
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Extended hook events (Stop, SubagentStop, Notification, Pre/PostCompact, SessionEnd, Setup) | Claude JSON I/O, matchers, HTTP + async; Gemini | PARTIAL — 4 core events | S — `utils/hooks.ts` |
| HTTP hooks | Claude `type: http` | MISSING | S — `utils/hooks.ts` |
| `/loop`, cron tools, `/goal` completion condition | Claude CronCreate/List/Delete, `/loop`; Gemini automation ext | MISSING | M — new tools + `agentic-loop.ts` |
| Channels (push events into a session) | Claude channel MCP contract | MISSING | L — MCP push transport |
| Background bash `/tasks` panel (Ctrl+B, output→file, auto-background) | Claude | PARTIAL — background tool + registry; no panel/auto-background | M — `components/`, `App.tsx` |

### 2.6 Output & interactive UX
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| **Output styles** (Proactive/Concise/Explanatory/Learning + custom `.md`) | Claude `/output-style` | MISSING (has `/variant` effort) | S — new `utils/output-styles.ts` |
| Custom status line (script-driven footer) | Claude `/statusline` emits JSON | PARTIAL — fixed footer | S/M — `LiveStatus.tsx` |
| Queue messages while model works | Claude type-ahead queue | MISSING | M — `App.tsx`, loop |
| Shell mode `!` with auto-respond | Claude output enters conversation, model reacts | PARTIAL — `!` runs locally only | S/M — `App.tsx` |
| Prompt suggestions | Claude predicted next prompt | MISSING | S — `App.tsx` |
| Vim input mode | Both | MISSING | M — `PromptInput.tsx` |
| Fullscreen flicker-free + mouse | Claude fullscreen; Gemini alt-buffer | PARTIAL — `stable-render.ts`, `mouse.ts` | S/M |
| Clipboard image paste as `[Image #N]` | Claude Ctrl+V chip | PARTIAL — `/image <path>` only | S — `utils/paste.ts` |
| Voice dictation | Claude `/voice`; Gemini experimental | MISSING | L |

### 2.7 Model selection & cost
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Task-based routing + fallback chains | Gemini auto Pro/Flash; Claude `--fallback-model` | PARTIAL — static model | S/M — `agentic-loop.ts`, `provider-models.ts` |
| Effort/thinking controls | Claude `/effort`, `/fast`; Gemini steering | HAS — `/variant`, thinking toggle | — |
| Advisor tool (stronger model consulted) | Claude `--advisor` | MISSING | M — `agentic-loop.ts` |
| Cost dashboards + hard budget cap | Claude `/cost`, `--max-budget-usd` | PARTIAL — live cost footer; no cap | S — `agentic-loop.ts`, `cost-tracker.ts` |
| Loop detection | Gemini `disableLoopDetection` | PARTIAL — `--max-iterations` only | S |

### 2.8 Headless / CI / protocol
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| **Streaming JSON event protocol** (`init/message/tool_use/tool_result/error/result`) | Gemini `--output-format stream-json`; Claude stream-json | PARTIAL — `-p --json` final only | S/M — `headless.ts` |
| Stdin input + message replay | Claude `--input-format stream-json`; Gemini stdin | MISSING | S — `headless.ts` |
| Structured output (`--json-schema`) | Claude JSON-schema validate | MISSING | S — `headless.ts` |
| CI allowlist (`dontAsk` + `--allowedTools`, `--permission-prompts none`) | Claude exact-allowlist, MCP prompt tool | MISSING | M — `approval.ts`, `headless.ts`, `cli.tsx` |
| Discriminative exit codes | Gemini 0/1/42/53; Claude 0/2/3/45 | PARTIAL — success 0, generic failure | S — `cli.tsx`, `headless.ts` |
| Bare/safe mode (skip discovery) | Claude `--bare`, `--safe-mode` | MISSING | S — `cli.tsx` |
| Subagent transcript forwarding in CI | Claude `--forward-subagent-text` | MISSING | S — `headless.ts` |

### 2.9 Security / extensions
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Bash sandboxing (fs + network boundary) | Claude sandboxed Bash; Gemini Seatbelt/Docker/gVisor/LXC | MISSING | L — `tools/bash.ts` + `utils/sandbox.ts` |
| Ignore files in search (`respectGitIgnore`, `.geminiignore`) | Gemini `fileFiltering.*` | MISSING/unknown | S — `tools/search-files.ts` |
| LLM self-correction on failed edits | Gemini edit tools; Claude multi-strategy Edit | MISSING — exact-string only | S/M — `tools/edit-file.ts` |
| Skill dynamic context injection (`!`cmd`, `@file`, `${VAR}`) | Claude/Gemini agent-skills | MISSING — static body | S/M — `skills.ts` |
| Skill-in-subagent (`context: fork`, per-skill model) | Claude | MISSING | M — `skills.ts`, `sub-agent.ts` |
| Live skill watch/reload | Claude hot-reload | MISSING | S — `skills.ts` |
| Skills from MCP / MCP prompts as commands | Claude | MISSING | M — `mcp.ts` |
| MCP OAuth login | Claude `claude mcp login` | MISSING | M — `mcp.ts` |
| Plugin marketplace / bundled skills / deps | Claude marketplaces | PARTIAL — local dirs only | M/L |

### 2.10 N/A for a local CLI (Claude enterprise/SaaS)
Cloud sessions (`--cloud`, `--teleport`), managed settings/org policies, SSO, code review ships,
desktop/IDE surfaces, computer use, remote control. The reusable kernel (scheduled tasks,
`/loop`, `/goal`, cross-device handoff) is covered above.

### 2.11 Top 15 (Claude Code + Gemini)
1. Custom named subagents — M, `src/agents.ts`
2. Headless streaming JSON protocol — S/M, `headless.ts`
3. Plan artifact + approval flow — M, `plan-file.ts` + UI
4. `dontAsk` allowlist + `--allowedTools` for CI — S/M
5. `CLAUDE.md`/`AGENTS.md` instruction files w/ imports + path-scoped rules — S/M
6. Auto memory + review inbox — M
7. `acceptEdits` mode + `Shift+Tab` cycle — S/M
8. Background task manager (`/tasks`, Ctrl+B) — M
9. Shell-mode `!` auto-respond — S/M
10. Extended hook events + matchers — S
11. Git-based snapshots + richer `/rewind` (summarize-from-here) — M
12. Output styles — S
13. `/goal` + `/loop` — M
14. Task-aware model routing + fallback chains — S/M
15. Structured output + exit codes + bare mode — S

---

## 3. Codex CLI + Aider

### 3.1 Codex CLI
| Capability | How it does it | bitacode | Effort / home |
|---|---|---|---|
| Layered `config.toml` (user+project+system, 7-step precedence) | Codex | PARTIAL — merged jsonc user+project; no system/profile layer | S — `runtime-config.ts` |
| Profile files (`--profile name`) | Codex per-task presets | MISSING | S — `runtime-config.ts`, `cli.tsx` |
| Model providers `[model_providers]` (wire_api, auth command, retry) | Codex | PARTIAL — registry w/ baseURL/headers/params | M — `providers/` |
| OS sandbox (`read-only`/`workspace-write`/`danger-full-access`, protected paths, network toggle) | Codex Seatbelt/bwrap/seccomp; protected .git/.agents/.aws | MISSING | L (lighter path+network allowlist M) — new `utils/sandbox.ts` |
| Granular approval policies (`request_permissions`, per-category) | Codex | PARTIAL — modes + tool/command/path rules | M — `approval.ts`, `settings.ts` |
| `exec` non-interactive (final message only stdout, `--json` JSONL) | Codex `codex exec` | PARTIAL — `-p --json` | S — `cli.tsx`, `headless.ts` |
| `exec resume --last` / `exec fork` | Codex | PARTIAL — `--session` interactive; no headless resume | S — `headless.ts` |
| `--output-schema` / `--output-last-message` | Codex | MISSING | S/M — `headless.ts` |
| `apply_patch` git-style edit | Codex | HAS — `tools/apply-patch.ts` (validated) | — |
| Git checkpoints before/after task | Codex workflow | PARTIAL — file checkpoints; no git-history checkpoints | M — `utils/checkpoint.ts`, `git.ts` |
| Plan mode → implement transfer | Codex `/plan` | HAS/partial — plan↔build; no approve-transfer | M — loop/App |
| Queued follow-up prompts / inject into turn | Codex Tab queue, Enter inject | MISSING | M — `App.tsx`, loop |
| `/status` introspection (model, policy, roots, tokens) | Codex | PARTIAL — footer tokens/cost | S |
| `codex review` standalone | Codex | PARTIAL — `/review` slash only | S — `cli.tsx` |
| Session archive/unarchive/delete | Codex | MISSING — has fork/rename/pin/export | S — `commands/sessions.ts` |
| `--worktree` isolation | Codex | MISSING | M — `utils/git-branch.ts` |
| Web search modes (`cached`/`indexed`/`live`/`disabled`) | Codex cached-by-default (injection reduction) | PARTIAL — live only | M — `tools/web-search.ts` |
| Network access control (domain allowlist, DNS rebinding) | Codex | MISSING | L — `tools/bash.ts` |
| Auto-approval reviewer agent | Codex `approvals_reviewer = auto_review` | MISSING | L — new reviewer |
| Protected paths in writable roots (.git/.codex/.aws) | Codex | MISSING | S — `utils/path-validation.ts` |
| `shell_environment_policy` (env allowlist for spawned cmds) | Codex | MISSING | M — `tools/bash.ts` |
| `AGENTS.md` hierarchy (global→project→subdir) | Codex | MISSING (repo-context heuristic only) | M — `system-prompt.ts` |
| MCP management CLI + OAuth | Codex `codex mcp add/list/remove`, OAuth | PARTIAL — config only | M — `mcp.ts` |
| TUI modes (scrollback/fullscreen, `/raw`, `/statusline`, `/title`) | Codex | PARTIAL — fullscreen+theme | S/M |
| `/import` from other agents | Codex | MISSING | S |
| Telemetry/OTel export | Codex `[otel]` | MISSING | M — `utils/logger.ts` |
| API key / auth mgmt (`login/logout/status`) | Codex | PARTIAL — env/provider picker | M |

### 3.2 Aider
| Capability | How it does it | bitacode | Effort / home |
|---|---|---|---|
| **Repo map** (tree-sitter symbol graph, PageRank, token budget) | Aider `--map-tokens` | MISSING — repo-context + codesearch/find_symbol only | L — new `src/repo-map.ts` |
| Chat modes (`/code`, `/ask`, `/architect`, `/help`, `/context`) | Aider sticky/per-message | PARTIAL — plan mode only | S — flags in loop |
| Architect/editor two-model mode | Aider `--architect`, `--editor-model` | PARTIAL — sub_agent/agent_define can build it | M — loop + `sub-agent.ts` |
| Edit-format contract (whole/diff/udiff/editor prompts per model) | Aider | PARTIAL — tools only, no prompt-level format contract | M — `system-prompt.ts`, `edit-file.ts` |
| Auto-commit (Conventional Commit msg, attribution) | Aider after edits | PARTIAL — git tools gated by approval | M — `tools/git.ts`, loop |
| Dirty-file pre-commit before editing | Aider | MISSING | M — `git.ts`, `edit-file.ts` |
| Git-based undo | Aider `/undo` reverts commit | PARTIAL — file checkpoints | S/M — `undo.ts`, `checkpoint.ts` |
| Watch for AI comments (`# AI!`, `// AI?`) | Aider `--watch-files` | MISSING — `watch` tool is different | M — `watch.ts` + scanner |
| Voice-to-code | Aider `--voice` | MISSING | L |
| Auto-lint/test after edits | Aider `--auto-lint/--auto-test` | HAS — autoverify, verify_project, `/verify` | — |
| Weak model (cheap commit/summarize) | Aider `--weak-model` | PARTIAL — single model | S/M — `providers/`, `compactor.ts` |
| Model aliases + per-model settings files | Aider `.aider.model.settings.yml` | PARTIAL — registry; no user aliases | S — `providers/` |
| Prompt caching + keepalive pings | Aider `--cache-prompts`, `--cache-keepalive-pings` | PARTIAL — cache-friendly layering; no keepalive | M — `model-cache.ts` |
| `/tokens` per-component usage | Aider | PARTIAL — footer tokens/cost | S |
| Read-only files vs editable | Aider `--read`, `/read-only` | MISSING | S |
| `.aiderignore` / gitignore-editable control | Aider | PARTIAL — cwd-based | S — `path-validation.ts` |
| `$EDITOR` message compose / `/editor` | Aider | PARTIAL — multi-line composer | M — `App.tsx` |
| In-chat `/add`, `/drop`, `/reset`, `/ls`, `/save` | Aider | PARTIAL — `@` picker, `/find` | M — `App.tsx` |
| `CONVENTIONS.md` auto-read | Aider | PARTIAL — memory system | S — `system-prompt.ts` |
| `--message`, `--apply`, dry-run debug | Aider | PARTIAL — `-p` only | S/M — `headless.ts` |
| Leaderboard / eval harness | Aider | MISSING | L — `bench/` |

### 3.3 Top 15 (Codex + Aider)
1. Repo map (token-budgeted symbol graph) — L
2. `AGENTS.md` layered instruction hierarchy — M
3. Sandbox modes + protected paths + network toggle — L
4. Auto-commit + git-based undo (dirty-file pre-commit) — M
5. `exec resume --last` for headless — S
6. `--output-schema` structured output — M
7. Profile files (`--profile`) — S
8. Edit-format contract per model — M
9. Architect/editor two-model mode — M
10. Web search cached-by-default — M
11. `shell_environment_policy` (env allowlist) — M
12. Auto-approval reviewer agent — L
13. `/ask` read-only chat mode — S
14. Weak/editor model separation (commit msgs, compaction) — M
15. AI-comment watch mode — M

---

## 4. Goose + Crush + Amp

### 4.1 Extensibility & tool architecture
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Reusable versioned recipes (params, extension pin, response schema, retry, sub_recipes, `/recipe` generate) | Goose YAML recipes, GitHub repo load, `--params` | PARTIAL — markdown custom commands only | M — `utils/custom-commands.ts` + `src/recipes.ts` |
| Recipe retry w/ success validation | Goose RetryManager, SuccessCheck | PARTIAL — autoverify close | M — `agentic-loop.ts` |
| Dynamic extension add/remove mid-session | Goose Extension Manager, `/extension` | PARTIAL — init-time registration | M — `mcp.ts` |
| Extension env secrets via keyring | Goose `env_keys` → keyring | MISSING — env vars only | M — new `utils/secret-store.ts` |
| Extension tool whitelisting | Goose recipe `available_tools`; Crush per-server enabled/disabled | PARTIAL — allowed-tools parsed, not enforced | S — `tools/index.ts` |
| Skill standard interop (`.claude/skills`, `.cursor/skills`) | Crush | PARTIAL — `.agents`/`.bitacode` only | S — `skills.ts` |
| User-invocable skills in palette (disable-model-invocation) | Crush `user-invocable:true` | MISSING | S/M — `skills.ts` + `App.tsx` |
| On-demand tool definitions / batching (Code Mode) | Goose `execute_code` (search/read/execute, 30% fewer tokens) | PARTIAL — parallel + spill; all 55 schemas always loaded | M/L — `system-prompt.ts` + new tool |
| Toolkits (Python entry points) | Goose legacy; superseded by extensions | skip — MCP/skills cover | — |

### 4.2 Context management
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Tunable compaction threshold + manual `/compact` | Goose 80% + `GOOSE_AUTO_COMPACT_THRESHOLD`; Crush auto/manual | PARTIAL — 90%, no manual | S — `compactor.ts` |
| Context strategy selection (summarize/truncate/clear/prompt) | Goose | PARTIAL — summarize only | M — `compactor.ts` |
| Tool-output aging (summarize old tool results, keep recent full) | Goose tool-call cutoff, tool-pair summarization | MISSING | M — `compactor.ts`/loop |
| **Hybrid algorithmic + LLM compaction** (extract goals/files/errors/commits ~30ms zero cost, then small LLM polish ~100x fewer tokens) | Crush AlgorithmicSummarize | MISSING | M — `compactor.ts` |
| Compaction preview + confirm | Crush Preview/ConfirmSummarize | MISSING | M — `compactor.ts` + `App.tsx` |
| Persistent top-of-mind instructions / global context files | Goose Top of Mind; Crush `CRUSH.md` + global `AGENTS.md` | PARTIAL — working-checkpoint + repo-context | S |
| Per-model context-limit override | Goose `GOOSE_CONTEXT_LIMIT`; Crush `--context-window` | HAS — config contextWindow | — |

### 4.3 Permissions & trust
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| **Smart-approve** (LLM read-only judge, cached verdicts, MCP annotations) | Goose `smart_approve` PermissionJudge → `permission.yaml` | PARTIAL — manual/auto/yolo + shell tiers; no semantic read-only | M — `utils/approval.ts` |
| Per-tool AlwaysAllow/AskBefore/NeverAllow | Goose/Crush/Amp rules | HAS — permission rules | — |
| Parameter-scoped rules + wildcards (`--cmd '*rm*rf*'`, `--projectKey`) | Amp `permissions add` | PARTIAL — per-command/path; parameter-scoped richer | M — `permission-rules.ts` |
| Permission rule dry-run (`permissions test`) | Amp | MISSING | S — `permission-rules.ts` |
| External decision delegate (`--to program`, exit 0/1/2, OPA) | Amp | MISSING | M — `approval.ts` |
| Deny hides tool entirely vs blocks | Crush hides; Goose blocks w/ msg | PARTIAL | S |
| Provable-inert bash allowlist (only when no redirection/substitution/pipeline) | Crush | PARTIAL — 3-tier gate; provability depth unclear | M — `bash.ts`, `command-gate.ts` |
| Inspector chain / `adversary.md` repo policy | Goose Security→Egress→Adversary→Permission→Repetition | MISSING | M/L — `approval.ts` |
| Fail-closed headless interactive-only modes | Goose hard-errors in headless | MISSING (verify) | S — `headless.ts` |
| Repetition/doom-loop guard (`--max-tool-repetitions`) | Goose RepetitionInspector | PARTIAL — max-iterations only | S — `agentic-loop.ts` |

### 4.4 Sessions, undo, state
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Editor-based session editing + fork (`$EDITOR` YAML) | Goose `session --edit --fork` | PARTIAL — fork exists; no editor rewrite | S/M — `sessions.ts` |
| Diagnostics bundle | Goose session diagnostics JSON | PARTIAL — doctor + logs | S — `doctor.ts` |
| Shared live workspaces (server mode) | Crush `serve`, attached clients | MISSING | L — new server module |
| Crash recovery: settle unfinished tool calls | Crush settle.go synthetic error result | PARTIAL — rewind covers part | S/M — loop/`sessions.ts` |
| `AGENT_SESSION_ID` env for subprocesses | Goose | MISSING | S — `bash.ts`/env |
| SQLite session metadata (queryable token/cost/turns) | Goose sessions.db | MISSING — JSON files | L |
| Continue latest thread (`last`) | Amp | PARTIAL — `--session <id>` | S |
| Git commit trailers for traceability | Amp `Amp-Thread-ID` + Co-authored-by; Crush attribution | MISSING | S — `tools/git.ts` |
| Diff between checkpoints | Crush snapshot refs, diff any two | PARTIAL — restore only, no diff UI | M — `checkpoint.ts`, `unified-diff.ts` |
| Non-destructive revert + redo | Crush revert marker + redo | PARTIAL — rewind/undo; no redo | M — `checkpoint.ts`, `App.tsx` |
| **Staleness detection on write** (mtime vs last-read, reject externally-modified) | Crush filetracker | MISSING | S/M — `write-file.ts`, `edit-file.ts` |
| Whitespace-tolerant edit matching (flagged) | Crush | MISSING | M — `edit-file.ts` |
| Unified-diff in approval prompt | Crush | PARTIAL — approval shows args only | S/M — `approval.ts` |

### 4.5 TUI / UX
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Searchable command palette (single entry: themes/skills/undo/providers) | Crush Ctrl+P | PARTIAL — `/` picker filters commands only | M — `App.tsx` |
| Message type-ahead queue | Crush queues while busy | MISSING | S/M — `App.tsx` |
| Live theme editing/preview | Crush; bitacode live swatches | PARTIAL | S |
| `$EDITOR` compose for long input | Crush Ctrl+O | MISSING | S — `App.tsx` |
| Focus-aware notifications + bell | Crush native/OSC/bell; Goose bell | PARTIAL — notify tool, not focus-aware | S/M — `notify.ts`, `App.tsx` |
| Read-only / plan sub-agent tool allowlists | Crush AgentTask (read-only+bash) / AgentPlan | PARTIAL — generic sub_agent | M — `sub-agent.ts` |
| `/status` line (session id/model/mode/tokens) | Goose `/status`; Crush header | PARTIAL — footer tokens/cost | S |
| Tool param truncation / full-view toggle | Goose `/r` | PARTIAL — collapse/expand cards | S |

### 4.6 Config & ops
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Bash-based rc w/ builtins + `$(...)` secret read | Crush crushrc | PARTIAL — jsonc + `${VAR}` | skip (philosophy change) |
| Natural-language self-config | Crush config skill | PARTIAL — custom commands/hooks | S |
| Security settings user-only (workspace can't override) | Amp user-vs-workspace security keys | PARTIAL — trust gating | S — `runtime-config.ts` |
| Named profiles (provider+mode+extensions) | Goose `profiles.yaml --profile` | MISSING | M — `runtime-config.ts` |
| Prompt template replacement (task/plan/summary/title/init) | Crush `option prompt` | PARTIAL — `system-prompt.ts` | S/M |
| Env pre-configuration | Crush `env` field | MISSING | S — `config.ts` |
| Instruction files / stdin runs (`-i file`, `-i -`) | Goose `run -i`, `-q` | PARTIAL — `-p` prompt | S — `headless.ts` |
| `stream-json` event stream | Goose/Amp | PARTIAL — `--json` | S/M — `headless.ts` |
| Inactivity watchdog for hung headless runs | Goose `GOOSE_INACTIVITY_TIMEOUT` | MISSING | S/M — `headless.ts` |
| Container isolation (`--container`) | Goose | MISSING | L |

### 4.7 Top 15 (Goose + Crush + Amp)
1. Smart-approve read-only detection — M, `approval.ts`
2. Staleness detection on writes — S/M, `write-file.ts`/`edit-file.ts`
3. Unified diff in approval prompt — S/M
4. Hybrid algorithmic+LLM compaction — M
5. Tool-output aging/summarization — M
6. Parameter-scoped permission rules + `permissions test` — M
7. Recipe system w/ params + `/recipe` + extension pin — M
8. Crash recovery for interrupted turns — S/M
9. Tool repetition guard — S
10. User-invocable skills in palette — S/M
11. Headless fail-closed + inactivity watchdog — S/M
12. Non-destructive turn redo — M
13. Session edit-and-fork in `$EDITOR` — S/M
14. External permission delegate helper — M
15. Message type-ahead queue — S/M

---

## 5. OpenCode + Cline + Continue

### 5.1 LSP & code intelligence
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| **Real LSP integration** (spawn language servers, JSON-RPC diagnostics/defs) | OpenCode auto-installs per-language LSPs | PARTIAL — regex heuristics + `tsc` only | L — new `utils/lsp-client.ts` |
| Symbol/project map outline | Continue `@Repository Map` | PARTIAL — regex `find_symbol` | M — `utils/repo-map.ts` |
| Compiler/linter diagnostics fed into loop proactively-after-edit | OpenCode; Cline linter monitor | PARTIAL — on-demand `diagnostics` only | S/M — PostToolUse/executor hook |
| Multi-language diagnostics | OpenCode | MISSING — tsc only | L |

### 5.2 Checkpoints, git, undo
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Git-commit-per-step snapshots (shadow git repo) | Cline `git --git-dir=<data>/checkpoints --work-tree=<cwd>`, reset --hard | PARTIAL — whole-file snapshots | M — `utils/checkpoint.ts` |
| Undo conversation ↔ files together (Restore files/task/both) | Cline 3 choices; OpenCode staged `/undo` + `/redo` | PARTIAL — separate features, no combined staged rollback/redo | S/M — `turn-snapshots.ts`, `checkpoint.ts` |
| Git worktrees (`--worktree`, per-session tree) | OpenCode `worktree_*`; Cline `--worktree` | MISSING | M — `git.ts`, `cli.tsx` |
| Richer git tools (branch/log/restore/push) | OpenCode/Cline | PARTIAL — status/diff/add/commit/stash only | S — `tools/git.ts` |

### 5.3 Rules & instruction files
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Nested + global AGENTS.md merged (nearest wins, hot-reload) | OpenCode global + every dir + CLAUDE.md fallback | PARTIAL — first AGENTS.md wins, no merge/global/reload | S/M — `system-prompt.ts`, new `utils/rules.ts` |
| Rules dirs with toggles (`.clinerules/`, `.cursorrules`, `.windsurfrules`) | Cline per-rule toggle, `/newrule` | PARTIAL — AGENTS.md only | S — `utils/rules.ts` |
| Conditional rules by path glob/regex frontmatter | Cline `paths:`; Continue `globs`/`regex`/`alwaysApply` | MISSING | S/M — `context-layers.ts` |

### 5.4 Context & memory
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| `@`-mention context providers (`@git diff`, `@terminal`, `@problems`, `@clipboard`) | Continue provider classes | PARTIAL — `@file` + `@skill` only | S/M — `mentions.ts` |
| Prompt-cache warming (keep-alive at 90% TTL) | OpenCode `warming: true` | MISSING | S — new `utils/warming.ts` |
| Structured memory bank (agent-maintained docs folder) | Cline memory-bank markdown set | PARTIAL — typed facts, no doc hierarchy | S (as skill) / M native |
| Store-vs-summarize compaction knobs (buffer % of window, keep.tokens, compact model, background compaction) | OpenCode | PARTIAL — fixed 90% + keep-5, inline | M — `compactor.ts` |
| Prune old tool outputs on compaction | OpenCode prune | MISSING | S |

### 5.5 Agent architecture
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Named agent definitions (mode primary/subagent, own prompt/model/permissions/steps) | OpenCode `agents/*.md` | MISSING | M — new `src/agents.ts` |
| Sub-agent cadence (background, per-round reports, continue by ID) | OpenCode always-background parent-continues; Cline `spawn_agent` subtree | PARTIAL — parent blocks on final answer | M — `subagent-store.ts` + loop |

### 5.6 Browser & web
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Headless browser tool (navigate/click/type/screenshot/console) | Cline Playwright Chrome | MISSING — only `open_url` | L (or S via Playwright MCP config) |
| Browser via MCP docs | Both promote MCP browser servers | PARTIAL — MCP works; no docs/approval integration | S |
| Web-search provider abstraction (Tavily/Brave config, DDG fallback) | OpenCode providers | PARTIAL — DDG HTML scrape, single provider | M — `tools/web-search.ts` |

### 5.7 Permissions & plugins
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Ordered last-match-wins rules + `*`/`?` wildcards + saved "always" approvals + admin hard-deny policies | OpenCode | PARTIAL — fixed precedence, no ordered/saved/policies | M — `permission-rules.ts` |
| Per-agent permission scoping | OpenCode | MISSING | M (with agents) |
| MCP OAuth | Cline wizard | MISSING | M — `mcp.ts` |
| Plugin `registerTool` (custom tools) | OpenCode/Cline SDK `createTool` | MISSING — plugins: commands+hooks only | M — `plugins.ts` + `tools/index.ts` |
| Plugin in-process request interception (mutate prompt/messages/tools/options) | OpenCode `context` hook | MISSING — shell hooks only | M — new events |
| Plugin session control (interrupt/wait/compact/attach) | OpenCode `ctx.session.*` | MISSING | M |
| Plugin package management (npm/git install/update/hot-reload) | OpenCode/Cline `plugin install` | PARTIAL — local dirs only | M — `plugins.ts` |
| Custom command shell blocks (`` !`cmd` ``) + per-command agent/model | OpenCode | PARTIAL — `$1`/`$ARGUMENTS` only | S — `custom-commands.ts` |
| Skill marketplace / install CLI | Cline `skill add`, OpenCode HTTP catalogs | PARTIAL — local discovery only | M — `skills.ts` |

### 5.8 Sessions, modes, headless, roles
| Capability | How they do it | bitacode | Effort / home |
|---|---|---|---|
| Scriptable `execute`/Code Mode (run JS calling tools) | OpenCode | MISSING | L (low value for this niche) |
| Headless flags `--json`, `--plan`, `--readonly`, `--allow/--exclude` | Cline/Continue | PARTIAL — `-p --json/--approval` | S — `cli.tsx` |
| Session HTML export | Cline | MISSING | S |
| Schedule/cron agents | Cline `schedule` | MISSING | M — new `src/schedule.ts` |
| Model-role routing (autocomplete/edit/chat/summarize distinct models) | Continue | PARTIAL — per-session model only | S/M — `runtime-config.ts` |
| Tab autocomplete | Continue | MISSING — no editor surface | skip (out of scope) |
| Docs indexing/retrieval (`@Docs`) | Continue (now Context7 MCP) | PARTIAL — `search-docs.ts` + web_search | S — MCP config |

### 5.9 Top 15 (OpenCode + Cline + Continue)
1. Per-tool `--allow/--exclude` + `--readonly` headless flags — S
2. Git worktrees (`git_worktree_*` + `--worktree`) — M
3. Git-backed checkpoints (shadow repo / stash-create refs) — M
4. `/redo` + staged undo restoring the prompt — S
5. Rules dirs (`.clinerules`/`.cursorrules`/`.windsurfrules`) + toggle — S
6. Merged nested + global AGENTS.md w/ CLAUDE.md fallback + hot-reload — S/M
7. Manual `/compact` + buffer-as-%-of-window — M
8. Plugin `registerTool` API — M
9. Context providers `@git diff`/`@terminal`/`@clipboard` — S/M
10. Prompt-cache warming — S
11. Conditional rules by path glob — S/M
12. Per-agent profiles (own prompt/model/permissions) — M
13. Sub-agent parent-continues + per-round reports — M
14. Web-search provider abstraction — M
15. Browser automation via Playwright CLI wrapper (or MCP docs) — L/S

---

## 6. Consolidated backlog

Merged and de-duplicated across all ten tools. Ordered by (value × fit for a small,
readable, Termux-friendly TypeScript agent) ÷ effort. Each item is its own module so it
stays reviewable. **Bold** = recommended first wave (small, self-contained, high value).

### P0 — do first (correctness, safety, CI)
| # | Capability | Source | Home module | Size |
|---|---|---|---|---|
| 1 | **Staleness detection on write/edit** (mtime vs last-read; reject externally-modified) | Crush | `tools/write-file.ts`, `tools/edit-file.ts`, new `utils/file-freshness.ts` | S |
| 2 | **Tool repetition / doom-loop guard** (`max-tool-repetitions`) | Goose | `agentic-loop.ts` | S |
| 3 | **Permission rule dry-run** (`permissions test`) + parameter-scoped wildcard rules | Amp | `utils/permission-rules.ts`, `commands/permissions.ts` | S/M |
| 4 | **Headless hardening**: `--allowedTools`/`--exclude`, `--readonly`, `--output-last-message`, discriminative exit codes, fail-closed on interactive-only approval | Claude/Gemini/Codex/Cline | `headless.ts`, `cli.tsx`, `utils/approval.ts` | S/M |
| 5 | **Inactivity watchdog** for hung headless runs | Goose | `headless.ts` | S/M |
| 6 | **Protected paths** in writable roots (`.git`, `.agents` read-only) | Codex | `utils/path-validation.ts` | S |
| 7 | **Unified diff in approval prompt** (review before approve) | Crush | `utils/approval.ts`, `components/ApprovalPrompt.tsx` | S/M |
| 8 | **Crash recovery**: settle unfinished tool calls on resume | Crush | `agentic-loop.ts`, `sessions.ts` | S/M |

### P1 — high value (workflow, context, autonomy)
| # | Capability | Source | Home module | Size |
|---|---|---|---|---|
| 9 | **Custom named subagents** (frontmatter: tools/model/permissionMode) + Explore/Plan built-ins | Claude/OpenCode/Crush | new `src/agents.ts`, `sub-agent.ts` | M |
| 10 | **Instruction files**: `AGENTS.md`/`CLAUDE.md` merged tree + imports + path-scoped rules + rules dirs interop | Codex/OpenCode/Cline/Continue | `system-prompt.ts`, new `utils/rules.ts` | S/M |
| 11 | **Output styles** (Prose presets + custom `.md`) | Claude | new `utils/output-styles.ts` | S |
| 12 | **`/compact` + buffer-as-%-of-window + tool-output aging** | Goose/OpenCode | `utils/compactor.ts` | M |
| 13 | **Hybrid algorithmic+LLM compaction** (cheap extraction then small polish) | Crush | `utils/compactor.ts` | M |
| 14 | **`acceptEdits` approval mode + `Shift+Tab` cycle** | Claude | `utils/approval.ts`, `settings.ts`, `App.tsx` | S/M |
| 15 | **Smart-approve** (LLM read-only judge, cached) | Goose | `utils/approval.ts` | M |
| 16 | **Plan artifact + approval flow** (plan file, approve/iterate, `$EDITOR`) | Gemini/Claude/Codex | new `utils/plan-file.ts`, `components/PlanPrompt.tsx` | M |
| 17 | **Headless streaming JSON protocol** (per-tool events + usage) | Gemini/Claude/Goose | `headless.ts` | S/M |
| 18 | **Git worktree isolation** (`--worktree`, `git_worktree_*`) | OpenCode/Cline/Codex | `utils/git-branch.ts`, `tools/git.ts`, `cli.tsx` | M |
| 19 | **Git-backed checkpoints + `/redo` + combined staged undo** | Cline/OpenCode/Crush | `utils/checkpoint.ts`, `turn-snapshots.ts`, `App.tsx` | M |
| 20 | **Prompt-cache warming** (keep-alive) | OpenCode/Aider | new `utils/warming.ts` | S |
| 21 | **Context providers** `@git diff` / `@terminal` / `@clipboard` / `@problems` | Continue | `utils/mentions.ts` | S/M |
| 22 | **User-invocable skills in palette** + `.claude`/`.cursor` skill interop + skill `!`cmd` injection | Crush/Claude | `skills.ts`, `App.tsx` | S/M |
| 23 | **Recipe system** (params, extension pin, `/recipe` generate, response schema) | Goose | `utils/custom-commands.ts`, new `src/recipes.ts` | M |

### P2 — worthwhile (polish, ops, ecosystem)
| # | Capability | Source | Home module | Size |
|---|---|---|---|---|
| 24 | Background `/tasks` panel + Ctrl+B + auto-background on timeout | Claude | `components/`, `App.tsx` | M |
| 25 | Message type-ahead queue | Crush | `App.tsx` | S/M |
| 26 | Shell-mode `!` auto-respond | Claude | `App.tsx`, `agentic-loop.ts` | S/M |
| 27 | Extended hook events + HTTP hooks + matchers | Claude/Crush | `utils/hooks.ts` | S |
| 28 | `/goal` + `/loop` + cron tools | Claude/Gemini/Cline | new tools, `agentic-loop.ts` | M |
| 29 | Task-aware model routing + fallback chains + weak/summarize model | Gemini/Claude/Aider/Continue | `agentic-loop.ts`, `provider-models.ts`, `runtime-config.ts` | S/M |
| 30 | Named config profiles (`--profile`) + env pre-config + user-only security keys | Goose/Codex/Crush/Amp | `runtime-config.ts`, `cli.tsx` | M |
| 31 | Session edit-in-`$EDITOR` → fork; `/continue` latest; retention cleanup; archive/delete | Goose/Codex/Claude | `sessions.ts`, `commands/sessions.ts`, `cli.tsx` | S/M |
| 32 | Git commit trailers (`Agent-Thread-ID`) + `AGENT_SESSION_ID` env + `/status` line | Amp/Goose | `tools/git.ts`, `bash.ts`, `App.tsx` | S |
| 33 | Permission delegate helper (`--to program`, exit 0/1/2) + saved "always" approvals + ordered rules | Amp/OpenCode | `utils/permission-rules.ts`, `approval.ts` | M |
| 34 | Plugin `registerTool` + in-process interception events + package install/hot-reload | OpenCode/Cline | `utils/plugins.ts`, `tools/index.ts` | M |
| 35 | Web-search provider abstraction (Tavily/Brave + DDG fallback) | OpenCode | `tools/web-search.ts` | M |
| 36 | LSP diagnostics fed into loop after edits; ignore-file config in search | OpenCode/Cline/Gemini | executor hook, `tools/search-files.ts` | S/M |
| 37 | Session HTML export; natural-language config skill; `$EDITOR` compose | Cline/Crush | `commands/`, `App.tsx` | S |

### P3 — deliberate defer (large or off-model)
- **Repo map** (tree-sitter symbol graph) — large; start with a regex/signature outline instead.
- **Real LSP client** — large; Termux value unproven; keep heuristic tools.
- **OS sandboxing** (`bwrap`/Seatbelt/Docker) — large, platform-specific; offer `--sandbox docker` opt-in later.
- **Browser automation** — heavy; ship Playwright MCP config docs first.
- **Server mode / shared workspaces / agent daemon / cloud sync / orbs** — different product shape.
- **SQLite session store** — migration pain for little user value over JSON.
- **Voice dictation / i18n / telemetry OTel** — only on real demand.

### Deliberate design choices (keep, don't "fix")
- bitacode's `deny > ask > allow` precedence is **safer** than OpenCode's last-match-wins — keep it, add saved approvals on top.
- AGENTS.md "first found wins" is different from the ecosystem's "merge all" — decide deliberately (recommended: adopt merge, it matches user expectation).
- bitacode's write barrier + tool-result spill + `apply_patch` validation are already **ahead** of most of these tools — advertise them.

---

## 6b. Implemented in this branch (first wave)

Each item landed as its own module with a focused test. Verification:
`npm run typecheck`, `npm run lint`, `npm test` (the two session-autosave/exit
tests are load-timing flakes: they pass in isolation).

| Backlog item | Module | Test |
|---|---|---|
| Stale-write guard on both `write_file` and `edit_file` (mtime + existing read-state) | `utils/file-time.ts`, `tools/write-file.ts`, `tools/edit-file.ts` | existing |
| Permission dry-run `bitacode permissions test <tool> [arg]` + match buckets | `utils/permission-rules.ts`, `commands/permissions.ts` | `tests/permission-dryrun.test.ts` |
| Headless `--allowed-tools` / `--exclude-tools` / `--output-last-message` / `-q` / `--timeout-ms` | `headless.ts`, `cli.tsx`, `tools/index.ts` | `tests/headless-output.test.ts`, `tests/tool-filter.test.ts` |
| Protected control-plane paths (`.git`, `.bitacode`, `.ssh`, `.aws`, …) refused for writes | `utils/protected-paths.ts`, `tools/write-file.ts`, `tools/edit-file.ts` | `tests/protected-paths.test.ts` |
| Instruction files: merge root→cwd, `@import`, `.cursorrules`/`.clinerules`, rules dirs | `utils/rules.ts`, `system-prompt.ts` | `tests/rules.test.ts` |
| Output styles + `bitacode styles [list|set <id>]` | `utils/output-styles.ts`, `settings.ts`, `system-prompt.ts`, `cli.tsx` | `tests/output-styles.test.ts` |
| Repo outline (bounded, cached symbol map — the light version of Aider's repo map) | `utils/repo-outline.ts`, `system-prompt.ts` | `tests/repo-outline.test.ts` |
| Session `archive`/`unarchive`/`delete`/`prune` + archived hidden from `list` | `sessions.ts`, `commands/sessions.ts`, `cli.tsx` | `tests/session-archive.test.ts`, `tests/session-prune.test.ts` |

Still deferred (P1+/P3): tree-sitter repo map, real LSP client, OS sandboxing,
browser automation, daemon/server mode, plugin `registerTool`, git worktrees,
smart-approve classifier, hybrid compaction, plan artifact flow, auto-commit,
recipes, `/goal`+`/loop`, task-aware model routing.

## 7. Verification
- `npm test` baseline (see REPORT of the run), `npx tsc --noEmit`, `npm run lint` are the gates for every item added.
- Each added module ships with a focused test under `tests/`.
