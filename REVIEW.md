# bitacode — Code Review

Scope: whole repository (`src/`, `tests/`, config, CI), reviewed read-only.
Date: as of `c91a850` (v0.1.25), ~22.5k LOC across 128 TS/TSX files.

## Baseline (all commands run for this review)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 errors |
| Lint | `npm run lint` | ✅ 0 errors, ⚠️ 176 warnings (all `no-explicit-any`) |
| Tests | `npm test` | ✅ 544 passed / 0 failed (~89 s) |
| Build reproducibility | `tsc --outDir .review/dist-check` vs committed `dist/` | ✅ identical (no drift today) |

So the project is in good shape mechanically. The findings below are behavioural: bugs
that only appear in specific flows, security-model inconsistencies, and structural
debt. Every finding marked **[verified]** was reproduced with a script against the
real modules, not just read off the source.

---

## Fix status (this branch)

Every item below was fixed, with a regression test where the bug was behavioural.
`npm test` is 560 passed / 0 failed; `npm run lint` 0 errors; `dist/` rebuilt.

| Item | Fix | Where |
|---|---|---|
| 1.1 compaction orphans | tail aligned to a non-tool boundary, skill results dropped when their parent is gone, `dropOrphanToolMessages()` safety pass, unusable results return the input by identity | `src/utils/compactor.ts` |
| 1.2 process sandbox | one shared gate (`gateCommand`, `isDangerousCommand`, `isSafeCommand`, `validateCommandPaths`) used by `bash`, `start_process`, `background`, `watch`; `start_process` gained a validated `cwd`; argv[0] and `--flag=path` are now checked | `src/utils/command-gate.ts`, `src/tools/{bash,process,watch}.ts` |
| 1.3 `read_image` | uses `validatePath()` | `src/tools/image-input.ts` |
| 1.4 checkpoints | absolute path stored, `validatePath()` on restore | `src/utils/checkpoint.ts` |
| 1.5 lingering processes | `stopAllProcesses()` on unmount and on `process.once('exit')` | `src/tools/process.ts`, `src/App.tsx` |
| 1.6 MCP startup | parallel `Promise.allSettled`, per-server timing + failure summary | `src/mcp.ts` |
| 1.7 session writes | temp file + `fs.rename`, load/list failures logged | `src/sessions.ts` |
| 1.8 stale closure | `subAgentActivitiesRef` mirrors the state | `src/App.tsx` |
| 1.9 nits | token 0 validated, `[`/`]` removed from the control pattern, delete uses `file_write`, cwd read per call, renderer guard, `max_tokens` derived from history, `changed` counted explicitly, ripgrep detected lazily | see §1.9 |
| 3.3 aliases | `TOOL_NAME_ALIASES` unioned into `getValidToolNames()` | `src/tools/index.ts`, `src/agentic-loop.ts` |
| 3.4 three gates | collapsed into `command-gate.ts` | — |
| 3.6 logging | kept-open `WriteStream`, `0600` file in `0700` dir, `closeLogFile()` | `src/utils/logger.ts` |

Also fixed, not in the original list: the `400 Input required: specify "prompt" or
"messages"` failure (empty history reaching the provider), the in-place compaction swap
that could wipe a conversation, `PromptInput` growing into a multi-line text area, and
`splitLiveArea` reserving rows for it. §3.1 (split `App.tsx`), §3.2 (tool schema size),
§3.7 (`any` cleanup) and §3.5 (dist tracking — a CI check already exists) remain open.

---

## 1. Bugs

### 1.1 HIGH — Compaction can emit an invalid message history (orphan `tool` messages) **[verified]**

`src/utils/compactor.ts:84-89`, `126-131`

`compactConversation` slices the tail by message count (`RECENT_MESSAGES_TO_KEEP = 5`)
and re-inserts `protectedMessages` (skill content) independently of their parent
assistant message. Both can leave a `role: 'tool'` message with no preceding
assistant `tool_calls` — a shape OpenAI/Anthropic/Gemini reject with HTTP 400.

Reproduced with 5 parallel tool calls (an assistant message with 5 calls + 5 tool
results, which the loop happily produces):

```
compacted roles: system,system,tool,tool,tool,tool,tool
assistant tool_calls kept? false        ← 5 orphaned tool messages
```

Reproduced again with one protected `<skill_content>` tool message:

```
system,system,tool:c1,user,user,user,user,user   ← tool:c1 orphaned
```

Impact: every request after that compaction fails 400; the error handler then tries to
repair history (`removeOrphanedToolResults`), so the user sees a long stall or lost
context instead of a clean turn. Trigger probability grows with parallelism (the tool
schema encourages it) and with skills.

Fix:
- widen the retain window so it never starts inside a tool-result run: walk backwards
  and include the assistant message that owns the leading `tool` messages;
