# Theming in Bitacode

All colours live in `src/theme/`. A theme is a flat object of 15 hex strings
(`#rrggbb`). Themes are **immutable**: the UI never edits a palette object at
render time. Instead, `ThemeProvider` publishes the selected palette through
React context and components read it with `useTheme()`.

```
src/theme/
  types.ts                    Theme, ThemeName, THEME_NAMES
  palettes.ts                 themes record + getTheme() resolver (internal)
  context.tsx                 ThemeProvider + useTheme()
  index.ts                    public API
  themes/black.ts             one palette per file
  themes/sand.ts
  themes/dark.ts
  themes/light.ts
  themes/high-contrast.ts
  theme.md                    this guide
```

`src/theme.ts` is a one-line compatibility shim that re-exports
`./theme/index.js`. Import from `../theme.js` (or `./theme.js`) as before, or
import directly from `../theme/index.js` in new code.

---

## Palettes and their intent

| Name | File | Intent |
| --- | --- | --- |
| `black` | `themes/black.ts` | **Product default.** Near-black canvas, warm-gold accents, soft-ivory ink. Quiet for long sessions but visually distinct from the old flat-dark look. |
| `sand` | `themes/sand.ts` | Warm, paper-light canvas with thin brown borders and muted ink. Chat and dialogs read like a notebook page; low saturation keeps syntax colours from fighting the chrome. |
| `dark` | `themes/dark.ts` | The historical flat-dark palette (pure black canvas, blue accents, lighter charcoal composer). Kept so existing users can stay on the classic look. This is also the value of the legacy `theme` export. |
| `light` | `themes/light.ts` | White canvas with dark foregrounds and blue focus accents, for bright rooms or light terminal themes. |
| `high-contrast` | `themes/high-contrast.ts` | Pure black/white with yellow and cyan accents. Maximises terminal contrast for accessibility or low-quality displays. |

`getTheme()` falls back to `black` for any missing or unknown name, so a stale
settings value can never break the UI.

---

## Semantic colour keys

Every palette defines exactly these 15 keys. Use the **semantic** key, not a
raw colour, so a new palette works everywhere without touching components.

