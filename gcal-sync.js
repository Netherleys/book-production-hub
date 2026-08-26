/*
 * gcal-sync.js — Book Production Hub
 * Marcus Webb — Systems & Tools Administrator — 2026-08-26 (Round 34)
 *
 * ONE-WAY push of release-date info (Soft/Street/Print Date, per title) from
 * the Hub into David's real Google Calendar. Confirmed with David: push-only
 * (Hub -> Calendar). The Hub never reads events back from Calendar and never
 * lets a Calendar-side edit flow back into the Sheet — if David edits an
 * event directly in Calendar, that edit is simply overwritten on the next
 * sync. This was David's own explicit call (matches the earlier
 * recommendation given to him, avoiding sync-conflict risk).
 *
 * Target calendar: David's "Headpress" calendar, ID hardcoded below (his own
 * calendar ID, not a secret — same threat model as the Sheet IDs already
 * public in config.js: access is controlled entirely by Google's own
 * sharing/ACLs on that calendar, not by hiding this ID).
 *
 * Auth: reuses BookHubAuth (google-auth.js) exactly as app.js's Sheets calls
 * do — same in-memory-only access token, same ensureFreshToken()/retry
 * pattern. No new auth plumbing. The token now carries an additional scope
 * (calendar.events — see config.js GOOGLE_OAUTH_SCOPE) alongside the
 * existing spreadsheets scope, requested together in ONE consent. Anyone
 * who was already signed in under the old (Sheets-only) scope will hit a
 * fresh consent prompt the next time they sign in after this ships — GIS
 * has no way to silently widen a scope on an existing token. Expected, not
 * a bug — see the Round 34 delivery report.
 *
 * Idempotency (the part that makes one-way push safe to re-run):
 * Every event this app creates is tagged via extendedProperties.private
 * with { bookHubApp:'1', bookHubTitleId:<title id>, dateType:'soft'|
 * 'street'|'print' }. Each sync run:
 *   1. Lists every existing event on the target calendar carrying
 *      bookHubApp=1 (Calendar's privateExtendedProperty query param does
 *      this server-side — never falls back to matching on title text or
 *      date, both of which break the moment David renames a title or edits
 *      a date more than once).
 *   2. Builds the "desired" set from the Hub's current in-memory data
 *      (data.titles) — exactly the same soft/street/print resolution
 *      renderCalendar() already uses (see gcalTitleDateEntries below,
 *      deliberately mirroring app.js's calTitleDateEntries so the calendar
 *      view and the pushed events can never silently disagree).
 *   3. Diffs by the (titleId, dateType) key: missing -> insert, present but
 *      date/title changed -> update, no longer desired (date cleared, or
 *      the title itself was deleted from the Hub) -> delete.
 * Re-running the sync on unchanged data therefore does nothing (0 inserts/
 * updates/deletes) — verified via a scripted dry-run (fake in-memory
 * calendar standing in for the real Calendar API) exercising exactly this
 * insert -> re-sync-no-op -> single-date-change -> date-cleared -> title-
 * deleted sequence; see the delivery report for the result.
 *
 * Event title text uses the SOFT/STREET/PRINT full-word labels (matches
 * Mia Chen's Round 33 rename of the in-app calendar's date-type tags from
 * So/St/Pr abbreviations to full words — GCAL_TYPE_LABEL below is
 * independent of her CAL_TYPE_TAG constant in app.js, but intentionally
 * kept in the same words).
 *
 * Trigger: manual "Sync to Google Calendar" button in the in-app Calendar
 * view toolbar (see app.js renderCalendar()) — deliberately NOT automatic
 * on every date save. Reasoning (per the brief): gives David visibility and
 * control over exactly when his real calendar changes, avoids a silent/
 * surprise push while he's mid-edit on a date, and is the simpler, lower-
 * risk first version of this — an auto-sync-on-save mode can be added later
 * if David wants it once the manual version has proven itself.
 */
'use strict';

const GCAL_CALENDAR_ID = '4bc89a26e1c4fc16f1b9a60a631ebd09a3b5b74ca318530815537c0b31cdebe5@group.calendar.google.com'; // David's "Headpress" calendar
const GCAL_EVENTS_API = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(GCAL_CALENDAR_ID) + '/events';
const GCAL_LS_KEY = 'bookHub_gcalLastSync_v1'; // local-only nav aid (last sync time/summary shown in the toolbar) — same pattern as PRINTER_REQ_LS_PREFIX elsewhere in app.js, never synced anywhere

const GCAL_TYPE_LABEL = { soft: 'SOFT', street: 'STREET', print: 'PRINT' };

let gcalSyncing = false;

// ── date helpers (string-based, deliberately not Date-object based, to
// avoid the local-timezone off-by-one risk of new Date('YYYY-MM-DD') /
// .getDate() round-tripping — an all-day Calendar event only ever needs the
// plain Y-M-D string anyway) ──
function gcalNextDayStr(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

// Mirrors app.js calTitleDateEntries() exactly (same autoPrintDate
// resolution) but returns plain date strings, not Date objects, and only
// for titles/date-types with a non-empty value — see file header.
function gcalTitleDateEntries(t) {
  const d = t.dates;
  const pd = d.autoPrintDate ? calcAutoPrint(d.streetDate) : d.printDate;
  return [['soft', d.softDate], ['street', d.streetDate], ['print', pd]]
    .filter(([, ds]) => ds && /^\d{4}-\d{2}-\d{2}/.test(ds))
    .map(([type, ds]) => ({ type, dateStr: ds.slice(0, 10) }));
}

function gcalEventSummary(type, title) {
  return GCAL_TYPE_LABEL[type] + ': ' + title;
}

async function gcalFetch(method, path, body) {
  return withAuthRetry(async () => {
    const url = GCAL_EVENTS_API + path;
    const resp = await fetch(url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, await authHeaders()),
      body: body ? JSON.stringify(body) : undefined
    });
    if (resp.status === 401) throw new AuthExpiredError('Calendar ' + method + ' 401');
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error('Calendar ' + method + ' ' + resp.status + ': ' + errBody.slice(0, 300));
    }
    if (resp.status === 204) return null; // DELETE has no body
    return resp.json();
  });
}

