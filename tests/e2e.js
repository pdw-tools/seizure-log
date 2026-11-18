// End-to-end test (run: node tests/e2e.js). Screenshots go to the OS temp folder.
// End-to-end test: real app files served over http://localhost (so the service
// worker runs), real Code.gs running against a mock Sheet, requests to the
// Apps Script URL intercepted and answered by that Code.gs.
const vm = require('vm'), fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(require('os').tmpdir(), 'seizure-log-e2e-');
const KEY = 'k'.repeat(10) + '0123456789abcdef0123456789abcdef';
const API = 'https://script.google.com/macros/s/TESTDEPLOY/exec';

/* ---------- mock Sheet + real Code.gs ---------- */
const COLS19 = ['id','when_local','at_ms','count','severity','duration_sec','description','location','triggers','warning_signs','improved_with','stopped_by_me','day_impact','day_impact_note','others_impact','others_impact_note','notes','created_ms','updated_ms','symptoms'];
const seededAt = Date.now() - 3 * 864e5;
const grid = [COLS19.slice(), ['seed-1', '', String(seededAt), '1', '2', '240', 'Imported entry', 'Home', 'Missed sleep', 'Aura | Nausea', 'Time passing', '', 'some', 'Lay down', 'none', '', '', String(seededAt), String(seededAt), '']];
const sheetObj = {
  getRange(r, c, nr = 1, nc = 1) {
    return {
      getValue: () => (grid[r-1] || [])[c-1] ?? '',
      getValues: () => { const o=[]; for(let i=0;i<nr;i++){ const row=[]; for(let j=0;j<nc;j++) row.push((grid[r-1+i]||[])[c-1+j] ?? ''); o.push(row);} return o; },
      setValues: function(v){ for(let i=0;i<nr;i++){ grid[r-1+i]=grid[r-1+i]||[]; for(let j=0;j<nc;j++) grid[r-1+i][c-1+j]=String(v[i][j]); } return this; },
      setNumberFormat(){ return this; }, setFontWeight(){ return this; }
    };
  },
  getMaxColumns: () => 26, insertColumnsAfter(){}, getLastRow: () => grid.length, deleteRow: r => { grid.splice(r-1, 1); }, setFrozenRows(){}
};
let activeUser = '';
const ctx = { console, JSON,
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheetObj, getUrl: () => 'https://docs.google.com/spreadsheets/d/TESTSHEET' }) },
  LockService: { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  Utilities: { getUuid: () => 'srv-' + Math.random().toString(36).slice(2, 10) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k === 'APP_KEY' ? KEY : null), setProperty(){} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
  Session: { getActiveUser: () => ({ getEmail: () => activeUser }), getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
  HtmlService: {}, Logger: { log(){} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8'), ctx);

// Owner guard checks (google.script.run path)
const guard = {};
try { ctx.api_list(); guard.anonymous = 'ALLOWED (bad)'; } catch (e) { guard.anonymous = 'refused'; }
activeUser = 'owner@example.com';
try { guard.owner = 'allowed, ' + ctx.api_list().length + ' rows'; } catch (e) { guard.owner = 'refused (bad): ' + e.message; }
// Stale save check: an older edit must not overwrite a newer one
const fresh = JSON.parse(JSON.stringify(ctx.listEntries_()[0]));
ctx.saveEntry_(Object.assign({}, fresh, { notes: 'newer', updated: seededAt + 2000 }));
const staleResult = ctx.saveEntry_(Object.assign({}, fresh, { notes: 'older', updated: seededAt + 1000 }));
guard.staleSave = staleResult.notes === 'newer' ? 'older edit ignored' : 'older edit WON (bad)';
ctx.saveEntry_(Object.assign({}, fresh, { notes: '', updated: seededAt + 3000 }));

let apiDown = false;
let apiCalls = 0;

/* ---------- static server for the app ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.md': 'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const BASE = 'http://localhost:' + server.address().port + '/';
  const b = await chromium.launch();
  const context = await b.newContext({ viewport: { width: 400, height: 860 }, serviceWorkers: 'allow' });
  const p = await context.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await context.route(API, async route => {
    apiCalls++;
    if (apiDown) return route.abort('internetdisconnected');
    const out = ctx.doPost({ postData: { contents: route.request().postData() } });
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: out.s });
  });
  const R = {};
  const sync = () => p.textContent('#sync-text');
  const wait = ms => p.waitForTimeout(ms);

  await p.goto(BASE);
  await p.evaluate(() => navigator.serviceWorker.ready);
  R.s1_notConnected = await sync();

  // A: saved before setup (device only)
  await p.click('.seg[data-sev="2"]');
  await p.click('#sec-what > summary');
  await p.click('#chips-symptoms .chip:nth-child(1)');
  await p.click('#btn-save'); await wait(200);
  R.s2_afterSaveNoSetup = await sync();

  // Setup: wrong key, then right key
  await p.click('.tabs a[data-view="setup"]');
  await p.fill('#cfg-url', API);
  await p.fill('#cfg-key', 'x'.repeat(40));
  await p.click('#btn-cfg-save'); await wait(300);
  R.s3_wrongKey = await p.textContent('#cfg-status');
  R.s3_configStored = await p.evaluate(() => localStorage.getItem('sl.config'));
  await p.fill('#cfg-key', KEY);
  await p.click('#btn-cfg-save'); await wait(600);
  R.s4_rightKey = await p.textContent('#cfg-status');
  R.s4_sync = await sync();
  R.s4_sheetRows = grid.length - 1;
  R.s4_deviceInfo = await p.textContent('#device-info');
  await p.screenshot({ path: OUT + 'pwa-setup-light.png' });

  // B: saved while the Sheet can't be reached
  apiDown = true;
  await p.click('.tabs a[data-view="log"]');
  await p.click('#when-quick .chip[data-off="60"]');
  await p.click('.seg[data-sev="1"]');
  await p.click('#btn-save'); await wait(400);
  R.s5_offlineSync = await sync();
  await p.click('.tabs a[data-view="history"]'); await wait(100);
  R.s5_pendingPills = await p.locator('.pill.pending').count();
  await p.screenshot({ path: OUT + 'pwa-history-pending.png' });

  // Draft survives a reload
  await p.click('.tabs a[data-view="log"]');
  await p.click('.seg[data-sev="3"]');
  await p.click('#sec-what > summary');
  await p.fill('#f-desc', 'Draft in progress');
  await wait(500);
  await p.reload(); await wait(500);
  R.s6_draftDesc = await p.inputValue('#f-desc');
  R.s6_draftSev = await p.getAttribute('.seg[data-sev="3"]', 'aria-pressed');
  R.s6_toast = await p.textContent('#toast');

  // Sheet back: Sync now sends B
  apiDown = false;
  await p.click('#btn-sync'); await wait(600);
  R.s7_sync = await sync();
  R.s7_sheetRows = grid.length - 1;

  // Save the draft as C; edit A; delete B
  await p.click('#btn-save'); await wait(500);
  R.s8_draftCleared = await p.evaluate(() => localStorage.getItem('sl.draft'));
  await p.click('.tabs a[data-view="history"]'); await wait(100);
  const descs = await p.$$eval('.entry .snip', n => n.map(x => x.textContent));
  R.s8_historyDescs = descs;
  // find entry with severity Mild (B) and the one with the symptom (A)
  const heads = p.locator('.entry-head');
  const n = await heads.count();
  let editedA = false, deletedB = false;
  for (let i = 0; i < n; i++) {
    const t = await heads.nth(i).textContent();
    if (!deletedB && /Mild/.test(t)) {
      await heads.nth(i).click();
      const body = p.locator('.entry-body:not([hidden])');
      await body.locator('text=Delete').click(); await body.locator('text=Tap again to delete').click();
      deletedB = true; await wait(500); break;
    }
  }
  const heads2 = p.locator('.entry-head');
  const n2 = await heads2.count();
  for (let i = 0; i < n2; i++) {
    const t = await heads2.nth(i).textContent();
    if (/Moderate/.test(t) && !/Imported/.test(t)) {
      await heads2.nth(i).click();
      await p.locator('.entry-body:not([hidden]) >> text=Edit').first().click();
      await p.click('#sec-notes > summary');
      await p.fill('#f-notes', 'Edited after sync');
      await p.click('#btn-save'); editedA = true; await wait(600); break;
    }
  }
  R.s9_editedA = editedA; R.s9_deletedB = deletedB;
  R.s9_sheet = grid.slice(1).map(r => [r[4], r[6], r[16], r[19]].join(' / '));
  R.s9_sync = await sync();

  // Fully offline: app must still open and save
  apiDown = true;
  await context.setOffline(true);
  await p.goto(BASE + '#log'); await wait(800);
  R.s10_offlineLoadTitle = await p.textContent('h1');
  R.s10_offlineEntries = await p.evaluate(() => JSON.parse(localStorage.getItem('sl.entries')).length);
  await p.click('.seg[data-sev="2"]');
  await p.click('#btn-save'); await wait(400);
  R.s10_sync = await sync();
  await p.screenshot({ path: OUT + 'pwa-offline-log.png' });
  apiDown = false;
  await context.setOffline(false);
  await wait(1200);
  R.s11_backOnline = await sync();
  R.s11_sheetRows = grid.length - 1;

  // Chip lists: remove, survive reload, restore, removing a selected chip deselects it
  await p.click('.tabs a[data-view="log"]');
  await p.click('#sec-what > summary');
  const symChips = () => p.$$eval('#chips-symptoms .chip', n => n.map(x => x.textContent));
  await p.click('#chips-symptoms .chip:has-text("Eye flashes")');            // select it first
  await p.click('#chips-symptoms .chip-tool:has-text("Edit list")');
  R.c1_editModeChips = (await symChips()).length;
  await p.click('#chips-symptoms .chip.removable:has-text("Headache")');
  await p.click('#chips-symptoms .chip.removable:has-text("Eye flashes")');
  await p.screenshot({ path: OUT + 'chips-edit.png' });
  await p.click('#chips-symptoms .chip-tool:has-text("Done")');
  R.c2_afterRemove = await symChips();
  R.c2_eyeFlashesDeselected = await p.evaluate(() => !document.querySelector('#chips-symptoms [aria-pressed="true"]'));
  await p.reload(); await wait(500);
  await p.click('#sec-what > summary');
  R.c3_afterReload = await symChips();
  await p.click('#chips-symptoms .chip-tool:has-text("Edit list")');
  await p.click('#chips-symptoms .chip-tool:has-text("Show removed")');
  await p.click('#chips-symptoms .chip.restorable:has-text("Headache")');
  await p.click('#chips-symptoms .chip-tool:has-text("Done")');
  R.c4_afterRestore = await symChips();
  // Adding a removed chip by typing brings it back
  await p.fill('#add-symptoms', 'eye flashes'); await p.press('#add-symptoms', 'Enter');
  R.c5_typedBack = await p.$$eval('#chips-symptoms .chip[aria-pressed="true"]', n => n.map(x => x.textContent));
  // History still shows a removed value on past entries (entry A had Nausea)
  await p.click('#chips-symptoms .chip-tool:has-text("Edit list")');
  await p.click('#chips-symptoms .chip.removable:has-text("Nausea")');
  await p.click('#chips-symptoms .chip-tool:has-text("Done")');
  await p.click('.tabs a[data-view="history"]'); await wait(100);
  R.c6_historyKeepsNausea = await p.evaluate(() => {
    const keys = JSON.parse(localStorage.getItem('sl.entries'));
    return keys.some(e => (e.symptoms || []).indexOf('Nausea') >= 0);
  });

  await p.emulateMedia({ colorScheme: 'dark' });
  await p.click('.tabs a[data-view="setup"]');
  await p.screenshot({ path: OUT + 'pwa-setup-dark.png' });
  R.overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  R.apiCalls = apiCalls;
  console.log(JSON.stringify({ guard, R, errs }, null, 1));
  await b.close(); server.close();

  const checks = [
    ['anonymous callers refused', guard.anonymous === 'refused'],
    ['owner allowed', /^allowed/.test(guard.owner)],
    ['older edit does not overwrite newer', guard.staleSave === 'older edit ignored'],
    ['wrong key not stored', R.s3_configStored === null],
    ['right key connects', /^Connected/.test(R.s4_rightKey)],
    ['entry saved before setup reaches the Sheet', R.s4_sheetRows === 2],
    ['unreachable Sheet leaves 1 change queued', /^1 change saved on this device/.test(R.s5_offlineSync) && R.s5_pendingPills === 1],
    ['draft restored after reload', R.s6_draftDesc === 'Draft in progress' && R.s6_draftSev === 'true'],
    ['queued change syncs', R.s7_sheetRows === 3 && /^All entries synced/.test(R.s7_sync)],
    ['draft cleared once saved', R.s8_draftCleared === null],
    ['edit and delete reach the Sheet', R.s9_editedA && R.s9_deletedB && R.s9_sheet.length === 3 && R.s9_sheet.some(r => /Edited after sync/.test(r))],
    ['app opens fully offline', R.s10_offlineLoadTitle === 'Seizure Log'],
    ['offline save syncs when back online', R.s11_sheetRows === 4 && /^All entries synced/.test(R.s11_backOnline)],
    ['chip edit mode shows the list', R.c1_editModeChips >= 12],
    ['removed chips leave the list', !R.c2_afterRemove.includes('Headache') && !R.c2_afterRemove.includes('Eye flashes')],
    ['removing a selected chip deselects it', R.c2_eyeFlashesDeselected === true],
    ['removed chips stay removed after reload', !R.c3_afterReload.includes('Headache')],
    ['restore puts a chip back', R.c4_afterRestore.includes('Headache')],
    ['typing a removed chip brings it back selected', R.c5_typedBack.includes('Eye flashes')],
    ['past entries keep removed values', R.c6_historyKeepsNausea === true],
    ['no horizontal overflow', R.overflow === false],
    ['no unexpected page errors', errs.every(e => /ERR_INTERNET_DISCONNECTED/.test(e))]
  ];
  let failed = 0;
  checks.forEach(([name, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; });
  console.log(failed ? failed + ' check(s) failed' : 'All ' + checks.length + ' checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
