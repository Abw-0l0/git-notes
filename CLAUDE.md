# CLAUDE.md

Guidance for working in this repo.

## What this is

GitNotes: a phone-friendly PWA for editing markdown notes that live in a GitHub repo, using the GitHub Contents API directly from the browser. No backend.

## Architecture

- **Zero-build, dependency-free, on purpose.** No `package.json`, no bundler, no framework. Keep it that way unless there's a concrete reason to change it — the whole point is that it can be dropped into any static host (GitHub Pages, Netlify, Vercel) with no build step.
- `index.html` — markup only. Links to `css/app.css` and `js/app.js`.
- `css/app.css` — all styling. Theme is CSS variables on `:root`, overridden under `prefers-color-scheme: dark` and by an explicit `data-theme` attribute (set from the in-app theme setting).
- `js/app.js` — one IIFE containing everything: the `gh()` fetch wrapper for `api.github.com`, a hand-rolled markdown renderer (`md()` / `inline()`), view switching (list / editor / settings), the formatting toolbar, list auto-continue on Enter, and localStorage-based caching of the file tree, notes, and unsaved drafts.
- `manifest.json` / `sw.js` / `icons/` — PWA plumbing. The service worker is network-first with cache fallback and explicitly ignores non-GET and cross-origin requests so it never intercepts GitHub API calls.

## Things worth knowing before changing code

- **Token handling:** the GitHub personal access token lives only in `localStorage` (`cfg.token`) and is sent only to `api.github.com`. Never log it, never send it anywhere else.
- **Conflict detection:** saves send the file's last-known `sha`; GitHub returns 409/422 if the file changed upstream since it was loaded. `friendly()` in `js/app.js` maps HTTP status codes to user-facing messages — extend that map rather than adding ad hoc error strings elsewhere.
- **Markdown renderer is intentionally minimal** (`md()`/`inline()` in `js/app.js`): no fenced-code syntax highlighting, no footnotes, shallow nested-list support. This is a deliberate tradeoff for a zero-dependency notes app, not an oversight.
- **Service worker cache versioning:** if you change any file under the service worker's `SHELL` list (`index.html`, `manifest.json`, `css/app.css`, `js/app.js`, icons), bump `CACHE` in `sw.js` (e.g. `gitnotes-v2` → `v3`) so installed PWA clients actually pick up the change instead of serving a stale cached shell.
- Paths throughout (`index.html`, `manifest.json`, `sw.js`) are relative with no leading slash, so the app works when hosted at a sub-path like `https://user.github.io/repo-name/`. Keep new paths relative too.

## Testing changes

There's no test suite. To verify a change: serve the repo root with any static server (`python -m http.server`) and exercise the app in a browser — Settings/connect flow needs a real GitHub repo + fine-grained PAT with Contents: Read and write.