- keep protected skill messages together with their owning assistant message (or drop
  the parent-less tool message);
- add a `sanitizeCompletionMessages()` pass over the compacted array before returning
  it (that function already exists in `sessions.ts` — move it to `utils/` and reuse);
- regression tests for both cases (the current `tests/compactor.test.ts` has exactly
  one test and never inspects the output shape).

### 1.2 HIGH — `start_process` / `background` / `watch` bypass the path sandbox **[verified]**

`src/tools/process.ts:106-116`, `144-200`; `src/tools/watch.ts:31-43`

`bash` runs every path token through `validatePath()` and refuses paths outside the
working directory. `start_process` only checks a command *prefix* allowlist and then
spawns with `shell: true`. Consequences:

```
bash     : Command blocked: "cat /etc/hostname" references a path outside the allowed working directory.
start_process: Started process proc-1: cat /etc/hostname        ← no approval, no path check
```

`watch` and `background` both delegate to `startProcess`, so they inherit the gap.
Any of them can read `~/.ssh`, `.env` above the project root, etc. with no prompt, and
`yolo`/`auto` mode is not even required.

Fix: share one command-gating module for `bash`, `process`, `watch` (tokenize, validate
paths, hard-block dangerous patterns) instead of three drifting copies. Also add a
`cwd` argument to `start_process` and validate it like `bash` does.

### 1.3 MEDIUM — `read_image` skips `validatePath` **[verified]**

`src/tools/image-input.ts:54`

```ts
const absolute = path.resolve(process.cwd(), filePath);   // no validatePath
```

Every other file tool validates. `read_image("../outside.png")` succeeded and returned
the base64 payload. Same class of escape as 1.2 (plus symlink escapes), and it puts
arbitrary bytes into the model context.

Fix: `const absolute = await validatePath(filePath);` and keep the existing
extension/size checks.

### 1.4 MEDIUM — `/undo` restores relative to *today's* cwd, not the session's

`src/utils/checkpoint.ts:106` stores `path: requested` (the raw, possibly relative
argument); `:162` restores with `path.resolve(process.cwd(), parsed.path)`.

Resume a session from a different directory (`cd sub && bitacode --session <id>`) and
undo writes the snapshot into the wrong place — and creates the parent directories for
it (`:166`). There is also no validation that the checkpoint path is inside an allowed
root at restore time, so a planted file under
`~/.local/share/bitacode/checkpoints/<session>/` can overwrite anything the user can
write.

Fix: store the absolute resolved path at snapshot time, validate it on restore, and
refuse to restore outside the allowed roots.

### 1.5 MEDIUM — Background processes survive the app

`src/tools/process.ts:29` keeps a module-level `Map` of spawned children; nothing runs
on exit (only MCP has a `closeMcp()` from `App.tsx:1294`). Because children are
`detached: true` on POSIX, quitting the TUI leaves `npm run dev`, watchers, servers
running with no handle to them. `stop_process` is the only way out and it is forgotten
once the process entry is evicted.

Fix: export `stopAllProcesses()`, call it from the exit cleanup (and on SIGINT/SIGTERM
next to `installTerminalRestore`), and log how many were stopped.

### 1.6 MEDIUM — MCP startup blocks the UI, one 15 s timeout at a time

`src/mcp.ts:314-346` connects servers strictly sequentially, each with
`CONNECT_TIMEOUT_MS = 15_000`; `App.tsx:939` awaits `initializeMcp()` before
`setInitialized(true)`.

Three slow servers = up to 45 s on a blank screen before the composer appears, and
there is no progress indicator. Fix: connect in parallel with `Promise.allSettled`
(the registry is already name-collision safe), lower the timeout for the first pass, and
surface connection results as events/toasts.

### 1.7 MEDIUM — Session saves are not atomic; load failures are silent

`src/sessions.ts:359-363` writes the whole JSON with `fs.writeFile` (truncate + write).
A kill mid-write leaves a truncated session file; `loadSession` (`:369-390`) catches
everything and returns `null`, so the user is told "Session not found" with no log line.
Same for `listSessions`, which silently skips corrupt files.

Fix: write to `<id>.json.tmp` + `fs.rename` (as `write_file` already does), and log the
parse error (with the file path, without content) before returning `null`.

### 1.8 LOW — `subAgentActivities` is persisted from a stale closure

`src/App.tsx:2399` saves `subAgentActivities` from the closure that started the run;
the state was updated by events during the run but the callback's dependency list does
not include it (`:2409-2411`). The last turn's sub-agent panel therefore disappears from
a saved session even though it was displayed live.

Fix: keep the activities in a ref alongside the state (same pattern as `reasoningRef`),
or read them via a functional setter when saving.

### 1.9 LOW — assorted

- `src/tools/bash.ts:236-240`: path validation starts at token index 1, so the command
  word itself is never checked (a script path as the executable skips validation; it
  still needs approval, so impact is low).
