# UI research — patterns from well-regarded CLI tools

Read-only review of: `charmbracelet/gum`, `junegunn/fzf`, `dandavison/delta`,
`jesseduffield/lazygit`, `google-gemini/gemini-cli`, `openai/codex` (TUI source
layout), plus the earlier OpenCode v2 benchmark. No code from those projects was
copied; these are the UX ideas worth adopting in a small Ink coding agent.

| Tool | UI idea |Why it works| Adopt here? |
|---|---|---|---|
| lazygit | **Contextual key-hint bar** — the footer always shows the keys valid *right now*, and changes with the focused pane | discovers features without a modal; reduces shortcut anxiety | **Yes** — a 1-line hint strip driven by app context |
| Gemini CLI | **`?` shortcut panel** above the composer, auto-hidden while streaming | on-demand help that never blocks typing | **Yes** |
| Gemini CLI | **`Tab` queues a prompt while the agent is busy** | turns dead time into useful input | **Yes** — already admitted automatically; needs a visible queue badge + explicit cue |
| Gemini CLI | **`Ctrl+L` redraw/clear**, **`Ctrl+O` expand/collapse**, **`F12` error details**, **Tab+Tab compact/full** | cheap escape hatches for a busy TUI | **Yes** (most) |
| Gemini CLI | explicit modifier matching, literal chars for terminals that mangle Option/Shift; keybindings file with `-command` to unbind | predictable remapping | Partial — our keybind config already normalises; document literal-char caveat |
| fzf | **fuzzy subsequence matching with scoring**, `^prefix`, `suffix$`, `'exact`, `!negate`, `|` OR | fast filtering with a tiny query language | **Yes** for `/` palette and `@` picker (keep prefix bonus) |
| fzf | **result count label** ("12 matches for [foo]") and a preview pane | makes search legible | **Yes** in palette footer |
| fzf | reverse layout / popup / `--height ~N%` (shrink to content) | dialogs don't eat the whole screen | Partial — our Dialog already sizes to content |
| delta | **word-level diff highlighting**, line numbers, file headers, `n`/`N` navigation, folding, theme presets | diffs are the primary artifact of a coding agent | **Yes** for DiffView (word-level + file header + `n`/`N`) |
| delta | automatic light/dark background detection | avoids unreadable palettes | Partial — theme already selectable; contrast check is a cheap addition |
| gum | titled spinners (`gum spin --title`), single-purpose `choose/confirm/input/pager`, consistent colour flags through env | calm, predictable interaction vocabulary | **Yes** — spinner labels and consistent prompt titles |
| gum | `gum write` multi-line composer with an explicit completion key | multi-line input without surprises | Our composer already handles this; keep the hint visible |
| Codex | TUI is split into small focused widgets (chat, composer, status, keymap, history, hints) with tests per widget | keeps a complex TUI maintainable | **Yes** as the long-term shape; our `App.tsx` should keep shrinking |

## Decisions

Adopt now: contextual hint strip, `?` shortcut panel, queue badge, `Ctrl+L`,
`F12` error log, fuzzy matching + match counts in the palette, `n`/`N` diff
navigation, spinner/prompt title consistency, contrast warning.

Skip: full fzf query language (too much surface for a slash palette), external
preview processes, desktop/web/machine UI, image/voice protocols.