// Lists every event this app has ever tagged on the target calendar
// (paginated — 250/page). Cheap single-flag server-side filter via
// privateExtendedProperty, so this never has to fetch/scan David's whole
// calendar.
async function gcalListTaggedEvents() {
  const out = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({
      privateExtendedProperty: 'bookHubApp=1',
      maxResults: '250',
      showDeleted: 'false',
      singleEvents: 'true'
    });
    if (pageToken) qs.set('pageToken', pageToken);
    const j = await gcalFetch('GET', '?' + qs.toString());
    (j.items || []).forEach(ev => out.push(ev));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

function gcalEventKey(ev) {
  const p = (ev.extendedProperties && ev.extendedProperties.private) || {};
  return p.bookHubTitleId + '::' + p.dateType;
}

/**
 * Runs one full sync pass: Hub (data.titles) -> target Calendar.
 * Returns { created, updated, deleted, unchanged, errors: [] }.
 */
async function gcalRunSync() {
  const result = { created: 0, updated: 0, deleted: 0, unchanged: 0, errors: [] };

  const existing = await gcalListTaggedEvents();
  const existingByKey = new Map();
  existing.forEach(ev => existingByKey.set(gcalEventKey(ev), ev));

  const desiredByKey = new Map(); // key -> {titleId, type, dateStr, title}
  (data.titles || []).forEach(t => {
    gcalTitleDateEntries(t).forEach(e => {
      desiredByKey.set(t.id + '::' + e.type, { titleId: t.id, type: e.type, dateStr: e.dateStr, title: t.title || '(untitled)' });
    });
  });

  // Insert / update
  for (const [key, want] of desiredByKey) {
    const ev = existingByKey.get(key);
    const summary = gcalEventSummary(want.type, want.title);
    const endStr = gcalNextDayStr(want.dateStr);
    const body = {
      summary,
      start: { date: want.dateStr },
      end: { date: endStr },
      extendedProperties: { private: { bookHubApp: '1', bookHubTitleId: want.titleId, dateType: want.type } }
    };
    try {
      if (!ev) {
        await gcalFetch('POST', '', body);
        result.created++;
      } else {
        const sameDate = ev.start && ev.start.date === want.dateStr;
        const sameSummary = ev.summary === summary;
        if (sameDate && sameSummary) {
          result.unchanged++;
        } else {
          await gcalFetch('PUT', '/' + encodeURIComponent(ev.id), body);
          result.updated++;
        }
        existingByKey.delete(key); // consumed — anything left in existingByKey after this loop is stale
      }
    } catch (e) {
      result.errors.push((ev ? 'Update' : 'Create') + ' failed for "' + summary + '" (' + want.dateStr + '): ' + e.message);
    }
  }

  // Whatever's left in existingByKey is no longer desired — date was
  // cleared in the Hub, or the title itself was deleted. Delete from
  // Calendar so the calendar never carries stale/orphaned release dates.
  for (const [, ev] of existingByKey) {
    try {
      await gcalFetch('DELETE', '/' + encodeURIComponent(ev.id));
      result.deleted++;
    } catch (e) {
      result.errors.push('Delete failed for event "' + (ev.summary || ev.id) + '": ' + e.message);
    }
  }

  return result;
}

function gcalSaveLastSyncNote(result) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(GCAL_LS_KEY, JSON.stringify({ at: new Date().toISOString(), result }));
  } catch (e) { /* best-effort only, never blocks the sync itself */ }
}
function gcalLoadLastSyncNote() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(GCAL_LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function gcalLastSyncLabel() {
  const note = gcalLoadLastSyncNote();
  if (!note || !note.at) return 'Never synced this session/device';
  const d = new Date(note.at);
  const timeStr = isNaN(d) ? note.at : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return 'Last synced: ' + timeStr;
}

// Called by the "Sync to Google Calendar" button in the Calendar view
// toolbar (see app.js renderCalendar()).
async function onGcalSyncClick() {
  if (gcalSyncing) return;
  const btn = document.getElementById('gcal-sync-btn');
  const statusEl = document.getElementById('gcal-sync-status');
  gcalSyncing = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  if (statusEl) statusEl.textContent = '';
  try {
    const result = await gcalRunSync();
    gcalSaveLastSyncNote(result);
    if (statusEl) statusEl.textContent = gcalLastSyncLabel();
    let msg = 'Google Calendar sync complete.\n\n' +
      'Created: ' + result.created + '\n' +
      'Updated: ' + result.updated + '\n' +
      'Deleted (date cleared / title removed): ' + result.deleted + '\n' +
      'Unchanged: ' + result.unchanged;
    if (result.errors.length) {
      msg += '\n\n' + result.errors.length + ' error(s):\n' + result.errors.slice(0, 10).join('\n');
    }
    alert(msg);
  } catch (e) {
    console.error(e);
    if (isAuthFailure(e)) {
      showReconnect('Calendar sync needs you to reconnect: ' + e.message);
    } else {
      alert('Google Calendar sync failed: ' + e.message);
    }
    if (statusEl) statusEl.textContent = 'Last sync failed — see error.';
  } finally {
    gcalSyncing = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Sync to Google Calendar'; }
  }
}