- `src/tools/bash.ts:75`: `SHELL_CONTROL_PATTERN` includes `[` and `]`, so
  `ls file[0-9].ts` and any bracketed test needs approval — a usability false positive.
- `src/tools/delete.ts:52-58`: the approval is filed as `type: 'shell_command'`, so the
  UI labels a deletion as a shell command and "approve all shell commands" silently
  covers deletes for the session. Use a file-operation type, or state the coupling
  explicitly.
- `src/utils/path-validation.ts:12`: `workingDirectory` is captured at module load;
  any later `process.chdir()` (or a future workspace switch) is invisible to every
  file tool.
- `src/utils/stable-render.ts:33`: `installStableRenderer` has no idempotence guard; a
  second call wraps `stdout.write` twice (tests that install it per-case are exposed).
- `src/utils/compactor.ts:112-118`: the compaction request hard-codes `max_tokens: 2000`
  and ignores the actual `usage.prompt_tokens` reported by the API, so it both
  underestimates context growth (chars/4) and can truncate a summary of a large history.
- `src/utils/message-sanitize.ts:92`: `changed` compares `result[i]` against
  `messages[i]` after drops, so it is true whenever anything was dropped — harmless but
  the intent (detect real repairs) is lost.
- `src/tools/search-files.ts:39-45`: ripgrep detection runs `execFileSync` at import
  time on every process start (blocking), and the result is cached forever.

---

## 2. Security model review

Good: approval fail-closed when no handler; hard-blocked dangerous commands are
pre-approval; `yolo` is documented as a path-restriction escape hatch only; webfetch
re-validates every redirect against private/loopback/metadata IPs, caps body size, and
tears the connection down; config/session files are written `0600` in `0700` dirs;
sessions, todos and checkpoints are schema-sanitised on load; logs strip ANSI.

Gaps:
1. §1.2 and §1.3 — three different command/path gates that disagree.
2. MCP stdio servers inherit the full `process.env` (`src/mcp.ts:154-157`), i.e. every
   provider key, `GITHUB_TOKEN`, etc. is handed to a third-party binary. Consider an
   allowlist plus explicit `env` passthrough, and document it in the config template.
3. `read_image` (§1.3) is a silent exfiltration channel into the model context.
4. DNS rebinding: `assertPublicUrl` resolves the host, then `fetch` resolves it again
   (§`src/tools/webfetch.ts:99-118`). Low risk, but pinning the resolved address would
   close it.
5. No integrity check on resumed checkpoints/sessions if another local process can
   write to `~/.local/share/bitacode/` (§1.4).

---

## 3. Architecture / maintainability

1. **`src/App.tsx` is 3,488 lines** with 51 `useState`, 26 `useEffect`, 31
   `useCallback` and a 25-entry dependency array in `handleSubmit`. This is the single
   biggest maintenance cost in the repo: slash-command routing, pickers, streaming
   state, session lifecycle, key handling and the approval bridge all live in one
   component. Suggested split: `useSessionLifecycle`, `useComposer`, `usePickers`,
   `useKeyboard`, `useStreaming`; the hooks already exist for one part of this.
2. **55 tools advertised, ~27 kB / ~6.8k tokens of JSON schema per request** (measured).
   That is a fixed cost on every turn before any conversation. Consider advert-only
   groups (file ops / web / process / agent) toggled by mode or config, or a
   `list_tools` indirection for the long tail (`notify`, `progress`, `agent_status`,
   `task_result`, `open_url`, `command_exists`).
3. **Alias plumbing is half-hidden**: `TOOL_ARGS` and the dispatcher accept `grep`,
   `shell`, `run`, `terminal`, `fetch_url`, `websearch`, `list`, `find_file`, but
   `getValidToolNames()` (`agentic-loop.ts:92`) does not, so the 400-repair path treats
   a call the dispatcher would accept as hallucinated. Pick one policy.
4. **Three copies of "is this command safe"** (`bash.ts`, `process.ts`, `watch.ts`)
   already diverge — the source of §1.2. One module, one table, three callers.
5. **Committed build output**: `dist/` is tracked (128 files) and published. It is in
   sync today, but nothing enforces that; a PR that changes `src/` without rebuilding
   ships stale JS from `npm pack`. Either drop it from git (CI publishes) or add a CI
   check that `tsc` output matches `dist/`.
6. **Logging**: `appendFileSync` per line (`utils/logger.ts:80`) with the default level
   `DEBUG` (`cli.tsx:59`), a new log file per run, no rotation/pruning, and the log dir
   is created without a mode. Prompt-adjacent content ends up in `~/.local/share/bitacode/logs`.
   Suggest: a `WriteStream`, default `WARN` (or INFO) unless `--log-level` is given,
   `0700` dir, and prune files older than N days at startup.
