# Seizure Log: notes for Claude

An installable, offline-first web app for logging seizures, hosted on GitHub
Pages from `main` (root). It syncs to the owner's private Google Sheet through
an Apps Script web app. See README.md for how it works and how it is set up.

## Hard rules

- **This repository is public.** Never commit the app key, the Apps Script
  deployment link, any log entries, Sheet contents or other personal details.
  The key and link are entered on each device (Setup tab) and stored only there.
- **Bump `VERSION` in `sw.js` whenever any app file changes** (`index.html`,
  `manifest.webmanifest`, `icons/`), so installed copies refresh cleanly.
- Do not change the Apps Script deployments' access settings or create, delete
  or archive deployments unless the owner asks.

## Where things live

- `index.html`: the whole app (form, history, weekly report, Setup tab, sync).
  Every change is saved to the device first (localStorage `sl.entries`) and
  queued in an outbox (`sl.outbox`), then sent to the Apps Script API. Drafts
  of unsaved entries live in `sl.draft`. Chip-list preferences (chips
  removed with "Edit list", per group in lowercase, and custom "When"
  shortcuts in minutes) live in `sl.prefs` and sync through the `prefs` API
  action, stored in Script Properties (`APP_PREFS`); the copy changed last
  wins. Removing a chip only hides it from the list and never changes past
  entries. If the Apps Script deployment lacks `prefs`, the app keeps lists on
  the device and still syncs entries.
- `sw.js`: service worker. Caches the app's own files only; never intercepts
  Apps Script requests.
- `apps-script/Code.gs`: the Google side. `doPost` is the key-protected JSON API
  the app uses (`ping`, `list`, `save`, `remove`, `prefs`). `api_*` functions serve the
  older owner-only page and refuse anyone but the owner.
- `apps-script/Index.html`: the older Apps Script-hosted page, kept as a backup
  way in. Not used by the GitHub Pages app.
- `tests/e2e.js`: end-to-end test (see below).

## Changes that touch the Sheet

Adding or changing a stored field means changing both sides:

1. `index.html`: the form, `collect()`, `fillForm()`, `rowsOf()` and the CSV.
2. `apps-script/Code.gs`: append new columns to the END of `COLS` (never
   reorder or insert; existing rows depend on column positions), and update
   `toRow_` and `fromRow_`. `sheet_()` adds missing header columns itself.
3. Tell the owner that Google runs its own copy of `Code.gs`. After pushing, the
   new `Code.gs` must be pasted into the Apps Script project and saved, then
   **Deploy → Manage deployments → edit "Installable app API" → New version →
   Deploy**. Editing that deployment keeps its link, so devices stay connected.
   Also redeploy the older owner-only deployment, "Seizure Log (backup page)", if
   its page should keep working with the new fields.
   When deploying a new version, retype the deployment's name in the
   Description field: Apps Script otherwise blanks it ("Untitled") and files the
   previous version under Archived with the old name. Archived entries are
   history only; the active deployment keeps its link.

Changes to `index.html` alone need no Google-side step.

## Design constraints

- Keep tap targets large (at least 44px), avoid drag gestures and hover-only
  controls, and keep typing optional: chips and buttons first, text fields as
  an extra.
- Only the date and time are required to save an entry.
- The app must keep working with no connection: never make saving wait on the
  network.
- Light and dark themes are both supported through the CSS tokens at the top of
  `index.html`; use the tokens, not literal colours.

## Testing

`node tests/e2e.js` serves the repo on localhost (so the service worker runs),
runs the real `apps-script/Code.gs` against a mock Sheet, and drives the app with
Playwright: offline save, queued sync, wrong-key handling, draft restore,
edit/delete, a fully offline reload, and the owner-only guard. It needs Node and
Playwright (`npm i -D playwright` and `npx playwright install chromium` if they
are not already available). Run it before pushing changes to `index.html`,
`sw.js` or `Code.gs`; it exits non-zero on failure.
