# New features (OpenCode v2 benchmark)

This file documents the features added on top of `REVIEW.md` and
`GAP-ANALYSIS-LYNN.md`. The full comparison and rationale is in
`OPENCODE-GAP-ANALYSIS.md`.

All new modules follow one rule: **bad input, corrupt files, failing hooks and
provider errors never crash the TUI**. They return `{ ok, value }` / `{
ok:false, error }` results or readable tool strings, log through `logger`, and
fail closed whenever permissions are involved. Nothing here runs during normal
startup unless it is explicitly enabled.

## Runtime features

| Feature | Enable with | Where |
|---|---|---|
| Tool groups (smaller schema per request) | `BITACODE_TOOL_GROUPS=core,files,web` or `settings.toolGroups` | `utils/tool-groups.ts`, `tools/index.ts` |
| Named agents + per-agent tools | drop `*.md` in `.bitacode/agents/`; `/agent` | `agents.ts`, `sub-agent.ts` |
| Session steering / queueing | automatic while a turn runs | `utils/session-inbox.ts`, `App.tsx` |
| Background job notifications | automatic for long shell jobs | `utils/background-jobs.ts`, `App.tsx` |
| Structured `form` tool | model calls `form` | `tools/form.ts` |
| Git worktree sandboxes | `bitacode worktree create <name>` | `utils/worktree.ts`, `cli.tsx` |
| Git-native snapshots (opt-in) | `settings.vcsSnapshots: true`, then `bitacode snapshot ...` | `utils/vcs-snapshot.ts` |
| Config hot-reload notices | automatic (watcher) | `utils/config-watch.ts` |
| Custom themes | `~/.config/bitacode/themes/*.json`, select `custom` | `theme/discovery.ts`, `theme/palettes.ts` |
| Keybinding overrides | `settings.keybindings` | `utils/keybinds.ts`, `App.tsx` |
| Goal/supervisor mode (opt-in) | `settings.goalMode: true` + `BITACODE_GOAL=...` | `utils/goal.ts`, `agentic-loop.ts` |
| Local provider presets | automatic (user config wins) | `providers/local-presets.ts` |
| Provider model policy | `bitacode.jsonc` → `providerPolicy` | `utils/provider-policy.ts`, `agentic-loop.ts` |
| Shell-aware permission checks | automatic for allow rules | `utils/shell-scan.ts`, `permission-rules.ts` |
| MCP env allowlist | `mcp.servers.<name>.env` / `envAllowlist` | `utils/mcp-env.ts`, `mcp.ts` |
| Event-sourced session log (opt-in) | `settings.sessionEventLog: true` | `utils/session-events.ts`, `sessions.ts` |

## New commands

```bash
bitacode mcp list|add|remove|test|show [name]
bitacode auth list|add|switch|active|export|import
bitacode worktree create|list|remove <name>
bitacode schedule list|add|due|rm
bitacode snapshot list|create|restore|delete [id]
bitacode sessions import <path.json>
```

New slash commands: `/search <text>` (all sessions), `/stash [save|pop|delete|list]`, `/agent`.

### Settings additions (`settings.json`)

```jsonc
{
  "toolGroups": ["core", "files", "web"],   // empty = every tool (legacy)
  "keybindings": { "search": "ctrl+f" },
  "themePath": "/path/to/theme.json",
  "goalMode": false,
  "vcsSnapshots": false,
  "sessionEventLog": false
}
```

`bitacode.jsonc` additions:

```jsonc
{
  "providerPolicy": {
    "allowedModels": ["anthropic/*", "openai/gpt-*"],
    "deniedModels": ["*-preview"],
    "maxRetries": 4
  },
  "mcp": {
    "servers": {
      "example": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "some-mcp-server"],
        "envAllowlist": ["MY_PUBLIC_TOKEN"]
      }
    }
  }
}
```

## Error-handling contract

- **Files and JSON:** atomic writes (tmp + rename), `0700` dirs / `0600` files,
  strict id validation, size caps, tolerant reads that skip corrupt entries.
- **Permissions:** deny > ask > allow; high-risk shell structure (chaining,
  substitution, redirection) downgrades an allow rule to `ask`.
- **Providers:** model policy is checked before any request; permanent and
  content-filter errors do not consume the transient retry budget; retries use
  jittered exponential backoff with a larger provider `Retry-After` winning.
- **UI bridges:** the `form` tool fails closed when no UI handler is attached;
  failed handlers become readable tool results, never unhandled rejections.
- **Lifecycle:** background jobs and spawned processes are stopped on exit;
  watchers close; queued prompts are delivered once and cleared.

## Verification note

The repository's dependencies were intentionally not installed in the
environment where this work was done, so `npm test`, `npm run typecheck` and
`npm run lint` were not executed here. Each new module was exercised in
isolation by its author with Node's built-in TypeScript stripping and a stubbed
logger; all 22 new test files use the project's `node:test` conventions and
should run with the normal toolchain.
