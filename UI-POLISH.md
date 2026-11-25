# UI polish and bug-fix pass

Companion to `UI-RESEARCH.md`. This pass was driven by three read-only audits of
`App.tsx`, the components, and the rendering utilities, plus the integration
audit from the previous feature wave. No dependency install was performed; the
normal `npm test` / `typecheck` / `lint` suite still needs a full environment.

## New UI behaviour

| Feature | Inspired by | Where |
|---|---|---|
| Contextual one-line key hints above the composer | lazygit | `utils/hints.ts`, `App.tsx` |
| `?` shortcut panel, auto-hidden while streaming/dialogs | Gemini CLI | `utils/shortcuts.ts`, `App.tsx` |
| `Ctrl+L` clear/redraw, `F12` recent-error panel | Gemini CLI | `App.tsx` |
| Visible `N queued` badge for steered prompts | Gemini CLI `Tab` queue | `utils/hints.ts`, `App.tsx` |
| Fuzzy `/` palette with match counts and highlighted characters | fzf | `utils/fuzzy.ts`, `Palette.tsx` |
| Word-level bold highlighting inside changed diff rows | delta | `utils/word-diff.ts`, `DiffView.tsx` |
| Theme-aware syntax colours, table column cap, true truncation counts | delta / audit | `format-message.tsx`, `code-highlight.tsx` |
| Narrow-terminal fixes (popup width, tables, hints, click geometry) | audit | `PromptInput`, `LiveStatus`, `SubAgent*`, `mouse.ts` |

## Correctness fixes (behavioural)

- **Provider policy now fails closed** on malformed top-level values and on a
  present-but-unusable `allowedModels`; the loop refuses the request if the
  policy check itself throws.
- **Stale MCP servers are disconnected** on re-init, including their dynamic
  tools and handlers.
- **Tool groups cover loop-level tools** (`sub_agent`, `subagent_control`) and
  hidden tools remain dispatchable.
- **`agent_type` enum now matches the real agent catalog** (`build`, `plan`,
  `general` plus project agents); no more silent fallback from `Explore`/`Bash`.
- **`snapshot restore`** distinguishes dry-run explanations from real failures,
  exits non-zero on errors, and supports `--apply`.
- **`auth add` accepts display labels** like `Work laptop`; `auth active` prints
  stable JSON.
- **Empty compaction results never wipe history**; the context-too-long repair
  only swaps in a non-empty, different array.
- **Headless output no longer passes through the interactive renderer**;
  stable-render installs only on the interactive path.
- **Custom themes register before the first frame**, and the theme provider
  repaints when a palette is registered late. `getTheme()` no longer accepts
  inherited object keys.
- **Theme audits cover `surface`/`surfaceAlt`**, with sand/light palette colours
  adjusted to keep AA contrast.
- **Stable renderer clear detection is anchored**, and per-stream state prevents
  cross-terminal row leakage.
- **Mouse wheel masking, duration formatting, terminal CI detection, grapheme
  token counting, BOM theme parsing** — all fixed in the utility pass.
- **App-side**: contextual dialog hacks (pendingAsk swallowing Esc/clicks),
  palette arrow/Enter selection, `Tab` completion, `/permissions`, keybind
  coverage, session-switch run abort, queued-prompt lifetime, duplicate error
  cards, scrollbar geometry, and unhandled API-key errors (see agent report).

## Verification note

New pure modules were run with Node's built-in TypeScript stripping and a
temporary `.js → .ts` resolver: `fuzzy` 11/11, `word-diff` 12/12, `hints`
12/12, `shortcuts` 11/11. `provider-policy`/`accounts` cannot run under that
harness because `logger.ts` uses a TypeScript `enum`; they are covered by their
existing `node:test` files for the normal toolchain.