| Key | What it is used for |
| --- | --- |
| `bg` | Page canvas / outer frame background (`App` frame) and the terminal OSC 11 background colour. |
| `surface` | Raised input/composer surface and `Dialog` card background. |
| `surfaceAlt` | Secondary surface, e.g. the background of inline code runs. |
| `border` | Card, composer and dialog borders; scrollbar rail; unfinished progress bar. |
| `borderFocus` | Focused border (reserved for a focused control; currently the palette's highlight border). |
| `text` | Primary foreground: splash wordmark, user/assistant text, titles, code body. |
| `userText` | Text of the user's own chat messages. |
| `userBorder` | Left rule of the user's chat message card. |
| `placeholder` | Composer placeholder text. |
| `muted` | Secondary text: descriptions, badges, meta, thought previews, footer model label. |
| `dim` | De-emphasised text: hints, separators, line numbers, "more lines" notes, scrollbar thumb. |
| `error` | Errors, rejected/destructive actions, diff removals, failed shell cards. |
| `accent` | Focus and selection cue: active list row, composer focus bar, toast/search highlight, headings, links. |
| `success` | Positive state: completed tasks, diff additions, accepted image, success toast. |
| `info` | Informational text: update notice, plan-mode banner, setup hint, hunk/literal syntax tokens. |

### Small element → colour reference

| Element | Key(s) |
| --- | --- |
| Composer box | `surface` background, `accent` (focused) / `border` (idle) left edge |
| Composer placeholder | `placeholder` |
| User message | `userText` text, `userBorder` left rule |
| Settings / picker card | `surface` background, `border` frame, `accent` title, `dim` hints, `muted` descriptions |
| Selected list row | `accent` |
| Active task (in progress) | `info` icon, `text` label |
| Completed task | `success` icon, `dim` label |
| Diff add / remove | `success` / `error` |
| Thinking card | `muted` label, `dim` metadata |
| Footer | `dim` folder/context/cost, `muted` model label |
| Post-exit session card | `accent` banner, `border` rules, `text` command, `dim` caption |
| Todo status icons | `success` (completed), `info` (in progress), `dim` (pending/cancelled) |
| Sub-agent status icons | `info` (start), `success` (done), `error` (error) |
| Syntax tokens | `dim` comments, `success` strings, `accent` keywords, `info` literals/hunks, `error` diff removals |

Plain-text Markdown rendering (`utils/format-message.tsx`) and syntax
highlighting (`utils/code-highlight.tsx`) are pure helper functions, not React
components, so they cannot call `useTheme()`. They take an explicit
`palette: Theme` (via a trailing argument / `HighlightOptions.palette`) and fall
back to `getTheme()` when omitted. React callers pass the value they already
read from `useTheme()`, so both helpers repaint when the palette changes. Three
legacy syntax token colours (`#9cdcfe`, `#b5cea8`, `#dcdcaa`) and the yellow /
orange Markdown marker colours remain fixed: they are not part of the 15-key
Theme type.

---

## Selecting and switching themes

### Theme picker (implemented)

Both entry points open the same dedicated picker card (built from `Dialog` and
`DialogList`):

- `ctrl+,` (or `/settings`) opens Settings → move to the **Theme** row → Enter.
- `/theme` opens it directly from the composer.

The picker lists all five palettes in `THEME_NAMES` order. Each row shows a live
swatch (an accent-coloured `■` painted on that palette's own `bg`), the name,
a short intent, and a `current` marker on the active palette. Use ↑↓ + Enter,
or press `1`–`5` to pick a palette directly; Esc closes the picker. Narrow
terminals truncate descriptions but keep names and swatches readable.

Selecting a palette calls the shared save path in `App`: `setSettings()` with
the new `theme`, `saveSettings()` to persist it, and a toast. `App` passes
`settings.theme` to `ThemeProvider`, so every consumer repaints on the next
render. Do not mutate a palette object or write ANSI escape sequences from the
command — the provider picks up an immutable palette automatically.

### Config file

The palette name is stored in the UI settings file (not the runtime provider
config), under the user's config directory:

- Linux/macOS: `~/.config/bitacode/settings.json`
- Windows: `%APPDATA%/../Local/bitacode/settings.json`

```json
{
  "animations": true,
  "mouseClicks": true,
  "variant": "none",
  "approvalMode": "manual",
  "theme": "sand"
}
```

`loadSettings()` validates the value against the five known names and falls
back to `black` otherwise.

---

## How ThemeProvider / useTheme work

```tsx
import { ThemeProvider, useTheme } from './theme/index.js';

// App owns the selected name (from settings) and publishes a palette:
<ThemeProvider name={settings.theme}>
  <AppContent settings={settings} setSettings={setSettings} />
</ThemeProvider>

// Any descendant reads the palette without prop drilling:
const Message: React.FC = () => {
  const theme = useTheme();
  return <Text color={theme.text}>hello</Text>;
};
```

- `ThemeProvider` derives the palette with `useMemo(() => getTheme(name), [name])`.
  It never writes to a module singleton; switching themes simply publishes a
  different immutable object and React re-renders consumers.
- `useTheme()` returns the nearest provider's palette. Outside a provider it
  returns `getTheme()` (the default `black` palette), so components rendered
  directly in tests still work without any wrapping.
- Plain (non-React) helpers should accept an explicit `palette: Theme`
  parameter and let their React caller pass `useTheme()`'s value. If that is
  impossible, `getTheme()` is an acceptable default.

---

## Customization

The look is tuned in two places: define a palette (a set of 15 semantic
colours) or adjust one dialog's chrome with props. Component layout never has
to change, and no component ever reads a palette file or raw hex directly.

### Adding a palette file

Palette files are plain `Theme` objects in `src/theme/themes/`. The name must be
registered in `THEME_NAMES` (`types.ts`) and in the `themes` record
(`palettes.ts`), and `settings.ts` must accept it before the picker can select
it. The semantic key → element mapping lives once in the two tables above
(*Semantic colour keys* and *Small element → colour reference*); when a new
element uses an existing key, extend those tables instead of duplicating the
mapping here.

Steps:

1. **Create the palette file** `src/theme/themes/<name>.ts`. Import
   `type { Theme } from '../types.js'`, declare `const <name>: Theme = { ... }`
   with **all 15 keys**, and `export default <name>;`.
2. **Register the name** in `src/theme/types.ts`: append the string to
   `THEME_NAMES` (this types `ThemeName` and drives the settings cycle).
3. **Register the palette** in `src/theme/palettes.ts`: import the new file and
   add it to the `themes` record under the same name.
4. **Update validation** in `src/settings.ts`: `isThemeName()` and the
   `UiSettings.theme` union must accept the new name. (Prefer importing
   `ThemeName` from the theme module once these unions are consolidated.)
5. **Update the docs**: add a row to the *Palettes and their intent* table in
   this file and add its intent to `THEME_INTENTS` in `src/App.tsx` so the
   picker can describe it.
6. **Add/extend a test** in `tests/theme.test.ts` so
   `Object.keys(themes)` includes the new name and its keys are all valid hex.
7. **Verify**: run `npm run typecheck`, the theme/UI test files, `npm run lint`,
   and `npm run build`.

Checklist:

- [ ] `themes/<name>.ts` exists with all 15 hex keys
- [ ] `THEME_NAMES` includes the name
- [ ] `themes` record maps the name to the palette
- [ ] `settings.ts` accepts the name
- [ ] `theme.md` documents it
- [ ] `theme.test.ts` covers it
- [ ] typecheck / tests / lint / build pass

### Dialog chrome

`Dialog` already takes its frame, title and rule colours from `useTheme()`. Two
optional props let a single dialog personalise that chrome without a new
palette key or a bespoke layout:

| Prop | Default | Effect |
| --- | --- | --- |
| `accentGlyph?: string` | none | Accent-coloured glyph rendered just before the title (in both normal and compact modes). |
| `borderStyle?: 'round' \| 'square'` | `'round'` | Corner style of the card frame. `'square'` maps to Ink's straight-corner `single` border; ignored in compact mode. |

Both default to the current look, so existing dialogs are unchanged. Use them
sparingly — they distinguish a special dialog, not every screen. The theme
picker is the worked example:

```tsx
<Dialog
  title="Theme"
  accentGlyph="◈"
  borderStyle="square"
  badge={`${index + 1}/${themeItems.length}`}
  hint="↑↓ move · enter use · 1-5 pick · esc close"
  columns={columns}
>
  <DialogList items={themeItems} selected={index} />
</Dialog>
```

The glyph is plain text, so it must not collide with the `■` palette swatches
that `DialogList` renders for theme rows.
