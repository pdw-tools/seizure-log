/**
 * Seizure Log: Apps Script back end.
 *
 * Bound to a Google Sheet. Each seizure is one row on a sheet named "Seizures".
 * Two front ends use it:
 *   1. Index.html, served by doGet() to the owner only (google.script.run calls).
 *   2. The installable web app on GitHub Pages, which calls doPost() with a
 *      secret key. The key lives in this script's Script Properties, never in
 *      the GitHub repository.
 *
 * To create or replace the key, run createAppKey() from the editor and read the
 * key in the Execution log.
 */

var SHEET_NAME = 'Seizures';
var COLS = [
  'id', 'when_local', 'at_ms', 'count', 'severity', 'duration_sec', 'description', 'location',
  'triggers', 'warning_signs', 'improved_with', 'stopped_by_me',
  'day_impact', 'day_impact_note', 'others_impact', 'others_impact_note',
  'notes', 'created_ms', 'updated_ms', 'symptoms'
];
var SEP = ' | ';
var KEY_PROP = 'APP_KEY';

/* ---------------- web entry points ---------------- */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Seizure Log')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * JSON API for the installable web app.
 * Request body (sent as text/plain): {"key": "...", "action": "...", ...}
 * Response: {"ok": true, "data": ...} or {"ok": false, "error": "..."}
 */
function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var key = PropertiesService.getScriptProperties().getProperty(KEY_PROP);
    if (!key || typeof req.key !== 'string' || !sameText_(req.key, key)) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    switch (req.action) {
      case 'ping': return json_({ ok: true, data: { sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl() } });
      case 'list': return json_({ ok: true, data: listEntries_() });
      case 'save': return json_({ ok: true, data: saveEntry_(req.entry) });
      case 'remove': return json_({ ok: true, data: removeEntry_(req.id) });
      default: return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sameText_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Run from the editor to create (or replace) the key the web app uses. */
function createAppKey() {
  var key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(KEY_PROP, key);
  Logger.log('New app key (paste it into the app\'s Setup tab): ' + key);
  Logger.log('Any device using an older key will need this new one.');
}

/* ---------------- functions for Index.html (owner only) ---------------- */

// The API deployment is open to "Anyone" so the GitHub-hosted app can reach it.
// These google.script.run functions run as the owner, so they refuse anyone who
// is not signed in as the owner.
function requireOwner_() {
  var active = Session.getActiveUser().getEmail();
  var owner = Session.getEffectiveUser().getEmail();
  if (!active || active !== owner) throw new Error('Not allowed.');
}

function api_list() { requireOwner_(); return listEntries_(); }
function api_save(e) { requireOwner_(); return saveEntry_(e); }
function api_remove(id) { requireOwner_(); return removeEntry_(id); }
function api_info() { requireOwner_(); return { url: SpreadsheetApp.getActiveSpreadsheet().getUrl() }; }

/* ---------------- sheet storage ---------------- */

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.setFrozenRows(1);
  }
  // Make sure the sheet has room for every column and a complete header row.
  // This also upgrades a sheet created by an earlier version of this script.
  if (sh.getMaxColumns() < COLS.length) sh.insertColumnsAfter(sh.getMaxColumns(), COLS.length - sh.getMaxColumns());
  if (String(sh.getRange(1, COLS.length).getValue()) !== COLS[COLS.length - 1]) {
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
  }
  return sh;
}

function list_(arr) {
  return (arr || []).map(function (x) { return String(x).split(SEP).join(' / '); }).join(SEP);
}
function unlist_(s) {
  return s === '' || s == null ? [] : String(s).split(SEP).filter(function (x) { return x !== ''; });
}
function num_(v) { return v === '' || v == null ? null : Number(v); }

function toRow_(e) {
  var d = e.dayImpact || {}, o = e.othersImpact || {};
  return [
    e.id, e.local || '', e.at, e.count || 1, e.severity || '', e.duration == null ? '' : e.duration,
    e.description || '', e.location || '',
    list_(e.triggers), list_(e.precursors), list_(e.improved), e.stopped ? 'Yes' : '',
    d.level || '', d.note || '', o.level || '', o.note || '',
    e.notes || '', e.created || '', e.updated || '',
    list_(e.symptoms)
  ];
}

function fromRow_(r) {
  var dayLevel = r[12] || null, dayNote = r[13] || '';
  var othLevel = r[14] || null, othNote = r[15] || '';
  return {
    id: String(r[0]),
    at: Number(r[2]),
    count: Number(r[3]) || 1,
    severity: num_(r[4]),
    duration: num_(r[5]),
    description: String(r[6] || ''),
    location: String(r[7] || ''),
    triggers: unlist_(r[8]),
    precursors: unlist_(r[9]),
    improved: unlist_(r[10]),
    stopped: r[11] === 'Yes',
    dayImpact: (dayLevel || dayNote) ? { level: dayLevel, note: String(dayNote) } : null,
    othersImpact: (othLevel || othNote) ? { level: othLevel, note: String(othNote) } : null,
    notes: String(r[16] || ''),
    created: num_(r[17]),
    updated: num_(r[18]),
    symptoms: unlist_(r[19])
  };
}

function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function listEntries_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, COLS.length).getValues()
    .filter(function (r) { return r[0] !== '' && isFinite(Number(r[2])); })
    .map(fromRow_);
}

/**
 * Create or replace one entry. Returns the entry as stored.
 * If the sheet already holds a newer version of the same entry (edited on
 * another device), the older save is ignored and the newer one is returned.
 */
function saveEntry_(e) {
  if (!e || !isFinite(Number(e.at))) throw new Error('Missing date and time.');
  if (e.id != null && (typeof e.id !== 'string' || e.id.length > 100)) throw new Error('Bad id.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    e.id = e.id || Utilities.getUuid();
    var row = findRow_(sh, e.id);
    if (row > 0) {
      var current = sh.getRange(row, 1, 1, COLS.length).getValues()[0];
      var curUpdated = num_(current[18]);
      if (curUpdated != null && e.updated != null && curUpdated > Number(e.updated)) return fromRow_(current);
    } else {
      row = Math.max(sh.getLastRow(), 1) + 1;
    }
    var values = toRow_(e);
    // Plain-text cells so a note that starts with "=" is stored as text, not a formula.
    sh.getRange(row, 1, 1, COLS.length).setNumberFormat('@').setValues([values]);
    return fromRow_(values);
  } finally {
    lock.releaseLock();
  }
}

function removeEntry_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    var row = findRow_(sh, id);
    if (row > 0) sh.deleteRow(row);
    return true;
  } finally {
    lock.releaseLock();
  }
}
