# Contributing to bitacode

Thanks for taking a look. This is a small codebase on purpose — it should stay
small enough to read in an afternoon, so the bar for new abstractions is high.

## Getting set up

```bash
git clone https://github.com/soumik183/bitacode.git
cd bitacode
npm install
npm run dev          # run from source with tsx
```

You need a provider API key. `bitacode` walks you through setup on first run,
or you can drop a `.env` in the project root (it is gitignored).

## Checks

Everything CI runs, runnable locally:

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test, 131 tests
npm run lint         # eslint
npm run build        # compile to dist/
```

All four must pass before a PR is merged.

### `dist/` is committed

The compiled output is tracked so a fresh clone runs with `node dist/cli.js`
and no build step. If you change anything in `src/`, run `npm run build` and
commit the result — CI fails when the committed `dist/` no longer matches
`src/`.

## Changing the TUI

Most of the interface lives in `src/App.tsx`, with panels in
`src/components/`. Two things to know before touching layout:

- The live area is a fixed number of rows (`CHROME_ROWS` in
  `src/utils/layout.ts`). Changing the composer or footer height without
  updating that budget squeezes the transcript.
- Scrolling uses windowed rendering (`src/utils/scroll.ts`), not negative
  margins. Ink's negative `marginTop` skips and lags, and made the terminal
  blink. Please keep new code inside the windowing model.

Layout maths lives in small pure modules under `src/utils/` specifically so it
can be unit tested without a terminal. Add tests there rather than driving the
whole app.

## Pull requests

- One logical change per PR. Split refactors away from behaviour changes.
- PR titles must be conventional commits (`fix: ...`, `feat: ...`), because
  squash-merge uses the title as the commit message.
- Fill in the PR template, including how you tested it.
- For any visible change, paste the rendered output or a short recording.
- Update `README.md`, `ARCHITECTURE.md`, or `SPEC.md` when behaviour changes —
  they are meant to describe the real thing, not an earlier version of it.

## Adding a tool

1. Create `src/tools/<name>.ts` exporting a `{ type: 'function', function: {...} }`
   schema plus an implementation.
2. Add the schema to the `tools` array in `src/tools/index.ts`.
3. Add a `case` to the `dispatchToolCall` switch in the same file.
4. Add display formatting in `src/utils/tool-display.ts`.
5. Test it in `tests/tools.test.ts`.

Tools that need user interaction should follow the `ask_user` / approval
pattern: a promise-based handler the UI registers, so the tool never blocks
forever in a headless run. See `src/tools/ask.ts`.

## Style

- TypeScript, ES modules, `.js` extensions on relative imports.
- Prefer small pure helper modules over logic buried in components.
- Comment the *why* when a decision is non-obvious, especially where you had to
  work around Ink or a provider quirk.

## Reporting bugs

Use the issue templates. For layout or scrolling bugs, a screen recording plus
your terminal name gets to a fix far faster than prose.

For security issues, see [SECURITY.md](SECURITY.md) — please do not open a
public issue.