7. **`any` everywhere**: 176 lint warnings, mostly `catch (err: any)` and `as any` in
   the tool layer. Adding `"@typescript-eslint/no-explicit-any": "error"` for `src/`
   (allowing it in tests) would pay off quickly and is mechanical.
8. `App.tsx` and `config.tsx` mix rendering with fs writes; the `writeConfig`/
   `writeActiveSelection` side effects inside effects make first-run/idempotency bugs
   hard to reason about.

---

## 4. Test coverage notes

544 tests is a genuinely good baseline, and the risky edges that exist are tested
(webfetch SSRF, approval fail-closed, undo, session sanitising, stream hardening,
shell escape, stable renderer).

Thin spots worth adding:
- `tests/compactor.test.ts` — one test; no shape assertions (§1.1).
- No test that `start_process`/`watch`/`read_image` respect `validatePath` (§1.2, §1.3).
- No exit-path test for background processes (§1.5).
- `App.tsx` flows are covered by render tests but the save/resume paths for
  `subAgentActivities` (§1.8) and compaction-inside-a-turn are not.

---

## 5. Suggested order of work

1. Compaction history repair (§1.1) + tests — highest user-visible blast radius.
2. One shared command/path gate for `bash`/`start_process`/`watch`, and `validatePath`
   in `read_image` (§1.2, §1.3).
3. Absolute + validated checkpoint paths, atomic session writes (§1.4, §1.7).
4. Exit cleanup for background processes, parallel MCP connect (§1.5, §1.6).
5. Structural: split `App.tsx`, drop or verify `dist/`, tighten logging, then toolset
   size (§3).

---

## 6. What I did not check

- Live provider calls against real endpoints (no keys used); provider-specific request
  shaping was read, not executed.
- Interactive TUI behaviour on a real terminal (Ink rendering, mouse, resize) beyond the
  existing test suite.
- Windows-specific paths (all probes ran on Android/Termux, POSIX).
- Dependency audit (`npm audit`) — network-dependent and out of scope here.

---

## 7. Implementation status (this working tree)

Every item in §1 and the structural work in §3 that the two reports agreed on is now
implemented, in its own module, with tests.

| Area | Module(s) | Tests |
| --- | --- | --- |
| Compaction/400 repair | `src/utils/compactor.ts`, `src/agentic-loop/errors.ts`, `message-sanitize.ts` | existing + new |
| Shared command/path gate | `src/utils/command-gate.ts` (bash, start_process, background, watch) | existing |
| Checkpoints & atomic sessions | `src/utils/checkpoint.ts`, `src/sessions.ts` | existing |
| Process cleanup, parallel MCP | `src/tools/process.ts`, `src/mcp.ts` | existing |
| Write barrier / batching | `src/agentic-loop/scheduler.ts` | `tests/runtime-core.test.ts`, `tests/executor-policy.test.ts` |
| Permission rules + trust | `src/utils/permission-rules.ts`, `src/utils/project-trust.ts`, `src/commands/permissions.ts` | `tests/runtime-core.test.ts` |
| Hooks | `src/utils/hooks.ts` | `tests/runtime-core.test.ts` |
| Tool-result spill | `src/utils/tool-result-budget.ts` | `tests/executor-policy.test.ts` |
| Read dedupe / edit guard | `src/utils/read-state.ts` | `tests/executor-policy.test.ts` |
| Postcondition verification | `src/utils/tool-verify.ts` | `tests/runtime-core.test.ts` |
| Headless `-p --json` | `src/headless.ts`, `src/providers/client.ts`, `src/cli.tsx` | `tests/runtime-features.test.ts` |
| Doctor | `src/utils/doctor.ts` | `tests/runtime-features.test.ts` |

Verification: `npx tsc --noEmit` clean, `npm run lint` 0 errors (199 advisory `any`
warnings), `npm test` **607 pass / 0 fail**, `npm run build` regenerates `dist/`.

Follow-up fixes on top of that table:

- **Transient retries** now follow one schedule for 429, 5xx and dropped
  connections: wait 1s, 3s, 5s, 10s and 15s (a longer provider `Retry-After`
  always wins), then stop after six attempts with a clear message instead of
  retrying forever.
- **Model lists** are cached on disk (`~/.local/share/bitacode/model-cache.json`),
  coalesced per provider, bounded by a 4s timeout, merged with the built-in
  models, and prefetched at startup — so the picker opens instantly and a new
  provider needs no code beyond the OpenAI-compatible `/models` endpoint.
- **Test isolation**: the App test harnesses now run inside their temp HOME so a
  test run can no longer rewrite the developer's project selection.

Burn-down commands, the two UI bugs from the original report and the remaining
advisory items (`App.tsx` size, dependency audit) are still open; nothing in this
table needs a live provider to run.
