# Seizure Log

A small installable web app for logging seizures: one entry per seizure, with
tap-to-select details, a history view, and a Sunday-to-Saturday weekly report
modelled on the paper clinic log.

**No personal data is stored in this repository.** Entries live on the device
that recorded them and in the owner's private Google Sheet. The connection
details (Apps Script link and app key) are entered on each device and stored
only there.

## How it works

```
phone / browser (this app, works offline)
   │  every change is saved on the device first, then queued
   ▼
Apps Script web app (doPost, protected by a secret app key)
   │
   ▼
Google Sheet "Seizures" tab (one row per seizure)
```

- `index.html`: the whole app (form, history, weekly report, setup).
- `sw.js`: service worker that caches the app so it opens with no signal.
- `manifest.webmanifest`, `icons/`: what makes it installable.
- `apps-script/Code.gs`: the Google side. Paste it into the Sheet's Apps Script project.
- `apps-script/Index.html`: the older Apps Script-hosted page (owner-only), kept as a backup way in.

## Saving and syncing

1. Saving writes the entry to the device immediately and adds it to an outbox.
2. The outbox is sent to the Sheet whenever there is a connection: right after
   saving, when the app is reopened, when the device comes back online, and
   every minute while changes are waiting.
3. Entries not yet in the Sheet show "Not synced yet" in History, and the bar at
   the top says how many changes are waiting.
4. A half-filled entry is kept as a draft and restored if the app is closed.

If the same entry is edited on two devices, the most recent edit wins.

## Setup (once)

### 1. Google side

1. Open the Google Sheet, then **Extensions → Apps Script**.
2. Replace `Code.gs` with `apps-script/Code.gs` from this repository and save.
3. In the editor, choose the function **createAppKey** and click **Run**. Open
   **Execution log** and copy the key. Running it again replaces the key; every
   device then needs the new one.
4. **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has
   access: Anyone**. Copy the web app link (ends in `/exec`).

"Anyone" is needed so the app can reach the script from GitHub Pages. Requests
without the app key are refused, and the script's page functions only work for
the owner.

### 2. GitHub Pages

Repository **Settings → Pages → Build and deployment**: Source **Deploy from a
branch**, branch **main**, folder **/ (root)**.

### 3. On each device

1. Open the Pages address. On iPhone, use Safari: **Share → Add to Home Screen**.
2. Open the installed app, go to **Setup**, paste the web app link and the key,
   and tap **Save and test**.

On iPhone the installed app has its own storage, separate from Safari, so do the
Setup step inside the installed app.

## Making changes

When changing any app file, bump `VERSION` in `sw.js` so installed copies update
(they pick it up the next time the app is opened with a connection).
