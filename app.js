/*
 * app.js — Book Production Hub
 * Mia Chen — Frontend Developer / UI Engineer — 2026-07-10
 *
 * Ports the existing Headpress Hub UI (headpress.html, 2026-06-29) to the
 * new Google Sheets backend Marcus Webb provisioned (see
 * MARCUS_BookProductionHubInfra_2026-07-10.md). Same card grid / detail /
 * accordion / pipeline-strip / ISBN-manager UX; the data source underneath
 * is swapped from a local headpress-data.json file to the "Book Production
 * Titles" Google Sheet, read/written client-side via the Sheets REST API
 * using the access token BookHubAuth.getAccessToken() provides. No new
 * auth plumbing here — google-auth.js already does that.
 *
 * Column mapping is exact against the live Sheet's actual header row (read
 * directly from the Sheet on 2026-07-10, not guessed from the brief) — see
 * TITLE_COLS / ISBN_COLS below and the field-mapping notes in the build
 * report for every place the new schema doesn't map 1:1 onto the old
 * headpress-data.json shape.
 */
'use strict';

// ─── CONSTANTS ───
const APP_VER = '1.0.0';
const CFG = window.BOOK_HUB_CONFIG || {};
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';

// Exact column order of the "Titles" tab, row 1, as read from the live
// Sheet on 2026-07-10 (40 columns, A:AN). Keep this in lockstep with the
// Sheet — if Marcus/Fred ever add or reorder columns, this array (and the
// row<->object mapping functions below) need updating to match.
// 2026-07-26 (Mia Chen, UI revision pass): added 'blockId' (col 41/AO —
// existed live in the Sheet already for the Blocks-tab feature, but was
// never actually mapped here, so the app has silently never read/written it
// until now — needed for the new release-Block filter, item 4) and
// 'quickNotes_json' (col 42/AP — brand new column, added to the live Sheet
// this session for the new Quick Note capture feature, item 32). Read/write
// ranges below (sheetsGet/sheetsPut calls) were widened from AN to AP to
// match — the old AN-capped range silently truncated blockId even when it
// existed, which is part of why the Blocks filter was never buildable
// before now.
const TITLE_COLS = [
  'title_id','title','subtitle','author','authorLiaison','imprint','status',
  'planningSheet','releaseBlock','streetDate','softDate','printDate','printDateAutoCalc',
  'contract','isbn_pbk','isbn_hbk','isbn_ebk','isbn_pbk_backup','isbn_ebk_backup',
  'trim','pages','categoryUK','categoryUSA','nielsenNotified','keywords',
  'imagesFolderLink','workingFolderLink','coverThumbnailFile',
  'poTrackerIsbnKey','poTrackerTitleOverride','bookBiblePresent','lastUpdated',
  'price_json','production_json','publicity_json','editorial_json','authorInfo_json',
  'productionNotes_json','printerContacts_json','filesLinks_json',
  'blockId','quickNotes_json',
  // Round 10, items 1/2 — new column, appended at the end (same pattern
  // previous rounds used for imagesFolderLink etc.) so existing row
  // positions/columns are untouched. TRUE/FALSE string, see
  // applyStatusAutoRules() below for what it means.
  'statusAuto'
];
const TITLE_RANGE_LAST_COL = 'AQ'; // keep in lockstep with TITLE_COLS.length (43)
const ISBN_COLS = ['isbn','format','assignedToTitleId','assignedToTitleName','nielsenNotified','legacyArchived'];

// Pipeline stages, grouped for the reworked chained/boxed layout (items
// 25/26). Grouping + labels read directly from the row-blocking pattern in
// David's original "Book Planning 2025" Google Sheet (Team Inbox/_Bin,
// per-year tabs) — light/dark grey banding groups: Setup, Production,
// Payment, Marketing Detail, Contacts, Formats, Extras. That sheet has no
// exact "Overview" stage-group (dates/status live in their own Dates box
// here, not Pipeline), so the stage groups below start from its "Contract"
// row onward. No gap within a group (reads as one connected chain); a
// visible gap between groups, matching the blank spacer rows in that sheet.
const PIPELINE_GROUPS = [
  { label:'Setup', stages:['Contract','Publicity Statement'] },
  { label:'Production', stages:['Cover','Cover Templates','Manuscript','PerfectIt','Images','Proofing','Layout','Index'] },
  { label:'Payment', stages:['Author Payment','Author Copies'] },
  { label:'Marketing Detail', stages:['Info Turnaround','Info SCB','Product Page','Promo Film'] },
  { label:'Formats', stages:['Print Estimate','eBook','Audiobook'] },
  { label:'Extras', stages:['Amazon A+','PLS.ORG','Newsletter'] }
];
const PIPELINE_STAGES = PIPELINE_GROUPS.reduce((a,g)=>a.concat(g.stages),[]);
const PROD_CHECKLIST = [
  'Make copy of file before starting to edit','Change font to TNR or Arial',
  'Check headings (Navigation) with contents list','Remove empty spaces',
  'Run PerfectIt','MSWord AutoFormat',
  "Check direction of quote marks (‘40s etc)",'Em dashes','En dashes',
  'Make sure language is US or UK spelling','Spelling',
  'Tracking changes — turn off','Styles — check styles (Normal, etc)',
  'Affinity: Create character style for italics > find and replace',
  'Affinity: Create character style for bold > find and replace',
  'Apply paragraph styles after the above'];
const PRINTER_DEF = [
  {name:'LSI POD', email:''},
  {name:'Biddles UK', email:'estimating@biddles.co.uk'},
  {name:'Lakeside US', email:'nicholas.barrett@lakesidebook.com'},
  {name:'Sheridan US', email:'jameson.gibson@sheridan.com'},
  {name:'Frank Gaynor US', email:'fwgaynor@bookprinterswest.com'}];

// ─── STATE ───
// `blocks` added Round 4 — the live "Blocks" tab (sheetId 1400180106, same
// "Book Production Titles" Sheet), loaded once alongside titles/isbns (see
// loadAllData()/loadDevSampleData()) and read synchronously off this cache
// from here on, same pattern as `isbns`.
let data = { titles: [], isbns: [], blocks: [] };
// 2026-08-11: saveTimer (singular) removed — see saveTimers map + the
// debouncedSave()/flushPendingSave() comment block further down for why a
// single shared timer was the root cause of a real data-loss bug.
let view = 'titles', selectedId = null, syncStatus = 'none';
// Round 25 (2026-08-20, David request) — Progress Report popout window.
// isPopoutReport is true only in the SEPARATE browser window opened by
// openReportPopout() below (this same page, loaded again with
// ?popout=report on the URL) — never in the main Hub window. Read once at
// script-load time since the query string never changes over a page's
// lifetime. See init() (forces view='report' + adds the popout-mode body
// class that hides header/footer/nav chrome via CSS) and
// openReportPopout()/refreshPopoutReport() further down for the rest of
// this feature.
const isPopoutReport = new URLSearchParams(location.search).get('popout') === 'report';
// Round 14 (2026-08-12), item 2 — 'sort' added to the existing filters
// object (same session-only, in-memory pattern as every other filter key
// here — no persistence needed, this is a display-order control, not data).
// Default 'alpha': the All Titles view previously had no explicit sort at
// all, just data.titles' raw array order (== Sheet row order == creation
// order ascending, oldest-first, since confirmAddTitle() pushes new titles
// onto the end — see addTitle's _row comment). Alphabetical is the more
// useful default for a working list of this size, but 'recent' (below) gets
// David back to something close to the old implicit order if he wants it,
// just newest-first instead of oldest-first.
let accordionOpen = {}, filters = { status:'', imprint:'', search:'', block:'', printTiming:'', sort:'alpha' }, isbnFilter = 'all';
let isbnLocked = {}; // titleId -> {isbnPbk:bool, isbnHbk:bool, isbnEbk:bool} — true = locked (default). Item 18 lock mechanism, session-only by design (see build report).
// Round 22, item 1 — same lock mechanism, applied to Cover & Folder Links'
// three fields (coverThumbnailFile, imagesFolderLink, workingFolderLink).
// Session-only, same as isbnLocked above, but with a different DEFAULT: a
// field only starts locked once it actually holds a value (see
// linkLockRow()) — an empty field on a brand-new title has nothing to
// protect yet and needs to stay freely typeable without an extra unlock
// click first.
let linksLocked = {}; // titleId -> {coverThumbnailFile:bool, imagesFolderLink:bool, workingFolderLink:bool}
let qnOpen = false;
// Item 6 (Round 3) — Active/Archived toggle state for the Quick Notes list
// view. Session-only (not persisted) — always opens back on Active, same
// pattern as isbnFilter above.
let qnListMode = 'active';
let assignCtx = null;
let devMode = false; // true when previewing with sample data, no network writes
let poLogRowsCache = null; // lazy-loaded PO Log rows from the PO tracker sheet
let poTabGidCache = null; // tabName(lowercase) -> {gid, title}
// 2026-08-11 (Marcus Webb) — titleIds with an edit that hasn't been
// confirmed saved to the Sheet yet (scheduled in debouncedSave(), cleared
// only on a successful saveTitle()). Two jobs: (1) drives the automatic
// retry-all the moment a reconnect succeeds after an auth failure, so
// nothing typed during an expired-token window has to be re-typed; (2)
// gates the beforeunload warning so a reload/close can't silently discard
// unsaved edits without at least one confirmation prompt.
let pendingSaveTitleIds = new Set();
// Round 32 (2026-08-26, David request) — in-app Calendar. calYear/calMonth
// are the currently-displayed month (session-only, always opens on the real
// current month — see calToday()/init() below, no persistence needed).
let calYear = new Date().getFullYear(), calMonth = new Date().getMonth();
let calYearPrintStyleEl = null; // temp <style> injected only while printing the Year Overview — see printCalendarYear()

// ─── HELPERS (unchanged from headpress.html) ───
function esc(s){ if(s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// JSON-encode a string for safe use as the RHS of a JS assignment inside an
// HTML attribute (e.g. onerror="this.x=THIS"). JSON.stringify handles JS
// string-literal escaping (quotes, backslashes); we additionally
// HTML-entity-escape the resulting double quotes so they can't prematurely
// close the surrounding double-quoted HTML attribute — the browser decodes
// &quot; back to " before the JS ever runs, so the string comes through
// intact. Safe here because coverPhHtml() only emits esc()-escaped text.
function escAttrJson(s){ return JSON.stringify(s).replace(/"/g,'&quot;'); }
// Placeholder cover — same as the original app, plus a small folder
// indicator if an images folder link exists. Used both as the default (no
// coverThumbnailFile URL set) and as the onerror fallback if a set URL
// fails to load (expired/renamed file, host down, etc.) — see renderCard().
// 2026-07-26: imprint is no longer shown as text anywhere on the card (item
// 6 — colour-code instead, see .book-card[data-imprint] in index.html) —
// dropped the old .cover-ph-imprint text line from the placeholder.
function coverPhHtml(t){
  return `<div class="cover-ph"><div class="cover-ph-h">B</div><div class="cover-ph-title">${esc(t.title)}</div>${t.imagesFolderLink?'<div class="cover-ph-folder">&#128193; images linked</div>':''}</div>`;
}
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function getTitle(id){ return data.titles.find(t=>t.id===id)||null; }
function daysUntil(ds){ if(!ds) return null; const d=new Date(ds); if(isNaN(d)) return null; d.setHours(0,0,0,0); const t=new Date(); t.setHours(0,0,0,0); return Math.round((d-t)/86400000); }
function formatDate(ds){ if(!ds) return ''; const d=new Date(ds); if(isNaN(d)) return ds; return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
// Round 17 (2026-08-13, David request) — long-form date display for the
// Dates & Scheduling section (Soft/Street/Print Date): "5 November 2026"
// instead of the native date input's short numeric display (e.g.
// "05/11/2026"). Same {day:'numeric',month:'long',year:'numeric'} en-GB
// options already used for the "created" date in rtfFooterGroup()'s Word
// export footer — reused rather than inventing a second long-date
// convention. Display-only: underlying stored value/format (ISO
// yyyy-mm-dd, read/written via fc()/onStreetDateChange()) is untouched.
function formatDateLong(ds){ if(!ds) return ''; const d=new Date(ds); if(isNaN(d)) return ds; return d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}); }
// Keeps a Dates & Scheduling long-format overlay (see renderDates()) in
// sync with its paired native <input type="date">'s current value. Needed
// beyond the input's own onchange in two situations: (1) live-updating as
// the user types/picks, since onchange only fires on commit — wired via
// oninput; (2) the two places Print Date's value is set programmatically
// (onStreetDateChange()/onAutoPrint(), when auto-calculate is on), which
// don't fire input/change events on the element they assign to.
function syncDateDisplay(inputEl){
  if(!inputEl) return;
  const overlay=inputEl.parentElement && inputEl.parentElement.querySelector('.date-long-overlay');
  if(!overlay) return;
  const val=inputEl.value;
  overlay.textContent = val ? formatDateLong(val) : '';
  overlay.classList.toggle('is-empty', !val);
}
function calcAutoPrint(sd){ if(!sd) return ''; const d=new Date(sd); if(isNaN(d)) return ''; d.setDate(d.getDate()-60); return d.toISOString().slice(0,10); }
// Round 37 (2026-08-28) — numeric sort key for the new Street/Print/Soft
// date sort options (renderTitles()). Missing/unparseable dates return
// Infinity so they always sort to the end regardless of ascending/blank
// mix, rather than being coerced to 0/epoch and reading as "earliest".
function dateSortKey(ds){ if(!ds) return Infinity; const d=new Date(ds); return isNaN(d) ? Infinity : d.getTime(); }
// Item 7 (Round 2) — default "Not Started" colour changed from the old
// neutral grey to white per the brief (dots are now squares too, see
// index.html .detail-p-dot — a border was added there since a plain white
// square needs one to stay visible against the box's own background).
// Round 6, item 6 — reverted back to grey (#9AA5B1, the --neutral-dot token)
// so these summary dots match the actual Production Pipeline box's own
// "Not Started" stage colour (.stage-not-started, index.html) — David's ask
// was specifically for the two to be consistent with each other.
// Round 12, item 2d — 'Not Required' added; treated identically to
// 'Complete' (same sage dot colour), per the "both mean nothing outstanding"
// equivalence in the brief.
function dotColor(status){ if(status==='Complete'||status==='Not Required') return 'var(--sage)'; if(status==='In Progress') return 'var(--amber)'; return '#9AA5B1'; }
// 2026-07-26 bug fix (item 15): live Sheet data uses the literal string
// "Completed" for status (confirmed live — 5 titles), not "Complete" as the
// Add-Title dropdown writes — a pre-existing mismatch that meant already-
// finished titles fell through every status===Complete check (badge, dot
// colour, day-count) straight to the "not scheduled" default. Also
// confirmed live: 3 of those titles have the *literal string* "Completed"
// sitting in the printDate field itself (real data, not a hypothetical) —
// `new Date("Completed")` is an Invalid Date, so daysUntil() returned NaN,
// which is the exact "NaN days to print" bug reported. isPublished() below
// is the single source of truth used everywhere a status check happens now,
// so both the string-mismatch and the NaN-fallthrough are fixed at the root
// rather than patched at each call site.
// Round 27 (2026-08-21) — David's ask: Complete/Completed/Released were
// three literal strings meaning exactly the same "done" thing (this
// function already treated them as equivalent, see the item-15 history
// above), so the dropdown is consolidated down to one label. 'Complete' was
// picked over 'Completed'/'Released' for consistency with the per-stage
// status vocabulary (PIPELINE_STAGE_STATUSES below already uses 'Complete').
// normalizeStatus() (right below STATUS_VALUES) remaps any legacy literal
// still sitting in the Sheet the moment a row loads, so this check never
// needs to look for the old strings again — see that function for the
// self-healing migration.
function isPublished(t){ return t.status==='Complete'; }
// Round 27 — legacy-value remap, same self-healing pattern
// normalizePrintStatusOverride() (further down) already uses for its own
// old-literal-value cleanup: applied once, at load (rowToTitle), so any
// title still carrying the old 'Completed'/'Released' literal from before
// this round is silently corrected to the new canonical 'Complete' in
// memory — and the very next save (titleToRow always writes back whatever's
// currently in memory) rewrites the Sheet cell to match too, no separate
// one-off script/backfill needed.
function normalizeStatus(v){
  if(v==='Completed' || v==='Released') return 'Complete';
  return v;
}
// Round 9, item 1 — the values status can hold. Round 27 (2026-08-21):
// consolidated Complete/Completed/Released into a single 'Complete' value
// per David, and added 'On Hold/Cancelled' as a new distinct status (a
// title that's stalled/dead, not simply "not yet scheduled").
const STATUS_VALUES=['Not Scheduled','In Progress','Complete','On Hold/Cancelled'];
// Single source of truth for the badge/edit-control colour class, factored
// out of renderDetail() so the same logic backs both the read-only card
// badge and the new editable one (statusEditSelect below) — previously
// this was inlined once, in renderDetail only.
function statusBadgeClass(status){
  return isPublished({status}) ? 'badge-complete' : ({'In Progress':'badge-inprogress','Not Scheduled':'badge-notscheduled','On Hold/Cancelled':'badge-onhold'}[status]||'badge-notscheduled');
}
function toBool(v){ return v===true || v==='TRUE' || v==='true' || v===1 || v==='1'; }
function fromBool(v){ return v ? 'TRUE' : 'FALSE'; }
function safeJson(str, fallback){ if(!str) return fallback; try{ const p=JSON.parse(str); return p==null?fallback:p; }catch(e){ return fallback; } }

// ─── STATUS AUTO-DERIVATION (Round 10, items 1/2) ───
// t.statusAuto:true means Status is still under this app's automatic
// control — either untouched at the 'Not Scheduled' default, or advanced by
// one of the two rules below (never by a deliberate pick from the
// statusEditSelect dropdown). onStatusChange() sets this to false the
// instant David picks ANY value himself, forever — from that point on
// neither rule below is allowed to touch Status again for this title, no
// matter what the pipeline stages or Street Date do afterwards.
//
// Build note on wording: the brief asks for the auto value "In Production",
// which isn't one of STATUS_VALUES above (only Not Scheduled/In Progress/
// Complete/On Hold/Cancelled exist as of Round 27 — matching the Add Title
// modal and real Sheet data). Read this as shorthand for the existing "actively
// being worked on" state rather than a brand-new 6th status value/Sheet
// schema change, and mapped it onto 'In Progress' — already styled
// (badge-inprogress), already what the dropdown offers for exactly this
// meaning. Flagged in the build report; happy to add a genuinely distinct
// value instead if that's not what was meant.
function applyStatusAutoRules(t){
  if(t.statusAuto===false) return false;
  let changed=false;
  // Item 2 — Street Date passed: title counts as Complete/Published, full
  // stop. Checked ahead of item 1 so an already-released title can never be
  // left sitting on a stale auto-'In Progress' value. Reuses daysUntil() —
  // the same date-comparison helper computeDayInfo() (and the Progress
  // Report further down, Round 24) already use for this exact "has this
  // date passed" question — rather than a new one-off date parser.
  if(!isPublished(t)){
    const d=daysUntil(t.dates.streetDate);
    if(d!==null && d<0){ t.status='Complete'; changed=true; }
  }
  // Item 1 — any Production Pipeline stage moves off its own 'Not Started'
  // default: advance the still-untouched 'Not Scheduled' default forward.
  // Only fires from the exact untouched default value, so it can never fire
  // twice, and never fights whatever item 2 (above) may just have set.
  if(!changed && t.status==='Not Scheduled' && t.pipeline.stages.some(s=>s.status!=='Not Started')){
    t.status='In Progress'; changed=true;
  }
  return changed;
}

// ─── SHARED GROWABLE LISTS (item 4, Round 3 — generalised to also cover
// Release Block, added same round after David's live follow-up) ───
// Both Author Liaison/PR Contact (item 4) and Release Block (David's
// follow-up) share the exact same underlying problem: a value that used to
// be either hardcoded in source (Author Liaison's David/Jen/Other <select>)
// or free-typed with no master list at all (PR Contact; Release Block —
// "e.g. 2027 Q1" typed fresh per title, risking inconsistent naming, which
// is exactly what David flagged), where what's actually wanted is one
// shared, growable list David can add to over time, reused everywhere that
// value is picked. One generic named-list helper (getLocalList/
// addToLocalList) plus growableListSelectHtml() (the shared <select>-with-
// "+ Add new…" renderer) underlie both features.
//
// UPDATE — Round 4: Contacts stays on localStorage; Release Block moved to
// the live Sheet. Round 3's design decision below (still accurate for
// Contacts) flagged the per-device tradeoff plainly and named the exact
// follow-up if it ever mattered: "have Marcus add real Sheet tabs, then swap
// the get*/add* wrappers to read/write via sheetsGet/sheetsAppend." That
// follow-up landed this round for Release Block specifically — Marcus's
// research (MARCUS_BookProductionHub_MultiUserAccess_2026-07-27.md) found
// the Sheet tab already existed (`Blocks`, sheetId 1400180106, built by Fred
// 2026-07-11) as the real managed, user-growable list — see the dedicated
// RELEASE BLOCKS section below getContacts/addContactName for the swap.
// Contacts (Author Liaison/PR Contact) are UNTOUCHED this round — David
// hasn't confirmed those need the same fix, so they stay exactly as round 3
// shipped them, per-device tradeoff and all.
//
// DESIGN DECISION (Round 3, still current for Contacts only) — why
// localStorage, not a new Sheet tab/column (see build report for the full
// tradeoff writeup): every other shared/growable list this app reads (ISBN
// pool, PO Tracker) lives in a Sheet tab a human (Marcus, or David via Sheet
// share) provisioned ahead of time — and this codebase has already been
// bitten twice by shipping code that assumes a column/tab exists before it
// actually does (see the blockId/quickNotes_json comment above TITLE_COLS:
// blockId sat unread in the live Sheet for weeks because the column-mapping
// code was never updated to match it). Adding a real Sheet tab for Contacts
// would need it created live in the actual spreadsheet first — outside
// what this build can verify/guarantee lands before this code ships.
// localStorage has no such dependency: fully self-contained in what's
// shipped here, works immediately, David grows the list himself via "+ Add
// new…" inline, no separate admin step. The real tradeoff, flagged plainly:
// this list is per-browser/per-device, not synced like the Sheet-backed
// title data itself — a contact name David adds on his desktop won't
// automatically show up on his laptop. If cross-device sync turns out to
// matter for Contacts too, the same follow-up applies: have Marcus add a
// real Sheet tab, then swap getContacts/addContactName to sheetsGet/
// sheetsAppend — contactSelectHtml()/onContactSelect() would need no
// changes either way, same as the Release Block swap below didn't need to
// touch growableListSelectHtml() or releaseBlockSelectHtml()'s callers.
function getLocalList(storageKey, seedFn){
  try{
    const raw = (typeof localStorage!=='undefined') ? localStorage.getItem(storageKey) : null;
    if(raw){ const arr = JSON.parse(raw); if(Array.isArray(arr) && arr.length) return arr; }
  }catch(e){}
  return seedFn ? seedFn() : [];
}
function saveLocalList(storageKey, list){
  try{ if(typeof localStorage!=='undefined') localStorage.setItem(storageKey, JSON.stringify(list)); }catch(e){}
}
function addToLocalList(storageKey, name, seedFn){
  name=(name||'').trim(); if(!name) return null;
  const list=getLocalList(storageKey, seedFn);
  if(!list.some(n=>n.toLowerCase()===name.toLowerCase())){ list.push(name); saveLocalList(storageKey, list); }
  return name;
}
// Generic renderer: a <select> populated from `list`, plus a trailing
// "+ Add new…" option, used for both contacts and release blocks. If the
// field's current saved value isn't already in the list (legacy free-text
// data, or the old hardcoded "Other" option), it's added as an extra option
// at the top so nothing already saved is silently dropped from view.
// `list` accepts either a flat array of strings (value===label — what
// Contacts still passes) or an array of {value,label} objects (Round 4 —
// what Release Block now passes, since its stored/matched value is a
// block_id slug but the visible text is the human block_name from the
// Blocks tab). Normalised to {value,label} once here so no caller below
// needs to care which shape it was given.
function growableListSelectHtml(fieldId, currentVal, list, changeHandlerJs, addLabel){
  const opts=list.map(item=>(item && typeof item==='object')?item:{value:item,label:item});
  if(currentVal && !opts.some(o=>String(o.value).toLowerCase()===String(currentVal).toLowerCase())){
    // Legacy/orphaned value not (or not yet) in the managed list — still
    // shown so nothing already saved silently vanishes from view. No name
    // to look up for it, so it falls back to showing the raw value as its
    // own label.
    opts.unshift({value:currentVal,label:currentVal});
  }
  // If nothing's set yet, an explicit blank option is selected by default —
  // otherwise the <select> would silently render its first real option as
  // "selected" purely by HTML default, even though nothing was actually
  // chosen/saved for this title yet (t.blockId etc. would stay '' internally
  // until the user actually interacts with the dropdown).
  const blankOption = !currentVal ? `<option value="" selected>— none —</option>` : '';
  const optionsHtml=opts.map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(currentVal)?'selected':''}>${esc(o.label)}</option>`).join('');
  return `<select id="${fieldId}" onchange="${changeHandlerJs}">${blankOption}${optionsHtml}<option value="__add_new__">+ Add new ${esc(addLabel||'')}…</option></select>`;
}

const CONTACTS_LS_KEY = 'bookHub_contactList_v1';
function getContacts(){ return getLocalList(CONTACTS_LS_KEY, ()=>['David','Jen']); } // seed matches the previous hardcoded Author Liaison list
function addContactName(name){ return addToLocalList(CONTACTS_LS_KEY, name, ()=>['David','Jen']); }
// Shared field for both Author Liaison and PR Contact — path is the fc()
// dot-path to write to ('authorLiaison' or 'publicity.prContact').
function contactSelectHtml(fieldId,titleId,path,currentVal){
  return growableListSelectHtml(fieldId, currentVal, getContacts(), `onContactSelect('${titleId}','${path}',this)`, 'contact');
}
function onContactSelect(titleId,path,selectEl){
  if(selectEl.value==='__add_new__'){
    const name=window.prompt('Add a new contact name (shared across both Author Liaison and PR Contact):');
    if(name && name.trim()){ addContactName(name.trim()); fc(titleId,path,name.trim()); }
    // Full re-render either way: on success the option lists on BOTH
    // contact selects need the new name; on cancel, the <select> already
    // visually jumped to "__add_new__" and needs resetting back to the
    // field's real saved value.
    renderDetail();
    return;
  }
  fc(titleId,path,selectEl.value);
}

// ─── RELEASE BLOCKS (Round 4 — swapped from localStorage to the live
// "Blocks" tab, per Marcus Webb's research: MARCUS_BookProductionHub_
// MultiUserAccess_2026-07-27.md) ───
// The Blocks tab (sheetId 1400180106, columns block_id/block_name/
// sortOrder/notes, in the same "Book Production Titles" Sheet) already
// existed — built by Fred 2026-07-11 — as the real managed, user-growable
// list: David adds a row there directly and it exists, no code change
// needed, and it's naturally shared across every device/browser since it
// lives in the Sheet rather than one browser's localStorage. data.blocks is
// loaded once in loadAllData()/loadDevSampleData() (same pattern as
// data.isbns) — everything below reads that cache rather than re-fetching
// per render.
//
// RETARGET (same pass, per Marcus's correction): the dropdown's save path
// moves from `dates.releaseBlock` to `blockId`. Per the Sheet's own ReadMe
// (2026-07-11 addendum), `releaseBlock`/`planningSheet` are explicitly
// read-only migration provenance, not meant to be live-edited — `blockId`
// is the actual authoritative live field, already what the round-2 Block
// filter keys off (populateBlockFilter() below). titleToRow() still writes
// back whatever `dates.releaseBlock` value a title loaded with, unchanged —
// nothing edits or clears it, it just stops being the field this dropdown
// drives.
//
// FLAGGED, NOT SILENTLY HANDLED — migration/backfill edge case: a title can
// have a `dates.releaseBlock` value (e.g. "2027 Q1") but no `blockId` at
// all — the dev-preview sample title 'sample-1' is deliberately left in
// exactly this state below, unfixed, to exercise it. There's no reliable
// automatic mapping from old free-text values onto the 5 real block_ids
// (2025-h2/2026-h1/2026-h2/2027/not-yet-assigned) — "2027 Q1" could
// plausibly mean '2027' or a half-year bucket that doesn't cleanly exist,
// and guessing wrong silently would misfile a title. Titles in this state
// render with blockId's dropdown on "— none —" (same as never having been
// set) and fall into the existing "Unassigned" bucket in the Block filter,
// same as any other title with no blockId — nothing crashes or
// misrepresents data, but David/whoever owns this needs to actually pick
// the right block per title rather than have this code guess for them.
// Round 31 (2026-08-26) — BUG FIX (David report): this used to sort by raw
// sortOrder ascending, i.e. OLDEST first — the one place in the app that
// never got Round 21's newest-first ordering (see blockSortKey/
// sortBlocksNewestFirst above, and populateBlockFilter/renderManageBlocksList
// which both already used it). That's exactly why the per-title Release
// Block dropdown in Dates & Scheduling has been listing blocks in a
// different order than the Dashboard's Block filter and the Manage Release
// Blocks modal — three views of the same underlying data.blocks that must
// always agree, now all routed through the one shared comparator so they
// can't drift apart again.
function getReleaseBlocks(){
  return sortBlocksNewestFirst(data.blocks||[])
    .map(b=>({value:b.block_id, label:b.block_name}));
}
function slugifyBlockName(name){
  let s = String(name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  if(!s) s = 'block-'+Date.now();
  // De-dupe against existing block_ids — e.g. two differently-worded names
  // that happen to slugify the same, or the same name typo'd twice — rather
  // than silently colliding two different blocks onto one id.
  let candidate=s, n=2;
  const existing = new Set((data.blocks||[]).map(b=>b.block_id));
  while(existing.has(candidate)){ candidate = s+'-'+n; n++; }
  return candidate;
}
// Appends a new row to the live Blocks tab and updates the local cache
// immediately (optimistic — same pattern as ISBN assignment's
// `data.isbns.push(rec); saveIsbn(rec);` a few hundred lines down: update
// state synchronously so the UI reflects it at once, fire the Sheets write
// in the background). Returns the new block_id once the local state is
// updated (the caller doesn't need to wait on the network write to proceed,
// but this function is itself async so it CAN be awaited where useful, e.g.
// onReleaseBlockSelect below awaits it just long enough to get the id back).
async function addReleaseBlockName(name){
  name=(name||'').trim(); if(!name) return null;
  const existingMatch=(data.blocks||[]).find(b=>b.block_name.toLowerCase()===name.toLowerCase());
  if(existingMatch) return existingMatch.block_id;
  const block_id=slugifyBlockName(name);
  const sortOrder=Math.max(0,...(data.blocks||[]).map(b=>b.sortOrder||0))+1;
  data.blocks.push({block_id, block_name:name, sortOrder, notes:''});
  if(!devMode){
    try{
      await sheetsAppend(CFG.TITLES_SHEET_ID, 'Blocks', [block_id, name, sortOrder, '']);
    }catch(e){
      const auth = isAuthFailure(e);
      showReconnect('Adding release block failed to save to the Sheet: '+(auth?'signed out / token expired.':e.message)+' — the new block is visible locally this session but was NOT saved; a reload will lose it.'+(auth?' Click Reconnect, then re-pick it from the dropdown to save it.':''), auth);
      console.error(e);
    }
  }
  return block_id;
}
// 2026-08-20 round, item 1 — real reverse-chronological sort key for a
// release Block, derived from its NAME (not its block_id). Checked the real
// data before writing this (see mia_check_blocks_and_counts.py / Team Inbox
// report): the block_id was NOT a safe thing to parse a year/half out of —
// the 5 original blocks happen to use a clean 'YYYY-hN' id shape, but any
// block added later via the "+ Add new release block" flow gets its id
// generated by slugifyBlockName() from whatever free-text name David types
// (see slugifyBlockName above) — confirmed live, a real block already
// exists as block_id '2027-1-2-august-january' (name "2027 (1/2)
// August-January"). block_name is the one thing that reliably carries the
// "YYYY" or "YYYY (N/2)" convention David actually uses, so that's what
// this parses.
// Returns a single number that sorts higher = more recent (year*10 + half),
// or null for a name that isn't dated at all (e.g. "Not Yet Assigned") —
// callers put null-key blocks after every dated one rather than guessing
// where they chronologically belong.
function blockSortKey(blockName){
  const m = String(blockName||'').match(/^(\d{4})\s*(?:\((\d)\/\d\))?/);
  if(!m) return null;
  const year = Number(m[1]);
  // A bare "YYYY" (no "(N/2)" suffix) means "on the year-sheet, no half
  // chosen yet" (see the 2026-07-26 build notes on the original '2027'
  // block) — ranks just OLDER than either specific half of that same year,
  // since a still-unsplit year is less "resolved"/current than a title
  // that's already been placed in one of that year's real halves.
  const half = m[2] ? Number(m[2]) : 0;
  return year*10 + half;
}
// Shared comparator: newest-first by blockSortKey, dated blocks before
// undated ones, undated ones falling back to the Blocks tab's own
// sortOrder (stable, not just insertion order) so two undated blocks don't
// jump around release to release. Used by both populateBlockFilter (item 1)
// and renderManageBlocksList (item 4) so the two views of "all blocks" never
// disagree with each other on order.
function sortBlocksNewestFirst(blocks){
  return blocks.slice().sort((a,b)=>{
    const ka=blockSortKey(a.block_name), kb=blockSortKey(b.block_name);
    if(ka!==null && kb!==null) return kb-ka;
    if(ka!==null) return -1;
    if(kb!==null) return 1;
    return (a.sortOrder||0)-(b.sortOrder||0);
  });
}
function releaseBlockSelectHtml(fieldId,titleId,currentBlockId){
  return growableListSelectHtml(fieldId, currentBlockId, getReleaseBlocks(), `onReleaseBlockSelect('${titleId}',this)`, 'release block');
}
async function onReleaseBlockSelect(titleId,selectEl){
  if(selectEl.value==='__add_new__'){
    const name=window.prompt('Add a new release block (e.g. "2027 Q2"):');
    if(name && name.trim()){
      const blockId=await addReleaseBlockName(name.trim());
      if(blockId) fc(titleId,'blockId',blockId);
    }
    renderDetail();
    return;
  }
  fc(titleId,'blockId',selectEl.value);
}
// Auto-expanding textarea helper (items 20/22 — Content & Marketing/Author
// boxes read as a real word-processing surface, not a fixed scrollable
// frame). Works alongside the CSS field-sizing:content progressive
// enhancement in index.html — this JS version is what actually drives the
// behaviour in browsers that don't yet support field-sizing (Firefox/Safari
// at time of writing), so the effect is real everywhere, not just Chrome.
function autoGrow(el){ if(!el) return; el.style.height='auto'; el.style.height=(el.scrollHeight+2)+'px'; }
function autoGrowAll(root){ (root||document).querySelectorAll('textarea.autoexpand').forEach(autoGrow); }

// ─── SHEETS API ───
// 2026-08-11 (Marcus Webb) — token-expiry incident fix. Previously
// authHeaders() synchronously pulled whatever token happened to be cached
// and threw immediately if it had expired, with nothing upstream ever
// refreshing it — a session left open past ~1hr would then fail every save
// from that point on ("Save failed: Not signed in / token expired") until
// David manually reloaded the page, which also discarded any unsaved edits
// sitting only in the in-memory `data` object. See
// book_production_hub_save_failed_token_expired_2026-08-11 memory.
//
// Fix, two layers:
//  1. authHeaders() is now async and calls BookHubAuth.ensureFreshToken(),
//     which silently refreshes the token in the background if it's close
//     to expiry (google-auth.js also proactively keeps it warm on a timer,
//     so this should almost always be an instant no-op).
//  2. AuthExpiredError + withAuthRetry(): if a request still comes back
//     needing auth (ensureFreshToken() couldn't get a silent token, or the
//     API itself returns 401 — e.g. access was revoked externally),
//     sheetsGet/Put/Append make ONE more attempt after an explicit
//     BookHubAuth.reconnect() (still silent-first) before giving up. Only
//     if that also fails does the caller see an AuthExpiredError — at which
//     point saveTitle()/saveIsbn() show the reconnect banner, which now has
//     a real "Reconnect" button (see onReconnectClick) instead of just a
//     dismiss "x". Unsaved edits are never dropped by any of this — they
//     stay in the in-memory `data` object regardless of save outcome, and
//     pendingSaveTitleIds (below) drives an automatic retry-all the moment
//     reconnect succeeds.
class AuthExpiredError extends Error {}

async function authHeaders(){
  if(!window.BookHubAuth) throw new AuthExpiredError('Not signed in / token expired.');
  try{
    const tok = await window.BookHubAuth.ensureFreshToken();
    return { 'Authorization': 'Bearer '+tok };
  }catch(e){
    throw new AuthExpiredError('Not signed in / token expired.');
  }
}
function isAuthFailure(e){
  return e instanceof AuthExpiredError || /^Sheets (GET|PUT|APPEND) 401\b/.test(e && e.message || '');
}
// Wraps a single Sheets API attempt with one automatic reconnect-and-retry
// if it fails for an auth reason. Network/permission/other API errors
// (403 not-shared-with-you, 5xx, etc.) pass straight through unchanged —
// only auth failures get the retry, so this never masks a real problem.
async function withAuthRetry(fn){
  try{
    return await fn();
  }catch(e){
    if(!isAuthFailure(e)) throw e;
    await new Promise((resolve,reject)=>{
      if(!window.BookHubAuth) { reject(e); return; }
      window.BookHubAuth.reconnect(()=>resolve(), (err)=>reject(err||e));
    });
    return await fn(); // one retry only — a second failure bubbles up for real
  }
}
async function sheetsGet(spreadsheetId, range){
  return withAuthRetry(async ()=>{
    const url = SHEETS_API+spreadsheetId+'/values/'+encodeURIComponent(range);
    const resp = await fetch(url, { headers: await authHeaders() });
    if(resp.status===401) throw new AuthExpiredError('Sheets GET 401 on '+range);
    if(!resp.ok){
      const body = await resp.text().catch(()=>'');
      throw new Error('Sheets GET '+resp.status+' on '+range+': '+body.slice(0,300));
    }
    const j = await resp.json();
    return j.values || [];
  });
}
async function sheetsPut(spreadsheetId, range, rowValues){
  return withAuthRetry(async ()=>{
    const url = SHEETS_API+spreadsheetId+'/values/'+encodeURIComponent(range)+'?valueInputOption=USER_ENTERED';
    const resp = await fetch(url, { method:'PUT', headers: Object.assign({'Content-Type':'application/json'}, await authHeaders()), body: JSON.stringify({ values:[rowValues] }) });
    if(resp.status===401) throw new AuthExpiredError('Sheets PUT 401 on '+range);
    if(!resp.ok){
      const body = await resp.text().catch(()=>'');
      throw new Error('Sheets PUT '+resp.status+' on '+range+': '+body.slice(0,300));
    }
    return resp.json();
  });
}
async function sheetsAppend(spreadsheetId, sheetName, rowValues){
  return withAuthRetry(async ()=>{
    const range = sheetName+'!A1';
    const url = SHEETS_API+spreadsheetId+'/values/'+encodeURIComponent(range)+':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
    const resp = await fetch(url, { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, await authHeaders()), body: JSON.stringify({ values:[rowValues] }) });
    if(resp.status===401) throw new AuthExpiredError('Sheets APPEND 401 on '+sheetName);
    if(!resp.ok){
      const body = await resp.text().catch(()=>'');
      throw new Error('Sheets APPEND '+resp.status+' on '+sheetName+': '+body.slice(0,300));
    }
    const j = await resp.json();
    // updatedRange looks like "Titles!A17:AN17" — pull the row number out.
    const m = /![A-Z]+(\d+):/.exec((j.updates||{}).updatedRange||'');
    return m ? parseInt(m[1],10) : null;
  });
}
// Round 9, item 2 — real row delete, added for Delete Title. Checked every
// existing Sheets helper first (sheetsGet/Put/Append above, plus how ISBN
// pool saves and Blocks-tab appends work): none of them delete anything —
// this app had never needed to remove a row before, only read/write/append
// one. sheetsGet/Put/Append all address a sheet by NAME (e.g. 'Titles'),
// which is all the values API needs — but a genuine row delete has to go
// through spreadsheets.batchUpdate's deleteDimension request, which
// addresses sheets by their numeric gid, not name, so that has to be
// resolved first.
const _sheetGidCache = {};
// Round 31 (2026-08-26) — BUG FIX (David report: deleting the "2027" release
// block threw an error advising him to reconnect). Root cause traced here,
// NOT a real token-expiry/GIS timing issue: `headers: authHeaders()` was
// missing its `await` — authHeaders() is async, so this was handing fetch()
// a bare, still-pending Promise object as the headers value instead of the
// resolved `{Authorization: 'Bearer …'}` object. Object.assign/fetch see no
// enumerable Authorization property on a Promise, so the request went out
// with NO auth header at all, every single time — guaranteed 401 regardless
// of whether the actual token was fresh or stale. Every other Sheets helper
// (sheetsGet/Put/Append above) already did `await authHeaders()` correctly;
// this row-delete path (added later, Round 9) was the one place that didn't.
// Also now wrapped in withAuthRetry + throws AuthExpiredError on a genuine
// 401, same pattern as sheetsGet/Put/Append, so a REAL expired-token case
// gets the same one-shot silent-reconnect-and-retry those already get,
// instead of surfacing the reconnect banner on the very first attempt.
async function getSheetGid(spreadsheetId, sheetName){
  const key = spreadsheetId+'::'+sheetName;
  if(_sheetGidCache[key] !== undefined) return _sheetGidCache[key];
  return withAuthRetry(async ()=>{
    const url = SHEETS_API+spreadsheetId+'?fields='+encodeURIComponent('sheets.properties(sheetId,title)');
    const resp = await fetch(url, { headers: await authHeaders() });
    if(resp.status===401) throw new AuthExpiredError('Sheets metadata GET 401 on '+sheetName);
    if(!resp.ok){
      const body = await resp.text().catch(()=>'');
      throw new Error('Sheets metadata GET '+resp.status+': '+body.slice(0,300));
    }
    const j = await resp.json();
    const sheet = (j.sheets||[]).find(s=>s.properties && s.properties.title===sheetName);
    if(!sheet) throw new Error('Could not find a "'+sheetName+'" tab in the spreadsheet.');
    _sheetGidCache[key] = sheet.properties.sheetId;
    return sheet.properties.sheetId;
  });
}
// Physically removes ONE row via batchUpdate/deleteDimension — a real
// Sheets-side delete, not a client-side splice that reappears on reload and
// not a blank-out-the-cells soft-delete either: the row is actually gone,
// so the sheet doesn't accumulate dead rows every time a title is deleted.
// rowNumber1Based is the same 1-indexed sheet row already cached as
// t._row everywhere else (see saveTitle's Titles!A{row} range) — converted
// here to the API's 0-indexed, end-exclusive range.
//
// Known consequence, handled by the caller (deleteTitleConfirmed below):
// deleteDimension shifts every row BELOW the deleted one up by one. Any
// other title object already loaded this session has its _row cached from
// before the shift, so it's stale the instant this call succeeds — the
// caller re-runs loadAllData() straight after so every title's _row is
// recomputed against the sheet's new layout, rather than leaving other
// titles' next save silently writing to the wrong (shifted) row.
async function sheetsDeleteRow(spreadsheetId, sheetName, rowNumber1Based){
  const sheetId = await getSheetGid(spreadsheetId, sheetName);
  // Same missing-`await authHeaders()` bug as getSheetGid above, fixed the
  // same way — see that function's comment for the full root-cause trace.
  return withAuthRetry(async ()=>{
    const url = SHEETS_API+spreadsheetId+':batchUpdate';
    const body = { requests: [{ deleteDimension: { range: {
      sheetId, dimension: 'ROWS',
      startIndex: rowNumber1Based-1, // 0-indexed, inclusive
      endIndex: rowNumber1Based      // exclusive — removes exactly this one row
    } } }] };
    const resp = await fetch(url, { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, await authHeaders()), body: JSON.stringify(body) });
    if(resp.status===401) throw new AuthExpiredError('Sheets batchUpdate (delete row) 401 on '+sheetName);
    if(!resp.ok){
      const errBody = await resp.text().catch(()=>'');
      throw new Error('Sheets batchUpdate (delete row) '+resp.status+': '+errBody.slice(0,300));
    }
    return resp.json();
  });
}

// ─── TITLE ROW <-> OBJECT MAPPING ───
// Deliberate mapping/consolidation calls made porting the old
// headpress.html shape onto Marcus's new columns (documented in the build
// report — flagging the highlights inline too, since this is the part most
// likely to need a tweak once Fred's real data lands):
//  - `contract` (top-level scalar column) is a Sheets-side mirror of the
//    Pipeline section's "Contract" stage status, kept in sync on every
//    save — not independently editable in the UI, so it can never drift.
//  - `illustrations` / `illustrationCount` (present in the original app,
//    dropped from the new column list) are preserved as extra keys inside
//    productionNotes_json rather than silently lost.
//  - Content section's old onlineQuotes + printQuote1/2/3 (4 fields)
//    consolidate onto publicity_json.quotes (one array) — the new schema
//    only has one quotes list, so this is a UI simplification, not a data
//    loss; same for sellingPoints (now an array, edited as one
//    newline-separated textarea for UX continuity with the original app).
//  - amazonAPlus / plsOrg / newsletter / promoFilm status fields from the
//    original Publicity section are DROPPED as separate fields — they
//    already exist as Pipeline stages (Amazon A+, PLS.ORG, Newsletter,
//    Promo Film) in production_json, so keeping a second, disconnected
//    status field for the same thing would just invite drift. Use the
//    stage's own `notes` field for anything that needs a note against
//    Promo Film etc.
function rowToTitle(row){
  const c = {}; TITLE_COLS.forEach((k,i)=>c[k]=row[i]!==undefined?row[i]:'');
  const price = Object.assign({pbkGBP:'',pbkUSD:'',ebkUSD:'',hbkGBP:''}, safeJson(c.price_json, {}));
  const editorial = Object.assign({fullDescription:'',jacketBlurb:'',briefDescription:'',salesHandle:'',toc:'',excerpt:'',authorInsight:'',competingTitles:''}, safeJson(c.editorial_json, {}));
  const publicity = Object.assign({publicityStatement:'',prContact:'',marketing:'',targetAudience:'',quotes:[],sellingPoints:[]}, safeJson(c.publicity_json, {}));
  // Round 5, item 2 — contributorRole added to the existing authorInfo_json
  // blob (no new Sheet column — same "add a key to an existing JSON blob"
  // approach already used for illustrationsText/poManualNotes etc.). Default
  // 'Author(s)' matches every title's existing behaviour before this field
  // existed (name shown plain, no role prefix).
  const authorInfo = Object.assign({bio:'',hometown:'',socials:'',otherContributors:'',previousPublications:'',contributorRole:'Author(s)'}, safeJson(c.authorInfo_json, {}));
  // 2026-07-26 (item 19): illustrations is now one free-text field instead
  // of a bool+count pair — e.g. "black and white images: 10, colour images:
  // 20, posters and photographs". Migrated automatically from the old
  // illustrationCount on first load if illustrationsText was never set, so
  // existing data isn't silently blanked.
  // Round 11, item 4c (2026-08-11) — pagesBreakdown added the same way
  // illustrationsText was (item 19 above): a new key inside the existing
  // productionNotes_json blob, no new Sheet column needed. Free text only,
  // David's own reference notes (e.g. "front matter i-iv; body of book
  // 1-172") — never parsed/computed against anywhere else.
  // Round 27 (2026-08-21), item 3 — releaseNote added the same way
  // printStatusOverride/pagesBreakdown were before it: a new key inside the
  // existing productionNotes_json blob, no new Sheet column needed. Free
  // text David uses to capture why/what's happening when a title misses its
  // scheduled release date; conceptually a Dates & Scheduling field (see
  // t.dates.releaseNote below) even though, like printStatusOverride, it
  // physically lives in this JSON blob.
  // Round 28 (2026-08-26), item 3 — authorBookkeepingLink (new "Author
  // Bookkeeping" field in Cover & Folder Links) added the same no-new-
  // column way: a key inside this same productionNotes_json blob. A real
  // Sheet column (the imagesFolderLink/workingFolderLink pattern) was tried
  // first but the live "Book Production Titles" Sheet edit needed to add it
  // got blocked by the session's own permission guard mid-task (adding a
  // header cell to the live production schema reads as a real, confirmable
  // write) — flagged rather than forced through. This JSON-blob route sidesteps
  // that entirely (no Sheet schema touch at all, same mechanism already
  // proven safe by releaseNote/pagesBreakdown above) and is functionally
  // identical from the UI's perspective — conceptually a Cover & Folder
  // Links field (see t.authorBookkeepingLink below) even though, like
  // releaseNote, it physically lives in this blob rather than its own
  // column.
  const pn = Object.assign({checklist:[],proofingNotes:'',typesettingNotes:'',lsiNotes:'',scbEbookCover:'1400px on shortest side / RGB',printerEstimates:'',futureEditionNotes:'',printReadyFiles:'Not Ready',illustrations:false,illustrationCount:0,illustrationsText:'',poManualNotes:'',pagesBreakdown:'',printStatusOverride:'',releaseNote:'',authorBookkeepingLink:''}, safeJson(c.productionNotes_json, {}));
  let illustrationsText = pn.illustrationsText;
  if(!illustrationsText && pn.illustrations && pn.illustrationCount) illustrationsText = String(pn.illustrationCount)+' illustrations';
  let checklist = pn.checklist && pn.checklist.length ? pn.checklist.map(x=>({text:x.item||x.text||'',checked:!!x.checked})) : PROD_CHECKLIST.map(t=>({text:t,checked:false}));
  const pc = safeJson(c.printerContacts_json, {});
  let contacts = (pc.contacts && pc.contacts.length) ? pc.contacts.slice() : PRINTER_DEF.map(p=>Object.assign({},p));
  const filesLinks = Object.assign({links:[]}, safeJson(c.filesLinks_json, {}));
  // Item 6 (Round 3) — every note is normalised to always carry a stable
  // `id` and an `archived` flag the moment data loads, regardless of
  // whether it's a brand-new note (already gets both at creation, see
  // saveQuickNote()) or older data saved before this round existed. This
  // means archiveQuickNote()/restoreQuickNote() can always reference a note
  // reliably by id, and `!n.archived` reads as "active" for legacy notes
  // with no flag at all, with no separate migration step required.
  const quickNotes = (safeJson(c.quickNotes_json, []) || []).map(n=>({
    id: n.id || uid(), ts: n.ts, text: n.text, archived: !!n.archived, archivedTs: n.archivedTs||''
  }));
  let stagesRaw = safeJson(c.production_json, []);
  let stages = PIPELINE_STAGES.map(name=>{
    const found = (stagesRaw||[]).find(s=>s.stage===name || s.name===name);
    return found ? {name, status: found.status||'Not Started', expectedDate: found.expectedDate||'', notes: found.notes||''} : {name, status:'Not Started', expectedDate:'', notes:''};
  });
  return {
    id: c.title_id, _row: null,
    // 2026-09-02 incident guard: remember whether Title was genuinely
    // non-blank at load time. saveTitle() below refuses to persist a blank
    // Title over a row that had a real one, using this flag — see the long
    // comment on that guard for the full incident writeup ("Is This Real?"
    // lost Title/Subtitle/Author to an unidentified cause and the blank
    // state got silently written back to the Sheet on the very next save).
    _hadTitleOnLoad: !!(c.title||'').trim(),
    title: c.title||'', subtitle: c.subtitle||'', authors: c.author||'',
    authorLiaison: c.authorLiaison||'David', imprint: c.imprint||'Headpress', status: normalizeStatus(c.status||'Not Scheduled'),
    // Round 10, items 1/2 — statusAuto is a new column, so it's blank ('',
    // see rowToTitle's c[k]=row[i]!==undefined?row[i]:'' default above) on
    // every row until this app next saves it. Blank is read as "derive from
    // the current status value": still true (auto-eligible) if status is
    // literally the untouched 'Not Scheduled' default, false otherwise — so
    // real legacy titles that already carry a deliberately-set status (from
    // the old create-once Add Title modal, before per-title editing existed)
    // are never retroactively auto-managed, only ones genuinely still
    // sitting at default. Once this saves once, the real TRUE/FALSE string
    // takes over via toBool().
    statusAuto: c.statusAuto==='' ? (c.status||'Not Scheduled')==='Not Scheduled' : toBool(c.statusAuto),
    planningSheet: c.planningSheet||'', bookBiblePresent: toBool(c.bookBiblePresent), lastUpdated: c.lastUpdated||'',
    blockId: c.blockId||'',
    dates: { releaseBlock: c.releaseBlock||'', softDate: c.softDate||'', streetDate: c.streetDate||'', printDate: c.printDate||'', autoPrintDate: toBool(c.printDateAutoCalc), printStatusOverride: normalizePrintStatusOverride(pn.printStatusOverride||''), releaseNote: pn.releaseNote||'' },
    commercial: {
      isbnPbk: c.isbn_pbk||'', isbnHbk: c.isbn_hbk||'', isbnEbk: c.isbn_ebk||'',
      // Backup ISBN fields removed from the UI entirely (item 18 — see build
      // report for the lock-mechanism reasoning) but the *raw sheet values*
      // are preserved verbatim here and written straight back unmodified in
      // titleToRow — this is a UI removal, not a data-deletion, so nothing
      // already sitting in those two columns is lost.
      _backupIsbnPbkRaw: c.isbn_pbk_backup||'', _backupIsbnEbkRaw: c.isbn_ebk_backup||'',
      trimSize: c.trim||'', pages: c.pages||'', categoryUK: c.categoryUK||'', categoryUSA: c.categoryUSA||'',
      nielsenNotified: toBool(c.nielsenNotified),
      illustrationsText: illustrationsText||'',
      pagesBreakdown: pn.pagesBreakdown||''
    },
    price,
    content: { keywords: c.keywords||'', fullDescription: editorial.fullDescription, jacketBlurb: editorial.jacketBlurb, briefDescription: editorial.briefDescription, salesHandle: editorial.salesHandle, sellingPoints: (publicity.sellingPoints||[]).join('\n'), quotes: (publicity.quotes||[]).join('\n'), targetAudience: publicity.targetAudience },
    authorInfo: Object.assign({}, authorInfo),
    pipeline: { stages },
    print: { printEstimate: pn.printerEstimates, scbEbookCoverSpec: pn.scbEbookCover, forLsiNotes: pn.lsiNotes, printerContacts: contacts },
    publicity: { publicityStatement: publicity.publicityStatement, prContact: publicity.prContact, marketing: publicity.marketing },
    toc: { tableOfContents: editorial.toc, howICameToWriteThis: editorial.authorInsight, excerpt: editorial.excerpt, competingTitles: editorial.competingTitles },
    productionNotes: { checklist, proofingNotes: pn.proofingNotes, typesettingNotes: pn.typesettingNotes },
    futureEdition: { infoAndChanges: pn.futureEditionNotes, printReadyFilesStatus: pn.printReadyFiles },
    filesLinks: { links: filesLinks.links||[] },
    quickNotes,
    poManualNotes: pn.poManualNotes||'',
    imagesFolderLink: c.imagesFolderLink||'', workingFolderLink: c.workingFolderLink||'', coverThumbnailFile: c.coverThumbnailFile||'',
    authorBookkeepingLink: pn.authorBookkeepingLink||'',
    poTrackerIsbnKey: c.poTrackerIsbnKey||'', poTrackerTitleOverride: c.poTrackerTitleOverride||''
  };
}
function titleToRow(t){
  const price_json = JSON.stringify(t.price||{});
  const production_json = JSON.stringify(t.pipeline.stages.map(s=>({stage:s.name,status:s.status,expectedDate:s.expectedDate,notes:s.notes})));
  const publicity_json = JSON.stringify({
    publicityStatement: t.publicity.publicityStatement||'', prContact: t.publicity.prContact||'', marketing: t.publicity.marketing||'',
    targetAudience: t.content.targetAudience||'',
    quotes: (t.content.quotes||'').split('\n').map(s=>s.trim()).filter(Boolean),
    sellingPoints: (t.content.sellingPoints||'').split('\n').map(s=>s.trim()).filter(Boolean)
  });
  const editorial_json = JSON.stringify({
    fullDescription: t.content.fullDescription||'', jacketBlurb: t.content.jacketBlurb||'', briefDescription: t.content.briefDescription||'',
    salesHandle: t.content.salesHandle||'', toc: t.toc.tableOfContents||'', excerpt: t.toc.excerpt||'',
    authorInsight: t.toc.howICameToWriteThis||'', competingTitles: t.toc.competingTitles||''
  });
  const authorInfo_json = JSON.stringify(t.authorInfo||{});
  const productionNotes_json = JSON.stringify({
    checklist: (t.productionNotes.checklist||[]).map(c=>({item:c.text,checked:!!c.checked})),
    proofingNotes: t.productionNotes.proofingNotes||'', typesettingNotes: t.productionNotes.typesettingNotes||'',
    lsiNotes: t.print.forLsiNotes||'', scbEbookCover: t.print.scbEbookCoverSpec||'', printerEstimates: t.print.printEstimate||'',
    futureEditionNotes: t.futureEdition.infoAndChanges||'', printReadyFiles: t.futureEdition.printReadyFilesStatus||'Not Ready',
    illustrationsText: t.commercial.illustrationsText||'', poManualNotes: t.poManualNotes||'',
    pagesBreakdown: t.commercial.pagesBreakdown||'', printStatusOverride: t.dates.printStatusOverride||'',
    releaseNote: t.dates.releaseNote||'', authorBookkeepingLink: t.authorBookkeepingLink||''
  });
  const printerContacts_json = JSON.stringify({ contacts: t.print.printerContacts||[] });
  const filesLinks_json = JSON.stringify({ links: t.filesLinks.links||[] });
  const quickNotes_json = JSON.stringify(t.quickNotes||[]);
  const contractStage = t.pipeline.stages.find(s=>s.name==='Contract');
  const c = {
    title_id: t.id, title: t.title, subtitle: t.subtitle, author: t.authors, authorLiaison: t.authorLiaison,
    imprint: t.imprint, status: t.status, planningSheet: t.planningSheet||'',
    releaseBlock: t.dates.releaseBlock, streetDate: t.dates.streetDate, softDate: t.dates.softDate, printDate: t.dates.printDate,
    printDateAutoCalc: fromBool(t.dates.autoPrintDate),
    contract: contractStage ? contractStage.status : '',
    isbn_pbk: t.commercial.isbnPbk, isbn_hbk: t.commercial.isbnHbk, isbn_ebk: t.commercial.isbnEbk,
    isbn_pbk_backup: t.commercial._backupIsbnPbkRaw||'', isbn_ebk_backup: t.commercial._backupIsbnEbkRaw||'',
    trim: t.commercial.trimSize, pages: t.commercial.pages, categoryUK: t.commercial.categoryUK, categoryUSA: t.commercial.categoryUSA,
    nielsenNotified: fromBool(t.commercial.nielsenNotified), keywords: t.content.keywords,
    imagesFolderLink: t.imagesFolderLink, workingFolderLink: t.workingFolderLink, coverThumbnailFile: t.coverThumbnailFile,
    poTrackerIsbnKey: t.commercial.isbnPbk || t.commercial.isbnHbk || t.poTrackerIsbnKey || '',
    poTrackerTitleOverride: t.poTrackerTitleOverride||'',
    bookBiblePresent: fromBool(t.bookBiblePresent), lastUpdated: new Date().toISOString(),
    blockId: t.blockId||'',
    // Round 10, items 1/2 — persist statusAuto as a real TRUE/FALSE string
    // once this title has been through this app at all, so subsequent loads
    // stop having to guess from the status text (see rowToTitle above).
    statusAuto: fromBool(t.statusAuto),
    price_json, production_json, publicity_json, editorial_json, authorInfo_json,
    productionNotes_json, printerContacts_json, filesLinks_json, quickNotes_json
  };
  return TITLE_COLS.map(k=>c[k]!==undefined?c[k]:'');
}
function isbnRowToObj(row){
  const c = {}; ISBN_COLS.forEach((k,i)=>c[k]=row[i]!==undefined?row[i]:'');
  return { isbn:c.isbn||'', format:c.format||'', assignedToTitleId:c.assignedToTitleId||'', assignedToTitleName:c.assignedToTitleName||'', nielsenNotified: toBool(c.nielsenNotified), legacyArchived: toBool(c.legacyArchived), _row:null };
}
function isbnObjToRow(r){
  return [r.isbn, r.format||'', r.assignedToTitleId||'', r.assignedToTitleName||'', fromBool(r.nielsenNotified), fromBool(r.legacyArchived)];
}

// ─── DEFAULT NEW TITLE ───
// Round 7, item 5 — every new title now defaults its Cover Image URL to
// David's real branded "Awaiting Cover" placeholder (yellow bg, AWAITING
// COVER text) committed into this repo, instead of the old blank field that
// fell through to the generic "B" + title-text placeholder box. David can
// overwrite it with a real cover URL at any time via the same Cover Image
// URL field as always.
// Round 10, item 8 — repointed at David's own upload, covers/Awaiting Cover
// - 600.jpg (no leading underscore — he uploaded it himself directly via the
// GitHub website, confirmed live: verified 200 OK / correct byte size on both
// raw.githubusercontent.com and the Pages URL before wiring this in). The old
// covers/_awaiting-cover.jpg stays in the repo untouched, just no longer
// referenced as the default.
const DEFAULT_COVER_PLACEHOLDER='covers/Awaiting Cover - 600.jpg';
function defTitle(o={}){
  const base = {
    id: uid(), title:'', subtitle:'', authors:'', authorLiaison:'David', imprint:'Headpress', status:'Not Scheduled',
    // Round 10, items 1/2 — statusAuto:true means Status is still under this
    // app's automatic control (see applyStatusAutoRules() below); a brand
    // new title always starts here. Flips to false forever the instant
    // David picks a value himself via statusEditSelect/onStatusChange.
    statusAuto:true,
    planningSheet:'', bookBiblePresent:false, lastUpdated:'', blockId:'',
    dates:{releaseBlock:'',softDate:'',streetDate:'',printDate:'',autoPrintDate:false,printStatusOverride:'',releaseNote:''},
    commercial:{isbnPbk:'',isbnHbk:'',isbnEbk:'',_backupIsbnPbkRaw:'',_backupIsbnEbkRaw:'',trimSize:'',pages:'',categoryUK:'',categoryUSA:'',nielsenNotified:false,illustrationsText:'',pagesBreakdown:''},
    // Round 11, item 4a (2026-08-11) — pbkUSD kept in the data model (still
    // read/written round-trip) even though its UI field is gone — see the
    // long comment above renderCommercial()'s price rows for why: 9 of 26
    // live titles have real $-price data sitting in this exact key, so it's
    // preserved rather than dropped, same non-destructive precedent as
    // _backupIsbnPbkRaw/_backupIsbnEbkRaw just above.
    price:{pbkGBP:'',pbkUSD:'',ebkUSD:'',hbkGBP:''},
    content:{keywords:'',fullDescription:'',jacketBlurb:'',briefDescription:'',salesHandle:'',sellingPoints:'',quotes:'',targetAudience:''},
    authorInfo:{bio:'',hometown:'',socials:'',otherContributors:'',previousPublications:'',contributorRole:'Author(s)'},
    pipeline:{stages:PIPELINE_STAGES.map(n=>({name:n,status:'Not Started',expectedDate:'',notes:''}))},
    print:{printEstimate:'',scbEbookCoverSpec:'1400px on shortest side / RGB',forLsiNotes:'',printerContacts:PRINTER_DEF.map(p=>Object.assign({},p))},
    publicity:{publicityStatement:'',prContact:'',marketing:''},
    toc:{tableOfContents:'',howICameToWriteThis:'',excerpt:'',competingTitles:''},
    productionNotes:{checklist:PROD_CHECKLIST.map(t=>({text:t,checked:false})),proofingNotes:'',typesettingNotes:''},
    futureEdition:{infoAndChanges:'',printReadyFilesStatus:'Not Ready'},
    filesLinks:{links:[]},
    quickNotes:[], poManualNotes:'',
    imagesFolderLink:'', workingFolderLink:'', coverThumbnailFile:DEFAULT_COVER_PLACEHOLDER, authorBookkeepingLink:'', poTrackerIsbnKey:'', poTrackerTitleOverride:'',
    _row: null
  };
  return Object.assign({}, base, o);
}

// ─── DEV SAMPLE DATA (offline preview only — no sign-in, no network) ───
function loadDevSampleData(){
  devMode = true;
  data = { titles:[
    // Round 4 — 'sample-1' is deliberately left with a dates.releaseBlock
    // value ("2027 Q1") but NO blockId, on purpose: this is the exact
    // migration/backfill edge case flagged in the RELEASE BLOCKS comment
    // above (real live titles can be in this state) — kept unfixed here so
    // the dropdown's "— none —"/Unassigned fallback path actually gets
    // exercised by the smoke test, rather than silently guess-assigning it
    // to a blockId.
    defTitle({id:'sample-1', title:'Beyond Bone Tomahawk', subtitle:'On The Borders And The Brutality Of The Western', authors:'Rich Johnson', status:'In Progress', imprint:'Headpress',
      commercial:Object.assign({},defTitle().commercial,{isbnPbk:'978-1-915316-62-2', isbnEbk:'978-1-915316-63-9'}),
      dates:{releaseBlock:'2027 Q1',softDate:'',streetDate: new Date(Date.now()+45*86400000).toISOString().slice(0,10), printDate:'', autoPrintDate:true},
      imagesFolderLink:'https://onedrive.live.com/example-images-folder', workingFolderLink:'D:\\PROJECTS - BOOKS\\Book_Beyond Bone Tomahawk',
      content:Object.assign({},defTitle().content,{fullDescription:'Sample description for dev preview.'}),
      // Item 6 (Round 3) dev-preview fixtures — two active notes + one
      // already-archived note, so the Active/Archived toggle and the
      // grouped-checkbox behaviour both have something real to exercise
      // without needing a live Sheet.
      quickNotes:[
        {id:'qn-sample-1a', ts:new Date(Date.now()-2*86400000).toISOString(), text:'Chase Rich for the final author photo.', archived:false, archivedTs:''},
        {id:'qn-sample-1b', ts:new Date(Date.now()-1*86400000).toISOString(), text:'Confirm trim size with Marcus before print quote.', archived:false, archivedTs:''},
        {id:'qn-sample-1c', ts:new Date(Date.now()-6*86400000).toISOString(), text:'Old note — already dealt with.', archived:true, archivedTs:new Date(Date.now()-3*86400000).toISOString()}
      ]
    }),
    defTitle({id:'sample-2', title:'Sample Not Scheduled Title', authors:'Jane Author', status:'Not Scheduled', imprint:'Oil On Water Press'}), // Round 16 (2026-08-12) — was 'Oil and Water Press' (wrong name), fixed for consistency
    // Round 10, items 1/2 dev-preview fixture — status still auto-managed
    // (statusAuto:true, the defTitle() default, not overridden here) but its
    // Street Date is already 10 days in the past, so the normalisation pass
    // below (applyStatusAutoRules(), run once per title straight after this
    // data is built) should flip it to 'Complete' the moment dev preview
    // loads — exercises item 2 without needing to wait for a real calendar
    // date to pass.
    defTitle({id:'sample-3', title:'Sample Auto-Complete Title', authors:'Pat Editor', status:'In Progress', imprint:'Headpress',
      dates:{releaseBlock:'',softDate:'',streetDate:new Date(Date.now()-10*86400000).toISOString().slice(0,10), printDate:'', autoPrintDate:false}
    })
  ], isbns:[
    {isbn:'978-1-909394-11-7', format:'', assignedToTitleId:'', assignedToTitleName:'', nielsenNotified:false, legacyArchived:false, _row:null},
    {isbn:'978-1-909394-12-4', format:'PBK', assignedToTitleId:'', assignedToTitleName:'', nielsenNotified:false, legacyArchived:false, _row:null}
  ], blocks:[
    // Mirrors the real live "Blocks" tab exactly (Marcus Webb's research,
    // 2026-07-27) so dev preview exercises the same shape/values as
    // production, not an arbitrary stand-in set.
    {block_id:'2025-h2', block_name:'2025 (2/2) August-January', sortOrder:1, notes:'provenance note, per-title sourcing'},
    {block_id:'2026-h1', block_name:'2026 (1/2) February-July', sortOrder:2, notes:'provenance note'},
    {block_id:'2026-h2', block_name:'2026 (2/2) August-January', sortOrder:3, notes:'provenance note (incl. harmonised titles)'},
    {block_id:'2027', block_name:'2027', sortOrder:4, notes:'titles on the 2027 year-sheet, no half-year chosen yet'},
    {block_id:'not-yet-assigned', block_name:'Not Yet Assigned', sortOrder:999, notes:'titles genuinely unscheduled'}
  ]};
  // Round 10, item 2 — same load-time normalisation pass loadAllData() runs
  // on real data (see there); saveTitle() no-ops under devMode anyway, but
  // running it here too keeps dev preview's behaviour identical to live.
  data.titles.forEach(t=>{ applyStatusAutoRules(t); });
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('whoami').textContent = 'DEV PREVIEW — not saving';
  setSyncStatus('none');
  render();
}

// ─── AUTH / LOAD ───
function doSignIn(){
  const errEl = document.getElementById('auth-error');
  errEl.style.display = 'none';
  const btn = document.getElementById('auth-signin-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try{
    window.BookHubAuth.signIn(
      async () => {
        btn.disabled = false; btn.textContent = 'Sign in with Google';
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('whoami').textContent = 'Signed in';
        await loadAllData();
      },
      (err) => {
        btn.disabled = false; btn.textContent = 'Sign in with Google';
        errEl.style.display = 'block';
        errEl.textContent = 'Sign-in failed: ' + (err && err.message ? err.message : JSON.stringify(err));
      }
    );
  }catch(e){
    btn.disabled = false; btn.textContent = 'Sign in with Google';
    errEl.style.display = 'block';
    errEl.textContent = e.message;
  }
}
async function loadAllData(){
  setSyncStatus('saving'); // reused as "loading" visual — amber pulsing dot
  try{
    const titleRows = await sheetsGet(CFG.TITLES_SHEET_ID, 'Titles!A2:'+TITLE_RANGE_LAST_COL+'2000');
    const isbnRows = await sheetsGet(CFG.TITLES_SHEET_ID, 'ISBNs!A2:F2000');
    // Round 4 — Blocks tab (block_id/block_name/sortOrder/notes), loaded
    // once here alongside titles/isbns and read synchronously off
    // data.blocks from then on by getReleaseBlocks()/populateBlockFilter().
    const blockRows = await sheetsGet(CFG.TITLES_SHEET_ID, 'Blocks!A2:D200');
    data.titles = titleRows
      .filter(r => r[0] && r[0] !== 'EXAMPLE-DELETE-ME')
      .map((r,i) => { const t = rowToTitle(r); t._row = findRowIndex(titleRows, r) + 2; return t; });
    // Round 10, item 2 — Street Date is a calendar fact, not a user action,
    // so there's no click/onchange handler to hook it onto the way item 1
    // hooks into cycleStage(). Instead it's re-checked here, once per load
    // (covers the normal "David opens the app" case) — any title whose
    // Street Date has passed since it was last opened gets corrected and
    // saved back immediately, same non-override rule as everywhere else
    // (applyStatusAutoRules() no-ops instantly on any title David has
    // manually set Status on).
    data.titles.forEach(t=>{ if(applyStatusAutoRules(t)) saveTitle(t.id); });
    data.isbns = isbnRows.map((r,i) => { const o = isbnRowToObj(r); o._row = i+2; return o; });
    data.blocks = blockRows.filter(r=>r[0]).map(r=>({
      block_id: r[0]||'', block_name: r[1]||r[0]||'',
      sortOrder: (r[2]!==undefined && r[2]!=='') ? Number(r[2]) : 999,
      notes: r[3]||'',
      // 2026-08-20 round, item 4 — real Sheets-row delete for an empty block
      // (see "MANAGE RELEASE BLOCKS" section below) needs the same 1-indexed
      // sheet row every other delete path uses (t._row on titles, same
      // findRowIndex(...)+2 pattern as the titles map just above). Blocks
      // never needed this before today because nothing ever deleted a block.
      _row: findRowIndex(blockRows, r) + 2
    }));
    setSyncStatus('saved');
    document.getElementById('footer-sync-label').textContent = 'Connected — Book Production Titles';
    render();
  }catch(e){
    setSyncStatus('error');
    showReconnect('Could not load data: ' + e.message + ' — if this is a 403, ask David to share the Sheet with your Google account.');
    console.error(e);
  }
}
function findRowIndex(arr, item){ return arr.indexOf(item); }

// `authFailure` (default true) controls whether the banner's Reconnect
// button is shown — no point offering it for a non-auth error (e.g. a 403
// "not shared with you" or a genuine network outage) where retrying the
// same request will just fail the same way again.
function showReconnect(msg, authFailure){
  document.getElementById('reconnect-msg').textContent = msg;
  const btn = document.getElementById('reconnect-retry-btn');
  if(btn) btn.style.display = (authFailure===false) ? 'none' : '';
  document.getElementById('reconnect-banner').classList.remove('hidden');
}
function setSyncStatus(s){
  syncStatus = s;
  ['sync-dot','footer-sync-dot'].forEach(id=>{ const el=document.getElementById(id); if(el) el.className='sync-dot '+s; });
}

// ─── SAVE (debounced full-row rewrite, mirrors headpress.html's debounced-save pattern) ───
// 2026-08-11 (Marcus Webb, David's batch) — ROOT CAUSE FIX for the
// data-loss bug flagged the same day as the token-refresh incident: this
// used to key off ONE shared `saveTimer` variable for every title. Editing
// title A, then switching to title B within the 1s debounce window,
// cleared A's timer via clearTimeout(saveTimer) and replaced it with B's —
// A's edit stayed correct in memory (and in pendingSaveTitleIds) but its
// setTimeout callback had been silently cancelled, so saveTitle(A) would
// never actually run unless David happened to reopen title A later or a
// reconnect triggered retryPendingSaves(). That's a real, silent,
// indefinite loss — not just a delay. Fixed at the root by giving every
// title its OWN debounce timer (saveTimers, keyed by titleId) so switching
// titles can never cancel a different title's pending save again.
let saveTimers = {}; // titleId -> setTimeout id
function debouncedSave(titleId){
  if(devMode) return; // preview only, never writes
  pendingSaveTitleIds.add(titleId);
  clearTimeout(saveTimers[titleId]);
  saveTimers[titleId] = setTimeout(()=>{ delete saveTimers[titleId]; saveTitle(titleId); }, 1000);
}
// Belt-and-braces on top of the per-title-timer fix above: if the title
// David is actively navigating AWAY from still has a live, not-yet-fired
// debounce timer (i.e. he edited a field in the last <1s and is now
// switching titles/views before it would have fired on its own), save it
// immediately instead of waiting — so there's never a live pending edit
// sitting only in a timer that a stray reload/crash could still catch
// between now and 1s from now. Called from every gotoX() navigation
// function below. Safe to call on a title with nothing pending (no-op).
function flushPendingSave(titleId){
  if(!titleId) return;
  if(saveTimers[titleId]){
    clearTimeout(saveTimers[titleId]);
    delete saveTimers[titleId];
    saveTitle(titleId);
  }
}
async function saveTitle(titleId){
  if(devMode) return; // preview only, never writes — guarded here too since
                       // confirmAddTitle() calls saveTitle() directly rather
                       // than via the debounced path.
  const t = getTitle(titleId); if(!t) return;
  // 2026-09-02 incident guard — see _hadTitleOnLoad comment in rowToTitle().
  // "Is This Real?" had its Title/Subtitle/Author silently blanked in
  // memory (root cause not conclusively identified — a full-codebase search
  // found no keydown/keyup/keypress listener anywhere in this app that
  // touches these fields, so it was NOT a mis-scoped keyboard-shortcut
  // handler as first suspected; whatever cleared them did so outside this
  // app's own event-handling code) and the blank state was then persisted
  // to the Sheet on the very next debounced save, overwriting the real
  // values with no warning. Regardless of what clears it in memory, this
  // refuses to let that transition ever reach the Sheet again: a title that
  // loaded with a real Title never has that Title (or Subtitle/Author)
  // saved blank without a human explicitly re-confirming. This is a save-
  // path safety net, not a fix for whatever the original trigger was.
  if(t._row && t._hadTitleOnLoad && !((t.title||'').trim())){
    pendingSaveTitleIds.add(titleId); // keep flagged — this is NOT saved
    setSyncStatus('error');
    showReconnect('Save blocked for "'+(t.id||titleId)+'": Title (and possibly Subtitle/Author) would be saved BLANK, but this title had a real Title on load. Nothing was written to the Sheet — retype the Title to clear this warning and save normally. If you meant to blank it, edit it once more with the value you want, then it will save.', false);
    console.error('saveTitle: refused to persist blank Title over a previously-populated row for', titleId, t);
    return;
  }
  setSyncStatus('saving');
  try{
    const row = titleToRow(t);
    if(t._row){
      await sheetsPut(CFG.TITLES_SHEET_ID, 'Titles!A'+t._row+':'+TITLE_RANGE_LAST_COL+t._row, row);
    } else {
      const assignedRow = await sheetsAppend(CFG.TITLES_SHEET_ID, 'Titles', row);
      if(assignedRow) t._row = assignedRow;
    }
    pendingSaveTitleIds.delete(titleId);
    setSyncStatus('saved');
    document.getElementById('footer-last-saved').textContent = 'Saved '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }catch(e){
    // NOTE: titleId deliberately stays in pendingSaveTitleIds here — the
    // edit is safe in memory (t already holds it) and will be retried
    // automatically the moment reconnect succeeds (see onReconnectClick).
    setSyncStatus('error');
    const auth = isAuthFailure(e);
    showReconnect(
      auth
        ? 'Save failed: signed out / token expired. Your edits are kept — click Reconnect to sign back in and save them.'
        : 'Save failed: '+e.message,
      auth
    );
    console.error(e);
  }
}
async function saveIsbn(rec){
  if(devMode) return;
  try{
    const row = isbnObjToRow(rec);
    if(rec._row){
      await sheetsPut(CFG.TITLES_SHEET_ID, 'ISBNs!A'+rec._row+':F'+rec._row, row);
    } else {
      const assignedRow = await sheetsAppend(CFG.TITLES_SHEET_ID, 'ISBNs', row);
      if(assignedRow) rec._row = assignedRow;
    }
  }catch(e){
    const auth = isAuthFailure(e);
    showReconnect(auth ? 'ISBN save failed: signed out / token expired. Click Reconnect and try again.' : 'ISBN save failed: '+e.message, auth);
    console.error(e);
  }
}

// 2026-08-11 (Marcus Webb) — the reconnect banner's "Reconnect" button.
// Tries a silent reconnect first (no popup, works as long as David's
// underlying Google browser session is still alive — the common case);
// only falls back to the interactive "Sign in with Google" overlay if that
// genuinely fails. Either way, the moment we're signed in again, every
// title with an unsaved edit (pendingSaveTitleIds) gets its save retried
// automatically — David doesn't have to touch each field again.
function onReconnectClick(){
  const btn = document.getElementById('reconnect-retry-btn');
  if(btn){ btn.disabled = true; btn.textContent = 'Reconnecting…'; }
  window.BookHubAuth.reconnect(
    async () => {
      if(btn){ btn.disabled = false; btn.textContent = 'Reconnect'; }
      document.getElementById('reconnect-banner').classList.add('hidden');
      document.getElementById('whoami').textContent = 'Signed in';
      if(!data.titles.length && !data.blocks.length){
        await loadAllData(); // initial load itself failed — retry it now we're reconnected
      } else {
        await retryPendingSaves();
      }
    },
    () => {
      if(btn){ btn.disabled = false; btn.textContent = 'Reconnect'; }
      // Silent reconnect failed (e.g. the Google session itself is gone) —
      // surface the normal interactive sign-in overlay instead of forcing a
      // page reload, so pendingSaveTitleIds / in-memory edits survive.
      document.getElementById('reconnect-msg').textContent =
        'Could not reconnect silently — please sign in again below. Your unsaved edits are kept and will save automatically once you do.';
      const errEl = document.getElementById('auth-error');
      if(errEl){ errEl.style.display = 'none'; }
      document.getElementById('auth-overlay').classList.remove('hidden');
    }
  );
}
// Retries every title currently believed unsaved. Safe to call any time —
// saveTitle() no-ops harmlessly if a title is already gone/renamed, and
// re-saving a title that actually did succeed just writes the same row
// again (idempotent, no duplicate rows: sheetsPut/Append key off t._row).
async function retryPendingSaves(){
  const ids = Array.from(pendingSaveTitleIds);
  for(const id of ids){ await saveTitle(id); }
}
// Cheap last-resort safety net for the exact failure mode that caused the
// 2026-08-11 incident (David reloading/closing the tab while a save was
// still stuck failed, discarding in-memory-only edits): if anything is
// still unsaved, the browser shows its native "leave site?" confirmation.
window.addEventListener('beforeunload', function(e){
  if(pendingSaveTitleIds.size > 0){
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

// ─── SECTION STATUS / ATTENTION ───
function hasAttention(t){
  const now=new Date();now.setHours(0,0,0,0);
  if(t.pipeline.stages.some(s=>s.status==='In Progress'&&s.expectedDate&&new Date(s.expectedDate)<now))return true;
  // 2026-08-11 (item 3 follow-up) — same override-consistency fix as
  // getSectionStatus's 'dates' case just above: a card's red "needs
  // attention" dot is driven by this function, which used to compute the
  // print-date proximity fresh every time, blind to printStatusOverride —
  // so a title David explicitly marked "In Print" would still flash the
  // attention dot from a Print Date that's since passed. "Delayed / On
  // Hold" is the one override value that SHOULD still flag attention.
  if(t.dates.printStatusOverride) return t.dates.printStatusOverride==='Delayed/On Hold';
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  if(pd){const d=daysUntil(pd);if(d!==null&&d<=60&&!isPublished(t))return true;}
  return false;
}
// Round 38 (2026-08-28) — David: the red ribbon is a flat alarm colour with
// no urgency level shown, floated a "-60 days"-style countdown. Genuinely
// low-effort per the investigation: hasAttention() above already computes
// exactly the signal that decides whether the ribbon shows at all (overdue
// in-progress pipeline stage / Delayed-On-Hold override / print date within
// 60 days) — this just turns that same signal into a short display string,
// reusing computeDayInfo() (below) for the print-date branch instead of
// re-deriving day-math a third time. Mirrors hasAttention()'s exact
// precedence (stage-overdue checked first, then override, then print date)
// so the label can never disagree with whether the ribbon is showing.
// Format: literal negative-number countdown ("-60d") rejected in favour of
// "N DAYS" while approaching — reads as "how long you have", which is what
// a heads-up ribbon is for, vs. a negative number reading as "how far past
// zero" (backwards for a not-yet-due item). Once genuinely overdue, switches
// to "N DAYS LATE" (singular "1 DAY LATE") — keeps the approaching/overdue
// distinction David raised last round visible at a glance, not just implied
// by the ribbon already being red either way.
function attentionLabel(t){
  const now=new Date();now.setHours(0,0,0,0);
  const overdueDays = t.pipeline.stages
    .filter(s=>s.status==='In Progress'&&s.expectedDate&&new Date(s.expectedDate)<now)
    .map(s=>daysUntil(s.expectedDate))
    .filter(d=>d!==null);
  if(overdueDays.length){
    const n=Math.abs(Math.min(...overdueDays));
    return n+(n===1?' DAY LATE':' DAYS LATE');
  }
  if(t.dates.printStatusOverride==='Delayed/On Hold') return 'ON HOLD';
  const info=computeDayInfo(t);
  if(info.kind==='overdue'){ const n=Math.abs(info.days); return n+(n===1?' DAY LATE':' DAYS LATE'); }
  if(info.kind==='counting') return info.days+(info.days===1?' DAY':' DAYS');
  return 'ATTENTION'; // safety net only — hasAttention()'s own branches should make this unreachable
}
// 2026-07-26 (items 13/14/15) — single source of truth for the
// print-timing status shown on cards, detail view, and the new print-
// timing filter, so all three can never drift out of sync with each other.
//   kind: 'published' | 'nodate' | 'overdue' | 'counting'
//   colorClass: which of the 4 status colours to paint (published/overdue
//   share their kind's colour; 'counting' has 3 shade tiers — ok/notice/
//   due-soon — all deliberately short of the alarm red reserved for overdue)
// Round 11, item 3 (2026-08-11) — Print Status manual-override lock.
// INVESTIGATION FINDING (flagged in the build report, not guessed past):
// before this change, "Print Status" was NOT a manually-set field at all —
// there was no stored value for it anywhere; it was 100% computed fresh
// every render, purely from Print Date vs today (via this exact function),
// completely ignoring the overall Status field. That's the actual root
// cause of "gets stuck on OVERDUE even after I try to change it" — David
// was very likely changing the overall Status dropdown (expecting Print
// Status to follow), which this function never looked at, so a passed
// Print Date kept showing OVERDUE regardless of what Status said.
// Fix: a genuine manual override, same design pattern as the existing
// Status auto-derivation lock (statusAuto/applyStatusAutoRules above) —
// once David explicitly sets one of PRINT_STATUS_OVERRIDES via the new
// control in renderDates(), it sticks permanently (checked FIRST, ahead of
// even the Published/overdue auto-logic below) until he explicitly sets it
// back to "Auto (from Print Date)". Persisted as
// productionNotes_json.printStatusOverride (existing JSON-blob pattern, no
// new Sheet column — see illustrationsText/pagesBreakdown for precedent).
// NOTE: this is the sensible-fix-first attempt the brief asked for, not a
// confirmed exact match to David's mental model — flagged directly to him
// in the build report to confirm this is the state model he actually wants.
//
// Round 14 (2026-08-12) — David: "we seem to have a couple of options that
// effectively mean the same (In Print and Printed)" — collapsed the list to
// exactly 4: Auto (from Print Date) / In Print / Delayed/On Hold / Out of
// Print. 'Printed' is REMOVED as a selectable option (merged into 'In
// Print', per David's own framing that they mean the same thing); 'Delayed
// / On Hold' is renamed 'Delayed/On Hold' (no spaces, matching his exact
// wording) — same meaning, same colour, label only. 'Out of Print' is
// genuinely new (books that were printed but are no longer being kept in
// print), given its own neutral/muted colour rather than reusing red —
// deliberately not an "attention" state like overdue, just a settled one
// (see hasAttention()/getSectionStatus('dates') below, neither of which
// were told to treat it as urgent).
//
// Live-data safety check BEFORE this change (Marcus, 2026-08-12, direct
// Sheets API read of Titles!productionNotes_json across all 27 real rows):
// 25 rows Auto/blank, 2 rows already 'In Print', ZERO rows using 'Printed',
// ZERO rows using 'Delayed / On Hold'. So there was nothing live to
// migrate — but normalizePrintStatusOverride() below still defensively
// remaps both old values on load (not just at the point of writing this),
// in case a row is ever hand-edited in the Sheet with the old literal
// values later. No ambiguous/unmapped values found live.
function normalizePrintStatusOverride(v){
  if(v==='Printed') return 'In Print';
  if(v==='Delayed / On Hold') return 'Delayed/On Hold';
  return v;
}
const PRINT_STATUS_OVERRIDES = {
  'In Print': {colorClass:'ok'},
  'Delayed/On Hold': {colorClass:'notice'},
  'Out of Print': {colorClass:'neutral'}
};
function computeDayInfo(t){
  if(t.dates.printStatusOverride && PRINT_STATUS_OVERRIDES[t.dates.printStatusOverride]){
    return {kind:'manual', label:t.dates.printStatusOverride, colorClass:PRINT_STATUS_OVERRIDES[t.dates.printStatusOverride].colorClass};
  }
  if(isPublished(t)) return {kind:'published', label:'Published', colorClass:'published'};
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  if(pd){
    const d=daysUntil(pd);
    if(d===null){
      // pd string didn't parse as a real date (dirty legacy data, e.g. the
      // literal text "Completed" found live in 3 rows) — treat as no usable
      // print date rather than showing NaN (the item-15 bug, fixed at the
      // root rather than patched per-callsite).
    } else if(d<0){
      return {kind:'overdue', days:d, label:'Print date passed', colorClass:'overdue'};
    } else {
      const cls = d<=30?'due-soon':d<=90?'notice':'ok';
      return {kind:'counting', days:d, label:d+' days to print', colorClass:cls};
    }
  }
  if(t.dates.streetDate) return {kind:'nodate', label:'Street: '+formatDate(t.dates.streetDate), colorClass:'neutral', hasStreet:true};
  return {kind:'nodate', label:'Not scheduled', colorClass:'neutral'};
}
function getSectionStatus(t,key){
  switch(key){
    case 'commercial':return(t.commercial.isbnPbk&&t.commercial.isbnEbk)?'complete':'partial';
    case 'content':return(t.content.fullDescription&&t.content.jacketBlurb)?'complete':'partial';
    case 'author':return t.authorInfo.bio?'complete':'partial';
    case 'pipeline':{
      const now=new Date();now.setHours(0,0,0,0);
      if(t.pipeline.stages.some(s=>s.status==='In Progress'&&s.expectedDate&&new Date(s.expectedDate)<now))return 'overdue';
      // Round 12, item 2d — 'Not Required' counts as done here too, same
      // "nothing outstanding" equivalence as dotColor()/renderCard() above.
      return t.pipeline.stages.every(s=>s.status==='Complete'||s.status==='Not Required')?'complete':'partial';
    }
    case 'dates':{
      // 2026-08-11 (item 3 follow-up, caught in live testing) — this drives
      // the accordion header's coloured left-border stripe, and used to be a
      // second, separate "is the print date overdue" calculation living
      // completely apart from computeDayInfo() — so setting a Print Status
      // override (e.g. "In Print") updated the Print Status text itself but
      // left this stripe showing red/overdue regardless, a visible
      // contradiction confirmed live (dev-preview screenshot, same session).
      // Checked first, same override-wins priority as computeDayInfo().
      if(t.dates.printStatusOverride) return t.dates.printStatusOverride==='Delayed/On Hold' ? 'overdue' : 'complete';
      if(isPublished(t))return 'complete';
      if(!t.dates.streetDate)return 'partial';
      const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
      if(pd&&!isNaN(new Date(pd))&&new Date(pd)<new Date())return 'overdue';
      return 'complete';
    }
    case 'print':return t.print.printEstimate?'complete':'partial';
    case 'poTracker': return (t.commercial.isbnPbk||t.commercial.isbnHbk||t.poTrackerTitleOverride)?'complete':'partial';
    case 'publicity':return t.publicity.publicityStatement?'complete':'partial';
    case 'toc':return t.toc.tableOfContents?'complete':'partial';
    case 'productionNotes':return t.productionNotes.checklist.every(c=>c.checked)?'complete':'partial';
    case 'futureEdition':return t.futureEdition.printReadyFilesStatus==='Submitted'?'complete':'partial';
    default:return 'partial';
  }
}
// Section order — 7/26 (item 30): PO Tracker moved up from position 7 to
// position 2, right after Commercial, defaults open like Pipeline, made
// visually prominent (see .po-prominent) — "no longer buried". Files &
// Links removed entirely (item 31 — redundant with the top-of-page folder
// links row already added 2026-07-15, see renderLinksStrip()).
//
// Round 2 (items 20/21) — SUPERSEDES the 7/26 placement above: "wrong place
// for David's actual workflow" — PO Tracker moves from position 2 down to
// second-to-last (right before Info & Future Edition), with Future Edition
// bumped one further as the direct, mechanical consequence. Left its
// always-open + .po-prominent highlight behaviour untouched — the brief
// only asked for a REORDER, not a restyle, so it's still always-open and
// still gets the highlighted border, just later in the list now.
//
// NOTE on the literal numbers in the brief ("moves to position 11" /
// "becomes box 12"): with the new Key Contacts block (item 12) rendered
// as its own standalone, un-numbered block (not one of these accordion
// sections — see renderKeyContacts()), this list is still 11 keys long,
// so PO Tracker lands at 10 and Future Edition at 11, not literally
// "11"/"12". Rather than hand-forcing mismatched literal numbers (which
// would require either double-counting Key Contacts as a numbered section
// despite the brief calling it "standalone", or leaving a gap in the
// sequence), labels are now generated DYNAMICALLY from this array's actual
// order (below) so they can never go stale again regardless of future
// additions/reorders. Flagged for David in the build report as an open
// point, not silently decided.
// Item 1 (Round 3, David's live follow-up) — "Dates & Scheduling" moved from
// position 5 to position 1 (top of the list). Pure reorder of this one
// array — SECTION_LABELS below numbers itself dynamically off this order
// (round 2's fix, see the .forEach a few lines down), and the jump-nav
// sidebar/accordion both just iterate SECTION_KEYS in whatever order it's
// in — so nothing else needed touching to make this change.
const SECTION_KEYS = ['dates','commercial','content','author','pipeline','print','publicity','toc','productionNotes','poTracker','futureEdition'];
const SECTION_LABEL_TEXT = {commercial:'Commercial',poTracker:'PO Tracker / Print Estimates',content:'Content & Marketing',author:'Author',pipeline:'Production Pipeline',dates:'Dates & Scheduling',print:'Print & Distribution',publicity:'Publicity & Marketing',toc:'TOC / Excerpt / Insight',productionNotes:'Production Notes',futureEdition:'Info & Future Edition'};
const SECTION_LABELS = {};
SECTION_KEYS.forEach((k,i)=>{ SECTION_LABELS[k] = (i+1)+'. '+SECTION_LABEL_TEXT[k]; });
// Round 6, item 4 — REVERSES the rounds 1/2 instruction that Pipeline/PO
// Tracker stay pinned open, and drops the old "open unless this section's
// own data looks complete" default for every other section too. David's
// current, plainer wording ("some menus appear to have difficulty opening
// and closing," "default to all collapsed") is being taken at face value:
// every section, no exceptions, collapsible, closed by default the moment a
// title is opened. Thomas has already flagged the Pipeline/PO Tracker
// reversal to David directly — not re-flagging here, just building it.
// accordionOpen is still keyed per titleId-key and still only ever set by an
// explicit user click (toggleAccord below) — so once David actually opens a
// section this session, it stays open/closed exactly as he left it if he
// navigates away and back, same persistence as before. It just no longer
// starts pre-opened on a fresh view.
function isOpen(titleId,key){
  const k=`${titleId}-${key}`;
  if(accordionOpen.hasOwnProperty(k))return accordionOpen[k];
  return false;
}

// ─── RENDER ROUTING ───
function render(){
  document.getElementById('tab-titles').classList.toggle('active',view==='titles');
  document.getElementById('tab-isbns').classList.toggle('active',view==='isbns');
  const qnTab=document.getElementById('tab-quicknotes'); if(qnTab) qnTab.classList.toggle('active',view==='quicknotes');
  const rptTab=document.getElementById('tab-report'); if(rptTab) rptTab.classList.toggle('active',view==='report');
  const calTab=document.getElementById('tab-calendar'); if(calTab) calTab.classList.toggle('active',view==='calendar');
  // Round 15 (2026-08-12) — the old header search/filter row (#search-wrap)
  // moved into the new left-hand filter sidebar (see #filter-panel-wrap in
  // index.html, right after </header>). Same show-only-on-'titles' toggle
  // as before, just retargeted: 'contents' (not 'flex') because
  // #filter-panel-wrap's own two children (the drawer-toggle button + the
  // sidebar itself) need to stay true flex-siblings of #main inside
  // .layout-wrap for the flex layout/CSS sibling-selector (drawer toggle)
  // to work — display:contents makes the wrapper invisible to layout
  // without pulling it out of the DOM, so one line still shows/hides both.
  document.getElementById('filter-panel-wrap').style.display=view==='titles'?'contents':'none';
  document.getElementById('btn-add-title').style.display=view==='titles'?'inline-block':'none';
  const main=document.getElementById('main');
  main.className='main-'+view; // item 11/2 — width split by view (titles=full width, detail=slimmer, isbns=medium)
  // Item 6 (Round 2) — muted-green page background is scoped to the
  // detail/title view only (see body[data-view="detail"] in index.html);
  // every other view keeps the existing dark chrome.
  document.body.dataset.view = view;
  if(view==='titles'){ populateBlockFilter(); renderTitles(); }
  else if(view==='detail')renderDetail();
  else if(view==='isbns')renderISBNs();
  else if(view==='quicknotes')renderQuickNotesList();
  else if(view==='report')renderReport();
  else if(view==='calendar')renderCalendar();
  populateQuickNoteTitles();
  // Round 20 (2026-08-19) — header dropdown lives outside #main (it's part
  // of the persistent #app-header, never touched by the innerHTML swaps
  // above), so it needs its own explicit refresh here rather than picking
  // up changes "for free" the way the per-view content does.
  renderRecentlyViewed();
  // Items 1/2 (Round 2) — header is no longer a fixed height (see
  // #app-header in index.html), so its real rendered height is re-measured
  // on every render and synced into --hh, which body padding-top and
  // everything else keyed to --hh reads from. Round 15 (2026-08-12): the
  // filter row that used to live in the header (and could wrap to extra
  // rows, changing the header's real height between views) has moved out
  // to the new sidebar — the header is now just logo+nav+actions on every
  // view, so its height is effectively constant now. Left this re-measure
  // in place regardless (harmless, still correct if the header ever wraps
  // for some other reason, e.g. a narrow window squeezing the nav tabs).
  syncHeaderHeight();
}
// 2026-08-11 — every navigation-away path flushes the CURRENTLY selected
// title's pending debounce first (see flushPendingSave() above). selectedId
// is only ever meaningfully "active" while view==='detail', so this is a
// safe no-op the rest of the time (flushPendingSave() itself no-ops if
// there's nothing pending or titleId is null).
function gotoTitles(){flushPendingSave(selectedId);view='titles';selectedId=null;render();}
function gotoISBNs(){flushPendingSave(selectedId);view='isbns';render();}
function gotoReport(){flushPendingSave(selectedId);view='report';render();}
function gotoDetail(id){if(selectedId&&selectedId!==id)flushPendingSave(selectedId);view='detail';selectedId=id;render();}
function gotoQuickNotesList(){flushPendingSave(selectedId);view='quicknotes';render();}
function gotoCalendar(){flushPendingSave(selectedId);view='calendar';render();}
// Item 1 (Round 2) — see render()'s comment above for why this exists.
// Measured on a rAF tick so it runs after the browser has actually laid
// out the just-injected HTML (offsetHeight would still read the PREVIOUS
// layout if measured synchronously in the same tick as the innerHTML swap
// in some edge cases, e.g. font loading reflow) — rAF is enough of a
// nudge to be reliably accurate without adding a real delay.
function syncHeaderHeight(){
  requestAnimationFrame(()=>{
    const header=document.getElementById('app-header');
    if(!header)return;
    const h=Math.round(header.getBoundingClientRect().height);
    if(h>0) document.documentElement.style.setProperty('--hh', h+'px');
  });
}
window.addEventListener('resize', syncHeaderHeight);

// Item 4 — release-Block filter. Populated from the distinct blockId values
// actually present on titles, grouping under "Unassigned" for titles with no
// block at all — deliberately surfaced rather than hidden, since that's a
// real known gap.
// Round 4 update: display labels now come from data.blocks (the live Blocks
// tab, loaded once in loadAllData()/loadDevSampleData() — see the RELEASE
// BLOCKS section above) instead of falling back to each title's own
// dates.releaseBlock text. That fallback made sense when nothing else was
// loaded client-side, but now that the dropdown writes blockId instead of
// dates.releaseBlock (this round's retarget), releaseBlock stops being kept
// current for anything edited going forward — so leaning on it here would
// have made filter labels silently drift stale/wrong. block_name from the
// Blocks tab is the actual live source of truth; dates.releaseBlock is only
// still used as a last-resort fallback for a blockId that (for whatever
// reason) isn't found in data.blocks, so nothing renders blank.
function populateBlockFilter(){
  const sel=document.getElementById('filter-block');if(!sel)return;
  const cur=filters.block;
  const blockNameById={}; (data.blocks||[]).forEach(b=>{ blockNameById[b.block_id]=b.block_name; });
  const blocks=new Map(); // blockId -> display label
  data.titles.forEach(t=>{
    if(t.blockId) blocks.set(t.blockId, blockNameById[t.blockId]||t.dates.releaseBlock||t.blockId);
  });
  const hasUnassigned = data.titles.some(t=>!t.blockId);
  // Item 2 — "All Blocks" renamed "All Books" (label text only, same
  // value="" clears-the-filter behaviour).
  let html='<option value="">All Books</option>';
  // Item 1 — real reverse-chronological order (see blockSortKey/
  // sortBlocksNewestFirst above), replacing the old Array.from(...).sort()
  // plain string sort, which only ever read oldest-first by a coincidence
  // that already broke live (see blockSortKey's comment).
  const optionBlocks = Array.from(blocks.keys()).map(bid=>({block_id:bid, block_name:blocks.get(bid), sortOrder:(data.blocks||[]).find(b=>b.block_id===bid)?.sortOrder||0}));
  sortBlocksNewestFirst(optionBlocks).forEach(b=>{ html+=`<option value="${esc(b.block_id)}" ${cur===b.block_id?'selected':''}>${esc(b.block_name)}</option>`; });
  if(hasUnassigned) html+=`<option value="__unassigned__" ${cur==='__unassigned__'?'selected':''}>Unassigned</option>`;
  sel.innerHTML=html;
}
// Item 3 — visible on-page readout of the current Block filter, live-updated
// (renderTitles() calls this on every render, including every filter
// change) since the selected text otherwise only shows inside the closed
// dropdown itself. Deliberately returns '' (renders nothing) for the "All
// Books" default — David's own call was "probably shouldn't show anything…
// or something neutral" for that state; showing nothing keeps the grid top
// clean when nothing is actually filtered, rather than a label that always
// reads e.g. "Showing: All Books".
function activeBlockFilterHtml(){
  if(!filters.block) return '';
  let label;
  if(filters.block==='__unassigned__'){
    label='Unassigned';
  }else{
    const b=(data.blocks||[]).find(x=>x.block_id===filters.block);
    label = b ? b.block_name : filters.block;
  }
  return `<div class="active-filter-label">Showing: <strong>${esc(label)}</strong></div>`;
}

// ─── TITLES VIEW ───
function renderTitles(){
  let titles=data.titles.filter(t=>{
    if(filters.status&&t.status!==filters.status)return false;
    // Round 16 (2026-08-12) — BUG FIX. This used to be a raw strict-equality
    // check (t.imprint!==filters.imprint) against whatever literal text the
    // filter dropdown's selected <option value> holds. Confirmed live
    // (direct Sheets API read of Titles!imprint): 26 rows are literally
    // 'Headpress', but the one real Oil On Water Press title ("Song Over
    // the Bones", row 19) is stored as the short code 'OOWP' — NOT any
    // spelled-out variant. So selecting "Oil On Water Press"/"Oil and Water
    // Press" in the filter could never have matched that row by raw string
    // equality regardless of which spelling the dropdown used — David's
    // reported bug ("Oil On Water Press filter finds nothing") reproduces
    // with either spelling, confirmed before touching anything. The wrong
    // "and" spelling (see imprintEditSelect()/Add Title modal below, also
    // fixed this round) was a real, separate mislabeling, but fixing the
    // words alone would NOT have fixed this filter — it would still be
    // comparing full text against the raw 'OOWP' short code and still find
    // nothing. Real fix: compare through imprintKey(), the same
    // normalisation helper the card accent colour/imprint dot/edit-select
    // "selected" state already use elsewhere in this file specifically
    // because the raw Sheet data is inconsistent ('OOWP' vs a full name) —
    // this is the ONE place that was still doing a raw comparison instead.
    if(filters.imprint&&imprintKey(t.imprint)!==imprintKey(filters.imprint))return false;
    if(filters.block){
      if(filters.block==='__unassigned__'){ if(t.blockId)return false; }
      else if(t.blockId!==filters.block)return false;
    }
    if(filters.printTiming){
      const info=computeDayInfo(t);
      const map={notscheduled:'nodate',duesoon:'counting',overdue:'overdue',published:'published'};
      if(info.kind!==map[filters.printTiming])return false;
    }
    if(filters.search){const q=filters.search.toLowerCase();if(!t.title.toLowerCase().includes(q)&&!t.authors.toLowerCase().includes(q))return false;}
    return true;
  });
  // Round 14 (2026-08-12), item 2 — display-order toggle (no new data
  // field). 'alpha' sorts on the title text itself (localeCompare, base
  // sensitivity so case/accents don't split otherwise-identical titles
  // apart). 'recent' uses t._row — the title's row position in the live
  // Sheet — as the "created" proxy: new titles are always appended to the
  // end of the Sheet (see confirmAddTitle/saveTitle's _row comment), so a
  // higher _row reliably means a more recently created title without
  // needing a new createdDate column. Sorted on a copy (.slice()) so the
  // underlying data.titles array — and every _row index into it — is never
  // reordered by a display choice.
  // Round 37 (2026-08-28) — David request: sort by Street/Print/Soft date,
  // on top of the existing filters (critically including the Release Block
  // filter above) — this comparator runs on `titles`, which at this point
  // is already the filtered array, so picking a Block first then one of
  // these date sorts naturally sorts just that block's titles, nothing
  // extra needed. dateSortKey() below sends missing/unparseable dates to
  // the very end (Infinity) rather than the start, so an empty Street/
  // Print/Soft date never looks like "earliest" — matches the convention
  // Progress Report's own date sort already uses (reportByTitle fallback
  // after a numeric date-days compare, see reportRows() below). Print uses
  // the same effective-date logic as everywhere else in the app
  // (autoPrintDate → calcAutoPrint(streetDate), else the manual printDate)
  // so this sorts on what the card/detail view actually displays as the
  // Print Date, not a raw possibly-blank field.
  titles = titles.slice().sort((a,b)=>{
    const tiebreak=()=>a.title.localeCompare(b.title,undefined,{sensitivity:'base'});
    if(filters.sort==='recent') return (b._row||0)-(a._row||0);
    if(filters.sort==='street') return dateSortKey(a.dates.streetDate)-dateSortKey(b.dates.streetDate)||tiebreak();
    if(filters.sort==='print'){
      const pa=a.dates.autoPrintDate?calcAutoPrint(a.dates.streetDate):a.dates.printDate;
      const pb=b.dates.autoPrintDate?calcAutoPrint(b.dates.streetDate):b.dates.printDate;
      return dateSortKey(pa)-dateSortKey(pb)||tiebreak();
    }
    if(filters.sort==='soft') return dateSortKey(a.dates.softDate)-dateSortKey(b.dates.softDate)||tiebreak();
    return tiebreak();
  });
  const main=document.getElementById('main');
  // Item 3 (2026-08-20 round) — active-Block-filter readout, above the grid.
  // Placed here (top of #main, between the header and the card grid) rather
  // than tucked inside .filter-sidebar: the sidebar collapses to a hidden,
  // toggle-opened overlay on narrow/mobile widths (see .filter-sidebar's
  // media-query transform below in index.html), so anything living inside
  // it disappears with it — this readout needs to stay visible regardless
  // of whether the filter panel itself is open.
  const filterLabel = activeBlockFilterHtml();
  if(!titles.length){main.innerHTML=filterLabel+'<div class="empty-state"><h3>No titles found</h3><p>Try changing your filters, or add a new title. If this is a fresh sheet, Fred\'s Book Bible migration may not have landed yet.</p></div>';return;}
  main.innerHTML=filterLabel+'<div class="titles-grid">'+titles.map(renderCard).join('')+'</div>';
}
// Imprint colour-code (item 6) — data attribute + tooltip-only dot, no
// visible text label anywhere on the card.
function imprintKey(imprint){ return (imprint||'').toLowerCase().indexOf('oil')===0||(imprint||'').toLowerCase().indexOf('oowp')===0 ? 'oowp' : 'headpress'; }
function imprintName(imprint){ return imprintKey(imprint)==='oowp' ? 'Oil On Water Press' : 'Headpress'; }
// Item 3 (Round 3) — real editable imprint control for existing titles.
// Before this, imprint could only ever be set once, at title-creation time
// (new-imprint select in the Add Title modal, see index.html) — the detail
// view only ever rendered it as a plain read-only <span>. Confirmed live
// there was genuinely no edit path anywhere, so this is a new control, not
// a discoverability fix. Values match the Add Title modal's options
// exactly ("Headpress" / "Oil On Water Press" — corrected Round 16,
// 2026-08-12, was the wrong "Oil AND Water Press" before; see build report)
// so round-tripping through the Sheet's imprint column is unaffected.
function imprintEditSelect(t){
  const ik=imprintKey(t.imprint);
  // Round 10, item 5 — data-imprint drives the per-imprint accent-colour CSS
  // (see .imprint-edit-select[data-imprint=...] in index.html), same
  // attribute/pattern .book-card already uses for its own imprint accent.
  return `<select class="imprint-edit-select" data-imprint="${ik}" title="Change imprint" onchange="onImprintChange('${t.id}',this.value)">
    <option value="Headpress" ${ik==='headpress'?'selected':''}>Headpress</option>
    <option value="Oil On Water Press" ${ik==='oowp'?'selected':''}>Oil On Water Press</option>
  </select>`;
}
function onImprintChange(titleId,value){
  const t=getTitle(titleId);if(!t)return;
  t.imprint=value;
  debouncedSave(titleId);
  // Full re-render (same pattern used elsewhere for structural changes,
  // e.g. addPrinterContact/removePrinterContact below) so the imprint dot
  // colour next to the title and the card-grid colour-code both pick up
  // the change immediately — imprint changes are rare/deliberate edits,
  // not per-keystroke typing, so losing focus on re-render is a non-issue.
  renderDetail();
}

// Round 9, item 1 — real edit control for status. Same bug class as
// imprint/title/subtitle/author before it: status could only ever be set
// once, at title-creation (new-status select in the Add Title modal, see
// index.html), then only ever rendered afterward as a plain read-only
// .status-badge <span> — confirmed live there was genuinely no edit path,
// which is exactly what produced David's "Not Scheduled" confusion on a
// title that already had a real Street Date (status is a separate manual
// field, never derived from schedule data — that auto-derive question is
// a bigger design call flagged to David directly, out of scope here).
//
// Implementation choice: rather than bolting a second select next to the
// badge (the pattern imprintEditSelect uses, sitting alongside
// .status-badge), the badge itself BECOMES the control — same badge-*
// colour classes, same pill shape, just swapped from <span> to <select>.
// Status IS what the badge shows, so there's no reason for a separate
// control; this also means the coloured badge people already read at a
// glance keeps working exactly as before, just clickable now.
function statusEditSelect(t){
  const cls=statusBadgeClass(t.status);
  const opt=v=>`<option value="${esc(v)}" ${t.status===v?'selected':''}>${esc(v)}</option>`;
  return `<select class="status-badge ${cls}" title="Change status" onchange="onStatusChange('${t.id}',this.value)">
    ${STATUS_VALUES.map(opt).join('')}
  </select>`;
}
function onStatusChange(titleId,value){
  const t=getTitle(titleId);if(!t)return;
  t.status=value;
  // Round 10, items 1/2 — the instant David picks a value himself here,
  // auto-derivation (applyStatusAutoRules(), see above) must never touch
  // Status again for this title, permanently — even if he happens to pick
  // back to 'Not Scheduled' or 'In Progress', values the automatic rules
  // could also produce on their own.
  t.statusAuto=false;
  debouncedSave(titleId);
  // Full re-render, same reasoning as onImprintChange — status changes are
  // rare/deliberate, and the badge colour class, the card-grid progress bar
  // ("Published" vs percentage — see renderCard's isPublished() check) and
  // the day-count badge all read off status too, so all of it needs to
  // pick up the change immediately, not just the control itself.
  renderDetail();
}

// ─── ROUND 5: Title/Subtitle/Author real edit controls + contributor-role
// selector ───
// Item 1 — Title, Subtitle and Author(s) had no edit path anywhere except
// the once-only Add Title modal (same bug class as the imprint gap round 3
// fixed). Rendered now as genuinely editable fields in the detail view
// (see the detail-title-row/detail-author-row markup in renderDetail()),
// styled to read as plain text until focused/hovered (see .detail-title-
// input etc. in index.html) rather than looking like a form field bolted
// onto a title, since this is prime, above-the-fold real estate.
// Item 2 — contributor-role selector (Author(s)/Editor(s)/Author(s) &
// Editor(s)), approved by David as: keep the single free-text name field
// as-is, add a small selector next to it that changes the LABEL wherever
// the name displays elsewhere (card grid, HTML/Word export) — see
// contributorLabel() below. The role itself lives in authorInfo.
// contributorRole (see rowToTitle/defTitle above) — an existing JSON blob
// column, no new Sheet column needed.
function contributorLabel(t){
  const name=(t.authors||'').trim();
  if(!name) return '';
  const role=(t.authorInfo&&t.authorInfo.contributorRole)||'Author(s)';
  if(role==='Editor(s)') return 'Edited by '+name;
  if(role==='Author(s) & Editor(s)') return name+' (Author & Editor)';
  return name; // 'Author(s)' (default) — unchanged from before this round
}
function contribRoleSelectHtml(fieldId,titleId,role){
  const r=role||'Author(s)';
  const opt=(v,label)=>`<option value="${esc(v)}" ${r===v?'selected':''}>${esc(label)}</option>`;
  return `<select id="${fieldId}" class="contrib-role-select" title="Contributor role — changes how the name below is labelled elsewhere (card, exports)" onchange="onContribRoleChange('${titleId}',this.value)">
    ${opt('Author(s)','Author(s)')}${opt('Editor(s)','Editor(s)')}${opt('Author(s) & Editor(s)','Author(s) & Editor(s)')}
  </select>`;
}
function onContribRoleChange(titleId,value){
  fc(titleId,'authorInfo.contributorRole',value);
  // Full re-render, same reasoning as onImprintChange — a rare, deliberate
  // choice, not per-keystroke, and the "Displays as" preview line + card
  // label both need to reflect it immediately.
  renderDetail();
}
// Live-save handler for the new Title/Subtitle/Author(s) inputs. Saves on
// every keystroke via fc() (debounced, same as every other text field in
// this app) WITHOUT a full renderDetail() — that would reset cursor
// position mid-typing. Anywhere else these values are mirrored on the same
// page (the cover placeholder's title text, the author "Displays as"
// preview) is patched directly here instead.
function onDetailFieldChange(titleId,field,value){
  const t=getTitle(titleId);if(!t)return;
  // 2026-09-02 incident, part 2 — David reproduced the actual trigger on his
  // own machine: an interrupted Alt-code em-dash entry (e.g. Alt+0, a
  // mistyped partial of Alt+0151) blurs the field AND clears it; a separate
  // Ctrl+0151-style combo kicks him out of the whole app (almost certainly
  // just Chrome's native Ctrl+<digit> tab-switch / Ctrl+0 zoom-reset
  // shortcuts firing — Ctrl+1..8 jump to the Nth open tab — nothing to fix
  // in this app's code for that half). Re-checked specifically for a blur/
  // focusout/focus handler this time (not just keydown as the first pass
  // covered): there is STILL none anywhere in this app, on these inputs or
  // any shared ancestor — only handler in the whole codebase is the header
  // logo's Enter/Space keydown. So whatever blurs the field and clears its
  // value is native Windows/Chrome keyboard handling, outside this app's
  // own event code — there's no handler here to remove. Can't intercept
  // the OS-level cause, so intercepting the symptom here instead: Title
  // going from a real value straight to empty in one single input event,
  // on an already-saved title, is never accepted — the on-screen input is
  // restored immediately so the user doesn't even see it go blank. Same
  // detection saveTitle() already uses (_hadTitleOnLoad) via the debounced
  // save/Sheet-write path; this is the same guard one step earlier, at
  // input time, so the field itself never visibly "loses" the title either.
  if(field==='title' && t._row && t._hadTitleOnLoad && (t.title||'').trim() && !value.trim()){
    const input=document.getElementById('f-'+titleId+'-title');
    if(input) input.value=t.title;
    console.warn('onDetailFieldChange: ignored a Title→blank edit for an existing title (likely a stray keystroke, e.g. an interrupted Alt-code entry) — value unchanged:', titleId);
    return;
  }
  fc(titleId,field,value);
  if(field==='title'){
    const ph=document.querySelector('.detail-cover .cover-ph-title');
    if(ph) ph.textContent=t.title;
  }
  if(field==='authors'){
    const prev=document.getElementById('detail-author-preview-'+titleId);
    if(prev) prev.textContent = t.authors ? 'Displays as: “'+contributorLabel(t)+'”' : '';
  }
}
function renderCard(t){
  // Round 12, item 3a (2026-08-12) — bullet dot replaced with a diagonal
  // corner ribbon (see .card-attention in index.html for the full
  // reasoning/CSS).
  // Round 13 (2026-08-12) — "!" glyph removed per David: the hover tooltip
  // already says "Needs attention", so the icon was redundant. Ribbon was a
  // plain empty coloured band from here through Round 37.
  // Round 38 (2026-08-28) — David asked for an urgency day-count on the
  // ribbon itself. Text re-added (see attentionLabel() above), tooltip now
  // carries the same label so hover and the ribbon text always agree.
  let attn='';
  if(hasAttention(t)){
    const attnLbl=attentionLabel(t);
    attn=`<div class="card-attention" title="Needs attention — ${esc(attnLbl)}">${esc(attnLbl)}</div>`;
  }
  // Real thumbnails, 2026-07-15 — investigated three options (see build
  // report): (A) Microsoft Graph API OAuth integration, (B) OneDrive's
  // anonymous-share thumbnail endpoint. Both dead-ended on the same
  // problem: tested live against JACKsploitation's actual imagesFolderLink
  // (the one real title with a folder link populated) — the folder 403s to
  // an unauthenticated fetch, and Graph's /shares/{id}/driveItem endpoint
  // now requires a bearer token even for "anyone" links regardless of the
  // link's own sharing setting. Both options collapse into "stand up a
  // second Microsoft OAuth app" — the same cost as Option A, for either
  // choice, on top of today's Google OAuth saga. So: (C) coverThumbnailFile
  // is repurposed from "filename within the folder" (Graph-dependent, never
  // implemented) to a plain direct image URL David pastes in per title —
  // zero new auth, zero API dependency, renders with a plain <img>, and
  // fails safe (onerror below) straight back to the placeholder if the URL
  // ever breaks while David's away from his desk. One extra manual step per
  // title, traded for something that can't silently stop working.
  const cover = t.coverThumbnailFile
    ? `<img src="${esc(t.coverThumbnailFile)}" alt="${esc(t.title)} cover" loading="lazy" onerror="this.outerHTML=${escAttrJson(coverPhHtml(t))}">`
    : coverPhHtml(t);
  // Item 1/3 — progress bar replaces the old 20-dot pipeline strip. Green
  // fill only once actually published; otherwise a muted gold shows partial
  // completion, keeping green reserved for "done" per David's instruction.
  const totalStages=t.pipeline.stages.length;
  // Round 12, item 2d — 'Not Required' counts toward the progress bar same
  // as 'Complete' (same "nothing outstanding" equivalence, see cycleStage()
  // comment above).
  const doneStages=t.pipeline.stages.filter(s=>s.status==='Complete'||s.status==='Not Required').length;
  const pct=totalStages?Math.round(doneStages/totalStages*100):0;
  const barDone=isPublished(t);
  const progressHtml=`<div class="progress-wrap"><div class="progress-track"><div class="progress-fill ${barDone?'done':''}" style="width:${barDone?100:pct}%"></div></div><div class="progress-label">${barDone?'Published':doneStages+'/'+totalStages}</div></div>`;
  const info=computeDayInfo(t);
  const deadlineHtml=`<div class="card-deadline ${info.colorClass}">${esc(info.label)}</div>`;
  const ik=imprintKey(t.imprint);
  // Round 10, item 3 — Street Date / Soft Date, added to the card when they
  // exist (omitted entirely, not shown as an empty placeholder, when blank —
  // most titles this early only have one or neither set).
  const cardDateParts=[];
  if(t.dates.streetDate) cardDateParts.push(`<span>Street: ${esc(formatDate(t.dates.streetDate))}</span>`);
  if(t.dates.softDate) cardDateParts.push(`<span>Soft: ${esc(formatDate(t.dates.softDate))}</span>`);
  const cardDatesHtml = cardDateParts.length ? `<div class="card-dates">${cardDateParts.join('')}</div>` : '';
  // Round 13 (2026-08-12) — card-view imprint dot removed entirely per
  // David (not shrunk back down, gone). The .imprint-dot CLASS itself is
  // untouched and still used in the detail view's title row below (this was
  // scoped to the Dashboard card only, see index.html's .imprint-dot
  // comment). The 5px top-border imprint colour bar (index.html, item 6's
  // other half) is a separate element and stays.
  return `<div class="book-card" data-imprint="${ik}" onclick="gotoDetail('${t.id}')">${attn}
    <div class="book-cover">${cover}</div>
    <div class="card-info">
      <div class="card-title-row"><span class="card-title">${esc(t.title)}</span></div>
      ${t.authors?`<div class="card-author">${esc(contributorLabel(t))}</div>`:''}
      ${cardDatesHtml}
      ${deadlineHtml}
    </div>
    <div class="card-footer">${progressHtml}</div>
  </div>`;
}

// ─── DETAIL VIEW ───
function renderDetail(){
  const t=getTitle(selectedId);
  if(!t){gotoTitles();return;}
  // Round 20 (2026-08-19) — every real detail-page open re-records this
  // title at the top of Recently Viewed (see the RECENTLY VIEWED block
  // below toggleAccord() for the full feature). Deliberately unconditional
  // here (not just on first open) — renderDetail() only runs once per
  // navigation-in (gotoDetail()->render()), never on the debounced field
  // edits that happen while already viewing a title, so this can't spam the
  // list. recordRecentlyViewed() resets this title's stored section/offset
  // back to 'top' on every fresh open, which is correct for a normal open —
  // openFromRecentlyViewed() (below) overrides that back to the saved
  // position immediately afterward for the one case that needs it.
  recordRecentlyViewed(t);
  const main=document.getElementById('main');
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  const info=computeDayInfo(t);
  // Round 10, item 4 — computeDayInfo()'s generic no-date fallback (kind
  // 'nodate' with no hasStreet flag, literal label 'Not scheduled') is
  // suppressed here specifically: statusEditSelect() just above already
  // shows the same thing via the Status badge, so on a title with neither
  // dates nor pipeline activity the two used to say essentially the same
  // thing side by side. The 'Street: [date]' variant (hasStreet:true) and
  // the real day-count/overdue variants aren't duplicated by the badge, so
  // those still render exactly as before.
  const suppressGenericNoDate = info.kind==='nodate' && !info.hasStreet;
  const daysHtml = suppressGenericNoDate ? '' : `<span class="card-deadline ${info.colorClass}" style="font-size:.85rem">${esc(info.kind==='overdue'?'OVERDUE':info.label)}</span>`;
  // Badge: any legacy 'Completed'/'Released' literal is remapped to
  // 'Complete' at load (normalizeStatus(), Round 27) so this always sees the
  // single canonical value; badge-complete is the one style for "done".
  // (Round 9: factored into statusBadgeClass() so statusEditSelect() below
  // can share it.)
  // 2026-07-15: real thumbnail if a Cover Image URL is set (see renderCard()
  // for why this is a pasted direct URL rather than a Graph API fetch),
  // same onerror fallback pattern as the card grid.
  const coverPlaceholder=`<div class="cover-ph"><div class="cover-ph-h">B</div><div class="cover-ph-title">${esc(t.title)}</div></div>`;
  // Round 6, item 1 — onerror/onload now point at onCoverImgError()/
  // onCoverImgLoad() (see those for the OneDrive-vs-generic-failure
  // distinction) instead of the old silent outerHTML swap.
  const coverHtml=t.coverThumbnailFile
    ? `<img src="${esc(t.coverThumbnailFile)}" alt="${esc(t.title)} cover" onerror="onCoverImgError('${t.id}',this)" onload="onCoverImgLoad('${t.id}')">`
    : coverPlaceholder;
  const detailStrip=t.pipeline.stages.map((s,i)=>`<div class="detail-p-dot" style="background:${dotColor(s.status)}" title="${esc(s.name)}: ${esc(s.status)}" onclick="cycleStage('${t.id}',${i})"></div>`).join('');
  const accordionHtml=SECTION_KEYS.map(k=>renderAccordionSection(t,k)).join('');
  // Item 8 (Round 2) — jump-nav converted from a sticky HORIZONTAL bar
  // (needed horizontal scrolling to see every item — the whole complaint)
  // into a floating vertical sidebar to the left of the content column
  // (.toc-sidenav, see index.html; collapses back to a horizontal bar under
  // 900px via media query). Labels no longer strip a leading "N. " prefix
  // via regex — SECTION_LABELS builds its own numbering dynamically now
  // (see the SECTION_KEYS/SECTION_LABELS block above), so the label text is
  // already just the plain name.
  // Item 9b (2026-08-11) — href kept (right-click/open-in-new-tab/no-JS
  // fallback still works, native anchor scroll still fires) but the actual
  // click is intercepted by jumpToSection(), which forces the target
  // section open (if collapsed) before scrolling to it — see that
  // function's comment for why a plain href alone wasn't enough.
  // data-section-key lets the scroll-spy (item 9a, setupSectionScrollSpy())
  // find/mark the right sidebar item without re-deriving it from the DOM.
  // Round 13 (2026-08-12) — "Top" entry added as the first/topmost sidebar
  // item, per David: the top box (cover/title/author/etc) wasn't reachable
  // from the sidebar before, only the numbered sections below it. Not part
  // of SECTION_KEYS/renderAccordionSection() — it's not a collapsible
  // accordion section, just a plain scroll target — so it's a separate
  // hand-written <a> prepended to the same nav, sharing the identical
  // click-to-scroll/active-highlight mechanics via jumpToTop() and the
  // 'top' data-section-key (see jumpToTop()/updateSectionScrollSpy() below).
  const tocNavHtml=`<nav class="toc-sidenav" id="toc-nav"><a class="toc-side-item" data-section-key="top" href="#dtop-${t.id}" onclick="jumpToTop('${t.id}');return false;">Top</a>${SECTION_KEYS.map(k=>`<a class="toc-side-item" data-section-key="${k}" href="#asec-${t.id}-${k}" onclick="jumpToSection('${t.id}','${k}');return false;">${esc(SECTION_LABEL_TEXT[k]||k)}</a>`).join('')}</nav>`;
  main.innerHTML=`
    <div class="detail-header-row">
      <button class="detail-back" onclick="gotoTitles()">&#8592; All Titles</button>
      <button class="btn-delete-title" onclick="openDeleteConfirm('${t.id}')" title="Permanently delete this title">Delete Title&hellip;</button>
    </div>
    <div class="detail-layout">
      ${tocNavHtml}
      <div class="detail-content">
        <div class="detail-top" id="dtop-${t.id}">
          <div class="detail-cover" title="Set the Cover Image URL below to show a real thumbnail here">${coverHtml}</div>
          <div class="detail-info">
            <div class="detail-title-row"><span class="imprint-dot" data-imprint="${imprintKey(t.imprint)}" style="background:var(--imprint-${imprintKey(t.imprint)==='oowp'?'oowp':'headpress'})" title="${esc(imprintName(t.imprint))}"></span><input type="text" class="detail-title-input" id="f-${t.id}-title" value="${esc(t.title)}" placeholder="Title" oninput="onDetailFieldChange('${t.id}','title',this.value)"></div>
            <input type="text" class="detail-subtitle-input" id="f-${t.id}-subtitle" value="${esc(t.subtitle)}" placeholder="Subtitle (optional)" oninput="onDetailFieldChange('${t.id}','subtitle',this.value)">
            <div class="detail-author-row">
              ${contribRoleSelectHtml(`f-${t.id}-contribRole`,t.id,t.authorInfo.contributorRole)}
              <input type="text" class="detail-author-input" id="f-${t.id}-authors" value="${esc(t.authors)}" placeholder="Author/Editor name(s)" oninput="onDetailFieldChange('${t.id}','authors',this.value)">
            </div>
            ${t.authors?`<div class="detail-author-preview" id="detail-author-preview-${t.id}">Displays as: “${esc(contributorLabel(t))}”</div>`:''}
            <div class="detail-meta-row">
              ${statusEditSelect(t)}
              ${imprintEditSelect(t)}
              ${t.dates.streetDate?`<span>Street: ${esc(formatDate(t.dates.streetDate))}</span>`:''}
              ${pd&&!isPublished(t)?`<span>Print: ${esc(formatDate(pd))}</span>`:''}
              ${daysHtml}
            </div>
            <div class="detail-strip-wrap">
              <div class="detail-strip-label">Production Pipeline — click to cycle status</div>
              <div class="detail-strip" id="detail-strip-${t.id}">${detailStrip}</div>
            </div>
          </div>
        </div>
        ${renderLinksStrip(t)}
        ${renderExportButtons(t)}
        ${renderKeyContacts(t)}
        <div class="accordion" id="accordion-${t.id}">${accordionHtml}</div>
      </div>
    </div>`;
  autoGrowAll(main);
  // PO Tracker data isn't in the row payload (it lives in a different
  // spreadsheet, fetched on demand). Round 6 — PO Tracker no longer defaults
  // open (item 4), so this only fires here if the section happens to
  // already be open (accordionOpen carried over from earlier this session,
  // e.g. navigating away and back) and hasn't been fetched yet; the normal
  // first-open case is handled by toggleAccord() itself.
  if(isOpen(t.id,'poTracker') && !poTrackerLoadedFor[t.id]){ poTrackerLoadedFor[t.id]=true; loadPoTrackerFor(t.id); }
  // Round 13 (2026-08-12) — was SECTION_KEYS[0] ('dates'); the detail view
  // actually opens scrolled to the top box, not "Dates & Scheduling", so
  // 'top' is the correct initial highlight now that it's a real sidebar
  // entry (matches what updateSectionScrollSpy()'s own fallback does).
  setActiveSideNavItem('top'); // sensible default until the first scroll tick fires
}

// New fields from brief §3: images folder link + working folder link
// (reveal helper).
//
// Cover Image URL (added 2026-07-15): a direct link to a single image file,
// separate from the Images Folder link above (which stays a plain folder
// link David opens by hand — no thumbnail rendering happens from it). See
// the long comment in renderCard() for why: a Microsoft Graph API OAuth app
// and OneDrive's "anonymous" thumbnail endpoint were both tried against a
// real title's folder link first and both require the same kind of auth
// dependency as a full Graph integration, so this deliberately trades one
// manual paste-in step per title for something that can never silently
// break.
//
// UPDATE 2026-07-15 (same day): a real David-pasted 1drv.ms link
// (JACKsploitation) turned out NOT to work — 1drv.ms short links resolve to
// OneDrive's HTML viewer page (onedrive.live.com/?qt=allmyphotos...), not
// raw image bytes, so <img src> gets HTML (or a 403 when unauthenticated)
// and silently falls back to the placeholder. Confirmed live by fetching
// the exact URL and inspecting the redirect chain/content-type. So: for the
// 26 launch titles this field is now bulk-populated with repo-relative
// paths (covers/<title_id>.jpg, committed straight into this repo's
// /covers/ folder from David's locally-synced OneDrive
// "_IMAGES & COVERS & LOGOS" folders — no OneDrive link, no auth, nothing
// that can break while David's away from his desk) rather than pasted
// OneDrive share links. type="text" (not "url") so a relative path like
// that doesn't trip native browser URL-validation styling. A plain
// publicly-hosted absolute URL still works fine in this field for any
// future title — a 1drv.ms/onedrive.live.com share link will NOT, per the
// above; use a direct file host or add the image to /covers/ instead.
//
// Round 10, item 6 — these three fields, previously loose inside the
// title/cover panel (detail-info), are now pulled into their own small
// bordered/backgrounded strip directly under it (renderLinksStrip below,
// renamed from renderFolderLinksRow) — same visual pattern as the Key
// Contacts box (.key-contacts-box), rather than fields floating inside the
// title block. David chose this over relocating them into the jump-nav
// sidebar (flagged as impractical live: too narrow/dark for real text
// inputs, and collapses under 900px).
// Round 10, item 9 — a short inline help note used to sit under the Cover
// Image URL field, documenting the GitHub-upload workflow David uses
// himself (repo's covers/ folder → Add file → Upload files → commit → paste
// the resulting covers/<filename> path back in here).
// Round 11, items 2b/2c (2026-08-11) — restyled to lead with the same
// pill-button aesthetic as .btn-export ("View HTML Output ↗" etc, David's
// explicit reference point) instead of showing the raw bold path as the
// primary visual — see the CSS comment above .link-action-row/.link-value-
// edit in index.html for the full reasoning. Functionality unchanged: same
// fc()/onCoverUrlChange() handlers, same openImagesFolder()/
// revealWorkingFolder() actions, same field ids.
// Round 23, item 1 (2026-08-20) — all three groups now share the exact same
// internal order (button/action row on top, editable link/path value below
// it) so the three-across row reads as one consistent pattern instead of
// Cover Image URL being the odd one out (it used to lead with the input,
// button underneath). Images Folder/Working Folder were already button-on-
// top; only Cover Image URL's internal order changed here — its handlers,
// ids and .folder-links-row/.folder-link-group CSS (already a 3-up flex
// row, gap:16px, wraps under 900px) are untouched.
// Round 23, item 2 — David's own words: multi-step instructions like the old
// "go to covers folder → Add file → Upload files → drag → commit → paste
// the path back in" note aren't something he'll remember/follow from a
// tooltip. Replaced with a single plain clickable link straight to this
// repo's live /covers/ folder page on github.com (build it the same way
// coverGithubUrl() builds a per-file blob link, just pointed at the folder
// itself via /tree/<branch>/covers rather than a specific file).
// Round 28 (2026-08-26), David request — three changes to this strip:
// (1) Images Folder / Working Folder each gain a root-level quick-access
// link (below the per-title input, same field-help slot pattern the Cover
// Image URL field already uses for its /covers/ link) — David's own
// reasoning: he wants a one-click way to get to the ROOT folder so he can
// find the right per-book subfolder and copy ITS link back into the field
// above, not a link to a specific book. Images Folder root points at the
// real OneDrive web URL for the root images folder (confirmed live via
// browser 2026-08-26 — see IMAGES_FOLDER_ROOT_URL below); Working Folder
// root reuses the exact same local reveal-helper mechanism
// revealWorkingFolder() already uses (book_reveal_helper.py on :8744), just
// against the fixed WORKING_FOLDER_ROOT path instead of a per-title one —
// see revealWorkingFolderRoot() below.
// (2) New fourth field, Author Bookkeeping (Google Drive) — same button +
// editable input + lock-toggle pattern as Images Folder/Working Folder,
// left blank per-title by default, no root-link (nothing to browse to by
// default, unlike the other two — it's one Sheet/Drive link per author,
// pasted in by hand same as the others originally were before root links
// existed). Data-wise this is a NEW persisted field — added as a new key
// inside the existing productionNotes_json blob (see pn.authorBookkeepingLink
// in rowToTitle() above and titleToRow() below), NOT a new raw Sheet column:
// adding a real column (the imagesFolderLink/workingFolderLink pattern) was
// tried first directly against the live "Book Production Titles" Sheet but
// got blocked by the session's own permission guard on committing the header
// cell — a live production-schema write needs a real confirm, so it was
// flagged rather than forced through. The JSON-blob route needs no Sheet
// edit at all and is the same mechanism already proven safe by
// releaseNote/pagesBreakdown in earlier rounds.
// (3) All four groups' button + input sized down specifically for this box
// (see .links-strip-box .btn-export / .links-strip-box .link-value-edit in
// index.html) — David's reasoning: these are one-time fills per book, just
// glanced at on a title card, not something that needs the same visual
// weight as View HTML Output/View Word File below (which share the base
// .btn-export class and stay full-size — scoped via the .links-strip-box
// ancestor selector rather than shrinking .btn-export itself so nothing
// else using that class anywhere in the app is affected).
const IMAGES_FOLDER_ROOT_URL='https://onedrive.live.com/my?id=%2Fpersonal%2F57fd0e54449e2748%2FDocuments%2F%5FIMAGES%20%26%20COVERS%20%26%20LOGOS';
// Round 29 (2026-08-26, David request) — static quick-access link to the
// master Author Bookkeeping sheet, same field-help pattern as Images
// Folder root / Cover Image URL's covers-folder link above: a fixed URL
// (not built per-book) so David can jump to the master sheet, find/copy the
// right reference, then paste a per-book link into the field itself.
const AUTHOR_BOOKKEEPING_MASTER_URL='https://docs.google.com/spreadsheets/d/1SeOIraiokeUiKHd5Bbrcs6OS88xjd_-bSZzaXQ5b_ms/edit?gid=622271452#gid=622271452';
function renderLinksStrip(t){
  const id=t.id;
  const imgSet=!!(t.imagesFolderLink&&t.imagesFolderLink.trim());
  const wfSet=!!(t.workingFolderLink&&t.workingFolderLink.trim());
  const coverSet=!!(t.coverThumbnailFile&&t.coverThumbnailFile.trim());
  const abSet=!!(t.authorBookkeepingLink&&t.authorBookkeepingLink.trim());
  // Round 22, item 1 — lock state for all three fields, computed per-render
  // (see linkLockRow(): defaults to locked once a value exists, unlocked
  // while genuinely empty). Round 22, item 2 — real github.com link for the
  // cover, built from whatever's actually in coverThumbnailFile right now.
  // Round 28 — same lock treatment extended to the new Author Bookkeeping field.
  const coverLocked=linkLockRow(id,'coverThumbnailFile',coverSet);
  const imgLocked=linkLockRow(id,'imagesFolderLink',imgSet);
  const wfLocked=linkLockRow(id,'workingFolderLink',wfSet);
  const abLocked=linkLockRow(id,'authorBookkeepingLink',abSet);
  const ghUrl=coverGithubUrl(t.coverThumbnailFile);
  const coversFolderUrl=`https://github.com/${GITHUB_REPO}/tree/${GITHUB_REPO_BRANCH}/covers`;
  const lockBtn=(field,locked)=>`<button class="lock-btn ${locked?'locked':'unlocked'}" title="${locked?'Locked — click to unlock and edit':'Unlocked — click to lock again'}" onclick="toggleLinkLock('${id}','${field}')">${locked?'&#128274;':'&#128275;'}</button>`;
  return `<div class="links-strip-box">
    <div class="links-strip-label">Cover &amp; Folder Links</div>
    <div class="folder-links-row">
      <div class="folder-link-group">
        <label class="field-label">Cover Image URL</label>
        <div class="link-action-row">
          <button class="btn btn-export ${ghUrl?'':'is-empty'}" type="button" onclick="openCoverGithubPage('${id}')">${ghUrl?'View on GitHub':'No Cover Set Yet'} &#8599;</button>
        </div>
        <div class="link-lock-row">
          <input type="text" class="link-value-edit" id="f-${id}-coverThumbnailFile" value="${esc(t.coverThumbnailFile)}" ${coverLocked?'readonly':''} placeholder="Not set — paste covers/title-id.jpg or a direct image URL" oninput="onCoverUrlChange('${id}',this.value)">
          ${lockBtn('coverThumbnailFile',coverLocked)}
        </div>
        <div class="cover-url-msg" id="cover-url-msg-${id}"></div>
        <div class="field-help">To add a new cover, upload it here: <a href="${coversFolderUrl}" target="_blank" rel="noopener">${coversFolderUrl}</a></div>
      </div>
      <div class="folder-link-group">
        <label class="field-label">Images Folder (OneDrive)</label>
        <div class="link-action-row">
          <button class="btn btn-export ${imgSet?'':'is-empty'}" type="button" onclick="openImagesFolder('${id}')">${imgSet?'Open Images Folder':'No Images Folder Set'} &#8599;</button>
        </div>
        <div class="link-lock-row">
          <input type="url" class="link-value-edit" id="f-${id}-imagesFolderLink" value="${esc(t.imagesFolderLink)}" ${imgLocked?'readonly':''} placeholder="Not set — paste a OneDrive folder link" oninput="fc('${id}','imagesFolderLink',this.value)">
          ${lockBtn('imagesFolderLink',imgLocked)}
        </div>
        <div class="field-help">Browse the root folder to find this title's subfolder: <a href="${IMAGES_FOLDER_ROOT_URL}" target="_blank" rel="noopener">Images Folder root &#8599;</a></div>
      </div>
      <div class="folder-link-group">
        <label class="field-label">Working Folder (local)</label>
        <div class="link-action-row">
          <button class="btn btn-export ${wfSet?'':'is-empty'}" type="button" onclick="revealWorkingFolder('${id}')">${wfSet?'Reveal in Explorer':'No Working Folder Set'} &#128269;</button>
        </div>
        <div class="link-lock-row">
          <input type="text" class="link-value-edit" id="f-${id}-workingFolderLink" value="${esc(t.workingFolderLink)}" ${wfLocked?'readonly':''} placeholder="Not set — paste D:\\PROJECTS - BOOKS\\Book_…" oninput="fc('${id}','workingFolderLink',this.value)">
          ${lockBtn('workingFolderLink',wfLocked)}
        </div>
        <div class="field-help">Browse the root folder to find this title's subfolder: <a href="#" onclick="revealWorkingFolderRoot();return false;">Working Folder root &#128269;</a></div>
      </div>
      <div class="folder-link-group">
        <label class="field-label">Author Bookkeeping (Google)</label>
        <div class="link-action-row">
          <button class="btn btn-export ${abSet?'':'is-empty'}" type="button" onclick="openAuthorBookkeeping('${id}')">${abSet?'Open Bookkeeping Link':'No Bookkeeping Link Set'} &#8599;</button>
        </div>
        <div class="link-lock-row">
          <input type="url" class="link-value-edit" id="f-${id}-authorBookkeepingLink" value="${esc(t.authorBookkeepingLink)}" ${abLocked?'readonly':''} placeholder="Not set — paste a Google Drive link" oninput="fc('${id}','authorBookkeepingLink',this.value)">
          ${lockBtn('authorBookkeepingLink',abLocked)}
        </div>
        <div class="field-help">Find this title's reference in the master sheet: <a href="${AUTHOR_BOOKKEEPING_MASTER_URL}" target="_blank" rel="noopener">Author Bookkeeping master sheet &#8599;</a></div>
      </div>
    </div>
  </div>`;
}
// Round 6, item 1 — the field used to fail completely silently: a bad URL
// (almost always a pasted 1drv.ms/onedrive.live.com SHARE link, per the
// field's own placeholder warning — those resolve to OneDrive's HTML viewer
// page, not raw image bytes, so they can never load as a plain <img src>)
// just quietly fell back to the generic placeholder with zero feedback
// either way. onCoverImgError() below now distinguishes that specific,
// very-likely cause from a genuine generic load failure (wrong URL, deleted
// file, host down, etc.) and writes a real, visible message into the
// cover-url-msg-${id} box added next to the field in renderLinksStrip().
function looksLikeOneDriveShareLink(url){
  return /(^|\/\/)(1drv\.ms|onedrive\.live\.com)(\/|$|\?)/i.test(String(url||'').trim());
}
// Round 7, item 4 — third, distinct failure case: a raw local Windows file
// path (drive-letter path like C:\Users\...\cover.jpg, a D:\... path, a UNC
// \\server\share\... path, or a file:// URI). Confirmed as David's actual
// real-world mistake — copying a path out of a OneDrive-*synced* local
// folder rather than a real web link. Distinct from both the OneDrive
// share-link case above (that's still an http(s):// URL, just the wrong
// *kind* of URL) and a generic broken-link failure: a local path is a hard
// browser boundary — it can never resolve as a web <img src>, on this
// machine or any other, no matter how it's hosted, because the browser has
// no access to another machine's (or even this machine's) local
// filesystem from a page served over https://. Checked BEFORE the OneDrive
// case since it's the more specific, more actionable diagnosis.
function looksLikeLocalFilePath(url){
  const u=String(url||'').trim();
  if(!u) return false;
  return /^[A-Za-z]:[\\/]/.test(u) || /^\\\\/.test(u) || /^file:\/\//i.test(u);
}
function onCoverImgError(titleId,imgEl){
  const t=getTitle(titleId);
  const placeholder=t?`<div class="cover-ph"><div class="cover-ph-h">B</div><div class="cover-ph-title">${esc(t.title)}</div></div>`:'';
  if(imgEl) imgEl.outerHTML=placeholder;
  const msgEl=document.getElementById('cover-url-msg-'+titleId);
  if(!msgEl||!t)return;
  const url=t.coverThumbnailFile||'';
  msgEl.innerHTML = looksLikeLocalFilePath(url)
    ? '<span class="cover-url-warn">&#9888; This looks like a file path on your own computer, not a web address — browsers can\'t load images this way, on any device (not even this one). Upload the file somewhere with a real web link first (a direct-image host, or this repo\'s /covers/ folder), then paste that URL here instead.</span>'
    : looksLikeOneDriveShareLink(url)
    ? '<span class="cover-url-warn">&#9888; This looks like a OneDrive share link (1drv.ms / onedrive.live.com) — those open a web viewer page, not raw image bytes, so it can\'t load here as a direct image. Use a direct-hosted image URL instead, or add the file to this repo\'s /covers/ folder and reference it as covers/&lt;title-id&gt;.jpg.</span>'
    : '<span class="cover-url-fail">&#9888; Couldn\'t load an image from this URL — check it\'s a direct, publicly-accessible image link (not a viewer page, share link, or something requiring sign-in).</span>';
}
function onCoverImgLoad(titleId){
  const msgEl=document.getElementById('cover-url-msg-'+titleId);
  if(msgEl) msgEl.innerHTML='';
}
// Updates the field, saves, and refreshes the visible detail-cover thumbnail
// immediately (rather than waiting on the next full renderDetail()) so
// David gets instant feedback that the URL he pasted actually renders — and
// now (round 6) clears/resets the feedback message for the new attempt, with
// onCoverImgError/onCoverImgLoad above populating it for real as the browser
// actually tries (and fails or succeeds) to load the new URL.
function onCoverUrlChange(titleId,value){
  fc(titleId,'coverThumbnailFile',value);
  const t=getTitle(titleId);if(!t)return;
  const msgEl=document.getElementById('cover-url-msg-'+titleId);
  const coverEl=document.querySelector('.detail-cover');
  const placeholder=`<div class="cover-ph"><div class="cover-ph-h">B</div><div class="cover-ph-title">${esc(t.title)}</div></div>`;
  // Round 7, item 4 — a local file path is a known dead end (see
  // looksLikeLocalFilePath()), so there's no point even attempting the
  // <img> load and waiting on its onerror to fire — show the specific
  // warning immediately and skip straight to the placeholder.
  if(looksLikeLocalFilePath(value)){
    if(msgEl) msgEl.innerHTML='<span class="cover-url-warn">&#9888; This looks like a file path on your own computer, not a web address — browsers can\'t load images this way, on any device (not even this one). Upload the file somewhere with a real web link first (a direct-image host, or this repo\'s /covers/ folder), then paste that URL here instead.</span>';
    if(coverEl) coverEl.innerHTML=placeholder;
    return;
  }
  if(msgEl) msgEl.innerHTML='';
  if(!coverEl)return;
  coverEl.innerHTML = value
    ? `<img src="${esc(value)}" alt="${esc(t.title)} cover" onerror="onCoverImgError('${titleId}',this)" onload="onCoverImgLoad('${titleId}')">`
    : placeholder;
}
function openImagesFolder(titleId){
  const t=getTitle(titleId);if(!t||!t.imagesFolderLink){alert('No images folder link set for this title yet.');return;}
  window.open(t.imagesFolderLink,'_blank','noopener');
}
// Round 28 (2026-08-26) — same shape as openImagesFolder() above, just for
// the new Author Bookkeeping (Google Drive) field.
function openAuthorBookkeeping(titleId){
  const t=getTitle(titleId);if(!t||!t.authorBookkeepingLink){alert('No author bookkeeping link set for this title yet.');return;}
  window.open(t.authorBookkeepingLink,'_blank','noopener');
}
// Round 22, item 2 — David's own words: "a plain URL to the github page in
// question would be 100 times better" than what the Cover Image URL field
// currently gives him. Checked live first: coverThumbnailFile is already
// (per Round 10 item 9's own field-help text, and the actual live data —
// e.g. covers/Awaiting Cover - 600.jpg, covers/last-orgy-by-the-cemetery.jpg)
// almost always a path relative to THIS repo's own /covers/ folder, which
// David uploads to by hand via github.com's web UI — so the one thing
// missing was a direct link to that file's real github.com page (where he
// can actually see/replace/manage it), as opposed to only ever seeing it
// rendered as an <img> or as a raw unclickable path string. This repo (see
// `git remote -v`) is Netherleys/book-production-hub, deployed off `main`.
const GITHUB_REPO='Netherleys/book-production-hub';
const GITHUB_REPO_BRANCH='main';
function coverGithubUrl(val){
  const v=String(val||'').trim();
  if(!v) return '';
  // Already a raw.githubusercontent.com URL (the direct-bytes form of a
  // file in this same repo) — rewrite to the browsable github.com/.../blob
  // page rather than linking straight at the raw bytes.
  const raw=v.match(/^https?:\/\/raw\.githubusercontent\.com\/([^\/]+\/[^\/]+)\/([^\/]+)\/(.+)$/i);
  if(raw) return `https://github.com/${raw[1]}/blob/${raw[2]}/${raw[3]}`;
  // Any other absolute URL (an externally-hosted direct-image link, not in
  // this repo at all) — nothing to rewrite; it's already "a plain URL",
  // just not a github.com one, so open it as-is rather than guessing.
  if(/^https?:\/\//i.test(v)) return v;
  // The normal case: a repo-relative path like covers/<filename> — build
  // the real github.com blob page for it.
  return `https://github.com/${GITHUB_REPO}/blob/${GITHUB_REPO_BRANCH}/${v.replace(/^\/+/,'')}`;
}
function openCoverGithubPage(titleId){
  const t=getTitle(titleId);if(!t)return;
  const url=coverGithubUrl(t.coverThumbnailFile);
  if(!url){alert('No cover image set for this title yet.');return;}
  window.open(url,'_blank','noopener');
}
// Reveal-in-Explorer, same fetch pattern as Photo Gallery's
// revealInExplorer() in js/gallery.js (1.2s timeout, GET ?path=, treat any
// non-ok/failed fetch as "helper not running" and fall back). Book
// Production Hub has no FileSystemDirectoryHandle / "Connect Library"
// concept, so there's no Layer-2 native-picker fallback to reuse here like
// gallery.js has — on failure this instead surfaces the raw path so David
// can navigate to it by hand. Documented as a scoped-down fallback in the
// build report, not a silent gap.
// 2026-08-11 (Marcus Webb, David's batch, item 2a) — book_reveal_helper.py
// now auto-starts silently at every Windows logon (a Startup-folder shortcut
// launching it headless via pythonw.exe — see the .py file's own docstring
// and the shortcut's own Description field for the full reasoning), so "is
// it running?" should no longer be the live question most of the time.
// What this function fixes on the JS side: it used to treat EVERY non-ok
// response identically to "unreachable", even when the helper answered
// perfectly fine with a specific reason (403 = path outside the allowed
// D:\PROJECTS - BOOKS root, 404 = path doesn't exist on disk) — genuinely
// misleading David toward "is the helper running?" when the real problem
// was the PATH. (Confirmed live 2026-08-11 against David's own "Last Orgy
// By The Cemetery" example: its Working Folder field currently holds a
// C:\...\OneDrive\_IMAGES & COVERS & LOGOS\... path, NOT the real
// D:\PROJECTS - BOOKS\Book_Last Orgy By The Cemetery working folder that
// actually exists on disk — that's a second, independent reason this
// specific title's reveal was failing, flagged separately in the build
// report rather than silently corrected, since it's David's data, not a
// code bug.) Now surfaces the helper's own JSON error message when it has
// one, and only falls back to the generic "is it running" message for a
// genuine network failure/timeout.
async function revealWorkingFolder(titleId){
  const t=getTitle(titleId);if(!t)return;
  const path=t.workingFolderLink;
  if(!path){alert('No working folder path set for this title yet.');return;}
  const helperUrl=(CFG.BOOK_REVEAL_HELPER_URL||'http://127.0.0.1:8744')+'/reveal';
  let resp=null;
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),1200);
    resp=await fetch(helperUrl+'?path='+encodeURIComponent(path),{signal:controller.signal});
    clearTimeout(timer);
    if(resp.ok)return; // Explorer opened by the helper — done.
    console.warn('Reveal helper responded but not OK (status '+resp.status+').');
  }catch(e){
    console.warn('Reveal helper not reachable (is book_reveal_helper.py running?):',e);
  }
  // Fallback: no live-folder-handle mechanism in this app (see note above)
  // — give David the path directly so he can navigate to it himself, plus
  // the most specific reason available.
  try{ await navigator.clipboard.writeText(path); }catch(e){}
  let reason='Could not reach the local reveal helper (is book_reveal_helper.py running on port 8744? — it should now auto-start at Windows logon; if it still isn\'t, double-click start_book_reveal_helper.bat in the Book Production Hub folder).';
  if(resp){
    try{
      const body=await resp.json();
      if(body&&body.error) reason='Reveal helper reached, but refused: '+body.error+(resp.status===403?' — check the Working Folder path for this title is really under D:\\PROJECTS - BOOKS\\.':'');
    }catch(e2){ reason='Reveal helper responded with an error (status '+resp.status+').'; }
  }
  alert(reason+'\n\nPath copied to clipboard:\n'+path);
}
// Round 28 (2026-08-26), item 2 — root-folder quick-access companion to
// revealWorkingFolder() above: same helper, same 127.0.0.1:8744/reveal
// endpoint and same fetch/timeout/fallback shape, just always the fixed
// WORKING_FOLDER_ROOT path instead of a per-title one, so David can browse
// straight to D:\PROJECTS - BOOKS and find a book's actual subfolder to
// paste back into the field above — mirrors the Images Folder root link and
// the existing Cover Image URL /covers/ link. book_reveal_helper.py's own
// WORKING_FOLDER_ROOT allow-list (see that file) explicitly accepts the
// root path itself, not just subfolders under it, so this needs no helper-
// side change. Deliberately not reusing revealWorkingFolder(titleId)
// directly — that alerts+bails when no per-title path is set, which is the
// wrong message for this always-available root action.
const WORKING_FOLDER_ROOT='D:\\PROJECTS - BOOKS';
async function revealWorkingFolderRoot(){
  const path=WORKING_FOLDER_ROOT;
  const helperUrl=(CFG.BOOK_REVEAL_HELPER_URL||'http://127.0.0.1:8744')+'/reveal';
  let resp=null;
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),1200);
    resp=await fetch(helperUrl+'?path='+encodeURIComponent(path),{signal:controller.signal});
    clearTimeout(timer);
    if(resp.ok)return; // Explorer opened by the helper — done.
    console.warn('Reveal helper responded but not OK (status '+resp.status+').');
  }catch(e){
    console.warn('Reveal helper not reachable (is book_reveal_helper.py running?):',e);
  }
  try{ await navigator.clipboard.writeText(path); }catch(e){}
  let reason='Could not reach the local reveal helper (is book_reveal_helper.py running on port 8744? — it should now auto-start at Windows logon; if it still isn\'t, double-click start_book_reveal_helper.bat in the Book Production Hub folder).';
  if(resp){
    try{
      const body=await resp.json();
      if(body&&body.error) reason='Reveal helper reached, but refused: '+body.error;
    }catch(e2){ reason='Reveal helper responded with an error (status '+resp.status+').'; }
  }
  alert('Couldn\'t open the root working folder automatically.\n\n'+reason+'\n\nPath copied to clipboard:\n'+path);
}

// Item 12 (Round 2) — new standalone "Key Contacts" block, sitting directly
// beneath the title/subtitle block (detail-top), NOT inside the numbered
// accordion list. Pulls Author Liaison (previously in the Author box) and
// PR Contact (previously in Publicity & Marketing) into one shared spot —
// both still write to the exact same data paths they always did
// (authorLiaison / publicity.prContact), so nothing about the underlying
// Sheet columns changes, only where these two fields are surfaced in the UI.
// Item 4 (Round 3) — Author Liaison was already a dropdown but hardcoded
// (David/Jen/Other) in source; PR Contact was still plain free text. Both
// now render from the same shared, growable contact list (see
// contactSelectHtml()/getContacts() above) instead — Author Liaison stops
// being a special hardcoded case, PR Contact gains the dropdown David asked
// for, and either field can grow the list via "+ Add new contact…".
function renderKeyContacts(t){const id=t.id;
  return `<div class="key-contacts-box">
    <div class="key-contacts-label">Key Contacts</div>
    <div class="field-grid">
      ${frow('Author Liaison',contactSelectHtml(`f-${id}-liaison`,id,'authorLiaison',t.authorLiaison))}
      ${frow('PR Contact',contactSelectHtml(`f-${id}-prContact`,id,'publicity.prContact',t.publicity.prContact))}
    </div>
  </div>`;}

// Round 6, item 3 — the HTML/Word export buttons used to sit inside the
// Content & Marketing box (position 3 in the accordion), which only made
// sense back when the export only covered Content & Marketing's 6 fields
// (round 2/4). Now that the export covers the entire title record (item 2),
// it no longer belongs tucked inside one specific section — moved up here,
// next to Key Contacts, which is the one block that always renders above
// the numbered accordion regardless of which sections are open/closed.
// Round 10, item 7 — moved again, this time to sit directly beneath the new
// Cover & Folder Links strip (renderLinksStrip(), item 6) rather than next
// to Key Contacts. Buttons made a little bigger (.btn-export, up from
// .btn-sm) and the explanatory paragraph that used to sit next to them is
// deleted outright, per the brief — just the two buttons now.
function renderExportButtons(t){
  return `<div class="export-actions-row">
    <button class="btn btn-export" onclick="openHtmlOutput('${t.id}')">View HTML Output &#8599;</button>
    <button class="btn btn-export" onclick="downloadWordFile('${t.id}')">View Word File &#8681;</button>
  </div>`;
}

function renderAccordionSection(t,key){
  const st=getSectionStatus(t,key);
  const open=isOpen(t.id,key);
  const akey=`${t.id}-${key}`;
  // Item 30 — PO Tracker box made visually prominent (moved to position 2
  // in SECTION_KEYS above, defaults open, and gets its own highlight border
  // here) rather than reading as identical to every other accordion box.
  const prominentCls = key==='poTracker' ? ' po-prominent' : '';
  return `<div class="accord-section${prominentCls}" id="asec-${akey}">
    <div class="accord-header stripe-${st}" data-accord-header="${akey}" onclick="toggleAccord('${t.id}','${key}')">
      <div class="accord-header-inner">
        <span class="accord-label">${SECTION_LABELS[key]||key}</span>
        <span class="accord-arrow ${open?'open':''}">&#8250;</span>
      </div>
    </div>
    <div class="accord-body ${open?'open':''}" data-accord="${akey}">
      ${renderSectionBody(t,key)}
    </div>
  </div>`;
}
function renderSectionBody(t,key){
  switch(key){
    case 'commercial':return renderCommercial(t);
    case 'content':return renderContent(t);
    case 'author':return renderAuthor(t);
    case 'pipeline':return renderPipeline(t);
    case 'dates':return renderDates(t);
    case 'print':return renderPrint(t);
    case 'poTracker':return renderPoTracker(t);
    case 'publicity':return renderPublicity(t);
    case 'toc':return renderTOC(t);
    case 'productionNotes':return renderProductionNotes(t);
    case 'futureEdition':return renderFutureEdition(t);
    default:return '';
  }
}
// Round 6, item 4 — Pipeline/PO Tracker's early-return (which made them
// permanently un-collapsible) is removed; every section, including these
// two, now toggles the same way.
let poTrackerLoadedFor = {}; // titleId -> true once its live data has been fetched this session
// 2026-08-11 — toggleAccord() and the new jumpToSection() (item 9b) both
// need to "make a section open" (one toggles, one always-opens-never-
// closes), so the actual open/close mechanics are factored out here once.
// Item 6 fix included: autoexpand textareas (Selling Points/Quotes — the
// two taAuto() fields that couldn't be converted to richTa, see item 5's
// comment on why) size themselves via scrollHeight, which reads as 0 (or
// whatever CSS min-height happens to be) for any element inside a
// display:none ancestor — exactly the state a COLLAPSED accord-body sits
// in. Previously autoGrow() only ever ran once, globally, right after
// renderDetail() — for any section that was collapsed AT THAT MOMENT, its
// textareas got measured while invisible, baking in a wrong/tiny height
// that toggleAccord() (a plain class-toggle, no re-render) never
// recalculated on a later reopen. Fixed by re-running autoGrowAll() scoped
// to just this section's body every time it actually becomes visible.
function setAccordOpen(tid,key,openState){
  const k=`${tid}-${key}`;
  accordionOpen[k]=openState;
  const body=document.querySelector(`[data-accord="${k}"]`);
  if(body){ body.classList.toggle('open',openState); if(openState) autoGrowAll(body); }
  const hdr=document.querySelector(`[data-accord-header="${k}"]`);
  if(hdr){ const arr=hdr.querySelector('.accord-arrow'); if(arr) arr.classList.toggle('open',openState); }
  // PO Tracker's live-fetched tables (print estimates / PO & Invoice pulls)
  // used to load automatically because the section was always open on
  // render — now that it starts closed like everything else, kick the fetch
  // off the first time it's actually opened instead (once per title per
  // session; the "Loading…" placeholder in renderPoTracker() is what's
  // sitting there until this fires).
  if(key==='poTracker' && openState && !poTrackerLoadedFor[tid]){
    poTrackerLoadedFor[tid]=true;
    loadPoTrackerFor(tid);
  }
}
function toggleAccord(tid,key){
  const opening=!isOpen(tid,key);
  setAccordOpen(tid,key,opening);
  // Round 20 (2026-08-19) — David expanding a section (without necessarily
  // scrolling any further) is itself a meaningful "this is what I'm looking
  // at" signal for Recently Viewed's position-restore — see
  // updateRecentlyViewedPosition() below. Only on OPEN, not close: closing
  // a section isn't "I want to come back here", and the scroll-spy listener
  // (updateSectionScrollSpy()) will immediately supersede this with a more
  // precise offset anyway once David actually scrolls.
  if(opening) updateRecentlyViewedPosition(tid,key,0);
}
// Item 9b (2026-08-11) — clicking a sidebar item used to be a plain <a
// href="#asec-...">, which relies on the browser's native anchor-scroll —
// it scrolls to the section's OUTER box just fine, but does nothing to open
// it if it's currently collapsed, so David would land on an empty collapsed
// header rather than the content he clicked for. Now a real function: force
// the section open first (never closes an already-open one — this is a
// "take me there" action, not a toggle) via setAccordOpen(), THEN scroll.
// .accord-section already has scroll-margin-top set (index.html) to clear
// the fixed header, so a plain scrollIntoView is enough — no manual offset
// math needed here.
function jumpToSection(tid,key){
  if(!isOpen(tid,key)) setAccordOpen(tid,key,true);
  const el=document.getElementById(`asec-${tid}-${key}`);
  if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
  setActiveSideNavItem(key);
}
// Round 13 (2026-08-12) — sidebar's new "Top" entry. No accordion section to
// force open here (.detail-top isn't collapsible, it's always visible), so
// this is just the scroll+highlight half of jumpToSection() above, aimed at
// #dtop-${tid} instead of an asec-* section.
function jumpToTop(tid){
  const el=document.getElementById(`dtop-${tid}`);
  if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
  setActiveSideNavItem('top');
}
// Item 9a (2026-08-11) — scroll-spy active-state highlighting for the
// floating sidebar. The .toc-side-item.active CSS rule (index.html) already
// existed — it was written for this same feature but never actually wired
// up to anything in JS, so it's been permanently dead code until now.
function setActiveSideNavItem(key){
  document.querySelectorAll('.toc-side-item').forEach(a=>{
    a.classList.toggle('active', a.dataset.sectionKey===key);
  });
}
// Recomputes which section is "current" by finding the LAST accord-header
// whose top edge has scrolled up past a marker line just below the fixed
// app header, then falling back to the very first header if none has (i.e.
// David is still above/at the top of the content). Reading getBoundingClient
// Rect() for every header on each tick is cheap (11 sections, max) — no
// IntersectionObserver bookkeeping needed for something this small. Called
// from a rAF-throttled scroll listener (see window.addEventListener
// ('scroll', ...) below) so it costs nothing while idle and never runs more
// than once per animation frame while scrolling.
// 2026-08-11 — markerY MUST be >= .accord-section's own scroll-margin-top
// (index.html: calc(var(--hh) + 46px)) — caught live in dev-preview testing:
// with a smaller marker (was +24), jumpToSection()'s own scrollIntoView()
// lands a freshly-opened section's header at top≈hh+46, which sat BELOW the
// old +24 marker line — so the very next scroll-triggered recompute
// (scrollIntoView fires real scroll events) immediately reverted the
// highlight back to whatever section was active before the jump, undoing
// jumpToSection()'s own setActiveSideNavItem() call a moment later. +50
// clears the real +46 landing position with a small rounding buffer.
function updateSectionScrollSpy(){
  if(view!=='detail') return;
  const headers=document.querySelectorAll('.accord-header[data-accord-header]');
  if(!headers.length) return;
  const markerY=(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--hh'))||60)+50;
  let best=null;
  headers.forEach(h=>{ if(h.getBoundingClientRect().top<=markerY) best=h; });
  // Round 13 (2026-08-12) — used to fall back to headers[0] ("Dates &
  // Scheduling") whenever no header had scrolled past the marker yet, which
  // was ANY time David was still looking at the top box, since it had no
  // sidebar entry of its own to fall back to instead. Now that it does
  // (jumpToTop()/the 'top' entry above), that's the correct highlight for
  // this case, not a false-positive "Dates & Scheduling".
  if(!best){
    setActiveSideNavItem('top');
    // Round 20 (2026-08-19) — same "how far past its scroll-margin-anchored
    // top edge" measurement as the section case below, aimed at the fixed
    // #dtop-<id> box instead of an .accord-header, so Recently Viewed can
    // restore David to the exact scroll depth even when he left the page
    // scrolled somewhere inside the top box (before any accordion section).
    const dtop=selectedId&&document.getElementById(`dtop-${selectedId}`);
    updateRecentlyViewedPosition(selectedId,'top', dtop?Math.max(0,markerY-dtop.getBoundingClientRect().top):0);
    return;
  }
  const akey=best.getAttribute('data-accord-header'); // `${titleId}-${key}`
  if(!selectedId||!akey.startsWith(selectedId+'-')) return;
  const key=akey.slice(selectedId.length+1);
  setActiveSideNavItem(key);
  // Round 20 (2026-08-19) — pixels scrolled PAST this section's top edge
  // (beyond the marker line), so restoring later can reproduce roughly the
  // same visual depth into the section, not just "section is open". See
  // updateRecentlyViewedPosition()/restoreDetailPosition() below.
  updateRecentlyViewedPosition(selectedId,key,Math.max(0,markerY-best.getBoundingClientRect().top));
}
let scrollSpyTicking=false;
window.addEventListener('scroll', function(){
  if(scrollSpyTicking) return;
  scrollSpyTicking=true;
  requestAnimationFrame(()=>{ updateSectionScrollSpy(); scrollSpyTicking=false; });
}, {passive:true});

// ─── RECENTLY VIEWED (Round 20, 2026-08-19) ───
// David's problem: he's deep in a title, jumps to ISBN Manager/Quick Notes
// to check something, and has no way back except re-finding it via All
// Titles. Header dropdown (#rv-wrap, index.html — sits in the persistent
// #app-header, next to the nav tabs) lists the last few titles opened on
// this device and jumps straight back to one, INCLUDING the section/scroll
// depth David was actually looking at, not just the top of the title page.
// David-approved mockup: _mockups/recently_viewed_nav_mockup_2026-08-19.html.
//
// Same localStorage-per-device pattern already established for
// Contacts/Release Blocks/Printer Request text (see CONTACTS_LS_KEY /
// PRINTER_REQ_LS_PREFIX above) — a personal nav aid, not synced
// record-of-truth data, same accepted tradeoff: won't follow David to a
// different browser/device.
//
// JUDGEMENT CALL (flagged, not silently assumed) on how "position" is
// captured: this app's title detail page (renderDetail()) is ONE long
// scrolling page made of collapsible accordion sections (SECTION_KEYS),
// not separate tabs/routes — so "where David was" is really two things
// together: (a) which section was open/current, and (b) how far scrolled
// into it. Round 13 already built a scroll-spy (updateSectionScrollSpy())
// that knows the current section on every scroll tick, and a marker-line
// measurement it uses to find it — this piggybacks on both rather than
// adding a second, competing scroll-tracking mechanism:
//   - `section`: the SECTION_KEYS key (or 'top') the scroll-spy currently
//     considers active, updated live while viewing (updateSectionScrollSpy())
//     AND the instant a section is opened by hand (toggleAccord(), opening
//     only) so an expand-without-scrolling still counts as "this is what
//     I'm looking at".
//   - `offset`: pixels scrolled PAST that section's own top edge (same
//     scroll-margin-top marker line the scroll-spy already uses), so a
//     restore can land at roughly the same depth into a long section
//     (e.g. Content & Marketing), not just its header. Deliberately
//     RELATIVE to the section's own top rather than an absolute page
//     scrollY — absolute pixel offsets aren't reliable here because the
//     accordion's layout shifts depending on which OTHER sections happen
//     to be open above it; an offset anchored to the target section itself
//     survives that.
// Restoring is therefore: force the saved section open (or scroll to the
// fixed top box for 'top'), let one frame of layout settle, scrollIntoView
// to the section's top, then scroll the extra saved offset. Not
// pixel-perfect if the underlying content has changed length since (e.g.
// David added a paragraph then came back later), but "same section,
// same-ish depth" is a solid, honest approximation — see restoreDetail
// Position() below.
const RV_LS_KEY = 'bookHub_recentlyViewed_v1';
const RV_MAX = 8; // David's ask: "last 5-8 titles" — capped at the top of that range

function getRecentlyViewed(){
  try{
    if(typeof localStorage==='undefined') return [];
    const raw = localStorage.getItem(RV_LS_KEY);
    if(raw){ const arr=JSON.parse(raw); if(Array.isArray(arr)) return arr; }
  }catch(e){}
  return [];
}
function saveRecentlyViewed(list){
  try{ if(typeof localStorage!=='undefined') localStorage.setItem(RV_LS_KEY, JSON.stringify(list)); }catch(e){}
}
// Called once per real navigation-in (renderDetail(), above). Dedupes by
// title id — re-opening a title moves it to the top rather than creating a
// second entry, per David's explicit ask — and resets THIS entry's
// section/offset back to 'top'/0, since a fresh open genuinely does start
// at the top; live viewing then updates it via updateRecentlyViewedPosition().
function recordRecentlyViewed(t){
  if(!t||!t.id) return;
  let list=getRecentlyViewed().filter(e=>e.id!==t.id);
  list.unshift({
    id:t.id, title:t.title||'(untitled)', authors:t.authors||'',
    imprint:imprintKey(t.imprint), section:'top', offset:0, viewedAt:Date.now()
  });
  if(list.length>RV_MAX) list.length=RV_MAX;
  saveRecentlyViewed(list);
  renderRecentlyViewed();
}
// Live position tracking while a title is open — see the big comment block
// above for why section+offset, not absolute scrollY. Deliberately does NOT
// call renderRecentlyViewed() (no visible dropdown content depends on
// section/offset) so this stays cheap enough to call from a scroll listener.
function updateRecentlyViewedPosition(titleId,section,offset){
  if(!titleId) return;
  const list=getRecentlyViewed();
  const idx=list.findIndex(e=>e.id===titleId);
  if(idx===-1) return; // not tracked yet (shouldn't happen — recordRecentlyViewed() runs on every open first)
  list[idx].section=section;
  list[idx].offset=Math.max(0,Math.round(offset||0));
  saveRecentlyViewed(list);
}
function rvTimeAgo(ts){
  if(!ts) return '';
  const minutes=Math.floor((Date.now()-ts)/60000);
  if(minutes<1) return 'Just now';
  if(minutes<60) return minutes+'m ago';
  const hours=Math.floor(minutes/60);
  if(hours<24) return hours+'h ago';
  const days=Math.floor(hours/24);
  if(days===1) return 'Yesterday';
  if(days<7) return days+'d ago';
  return formatDate(new Date(ts).toISOString().slice(0,10)); // same date format as the rest of the app
}
// Repopulates the header dropdown (#rv-wrap/#rvDropdown, index.html). Called
// from render() (runs on every navigation) since the dropdown lives in the
// persistent #app-header, outside the #main innerHTML swaps everything else
// re-renders through.
function renderRecentlyViewed(){
  const wrap=document.getElementById('rv-wrap'), dd=document.getElementById('rvDropdown');
  if(!wrap||!dd) return;
  let list=getRecentlyViewed();
  // Prune entries for titles that no longer exist (Delete Title, Round 9) —
  // only once real data is actually loaded (data.titles starts empty before
  // sign-in/load completes — see init()'s pre-auth render() call — so
  // pruning against an empty array here would otherwise wipe the list on
  // every cold load before it ever got a chance to populate).
  if(data.titles && data.titles.length){
    const pruned=list.filter(e=>getTitle(e.id));
    if(pruned.length!==list.length){ list=pruned; saveRecentlyViewed(list); }
  }
  if(!list.length){ wrap.style.display='none'; dd.innerHTML=''; return; }
  wrap.style.display='flex';
  dd.innerHTML = `<div class="rv-dropdown-label">Recently Viewed</div>` +
    list.map(e=>`<button class="rv-item" data-imprint="${esc(e.imprint)}" onclick="openFromRecentlyViewed('${e.id}','${e.section||'top'}',${e.offset||0})">
      <span class="rv-item-accent"></span>
      <span class="rv-item-body">
        <span class="rv-item-title">${esc(e.title)}</span>
        <span class="rv-item-meta"><span class="rv-item-author">${esc(e.authors)}</span><span class="rv-item-time">${esc(rvTimeAgo(e.viewedAt))}</span></span>
      </span>
    </button>`).join('') +
    `<div class="rv-divider"></div><div class="rv-footnote">Last ${list.length} title${list.length===1?'':'s'} opened on this device &middot; not synced, same as Contacts/Release Blocks</div>`;
}
function toggleRV(e){
  if(e) e.stopPropagation();
  const trigger=document.getElementById('rvTrigger'), dd=document.getElementById('rvDropdown');
  if(!trigger||!dd) return;
  trigger.classList.toggle('open');
  dd.classList.toggle('open');
}
document.addEventListener('click', function(e){
  const wrap=document.getElementById('rv-wrap');
  if(!wrap || wrap.contains(e.target)) return;
  const trigger=document.getElementById('rvTrigger'), dd=document.getElementById('rvDropdown');
  if(trigger) trigger.classList.remove('open');
  if(dd) dd.classList.remove('open');
});
// Clicking a Recently Viewed item: navigate there normally (gotoDetail()
// itself re-records/re-opens the title, which resets its stored
// section/offset to 'top'/0 — see recordRecentlyViewed()), then restore the
// SAVED position on top of that. gotoDetail() is fully synchronous — it
// runs render()->renderDetail(), which assigns main.innerHTML directly, so
// by the time gotoDetail() returns the new DOM is already live and
// getBoundingClientRect()/scrollIntoView() below will force-compute correct
// layout even with no paint frame yet. This deliberately mirrors the
// existing jumpToSection()/jumpToTop() pattern above (same synchronous
// open-then-scroll, no rAF) rather than introducing a second, different
// timing mechanism — and for good reason found in testing: an earlier
// version of this function used nested requestAnimationFrame() calls to
// "wait for layout to settle", which turned out to be the FLAKY choice, not
// the safe one — rAF callbacks can be throttled/delayed by the browser
// (backgrounded tab, extension-driven automation, etc.), which intermittently
// left the restore never firing at all. Plain synchronous DOM work, same as
// the rest of this app's navigation, is what's actually reliable.
function openFromRecentlyViewed(id,section,offset){
  const trigger=document.getElementById('rvTrigger'), dd=document.getElementById('rvDropdown');
  if(trigger) trigger.classList.remove('open');
  if(dd) dd.classList.remove('open');
  gotoDetail(id);
  restoreDetailPosition(id,section,offset);
}
function restoreDetailPosition(id,section,offset){
  if(selectedId!==id) return; // navigated away again before this ran — don't fight whatever's on screen now
  if(!section || section==='top'){
    // Deliberately NOT jumpToTop() here — it scrollIntoView()s with
    // behavior:'smooth', and stacking an immediate scrollBy() on top of a
    // still-animating smooth scroll fights the browser's own animation
    // (observed as a visible stutter/overshoot in testing). Instant scroll,
    // same as the section branch below, so the two calls land cleanly.
    const dtop=document.getElementById(`dtop-${id}`);
    if(dtop) dtop.scrollIntoView({behavior:'auto',block:'start'});
    if(offset>20) window.scrollBy(0,offset);
    setActiveSideNavItem('top');
    updateRecentlyViewedPosition(id,'top',offset||0);
    return;
  }
  if(!isOpen(id,section)) setAccordOpen(id,section,true);
  const el=document.getElementById(`asec-${id}-${section}`);
  if(!el){ // stale/unknown section key (shouldn't happen — fail safe to top rather than do nothing)
    const dtop=document.getElementById(`dtop-${id}`);
    if(dtop) dtop.scrollIntoView({behavior:'auto',block:'start'});
    setActiveSideNavItem('top');
    return;
  }
  el.scrollIntoView({behavior:'auto',block:'start'});
  if(offset>20) window.scrollBy(0,offset);
  setActiveSideNavItem(section);
  updateRecentlyViewedPosition(id,section,offset||0);
}

// ─── SECTION RENDERS ───
function frow(label,inputHtml,cls=''){return `<div class="field-group ${cls}"><label class="field-label">${label}</label>${inputHtml}</div>`;}
function inp(id,val,ph,handler){return `<input type="text" id="${id}" value="${esc(val)}" placeholder="${esc(ph)}" oninput="${handler}">`;}
function ta(id,val,ph,handler,tall=''){return `<textarea id="${id}" class="${tall}" placeholder="${esc(ph)}" oninput="${handler}">${esc(val)}</textarea>`;}
// Auto-expanding variant (items 20/22) — grows with content instead of
// scrolling in a fixed frame. autoGrow() is called on input (live growth)
// and once after every renderDetail() via autoGrowAll() so a field that
// already has a lot of saved text opens at its full height, not a stub.
function taAuto(id,val,ph,handler){return `<textarea id="${id}" class="autoexpand" placeholder="${esc(ph)}" oninput="${handler};autoGrow(this)">${esc(val)}</textarea>`;}
// Item 21 — real formatting restore (not just auto-expand) for the three
// main Content & Marketing fields: a contenteditable surface with a tiny
// Bold/Italic/Paragraph toolbar (document.execCommand — deliberately the
// simple, well-understood mechanism here rather than a full third-party
// rich-text library dependency for three fields) so bold/italic/paragraph
// breaks actually persist, instead of a plain <textarea> flattening
// everything to unstyled text — which is exactly what broke copy-pasting
// formatted blurbs out to distributors (flagged 2026-07-22, now fixed).
// Stored value is the div's innerHTML; existing plain-text data (no tags)
// renders identically to before, so nothing already saved is disturbed.
// Round 11, item 5 (2026-08-11) — richTa() is now used well beyond the
// original 3 Content & Marketing fields (see the SECTION RENDERS below —
// Author/Print/Publicity/TOC/Production Notes/Future Edition fields that
// used to be plain taAuto() textareas). A real number of those fields carry
// EXISTING plain-text data saved with informal "one per line" newlines
// (Socials & Societies, Previous Publications, Printer Contacts notes,
// etc.) — a bare newline character has no meaning inside HTML/contenteditable
// (browsers collapse it, same as any other whitespace), so dropping that raw
// text straight into a contenteditable div as-is would visually COLLAPSE
// every existing multi-line entry onto one run-on line the moment this
// ships — not a real data loss (the stored string is untouched) but a
// convincing-looking one the first time David opens an old title. Guarded
// against here: plainToRichHtml() detects "no real HTML tags yet" and
// wraps each existing line in its own <p>, one time, purely for display —
// nothing is written back to the Sheet until David actually edits the
// field, at which point it saves as real HTML paragraphs from then on,
// same as any other richTa field.
function plainToRichHtml(val){
  if(!val) return '';
  if(/<[a-z][\s\S]*>/i.test(val)) return val; // already real HTML — leave untouched
  return val.split(/\r?\n/).map(line=>line.trim()?`<p>${esc(line)}</p>`:'').join('');
}
function richTa(titleId,fieldKey,path,val,ph){
  const editId=`f-${titleId}-${fieldKey}`;
  const isEmpty = !val || !val.replace(/<[^>]+>/g,'').trim();
  const displayHtml = plainToRichHtml(val);
  return `<div class="richtext-wrap">
    <div class="richtext-toolbar">
      <button type="button" class="rt-btn" onmousedown="event.preventDefault()" onclick="document.execCommand('bold')"><b>B</b></button>
      <button type="button" class="rt-btn" onmousedown="event.preventDefault()" onclick="document.execCommand('italic')"><i>I</i></button>
      <button type="button" class="rt-btn" onmousedown="event.preventDefault()" onclick="document.execCommand('formatBlock',false,'p')">¶</button>
      <!-- Item 8 (2026-08-11) — numbered list, asked for specifically on the
           TOC field but wired into the shared toolbar (every richTa field
           gets it) rather than a TOC-only special case, per item 5's "extend
           consistently" steer. insertOrderedList produces a real <ol><li>
           structure; see htmlFragmentToRtfParagraphs()'s <ol> handling below
           for why the Word export needed a matching update to not silently
           drop list content. -->
      <button type="button" class="rt-btn" onmousedown="event.preventDefault()" onclick="document.execCommand('insertOrderedList')" title="Numbered list">1.</button>
    </div>
    <div id="${editId}" class="richtext" contenteditable="true" data-placeholder="${esc(ph)}" data-empty="${isEmpty?'1':'0'}"
      oninput="fc('${titleId}','${path}',this.innerHTML);this.dataset.empty=this.innerText.trim()?'0':'1'"
      onfocus="this.dataset.wasEmpty=this.dataset.empty;try{document.execCommand('defaultParagraphSeparator',false,'p')}catch(e){}" onblur="this.dataset.empty=this.innerText.trim()?'0':'1'"
      >${displayHtml}</div>
  </div>`;
}

function renderCommercial(t){const id=t.id;const c=t.commercial;const p=t.price;
  // Item 18 design decision (see build report for full reasoning): Backup
  // ISBN fields removed entirely from the UI (data preserved untouched on
  // the Sheet, see _backupIsbnPbkRaw/_backupIsbnEbkRaw in rowToTitle/
  // titleToRow). In their place, the three LIVE ISBN fields are locked
  // read-only by default — each has its own explicit "Unlock to edit"
  // toggle that requires a confirm() before it opens the field up, so an
  // accidental overwrite needs a deliberate two-step action instead of one
  // stray keystroke. Locks reset to locked every time the detail view is
  // re-rendered (session-only state, by design — see isbnLockRow()).
  const isbnField=(field,label)=>{
    const locked = isbnLockRow(id,field);
    const val = c[field];
    // Round 7, item 3a — the pool-picker (openPool()/pickISBN() above)
    // already keeps its own list to unassigned-only ISBNs, but these three
    // free-text fields write straight to the title via fc() with zero
    // validation against data.isbns, completely bypassing that protection.
    // findIsbnConflict() checks whether the typed value already matches an
    // ISBN assigned to a *different* title; conflicts show inline instantly
    // (onIsbnFieldInput) and are confirm()-gated on blur (onIsbnFieldBlur)
    // so a duplicate needs a deliberate "yes, really" rather than a stray
    // keystroke — same "warn, don't silently allow" posture as the
    // OneDrive/local-path cover-URL detection above.
    const conflict = findIsbnConflict(id, val);
    return frow(label, `<div class="isbn-row">
      <input type="text" id="f-${id}-${field}" value="${esc(val)}" ${locked?'readonly':''} oninput="onIsbnFieldInput('${id}','${field}',this.value)" onblur="onIsbnFieldBlur('${id}','${field}',this)">
      <button class="lock-btn ${locked?'locked':'unlocked'}" title="${locked?'Locked — click to unlock and edit':'Unlocked — click to lock again'}" onclick="toggleIsbnLock('${id}','${field}')">${locked?'&#128274;':'&#128275;'}</button>
      <button class="btn btn-sm" onclick="openPool('${id}','commercial.${field}','${esc(label)}')">Assign</button>
    </div>
    <div class="isbn-dup-warn" id="isbn-dup-warn-${id}-${field}">${conflict?'<span class="cover-url-warn">&#9888; Already assigned to “'+esc(conflict.assignedToTitleName||conflict.assignedToTitleId)+'” — check this isn\'t a duplicate.</span>':''}</div>`);
  };
  return `<div class="field-tint"><div class="field-grid-3">
    ${isbnField('isbnPbk','ISBN (PBK)')}
    ${isbnField('isbnHbk','ISBN (HBK)')}
    ${isbnField('isbnEbk','ISBN (EBK)')}
    ${/* Round 11, item 4a (2026-08-11) — simplified from 4 currency-specific
        fields to 1 field per format, reordered PBK/EBK/HBK per David's ask.
        "Cover Price PBK ($)" (price.pbkUSD) is removed from the UI entirely
        — but NOT from the data model/Sheet: 9 of 26 live titles carry real
        $-price data in that exact key (checked live against the actual
        Sheet before touching this, not assumed empty), so it's preserved
        untouched in price_json (see defTitle()/rowToTitle's price object) —
        same non-destructive precedent as the Backup ISBN fields' removal
        (item 18, an earlier round). Flagged to David in the build report:
        that USD PBK figure is now archived/inaccessible in the UI, not
        merged anywhere — his call whether it needs to resurface. */''}
    ${frow('Cover Price PBK',inp(`f-${id}-pbkGBP`,p.pbkGBP,'e.g. 14.99','fc(\''+id+'\',\'price.pbkGBP\',this.value)'))}
    ${frow('Cover Price EBK',inp(`f-${id}-ebkUSD`,p.ebkUSD,'','fc(\''+id+'\',\'price.ebkUSD\',this.value)'))}
    ${frow('Cover Price HBK',inp(`f-${id}-hbkGBP`,p.hbkGBP,'','fc(\''+id+'\',\'price.hbkGBP\',this.value)'))}
    ${frow('Trim Size',inp(`f-${id}-trimSize`,c.trimSize,'e.g. 198x129mm','fc(\''+id+'\',\'commercial.trimSize\',this.value)'))}
    ${frow('Pages',`<input type="number" id="f-${id}-pages" value="${esc(c.pages)}" min="0" oninput="fc('${id}','commercial.pages',this.value)">`)}
    ${/* Round 11, item 4c — free-text reference field, purely for David's
        own notes (e.g. "front matter i-iv; body of book 1-172"), sat next
        to Pages. Stored as productionNotes_json.pagesBreakdown, same
        no-new-Sheet-column pattern as illustrationsText just below. */''}
    ${frow('Pages Breakdown',inp(`f-${id}-pagesBreakdown`,c.pagesBreakdown,'e.g. front matter i-iv; body of book 1-172','fc(\''+id+'\',\'commercial.pagesBreakdown\',this.value)'))}
    ${frow('Category UK',inp(`f-${id}-categoryUK`,c.categoryUK,'','fc(\''+id+'\',\'commercial.categoryUK\',this.value)'))}
    ${frow('Category USA',inp(`f-${id}-categoryUSA`,c.categoryUSA,'','fc(\''+id+'\',\'commercial.categoryUSA\',this.value)'))}
    ${frow('Nielsen Notified',`<label class="field-row"><input type="checkbox" ${c.nielsenNotified?'checked':''} onchange="fc('${id}','commercial.nielsenNotified',this.checked)"> Notified</label>`)}
    ${frow('Illustrations',inp(`f-${id}-illustrationsText`,c.illustrationsText,'e.g. black and white images: 10, colour images: 20, posters and photographs','fc(\''+id+'\',\'commercial.illustrationsText\',this.value)'),'full')}
  </div></div>`;}

function renderContent(t){const id=t.id;const c=t.content;
  return `<div class="field-grid">
    ${frow('Full Description',richTa(id,'fullDesc','content.fullDescription',c.fullDescription,'Full marketing description…'),'full')}
    ${frow('Jacket Blurb',richTa(id,'jacketBlurb','content.jacketBlurb',c.jacketBlurb,'Back cover blurb…'),'full')}
    ${frow('Brief Description',richTa(id,'briefDesc','content.briefDescription',c.briefDescription,'Short description…'),'full')}
    ${frow('Sales Handle',inp(`f-${id}-salesHandle`,c.salesHandle,'One-line sales handle…',`fc('${id}','content.salesHandle',this.value)`),'full')}
    ${frow('Selling Points (one per line)',taAuto(`f-${id}-sellingPoints`,c.sellingPoints,'One selling point per line…',`fc('${id}','content.sellingPoints',this.value)`),'full')}
    ${frow('Quotes (one per line)',taAuto(`f-${id}-quotes`,c.quotes,'Online and print quotes, one per line…',`fc('${id}','content.quotes',this.value)`),'full')}
    ${frow('Target Audience',inp(`f-${id}-targetAud`,c.targetAudience,'',`fc('${id}','content.targetAudience',this.value)`))}
    ${frow('Keywords / Metadata',inp(`f-${id}-keywords`,c.keywords,'',`fc('${id}','content.keywords',this.value)`))}
  </div>`;}
  // Round 6, item 3 — the "View HTML Output"/"View Word File" buttons that
  // used to live in this box (item 11, Round 2) moved up to
  // renderExportButtons(), next to Key Contacts — see that function's
  // comment for why.

function renderAuthor(t){const id=t.id;const a=t.authorInfo;
  // Item 12 (Round 2) — Author Liaison moved OUT of this box entirely, into
  // the new standalone Key Contacts block under the title header (see
  // renderKeyContacts()) — it's no longer rendered here.
  //
  // Round 11, item 7 (2026-08-11) — David asked for a single new
  // "Contributor(s)" field positioned right after Author Bio/Author
  // Hometown, explicitly NOT a multi-author dynamic-list system. This box
  // already had a field doing exactly that job — "Other Contributors"
  // (authorInfo.otherContributors) — just sitting lower down (after
  // Previous Publications, per the 7/26 item-24 reorder above) and under a
  // slightly different name. Rather than add a genuinely duplicate field
  // covering the same purpose, this is that existing field RENAMED to
  // "Contributor(s)" and MOVED to the position David asked for — same data,
  // same storage key (authorInfo.otherContributors), nothing lost. Flagged
  // in the build report: if David actually wants two distinct fields (this
  // one AND a separate brand-new one), say so and it's a two-minute add.
  // Item 21/23 (7/26, still current) — Socials/Previous Publications stayed
  // as auto-expanding fields; Round 11 item 5 upgrades them (and this one)
  // to full rich-text (richTa) — see that item's comment on plainToRichHtml()
  // in richTa() above for how existing "one per line" plain data is handled
  // without visually collapsing.
  return `<div class="field-grid">
    ${frow('Author Bio',richTa(id,'bio','authorInfo.bio',a.bio,''),'full')}
    ${frow('Author Hometown',inp(`f-${id}-hometown`,a.hometown,'',`fc('${id}','authorInfo.hometown',this.value)`))}
    ${frow('Contributor(s)',richTa(id,'otherContribs','authorInfo.otherContributors',a.otherContributors,'Any additional contributor(s), separate from the main author(s)…'),'full')}
    ${frow('Socials & Societies',richTa(id,'socials','authorInfo.socials',a.socials,'One per line is fine…'),'full')}
    ${frow('Previous Publications',richTa(id,'prevPubs','authorInfo.previousPublications',a.previousPublications,''),'full')}
  </div>`;}

// Items 25/26 — reworked pipeline: each stage is its own bounded box with
// its status shown inside it (not a floating pill elsewhere), grouped into
// PIPELINE_GROUPS with zero gap between adjacent stages in the same group
// (reads as one connected chain) and a visible gap between groups (matches
// the row-blocking pattern in David's "Book Planning 2025" source sheet —
// see PIPELINE_GROUPS comment above for exactly which rows that was read
// from). Items 27/28 — Expected Date shrunk, Notes widened, via the
// .stage-box grid-template-columns in index.html rather than equal columns.
// Round 12, item 2e — legend/key, click-through order at a glance. Built
// off PIPELINE_STAGE_STATUSES (the same array cycleStage() cycles through)
// and reuses the real .stage-btn/.stage-* classes rather than hardcoding
// swatch colours a second time, so the legend can never drift out of sync
// with the actual button colours — if the status set or its colours ever
// change again, this updates itself automatically. Non-interactive
// (pointer-events:none via .legend-chip, see index.html) — it's a key, not
// a control.
function pipelineLegendHtml(){
  const chips=PIPELINE_STAGE_STATUSES.map((s,i)=>{
    const cls='stage-'+s.toLowerCase().replace(/ /g,'-');
    const arrow = i<PIPELINE_STAGE_STATUSES.length-1 ? '<span class="pipeline-legend-arrow">&#8594;</span>' : '';
    return `<span class="stage-btn legend-chip ${cls}">${esc(s)}</span>${arrow}`;
  }).join('');
  return `<div class="pipeline-legend"><span class="pipeline-legend-label">Click-through order:</span>${chips}</div>`;
}
// Round 12, item 2a — each PIPELINE_GROUPS category gets its own
// background/accent tint (see .pipeline-group[data-cat] in index.html) via
// a slug derived from the group's own label, so a future group
// addition/rename in PIPELINE_GROUPS needs no parallel edit here — it just
// falls back to the neutral default (--border2/transparent) until a
// matching data-cat rule is added. Colours deliberately avoid the sage/
// amber/terra hues already reserved for stage-status meaning (Complete/In
// Progress/overdue) and the orange/teal imprint colours, so a category tint
// can never be misread as a status or an imprint — see build report for the
// exact palette + reasoning, flagged as a judgement call for David to
// course-correct.
function pipelineCatSlug(label){ return String(label).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }
function renderPipeline(t){const id=t.id;
  const byName={}; t.pipeline.stages.forEach((s,i)=>byName[s.name]={s,i});
  const groupsHtml=PIPELINE_GROUPS.map(g=>{
    const boxes=g.stages.map(name=>{
      const {s,i}=byName[name]||{};
      if(!s)return '';
      const cls='stage-'+s.status.toLowerCase().replace(/ /g,'-');
      return `<div class="stage-box">
        <span class="stage-box-num">${i+1}.</span>
        <span class="stage-box-name">${esc(s.name)}</span>
        <button class="stage-btn ${cls}" data-stage-btn="${id}-${i}" onclick="cycleStage('${id}',${i})">${esc(s.status)}</button>
        <input type="date" class="stage-date-input" value="${esc(s.expectedDate)}" onchange="stageChange('${id}',${i},'expectedDate',this.value)">
        <input type="text" class="stage-notes-input" value="${esc(s.notes)}" placeholder="Notes…" oninput="stageChange('${id}',${i},'notes',this.value)">
      </div>`;
    }).join('');
    return `<div class="pipeline-group" data-cat="${pipelineCatSlug(g.label)}"><div class="pipeline-group-label">${esc(g.label)}</div><div class="pipeline-group-boxes">${boxes}</div></div>`;
  }).join('');
  return `<div class="pipeline-chain">${pipelineLegendHtml()}${groupsHtml}</div>`;}

// Item 13 — day-count colour now driven by computeDayInfo()'s shared
// tiering (item 13 bug fix — "X days" no longer shares the full-red alarm
// colour with an actually-passed date), and item 15 — a published title
// shows "Published" here too rather than attempting a day count at all.
function renderDates(t){const id=t.id;const d=t.dates;
  const compPrint=calcAutoPrint(d.streetDate);
  const pdVal=d.autoPrintDate?compPrint:d.printDate;
  const info=computeDayInfo(t);
  const colorVar={published:'var(--sage)',ok:'var(--sage)',notice:'var(--amber-border)','due-soon':'#B8722E',overdue:'var(--terra)',neutral:'var(--text3)'}[info.colorClass]||'var(--text3)';
  const ddHtml=`<span style="color:${colorVar};font-weight:600">${esc(info.kind==='overdue'?'OVERDUE — '+info.label:info.label)}</span>`;
  // Item 18 (Round 2) — root cause of "the print-date auto-calculate
  // element knocks the row beneath it out of alignment": the checkbox+label
  // used to sit ABOVE the date input inside this one field-group, which
  // pushed THIS input down a full extra line versus its row-mate (Street
  // Date's input sits directly under its label, one line up) — so even
  // though both fields are technically in the same CSS grid row, their
  // <input> boxes didn't line up with each other, and the checkbox's shadow
  // was cast onto whatever this row's height decided for the row beneath
  // it too. Fix: input now comes FIRST (lines up with every sibling input
  // in the grid), auto-calculate checkbox is a small caption BELOW it
  // instead — functionally identical, but no longer disturbs row alignment.
  return `<div class="field-grid">
    ${frow('Release Block',releaseBlockSelectHtml(`f-${id}-releaseBlock`,id,t.blockId))}
    ${frow('Soft Date',`<div class="date-long-wrap"><input type="date" class="date-long-display" id="f-${id}-softDate" value="${esc(d.softDate)}" onchange="fc('${id}','dates.softDate',this.value)" oninput="syncDateDisplay(this)"><span class="date-long-overlay${d.softDate?'':' is-empty'}">${esc(d.softDate?formatDateLong(d.softDate):'')}</span></div>`)}
    ${frow('Street Date',`<div class="date-long-wrap"><input type="date" class="date-long-display" id="f-${id}-streetDate" value="${esc(d.streetDate)}" onchange="onStreetDateChange('${id}',this.value)" oninput="syncDateDisplay(this)"><span class="date-long-overlay${d.streetDate?'':' is-empty'}">${esc(d.streetDate?formatDateLong(d.streetDate):'')}</span></div>`)}
    ${frow('Print Date',`<div class="date-long-wrap"><input type="date" class="date-long-display" id="f-${id}-printDate" value="${esc(pdVal)}" ${d.autoPrintDate?'readonly':''} onchange="fc('${id}','dates.printDate',this.value)" oninput="syncDateDisplay(this)"><span class="date-long-overlay${pdVal?'':' is-empty'}">${esc(pdVal?formatDateLong(pdVal):'')}</span></div><label style="font-size:.72rem;color:var(--text3);display:flex;align-items:center;gap:4px;margin-top:4px"><input type="checkbox" ${d.autoPrintDate?'checked':''} onchange="onAutoPrint('${id}',this.checked)"> Auto-calculate (street date −60 days)</label>`)}
    ${frow('Release Note',inp(`f-${id}-releaseNote`,d.releaseNote,'Why a date moved / what’s happening…',`fc('${id}','dates.releaseNote',this.value)`),'full')}
    ${frow('Print Status',`<div id="f-${id}-daysToprint" style="padding:6px 0 2px;font-size:.9rem">${ddHtml}</div><select id="f-${id}-printStatusOverride" style="margin-top:2px" onchange="onPrintStatusOverrideChange('${id}',this.value)"><option value="" ${!d.printStatusOverride?'selected':''}>Auto (from Print Date)</option>${Object.keys(PRINT_STATUS_OVERRIDES).map(v=>`<option value="${esc(v)}" ${d.printStatusOverride===v?'selected':''}>${esc(v)}</option>`).join('')}</select><div style="font-size:.7rem;color:var(--text3);margin-top:3px">Leave on Auto to derive from Print Date; pick a value here to lock it — it won't be overridden back to Overdue automatically.</div>`)}
  </div>`;}

function renderPrint(t){const id=t.id;const p=t.print;
  const contactRows=(p.printerContacts||[]).map((pc,i)=>`<div class="printer-row">
      <input class="pname" type="text" value="${esc(pc.name)}" placeholder="Printer name" oninput="printerContactChange('${id}',${i},'name',this.value)">
      <input type="email" value="${esc(pc.email)}" placeholder="email" oninput="printerContactChange('${id}',${i},'email',this.value)">
      <button class="btn-danger btn-sm" onclick="removePrinterContact('${id}',${i})">Remove</button>
    </div>`).join('');
  return `<div class="field-grid">
    ${frow('Print Estimate / Quotes',richTa(id,'printEstimate','print.printEstimate',p.printEstimate,'Record printer quotes here…'),'full')}
    ${frow('SCB eBook Cover Spec',inp(`f-${id}-scbSpec`,p.scbEbookCoverSpec,'',`fc('${id}','print.scbEbookCoverSpec',this.value)`),'full')}
    ${frow('For LSI Notes',richTa(id,'forLsi','print.forLsiNotes',p.forLsiNotes,''),'full')}
    <div class="field-group full"><label class="field-label">Printer Contacts</label>
      <div class="printer-contacts">${contactRows}</div>
      <button class="btn btn-sm" style="margin-top:8px" onclick="addPrinterContact('${id}')">+ Add Printer Contact</button>
    </div>
    <div class="field-group full"><label class="field-label">Printer Estimate Request — copy to email</label>
      <div style="font-size:.72rem;color:var(--text3);margin-bottom:6px">Title/ISBN auto-filled below (and Trim/Page count too, where already set in Commercial). Everything else is a *** placeholder — type straight over any of it, this whole block is plain editable text, then hit Copy and paste into your email to the printer.</div>
      <textarea id="f-${id}-printerReq" class="printer-req-textarea" rows="17" spellcheck="false" oninput="onPrinterReqInput('${id}',this.value)">${esc(getPrinterRequestText(t))}</textarea>
      <div style="margin-top:8px">
        <button class="btn btn-sm" id="f-${id}-printerReqCopyBtn" onclick="copyPrinterRequest('${id}')">Copy</button>
      </div>
    </div>
  </div>`;}

// Printer Estimate Request generator (2026-08-16, David's request, Part 2
// of the same round as the PO Tracker Loading-hang fix). Per-title so it
// can auto-populate Title + paperback ISBN — deliberately a single flat
// plain-text <textarea>, NOT a form of separate locked/unlocked fields and
// NOT contenteditable with styled label spans: David was explicit that
// this must paste cleanly into an email body with the "Title:"/"Trim:"/etc
// labels reading as ordinary inline text, same weight as everything else,
// no heading/bold markup riding along on copy. A <textarea> can only ever
// hold plain text, so that requirement is structurally guaranteed rather
// than something to remember to strip later.
// Binding: Paperback / Cover: Matte / the Qty list are fixed constants per
// David's literal brief — checked the rest of the Hub first (Print
// Estimate/Quotes free-text field, PO Tracker's PO Log sheet) for any sign
// these actually vary per title; found none, so they stay hardcoded as
// given, not made configurable.
// "Spine thickness: *** PLEASE ADVISE" is kept as literal trailing template
// text, per David's note that this is a genuine question TO the printer
// (spine thickness depends on their own stock/page-count calc), not a
// field for David to fill in himself.
// Trim/Page count DEVIATION, flagged here and in the delivery report: the
// brief said these have "no obvious structured home" in the Hub and should
// just be blank *** — but Commercial already has real per-title "Trim
// Size" (commercial.trimSize, e.g. "198x129mm") and "Pages"
// (commercial.pages) fields that are exactly this data, not a coincidental
// namesake. Auto-filling from them when set (falling back to *** when a
// title has neither yet) avoids making David retype data the Hub already
// holds, and doesn't reduce editability — the textarea stays fully
// overtype-able either way. Bleeds/Insides/Images/Delivery were checked
// the same way and have no existing match anywhere in the app, so those
// stay plain *** as specified.
// Persistence: localStorage only, per-device, same documented tradeoff
// already established for Contacts (see CONTACTS_LS_KEY above) — this is a
// one-off drafting scratchpad for an outbound email, not shared record-of-
// truth data, so it doesn't warrant a new Titles-sheet column (which would
// need a live Sheet schema change David/Marcus would have to coordinate,
// for something this disposable). If a title's saved draft is ever wiped
// (cleared browser storage, different device), reopening the section just
// regenerates a fresh default from Title/ISBN/Trim/Pages again.
const PRINTER_REQ_LS_PREFIX = 'bookHub_printerReqText_v1_';
function buildDefaultPrinterRequestText(t){
  const isbn=((t.commercial&&t.commercial.isbnPbk)||'').trim();
  const titleLine=(t.title||'')+(isbn?' — ISBN '+isbn:'');
  const trim=((t.commercial&&t.commercial.trimSize)||'').trim();
  const pagesRaw=t.commercial&&t.commercial.pages;
  const pages=(pagesRaw!==undefined&&pagesRaw!==null&&String(pagesRaw).trim()!=='')?String(pagesRaw).trim():'';
  return `Title: ${titleLine}

Trim: ${trim||'***'}

Bleeds:  ***

Page count:  ${pages||'***'}

Insides:  ***

Images: Colour *** / b&w ***

Binding: Paperback

Cover: Matte

Qty: please offer prices for the following:

Qty (1) 50, (2) 200 (3) 300 (4) 700

Delivery: ***

Spine thickness: *** PLEASE ADVISE`;
}
function getPrinterRequestText(t){
  try{
    if(typeof localStorage!=='undefined'){
      const saved=localStorage.getItem(PRINTER_REQ_LS_PREFIX+t.id);
      if(saved!=null) return saved;
    }
  }catch(e){}
  return buildDefaultPrinterRequestText(t);
}
function onPrinterReqInput(titleId,value){
  try{ if(typeof localStorage!=='undefined') localStorage.setItem(PRINTER_REQ_LS_PREFIX+titleId,value); }catch(e){}
}
function copyPrinterRequest(titleId){
  const ta=document.getElementById('f-'+titleId+'-printerReq');
  if(!ta) return;
  const btn=document.getElementById('f-'+titleId+'-printerReqCopyBtn');
  const showCopied=()=>{ if(btn){const orig=btn.textContent;btn.textContent='Copied!';setTimeout(()=>{btn.textContent=orig;},1500);} };
  navigator.clipboard.writeText(ta.value).then(showCopied).catch(()=>{
    ta.select();
    try{ document.execCommand('copy'); showCopied(); }catch(e){}
  });
}

// Item 29 design decision (full reasoning in the build report): this box
// now surfaces THREE things side by side rather than picking just one:
//   1. The existing per-title print-ESTIMATE pull (unchanged) — ISBN/title-
//      matched against the older Printer_Quotes_Per_Title_Complete sheet.
//   2. A NEW, read-only, best-effort pull from the separate "PO & Invoice
//      Tracker - Headpress" Sheet (Marcus, 2026-07-24) — that Sheet is
//      supplier/invoice-centric with NO title or ISBN column (confirmed
//      live: Tracker!A1:M1 headers are Date Received/Supplier/Invoice #/PO
//      Reference/Currency/Amount/Balance/Due Date/Status/Date Paid/Notes/
//      File), so a strict ISBN join isn't possible there — instead this
//      matches the title's own name as a case-insensitive substring inside
//      that Sheet's free-text Notes column (same "Book Title" substring-
//      match style already used for the older print-estimate sheet above),
//      clearly labelled as best-effort so it's never mistaken for a
//      guaranteed link.
//   3. A plain manual-entry free-text box (item 29: "David wants to add
//      info here manually either way") — stored per-title in this app's own
//      data (productionNotes_json.poManualNotes), independent of either
//      linked pull, so it works even when nothing matches automatically.
// Made prominent per item 30 — see po-prominent CSS class + SECTION_KEYS
// reorder (this box is now position 2, right after Commercial, and always
// open like Pipeline).
function renderPoTracker(t){const id=t.id;
  const key = t.commercial.isbnPbk || t.commercial.isbnHbk || '';
  return `<div class="field-grid">
    ${frow('PO Tracker ISBN Key (auto)',`<input type="text" value="${esc(key)}" readonly>`)}
    ${frow('Manual Override (title/tab name)',inp(`f-${id}-poOverride`,t.poTrackerTitleOverride,'Exact PO Log "Book Title" text or tab name — use if no ISBN yet','fc(\''+id+'\',\'poTrackerTitleOverride\',this.value)'))}
    <div class="field-group full" id="po-tracker-results-${id}">
      <label class="field-label">Matching Print Estimates (Printer_Quotes_Per_Title_Complete)</label>
      <div class="po-empty">Loading…</div>
    </div>
    <div class="field-group full" id="po-invoice-results-${id}">
      <div class="po-source-label">Matching POs / Invoices — best-effort match by title name (PO &amp; Invoice Tracker - Headpress)</div>
      <div class="po-empty">Loading…</div>
    </div>
    ${frow('Manual PO/Invoice Notes',richTa(id,'poManual','poManualNotes',t.poManualNotes,'Jot anything here manually — a PO number, a note about an invoice, whatever’s useful, independent of the linked pulls above…'),'full')}
  </div>`;}

async function loadPoTrackerFor(titleId){
  loadPrintEstimatesFor(titleId);
  loadPoInvoiceTrackerFor(titleId);
}

async function loadPrintEstimatesFor(titleId){
  const t=getTitle(titleId);if(!t)return;
  const container=document.getElementById('po-tracker-results-'+titleId);
  if(!container)return;
  if(devMode){ container.innerHTML='<div class="po-empty">Dev preview mode — PO tracker data isn\'t fetched (no live sign-in).</div>'; return; }
  const key=(t.commercial.isbnPbk||t.commercial.isbnHbk||'').trim();
  const override=(t.poTrackerTitleOverride||'').trim();
  if(!key && !override){ container.innerHTML='<div class="po-empty">No ISBN or manual override set — nothing to match against the print-estimate tracker yet.</div>'; return; }
  try{
    if(!poLogRowsCache){
      // Header row confirmed at row 3 of the live PO Log tab (rows 1-2 are
      // a title banner + blank spacer row, not part of the table).
      poLogRowsCache = await sheetsGet(CFG.PO_TRACKER_SHEET_ID, "'PO Log'!A3:L2000");
    }
    const dataRows = poLogRowsCache.slice(1);
    const matches = dataRows.filter(r=>{
      const bookTitle = (r[1]||'').toString();
      if(key && bookTitle.includes(key)) return true;
      if(override && bookTitle.toLowerCase().includes(override.toLowerCase())) return true;
      return false;
    });
    if(!matches.length){
      container.innerHTML='<div class="po-empty">No matching rows found in the print-estimate tracker\'s \'PO Log\' tab for this ISBN/override.</div>'+printEstimateOpenLink();
      return;
    }
    const rows = matches.map(r=>{
      const status=(r[7]||'').toString();
      const pillCls = /paid/i.test(status) ? 'po-status-paid' : /ordered/i.test(status) ? 'po-status-ordered' : 'po-status-other';
      return `<tr>
        <td>${esc(r[0]||'')}</td><td>${esc(r[2]||'')}</td><td>${esc(r[3]||'')}</td><td>${esc(r[4]||'')}</td>
        <td>${esc(r[6]||'')}</td><td><span class="po-status-pill ${pillCls}">${esc(status||'—')}</span></td><td>${esc(r[10]||'')}</td>
      </tr>`;
    }).join('');
    container.innerHTML = `<label class="field-label">Matching Print Estimates (Printer_Quotes_Per_Title_Complete)</label><table class="po-table"><thead><tr><th>Date</th><th>Printer</th><th>Qty</th><th>PO Number</th><th>Total Value</th><th>Status</th><th>Balance</th></tr></thead><tbody>${rows}</tbody></table>`+printEstimateOpenLink();
  }catch(e){
    // 2026-08-16 — a plain "Retry" button, not just "reopen this section":
    // the once-per-title-per-session load gate (poTrackerLoadedFor, set at
    // open time regardless of outcome) means toggling the accordion closed
    // and open again does NOT actually re-trigger the fetch after a
    // failure — only a direct call to this function does.
    container.innerHTML='<div class="po-empty">Could not load print-estimate tracker data: '+esc(e.message)+' <button class="btn btn-sm" onclick="loadPrintEstimatesFor(\''+titleId+'\')">Retry</button></div>'+printEstimateOpenLink();
    // Surface the same site-wide Reconnect banner every other auth failure
    // already uses (saveTitle/saveIsbn/loadAllData) — was previously the
    // one auth-failure path in the app that didn't do this.
    if(isAuthFailure(e)) showReconnect('Print-estimate lookup failed: signed out / token expired. Click Reconnect, then use Retry on the section.', true);
    console.error(e);
  }
}
function printEstimateOpenLink(){
  return `<p style="margin-top:8px"><a href="https://docs.google.com/spreadsheets/d/${esc(CFG.PO_TRACKER_SHEET_ID)}/edit" target="_blank" rel="noopener">Open full print-estimate tracker &#8599;</a></p>`;
}

// New (item 29) — best-effort read-only pull from the separate "PO &
// Invoice Tracker - Headpress" Sheet. That Sheet has no title/ISBN column,
// so this matches the title's own name (case-insensitive substring) against
// the Tracker tab's free-text Notes column — deliberately labelled
// "best-effort" in the UI rather than presented as a guaranteed join.
let poInvoiceRowsCache = null;
async function loadPoInvoiceTrackerFor(titleId){
  const t=getTitle(titleId);if(!t)return;
  const container=document.getElementById('po-invoice-results-'+titleId);
  if(!container)return;
  if(devMode){ container.innerHTML='<div class="po-source-label">Matching POs / Invoices — best-effort match by title name (PO &amp; Invoice Tracker - Headpress)</div><div class="po-empty">Dev preview mode — not fetched (no live sign-in).</div>'; return; }
  if(!CFG.PO_INVOICE_TRACKER_SHEET_ID){ container.innerHTML=''; return; }
  const titleNeedle=(t.title||'').trim().toLowerCase();
  if(!titleNeedle){ container.innerHTML=''; return; }
  try{
    if(!poInvoiceRowsCache){
      poInvoiceRowsCache = await sheetsGet(CFG.PO_INVOICE_TRACKER_SHEET_ID, "Tracker!A2:M1000");
    }
    const matches = poInvoiceRowsCache.filter(r=>{
      const notes=(r[11]||'').toString().toLowerCase();
      return notes.indexOf(titleNeedle)!==-1;
    });
    const label = `<div class="po-source-label">Matching POs / Invoices — best-effort match by title name (PO &amp; Invoice Tracker - Headpress)</div>`;
    if(!matches.length){
      container.innerHTML=label+'<div class="po-empty">No rows in the Tracker tab mention this title by name in their Notes — this is a best-effort text match, not a guaranteed link, so absence here doesn\'t mean nothing exists.</div>'+poInvoiceOpenLink();
      return;
    }
    const rows = matches.map(r=>{
      const status=(r[9]||'').toString();
      const pillCls = /paid/i.test(status)&&!/partial/i.test(status) ? 'po-status-paid' : /partial|unpaid/i.test(status) ? 'po-status-ordered' : 'po-status-other';
      return `<tr><td>${esc(r[0]||'')}</td><td>${esc(r[1]||'')}</td><td>${esc(r[2]||'')}</td><td>${esc(r[4]||'')}${esc(r[5]||'')}</td><td><span class="po-status-pill ${pillCls}">${esc(status||'—')}</span></td><td>${esc(r[11]||'')}</td></tr>`;
    }).join('');
    container.innerHTML = label+`<table class="po-table"><thead><tr><th>Date Recv'd</th><th>Supplier</th><th>Invoice #</th><th>Amount</th><th>Status</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`+poInvoiceOpenLink();
  }catch(e){
    // Same real-Retry fix as loadPrintEstimatesFor above — the once-per-
    // session load gate means "reopen the section" alone wouldn't re-fetch.
    container.innerHTML='<div class="po-empty">Could not load PO &amp; Invoice Tracker data: '+esc(e.message)+' <button class="btn btn-sm" onclick="loadPoInvoiceTrackerFor(\''+titleId+'\')">Retry</button></div>'+poInvoiceOpenLink();
    if(isAuthFailure(e)) showReconnect('PO & Invoice Tracker lookup failed: signed out / token expired. Click Reconnect, then use Retry on the section.', true);
    console.error(e);
  }
}
function poInvoiceOpenLink(){
  return `<p style="margin-top:8px"><a href="https://docs.google.com/spreadsheets/d/${esc(CFG.PO_INVOICE_TRACKER_SHEET_ID)}/edit" target="_blank" rel="noopener">Open full PO &amp; Invoice Tracker &#8599;</a></p>`;
}

// Item 12 (Round 2) — PR Contact moved OUT of this box, into the new
// standalone Key Contacts block under the title header (see
// renderKeyContacts()) — no longer rendered here.
function renderPublicity(t){const id=t.id;const p=t.publicity;
  // Round 12, item 1 (2026-08-12) — David's ask: rename this field's LABEL
  // from "Publicity Statement" to "Selling Points". Label only — fieldKey
  // ('pubStmt') and the underlying data path ('publicity.publicityStatement')
  // are untouched, so no data migration/mapping needed. Flagged in the build
  // report: Content & Marketing already has its own distinct field also
  // labelled "Selling Points" (c.sellingPoints, a one-per-line list, see
  // renderContent()) — this creates two same-named fields in different
  // boxes. Built exactly as asked since the brief was explicit and literal;
  // easy to pick a different label if this reads as confusing once live.
  return `<div class="field-grid">
    ${frow('Selling Points',richTa(id,'pubStmt','publicity.publicityStatement',p.publicityStatement,''),'full')}
    ${frow('Marketing Notes',richTa(id,'marketing','publicity.marketing',p.marketing,''),'full')}
    <p style="grid-column:1/-1;font-size:.78rem;color:var(--text3)">Amazon A+, PLS.ORG, Newsletter and Promo Film status now live in the Production Pipeline section above (they were duplicated in both places in the original app) — use each stage's Notes field for detail.</p>
  </div>`;}

// Round 11, items 5/8 (2026-08-11) — every field in this box converted from
// plain auto-expand textareas to full rich text (richTa), Table of Contents
// specifically being item 8's named target for numbered-list support (the
// "1." toolbar button lives in richTa() itself, shared by every rich field —
// see that function's comment for why it's not TOC-only).
function renderTOC(t){const id=t.id;const c=t.toc;
  return `<div class="field-grid">
    ${frow('Table of Contents',richTa(id,'toc','toc.tableOfContents',c.tableOfContents,''),'full')}
    ${frow('How I Came to Write This Book',richTa(id,'howIWrote','toc.howICameToWriteThis',c.howICameToWriteThis,''),'full')}
    ${frow('Excerpt',richTa(id,'excerpt','toc.excerpt',c.excerpt,''),'full')}
    ${frow('Competing Titles',richTa(id,'competing','toc.competingTitles',c.competingTitles,''),'full')}
  </div>`;}

function renderProductionNotes(t){const id=t.id;
  const items=t.productionNotes.checklist.map((c,i)=>`<div class="check-item ${c.checked?'done':''}">
    <input type="checkbox" id="chk-${id}-${i}" ${c.checked?'checked':''} onchange="checklistChange('${id}',${i},this.checked)">
    <label for="chk-${id}-${i}">${esc(c.text)}</label>
  </div>`).join('');
  return `<div class="checklist">${items}</div>
  <div class="field-grid" style="margin-top:14px">
    ${frow('Proofing Notes',richTa(id,'proofingNotes','productionNotes.proofingNotes',t.productionNotes.proofingNotes,''),'full')}
    ${frow('Typesetting Notes',richTa(id,'typesettingNotes','productionNotes.typesettingNotes',t.productionNotes.typesettingNotes,''),'full')}
  </div>`;}

function renderFutureEdition(t){const id=t.id;const f=t.futureEdition;
  return `<div class="field-grid">
    ${frow('Info & Changes for Future Edition',richTa(id,'futureInfo','futureEdition.infoAndChanges',f.infoAndChanges,''),'full')}
    ${frow('Print-Ready Files',`<select id="f-${id}-prf" onchange="fc('${id}','futureEdition.printReadyFilesStatus',this.value)"><option ${f.printReadyFilesStatus==='Not Ready'?'selected':''}>Not Ready</option><option ${f.printReadyFilesStatus==='Ready'?'selected':''}>Ready</option><option ${f.printReadyFilesStatus==='Submitted'?'selected':''}>Submitted</option></select>`)}
  </div>`;}

// Item 31 — Files & Links box removed entirely (renderFilesLinks/addLink/
// removeLink deleted along with it, 2026-07-26). That information is
// already effectively available at the top of the page via
// renderLinksStrip() (Cover Image URL / Images Folder / Working
// Folder), added 2026-07-15 — this box had become redundant with it.
// t.filesLinks itself is left in the data model/Sheet column untouched
// (same non-destructive approach as the Backup ISBN removal) in case any
// existing rows have data worth recovering later; it's just no longer
// rendered or editable from this UI.

// ─── ISBN VIEW ───
function renderISBNs(){
  const main=document.getElementById('main');
  const all=isbnFilter==='unassigned'?data.isbns.filter(r=>!r.assignedToTitleId&&!r.legacyArchived):data.isbns;
  const rows=all.map((r)=>{
    const fmtBadge=r.format?`<span class="isbn-badge isbn-badge-${r.format.toLowerCase()}">${esc(r.format)}</span>`:'<span class="isbn-badge isbn-badge-other">—</span>';
    const assigned=r.legacyArchived?`<span class="isbn-legacy">Archive: ${esc(r.assignedToTitleName)}</span>`:r.assignedToTitleId?esc(r.assignedToTitleName):'<em style="color:var(--text-muted)">Unassigned</em>';
    const assignBtn=(!r.assignedToTitleId&&!r.legacyArchived)?`<button class="btn btn-sm" onclick="isbnAssign('${esc(r.isbn)}')">Assign to Title</button>`:'';
    return `<tr><td>${esc(r.isbn)}</td><td>${fmtBadge}</td><td class="isbn-assign-cell">${assigned} ${assignBtn}</td>
      <td><input type="checkbox" ${r.nielsenNotified?'checked':''} onchange="isbnNielsen('${esc(r.isbn)}',this.checked)"></td></tr>`;
  }).join('');
  main.innerHTML=`<div style="margin-bottom:18px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
    <h2 style="font-family:var(--serif);font-weight:normal;font-size:1.3rem">ISBN Manager</h2>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label style="font-size:.85rem"><input type="radio" name="isbn-view-filter" value="all" ${isbnFilter==='all'?'checked':''} onchange="isbnFilter='all';renderISBNs()"> All ISBNs</label>
      <label style="font-size:.85rem"><input type="radio" name="isbn-view-filter" value="unassigned" ${isbnFilter==='unassigned'?'checked':''} onchange="isbnFilter='unassigned';renderISBNs()"> Unassigned Only</label>
      <button class="btn btn-sm" onclick="openAddISBN()">+ Add ISBN</button>
      <button class="btn btn-sm" onclick="openBulkAddISBN()">+ Bulk Add</button>
    </div>
  </div>
  ${!data.isbns.length?'<p style="color:var(--text3);margin-bottom:14px">The ISBNs tab is empty — per Marcus\'s delivery report, pool migration wasn\'t in his scope for this build. Whoever owns this needs to confirm where the live pool currently lives (e.g. the old ISBN Headpress.xlsx / Headpress Hub\'s local data) and import it here.</p>':''}
  <table class="isbn-table"><thead><tr><th>ISBN</th><th>Format</th><th>Assigned To</th><th>Nielsen Notified</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div id="add-isbn-form" class="hidden" style="margin-top:14px;background:var(--surface);border-radius:var(--r8);padding:16px;box-shadow:var(--shadow-sm)">
    <div class="field-grid"><div class="field-group"><label class="field-label">ISBN</label><input type="text" id="new-isbn-val" placeholder="978-1-..."></div>
    <div class="field-group"><label class="field-label">Format</label><select id="new-isbn-fmt"><option value="">—</option><option value="PBK">PBK</option><option value="EBK">EBK</option><option value="HBK">HBK</option></select></div></div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="btn btn-primary btn-sm" onclick="confirmAddISBN()">Add</button><button class="btn btn-sm" onclick="document.getElementById('add-isbn-form').classList.add('hidden')">Cancel</button></div>
  </div>
  <div id="bulk-isbn-form" class="hidden" style="margin-top:14px;background:var(--surface);border-radius:var(--r8);padding:16px;box-shadow:var(--shadow-sm)">
    <div class="field-group"><label class="field-label">Format (applies to the whole batch)</label><select id="bulk-isbn-fmt"><option value="">—</option><option value="PBK">PBK</option><option value="EBK">EBK</option><option value="HBK">HBK</option></select></div>
    <div class="field-group" style="margin-top:10px"><label class="field-label">ISBNs — one per line (paste a batch of 25/50 at once)</label>
      <textarea id="bulk-isbn-vals" rows="10" placeholder="978-1-...&#10;978-1-...&#10;978-1-..." style="width:100%;font-family:monospace;font-size:.85rem"></textarea>
    </div>
    <div id="bulk-isbn-result" style="font-size:.8rem;color:var(--text3);margin-top:6px"></div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="btn btn-primary btn-sm" onclick="confirmBulkAddISBN()">Add All</button><button class="btn btn-sm" onclick="closeBulkAddISBN()">Cancel</button></div>
  </div>`;}

// ─── QUICK NOTES — LIST/INDEX VIEW (item 5, Round 2; reworked item 6,
// Round 3) ───
// Round 2: before this, the only way to know a title had a quick note at
// all was to open its detail view and scroll to notice the floating
// panel's "recent" list — there was no way to see, at a glance, which
// titles across the whole catalogue had notes. This dedicated view (its
// own header tab) confirmed exactly that "at a glance" ask — David just
// wanted confirmation it existed, which it does, no rework needed there.
//
// Round 3 (item 6): additive on top, per David's live follow-up while
// reviewing this build — each title's INDIVIDUAL active notes now render
// as their own row (not just a one-line "latest note" preview), each with
// a checkbox. Checking a note off is an ARCHIVE action, not a strikethrough
// -in-place toggle: the note leaves the Active list and moves to a
// separate Archived view (the toggle below), so David can still look back
// at what's been addressed rather than it just vanishing. Nothing is ever
// deleted — see archiveQuickNote()/restoreQuickNote() further down (near
// saveQuickNote()).
function setQnListMode(mode){ qnListMode=mode; renderQuickNotesList(); }
function renderQuickNotesList(){
  const main=document.getElementById('main');
  const mode=qnListMode;
  const groups = data.titles
    .map(t=>({ t, notes:(t.quickNotes||[]).filter(n=> mode==='archived' ? n.archived : !n.archived) }))
    .filter(g=>g.notes.length);
  const toggleHtml = `<div class="qn-mode-toggle">
    <button type="button" class="qn-mode-btn ${mode==='active'?'active':''}" onclick="setQnListMode('active')">Active</button>
    <button type="button" class="qn-mode-btn ${mode==='archived'?'active':''}" onclick="setQnListMode('archived')">Archived</button>
  </div>`;
  const headingHtml = `<h2 style="font-family:var(--serif);font-weight:600;font-size:1.3rem;color:var(--text-oncream);margin-bottom:14px">Quick Notes</h2>`;
  if(!groups.length){
    const emptyMsg = mode==='archived'
      ? 'Nothing archived yet — checking off a note in the Active list moves it here.'
      : 'Jot one against any title using the &#128221; button (bottom-right) — it\'ll show up here, grouped by title.';
    main.innerHTML=headingHtml+toggleHtml+`<div class="empty-state"><h3>No ${esc(mode)} notes</h3><p>${emptyMsg}</p></div>`;
    return;
  }
  // Groups ordered by their most-recently-noted item first (same
  // most-recent-first ordering Round 2 already established). groups is
  // already filtered to non-empty .notes arrays above, so this is always
  // safe to compute.
  const latestTs = g => Math.max.apply(null, g.notes.map(n=>new Date(n.ts).getTime()||0));
  groups.sort((a,b)=> latestTs(b) - latestTs(a));
  const groupsHtml = groups.map(({t,notes})=>{
    const sortedNotes = notes.slice().sort((a,b)=>new Date(b.ts)-new Date(a.ts));
    const noteRows = sortedNotes.map(n=>{
      const when = new Date(n.ts).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
      if(mode==='active'){
        return `<div class="qn-note-row">
          <input type="checkbox" title="Mark addressed — archives this note" onclick="event.stopPropagation()" onchange="archiveQuickNote('${t.id}','${n.id}')">
          <div class="qn-note-text-wrap"><span class="qn-note-text">${esc(n.text)}</span><span class="qn-note-date">Noted ${esc(when)}</span></div>
        </div>`;
      }
      return `<div class="qn-note-row archived">
        <button type="button" class="qn-restore-btn" title="Restore to Active" onclick="event.stopPropagation();restoreQuickNote('${t.id}','${n.id}')">&#8635; Restore</button>
        <div class="qn-note-text-wrap"><span class="qn-note-text">${esc(n.text)}</span><span class="qn-note-date">Noted ${esc(when)}</span></div>
      </div>`;
    }).join('');
    return `<div class="qn-group">
      <div class="qn-group-header" onclick="gotoDetail('${t.id}')">
        <span class="qn-list-title">${esc(t.title)}</span>
        <span class="qn-list-count">${notes.length} note${notes.length===1?'':'s'}</span>
      </div>
      <div class="qn-group-notes">${noteRows}</div>
    </div>`;
  }).join('');
  main.innerHTML=headingHtml+toggleHtml+groupsHtml;
}

// ─── ISBN DUPLICATE-PREVENTION (Round 7, item 3a) ───
// Normalises an ISBN for comparison — strips hyphens/spaces so
// "978-1-915316-62-2" and "9781915316622" are recognised as the same
// number (typed formatting shouldn't be able to sneak a real duplicate
// past the check).
function isbnNormalize(s){ return String(s||'').toUpperCase().replace(/[^0-9X]/g,''); }
// Returns the conflicting data.isbns record if `value` is already assigned
// to a title OTHER than titleId, or null if there's no conflict (blank
// value, no match, or the match is this same title — e.g. re-saving its
// own already-assigned ISBN shouldn't trip a false warning).
function findIsbnConflict(titleId, value){
  const norm=isbnNormalize(value);
  if(!norm) return null;
  return (data.isbns||[]).find(r=>r.assignedToTitleId && r.assignedToTitleId!==titleId && isbnNormalize(r.isbn)===norm) || null;
}
function onIsbnFieldInput(titleId,field,value){
  fc(titleId,'commercial.'+field,value);
  const warnEl=document.getElementById('isbn-dup-warn-'+titleId+'-'+field);
  if(!warnEl) return;
  const conflict=findIsbnConflict(titleId,value);
  warnEl.innerHTML = conflict
    ? '<span class="cover-url-warn">&#9888; Already assigned to “'+esc(conflict.assignedToTitleName||conflict.assignedToTitleId)+'” — check this isn\'t a duplicate.</span>'
    : '';
}
// On leaving the field with a conflict still present, require an explicit
// "yes, really" via confirm() rather than silently letting a duplicate
// through — reverts the field back to blank on Cancel. This is the
// "block/require confirmation" half of the brief; the inline warning above
// is the "warn" half, shown live as soon as a match appears.
function onIsbnFieldBlur(titleId,field,inputEl){
  const conflict=findIsbnConflict(titleId,inputEl.value);
  if(!conflict) return;
  const ok=confirm('The ISBN "'+inputEl.value.trim()+'" is already assigned to "'+(conflict.assignedToTitleName||conflict.assignedToTitleId)+'".\n\nUse it here too anyway, creating a duplicate?');
  if(!ok){
    inputEl.value='';
    fc(titleId,'commercial.'+field,'');
    const warnEl=document.getElementById('isbn-dup-warn-'+titleId+'-'+field);
    if(warnEl) warnEl.innerHTML='';
  }
}

// ─── ISBN ASSIGN FROM DETAIL ───
function openPool(titleId,field,label){
  assignCtx={titleId,field,label};
  document.getElementById('isbn-assign-label').textContent='Assigning to: '+label;
  document.querySelectorAll('input[name="isbnfmt"]').forEach(r=>{if(r.value==='')r.checked=true;});
  renderISBNPoolList();
  document.getElementById('isbn-pool-modal').classList.remove('hidden');
}
function renderISBNPoolList(){
  const fmtEl=document.querySelector('input[name="isbnfmt"]:checked');
  const fmt=fmtEl?fmtEl.value:'';
  let avail=data.isbns.filter(r=>!r.assignedToTitleId&&!r.legacyArchived);
  if(fmt)avail=avail.filter(r=>r.format===fmt||(!r.format&&fmt===''));
  const el=document.getElementById('isbn-pool-list');
  if(!avail.length){el.innerHTML='<p style="padding:12px;color:var(--text3);font-size:.85rem">No unassigned ISBNs available for this format.</p>';return;}
  // 2026-08-11 (item 4b) — root cause of "genuinely hard to read" (Team
  // Inbox/Assign from ISBN Pool.png): the ISBN <span> had no explicit
  // `color` set at all, so it fell through to body{color:var(--text-oncream)}
  // — the light cream tone meant for THIS app's dark page chrome — instead
  // of a colour meant for text on a light surface. This modal (.modal) is a
  // white surface, so that cream text rendered as pale, barely-visible
  // near-white-on-white. Fixed by giving it an explicit --text colour, same
  // as every other real value shown on a light card surface in this app.
  el.innerHTML=avail.map(r=>`<div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;cursor:pointer" onclick="pickISBN('${esc(r.isbn)}')" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background=''">
    <span style="font-family:monospace;font-size:.85rem;color:var(--text)">${esc(r.isbn)}</span>
    <span class="isbn-badge isbn-badge-${(r.format||'other').toLowerCase()}">${r.format||'—'}</span>
  </div>`).join('');
}
function pickISBN(isbn){
  if(!assignCtx)return;
  fc(assignCtx.titleId,assignCtx.field,isbn);
  const rec=data.isbns.find(r=>r.isbn===isbn);
  if(rec){const t=getTitle(assignCtx.titleId);rec.assignedToTitleId=assignCtx.titleId;rec.assignedToTitleName=t?t.title:assignCtx.titleId;saveIsbn(rec);}
  const inputId=`f-${assignCtx.titleId}-${assignCtx.field.replace(/\./g,'-').replace('commercial-','')}`;
  const inp2=document.getElementById(inputId);if(inp2)inp2.value=isbn;
  document.getElementById('isbn-pool-modal').classList.add('hidden');
  debouncedSave(assignCtx.titleId);
}

// ─── ISBN MANAGER ACTIONS ───
function isbnAssign(isbn){
  const rec=data.isbns.find(r=>r.isbn===isbn);if(!rec)return;
  const titles=data.titles.map(t=>`<option value="${t.id}">${esc(t.title)}</option>`).join('');
  const d=document.createElement('div');d.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:250;display:flex;align-items:center;justify-content:center';
  d.innerHTML=`<div style="background:#fff;border-radius:8px;padding:24px;max-width:400px;width:100%;box-shadow:0 4px 18px rgba(0,0,0,.13)"><h3 style="font-family:var(--serif);font-weight:normal;margin-bottom:12px">Assign ${esc(isbn)}</h3><select id="isbn-assign-sel" style="width:100%;margin-bottom:14px">${titles}</select><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" onclick="this.closest('div[style]').remove()">Cancel</button><button class="btn btn-primary" onclick="confirmISBNAssign('${esc(isbn)}');this.closest('div[style]').remove()">Assign</button></div></div>`;
  document.body.appendChild(d);
}
function confirmISBNAssign(isbn){
  const sel=document.getElementById('isbn-assign-sel');if(!sel)return;
  const tid=sel.value;const t=getTitle(tid);if(!t)return;
  const rec=data.isbns.find(r=>r.isbn===isbn);if(!rec)return;
  rec.assignedToTitleId=tid;rec.assignedToTitleName=t.title;rec.legacyArchived=false;
  saveIsbn(rec);renderISBNs();
}
function isbnNielsen(isbn,checked){
  const rec=data.isbns.find(r=>r.isbn===isbn);if(rec){rec.nielsenNotified=checked;saveIsbn(rec);}
}
function openAddISBN(){
  document.getElementById('bulk-isbn-form').classList.add('hidden');
  document.getElementById('add-isbn-form').classList.remove('hidden');
}
function confirmAddISBN(){
  const v=document.getElementById('new-isbn-val').value.trim();if(!v)return;
  const fmt=document.getElementById('new-isbn-fmt').value;
  const rec={isbn:v,format:fmt,assignedToTitleId:'',assignedToTitleName:'',nielsenNotified:false,legacyArchived:false,_row:null};
  data.isbns.push(rec);saveIsbn(rec);renderISBNs();
}

// ─── ISBN BULK ADD (Round 7, item 3b) ───
// confirmAddISBN() above only ever handled one ISBN at a time — no way to
// load a fresh batch of 25/50 newly-purchased ISBNs in one go. This feeds
// the exact same data.isbns / saveIsbn() path as the single-add flow above,
// just looped over a pasted textarea (one ISBN per line) with one format
// selector shared across the whole batch, per the brief.
function openBulkAddISBN(){
  document.getElementById('add-isbn-form').classList.add('hidden');
  document.getElementById('bulk-isbn-form').classList.remove('hidden');
  const r=document.getElementById('bulk-isbn-result');if(r)r.textContent='';
}
function closeBulkAddISBN(){
  document.getElementById('bulk-isbn-form').classList.add('hidden');
  const ta=document.getElementById('bulk-isbn-vals');if(ta)ta.value='';
  const r=document.getElementById('bulk-isbn-result');if(r)r.textContent='';
}
function confirmBulkAddISBN(){
  const ta=document.getElementById('bulk-isbn-vals');
  const fmt=document.getElementById('bulk-isbn-fmt').value;
  const lines=(ta.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
  if(!lines.length)return;
  // De-dupe against both the existing pool and other lines in this same
  // pasted batch (a normalised-ISBN comparison, same as findIsbnConflict())
  // — pasting a batch of 25/50 is exactly the situation where an accidental
  // repeat is easy to miss by eye.
  const existing=new Set((data.isbns||[]).map(r=>isbnNormalize(r.isbn)));
  const seenInBatch=new Set();
  let added=0, skipped=0;
  lines.forEach(v=>{
    const norm=isbnNormalize(v);
    if(!norm || existing.has(norm) || seenInBatch.has(norm)){ skipped++; return; }
    seenInBatch.add(norm);
    const rec={isbn:v,format:fmt,assignedToTitleId:'',assignedToTitleName:'',nielsenNotified:false,legacyArchived:false,_row:null};
    data.isbns.push(rec);saveIsbn(rec);
    added++;
  });
  // renderISBNs() rebuilds the whole ISBN Manager view (needed so the
  // newly-added rows show up in the table), which wipes/re-hides the bulk
  // form along with everything else — so the result message has to be
  // written AFTER the re-render, into the freshly-built DOM, with the form
  // reopened so the confirmation is actually visible rather than flashing
  // and vanishing.
  renderISBNs();
  document.getElementById('bulk-isbn-form').classList.remove('hidden');
  const resultEl=document.getElementById('bulk-isbn-result');
  if(resultEl) resultEl.textContent=added+' ISBN'+(added===1?'':'s')+' added'+(skipped?', '+skipped+' skipped (blank or already in the pool)':'')+'.';
}

// ─── FIELD CHANGE ───
function fc(titleId,path,value){
  const t=getTitle(titleId);if(!t)return;
  const parts=path.split('.');let obj=t;
  for(let i=0;i<parts.length-1;i++){if(!obj[parts[i]])obj[parts[i]]={};obj=obj[parts[i]];}
  obj[parts[parts.length-1]]=value;
  debouncedSave(titleId);updateSectionHeaders(titleId);
}
function stageChange(titleId,idx,field,value){
  const t=getTitle(titleId);if(!t)return;
  t.pipeline.stages[idx][field]=value;debouncedSave(titleId);updateSectionHeaders(titleId);
}
// Round 12, item 2d (2026-08-12) — Production Pipeline stage status set
// changed from 3 values to these exact 4, in this exact order, per David's
// brief. 'Not Required' is new — styled identically to 'Complete' (same
// sage/green, see .stage-not-required in index.html) since both mean
// "nothing outstanding here" in the pipeline view, distinct from Not
// Started/In Progress which still need attention. Every place elsewhere in
// this file that reads pipeline stage status for "is this stage done"
// purposes (dotColor, doneStages progress count in renderCard, the pipeline
// section's overall-complete check in getSectionStatus) is updated
// alongside this to treat 'Not Required' the same as 'Complete', per that
// same stated equivalence — not just the button colour.
const PIPELINE_STAGE_STATUSES=['Not Started','In Progress','Complete','Not Required'];
function cycleStage(titleId,idx){
  const t=getTitle(titleId);if(!t)return;
  const s=PIPELINE_STAGE_STATUSES;
  const cur=s.indexOf(t.pipeline.stages[idx].status);
  t.pipeline.stages[idx].status=s[(cur+1)%s.length];
  const btn=document.querySelector(`[data-stage-btn="${titleId}-${idx}"]`);
  if(btn){const ns=t.pipeline.stages[idx].status;btn.textContent=ns;btn.className='stage-btn stage-'+ns.toLowerCase().replace(/ /g,'-');}
  const strip=document.getElementById(`detail-strip-${titleId}`);
  if(strip)strip.innerHTML=t.pipeline.stages.map((ss,i)=>`<div class="detail-p-dot" style="background:${dotColor(ss.status)}" title="${esc(ss.name)}: ${esc(ss.status)}" onclick="cycleStage('${titleId}',${i})"></div>`).join('');
  // Round 10, item 1 — a stage moving off 'Not Started' is exactly the
  // trigger item 1 asks for; re-evaluate Status auto-derivation now. Full
  // renderDetail() only when Status itself actually changed as a result (a
  // rare, meaningful transition — same "full re-render on a rare/deliberate
  // change" reasoning used for onImprintChange/onStatusChange above); every
  // OTHER stage click keeps the lightweight per-element DOM patch above so
  // rapid cycling doesn't lose scroll position.
  if(applyStatusAutoRules(t)){
    debouncedSave(titleId);updateSectionHeaders(titleId);
    renderDetail();
    return;
  }
  debouncedSave(titleId);updateSectionHeaders(titleId);
}
function checklistChange(titleId,idx,checked){
  const t=getTitle(titleId);if(!t)return;
  t.productionNotes.checklist[idx].checked=checked;
  const item=document.getElementById(`chk-${titleId}-${idx}`)?.closest('.check-item');
  if(item)item.classList.toggle('done',checked);
  debouncedSave(titleId);updateSectionHeaders(titleId);
}
function onStreetDateChange(titleId,value){
  const t=getTitle(titleId);if(!t)return;
  t.dates.streetDate=value;
  if(t.dates.autoPrintDate){
    t.dates.printDate='';
    const pdInput=document.getElementById(`f-${titleId}-printDate`);
    if(pdInput){pdInput.value=calcAutoPrint(value);syncDateDisplay(pdInput);}
    updateDaysDisplay(titleId);
  }
  debouncedSave(titleId);updateSectionHeaders(titleId);
}
function onAutoPrint(titleId,checked){
  const t=getTitle(titleId);if(!t)return;
  t.dates.autoPrintDate=checked;
  const pdInput=document.getElementById(`f-${titleId}-printDate`);
  if(pdInput){pdInput.readOnly=checked;if(checked){pdInput.value=calcAutoPrint(t.dates.streetDate);syncDateDisplay(pdInput);}}
  updateDaysDisplay(titleId);debouncedSave(titleId);
}
// 2026-08-11 (item 3 fix) — this used to carry its OWN separate, simpler
// day-count calculation, completely independent of computeDayInfo() — so it
// neither knew about isPublished() (a published title with a stale past
// print date would still say "OVERDUE" here, even though the main Print
// Status badge said "Published") nor, now, about the new printStatusOverride
// lock: changing Street Date or the auto-calculate checkbox would silently
// blow this element's display back to a raw date calculation, stomping over
// a manual override David had just set, until the next full renderDetail().
// Fixed by making this just another caller of computeDayInfo() — the single
// source of truth every other Print-Status-reading surface in the app
// already uses (renderDates, renderCard, the print-timing filter, both
// exports) — instead of a second, drifting copy of the same logic.
function updateDaysDisplay(titleId){
  const t=getTitle(titleId);if(!t)return;
  const el=document.getElementById(`f-${titleId}-daysToprint`);
  if(!el)return;
  const info=computeDayInfo(t);
  const colorVar={published:'var(--sage)',ok:'var(--sage)',notice:'var(--amber-border)','due-soon':'#B8722E',overdue:'var(--terra)',neutral:'var(--text3)'}[info.colorClass]||'var(--text3)';
  el.innerHTML=`<span style="color:${colorVar};font-weight:600">${esc(info.kind==='overdue'?'OVERDUE — '+info.label:info.label)}</span>`;
}
// Item 3 — the new manual-override control (renderDates()'s
// #f-<id>-printStatusOverride select). Empty value = back to Auto (fully
// re-derived from Print Date every render, exactly as before this fix
// existed); any other value locks Print Status to that literal label until
// changed back, same "sticks until deliberately changed" contract as
// Status/statusAuto elsewhere in this app.
function onPrintStatusOverrideChange(titleId,value){
  const t=getTitle(titleId);if(!t)return;
  t.dates.printStatusOverride=value;
  updateDaysDisplay(titleId);
  debouncedSave(titleId);updateSectionHeaders(titleId);
}
function updateSectionHeaders(titleId){
  const t=getTitle(titleId);if(!t)return;
  SECTION_KEYS.forEach(key=>{
    const el=document.getElementById(`asec-${titleId}-${key}`);if(!el)return;
    const hdr=el.querySelector('.accord-header');
    if(hdr){hdr.className='accord-header stripe-'+getSectionStatus(t,key);}
  });
}
function printerContactChange(titleId,idx,field,value){
  const t=getTitle(titleId);if(!t)return;
  t.print.printerContacts[idx][field]=value;debouncedSave(titleId);
}
function addPrinterContact(titleId){
  const t=getTitle(titleId);if(!t)return;
  t.print.printerContacts.push({name:'',email:''});debouncedSave(titleId);renderDetail();
}
function removePrinterContact(titleId,idx){
  const t=getTitle(titleId);if(!t)return;
  t.print.printerContacts.splice(idx,1);debouncedSave(titleId);renderDetail();
}

// ─── FILES & LINKS ACTIONS ───
// ─── ADD TITLE ───
function openAddTitle(){document.getElementById('add-title-modal').classList.remove('hidden');}
async function confirmAddTitle(){
  const titleVal=document.getElementById('new-title').value.trim();if(!titleVal)return;
  const t=defTitle({
    title:titleVal,
    subtitle:document.getElementById('new-subtitle').value.trim(),
    authors:document.getElementById('new-authors').value.trim(),
    imprint:document.getElementById('new-imprint').value,
    status:document.getElementById('new-status').value
  });
  data.titles.push(t);
  document.getElementById('add-title-modal').classList.add('hidden');
  ['new-title','new-subtitle','new-authors'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  gotoDetail(t.id);
  await saveTitle(t.id); // append immediately (not debounced) so _row is assigned right away
}

// ─── DELETE TITLE (Round 9, item 2) ───
// Confirmed via code search before writing any of this: no delete/remove-
// title function existed anywhere in the app — a title could be created
// (confirmAddTitle above) but never removed, so a test title had nowhere
// to go. This is genuinely destructive and per-title (unlike e.g.
// removePrinterContact, which just drops one entry from a sub-list within
// a title), so it gets its own real confirmation modal rather than a
// single confirm() dialog — David has to type the title's exact name
// before the button even enables, the same friction pattern GitHub/similar
// tools use for "delete this repo"-class actions, specifically so it can't
// be triggered by one stray/fast click.
let pendingDeleteTitleId=null;
function openDeleteConfirm(titleId){
  const t=getTitle(titleId);if(!t)return;
  pendingDeleteTitleId=titleId;
  const body=document.getElementById('delete-confirm-body');
  if(body){
    body.innerHTML = `<p>You're about to permanently delete:</p>
      <p class="delete-confirm-title">"${esc(t.title)}"${t.authors?' — '+esc(contributorLabel(t)):''}</p>
      <p>This removes the ENTIRE title record from the live Sheet: every field on this page for this title — Contents &amp; Marketing text, the production checklist, print/publicity/TOC notes, dates, ISBN values, cover and folder links, quick notes, everything. It does not touch the ISBN pool, the Blocks list, or any other separate tracker sheet — only this one title's row.</p>
      <p><strong>This cannot be undone from inside the app.</strong> To confirm, type the title exactly as shown above:</p>
      <input type="text" id="delete-confirm-input" placeholder="Type the title name to confirm" autocomplete="off" oninput="onDeleteConfirmInput()">`;
  }
  const confirmBtn=document.getElementById('confirm-delete-btn');
  if(confirmBtn){confirmBtn.disabled=true;confirmBtn.textContent='Delete Title';}
  document.getElementById('delete-confirm-modal').classList.remove('hidden');
  const input=document.getElementById('delete-confirm-input');
  if(input) input.focus();
}
function onDeleteConfirmInput(){
  const t=getTitle(pendingDeleteTitleId);if(!t)return;
  const el=document.getElementById('delete-confirm-input');
  const btn=document.getElementById('confirm-delete-btn');
  if(btn) btn.disabled = !el || el.value.trim()!==t.title.trim();
}
function closeDeleteConfirm(){
  document.getElementById('delete-confirm-modal').classList.add('hidden');
  pendingDeleteTitleId=null;
}
async function confirmDeleteTitle(){
  const titleId=pendingDeleteTitleId;
  const t=getTitle(titleId);if(!t)return;
  // Cancel any live debounce timer for the title about to be deleted — a
  // stray saveTitle() firing after the row is gone would either error
  // harmlessly (no _row) or, worse, write into whatever row now occupies
  // that index post-delete-shift. Same saveTimers map the 2026-08-11
  // debounce fix introduced (see debouncedSave()/flushPendingSave() above).
  clearTimeout(saveTimers[titleId]); delete saveTimers[titleId]; pendingSaveTitleIds.delete(titleId);
  const btn=document.getElementById('confirm-delete-btn');
  if(btn){btn.disabled=true;btn.textContent='Deleting…';}
  if(devMode){
    // Preview sandbox only — same guard used by saveTitle/saveIsbn, no
    // network write ever happens in devMode, so just drop it from the
    // in-memory array so the UI still demonstrates the flow.
    data.titles=data.titles.filter(x=>x.id!==titleId);
    closeDeleteConfirm();
    gotoTitles();
    return;
  }
  try{
    if(t._row){
      // The real Sheets-side delete — see sheetsDeleteRow above for why
      // this is a full deleteDimension row removal rather than a client-
      // side splice (which would just reappear on the next load/reload,
      // exactly the gap this brief called out).
      await sheetsDeleteRow(CFG.TITLES_SHEET_ID, 'Titles', t._row);
    }
    // t._row can legitimately be unset only if a brand-new title's initial
    // saveTitle() append (confirmAddTitle above) somehow never completed —
    // in that case there's nothing on the Sheet to delete yet, so just
    // drop the local object.
    closeDeleteConfirm();
    gotoTitles();
    // Re-fetch everything from the Sheet so every remaining title's cached
    // _row is recomputed against the post-delete layout — deleteDimension
    // physically shifts every row below the deleted one up by one, which
    // would otherwise leave other titles' _row stale for the rest of this
    // session (see the long comment on sheetsDeleteRow).
    await loadAllData();
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Delete Title';}
    showReconnect('Delete failed: '+e.message+' — the title has NOT been removed from the Sheet.');
    console.error(e);
  }
}

// ─── MANAGE RELEASE BLOCKS (2026-08-20 round, item 4) ───
// David asked for a way to delete a release Block once it's empty (zero
// titles assigned). Checked first, per standard practice on this project,
// rather than assuming: Blocks are a real stored entity — the live "Blocks"
// tab (block_id/block_name/sortOrder/notes), not a label derived on the fly
// from title data (see the RELEASE BLOCKS section above, and Marcus Webb's
// 2026-07-27 live verification) — so "delete a block" is unambiguous: it's
// exactly one row removed from that tab, via the same sheetsDeleteRow()
// path DELETE TITLE already uses above.
//
// One real wrinkle found while checking the live data (see
// mia_check_blocks_and_counts.py output, 2026-08-20): as of today every one
// of the 6 live blocks has at least one title on it, so there is currently
// no empty block to delete against live — flagged to Thomas/David in the
// handoff report rather than silently skipping the feature. Verified this
// works end-to-end instead against dev-sample data (loadDevSampleData's 3
// sample titles carry no blockId at all, so all 5 sample blocks are
// genuinely empty there) — Delete is live and enabled for every one of
// them in that preview.
//
// UI: a "Manage Release Blocks…" link under the Block filter select (see
// index.html) opens a small modal listing EVERY block from data.blocks
// (not just the ones with titles — unlike the filter dropdown above, an
// empty block by definition never appears there), each with its live title
// count and a Delete button that's only enabled at zero.
function renderManageBlocksList(){
  const wrap=document.getElementById('manage-blocks-list'); if(!wrap) return;
  const counts={};
  data.titles.forEach(t=>{ if(t.blockId) counts[t.blockId]=(counts[t.blockId]||0)+1; });
  const sorted = sortBlocksNewestFirst(data.blocks||[]);
  if(!sorted.length){ wrap.innerHTML='<p style="color:var(--text3);font-size:.85rem">No release blocks exist yet.</p>'; return; }
  wrap.innerHTML = sorted.map(b=>{
    const n = counts[b.block_id]||0;
    const canDelete = n===0;
    return `<div class="manage-block-row">
      <div class="manage-block-name">${esc(b.block_name)}</div>
      <div class="manage-block-count">${n} title${n===1?'':'s'}</div>
      <button class="btn btn-sm" ${canDelete?'':'disabled'} title="${canDelete?'Delete this empty block':'Move every title off this block first'}" onclick="confirmDeleteBlock('${esc(b.block_id)}')">Delete</button>
    </div>`;
  }).join('');
}
function openManageBlocks(){
  renderManageBlocksList();
  document.getElementById('manage-blocks-modal').classList.remove('hidden');
}
function closeManageBlocks(){
  document.getElementById('manage-blocks-modal').classList.add('hidden');
}
async function confirmDeleteBlock(blockId){
  const b=(data.blocks||[]).find(x=>x.block_id===blockId); if(!b) return;
  const stillHasTitles = data.titles.some(t=>t.blockId===blockId);
  if(stillHasTitles){ window.alert('This block still has titles assigned to it — move them off first.'); return; }
  if(!window.confirm(`Delete the release block "${b.block_name}"? This cannot be undone.`)) return;
  if(devMode){
    // Preview sandbox only — same guard used by confirmDeleteTitle/
    // saveTitle/saveIsbn, no network write ever happens in devMode.
    data.blocks = data.blocks.filter(x=>x.block_id!==blockId);
    renderManageBlocksList(); populateBlockFilter();
    return;
  }
  try{
    if(b._row){
      // Real Sheets-side delete — see sheetsDeleteRow above (built for
      // DELETE TITLE) for why this is a full deleteDimension row removal,
      // not a client-side splice.
      await sheetsDeleteRow(CFG.TITLES_SHEET_ID, 'Blocks', b._row);
    }
    // Re-fetch so every remaining block's cached _row is recomputed against
    // the post-delete layout, same reasoning as confirmDeleteTitle's
    // loadAllData() call above (deleteDimension shifts every row below the
    // deleted one up by one).
    await loadAllData();
    renderManageBlocksList();
  }catch(e){
    // Round 31 — auth-aware message, matching saveTitle/addReleaseBlockName's
    // pattern, now that sheetsDeleteRow's real 401s are correctly detected
    // (see its comment above) rather than lumped in with every other
    // failure. The withAuthRetry inside sheetsDeleteRow already tried one
    // silent reconnect-and-retry before this ever reaches here, so if it's
    // still an auth failure at this point David does need an interactive
    // reconnect — the block genuinely has NOT been deleted, unchanged in
    // data.blocks, safe to just try Delete again once reconnected.
    const auth = isAuthFailure(e);
    showReconnect(
      (auth ? 'Delete failed: signed out / token expired.' : 'Delete failed: '+e.message)
      + ' — the block has NOT been removed from the Sheet.'
      + (auth ? ' Click Reconnect, then click Delete again.' : ''),
      auth
    );
    console.error(e);
  }
}

// ─── FILTERS ───
function onSearch(v){filters.search=v;renderTitles();}
function onFilterStatus(v){filters.status=v;renderTitles();}
function onFilterImprint(v){filters.imprint=v;renderTitles();}
function onFilterBlock(v){filters.block=v;renderTitles();}
function onFilterPrintTiming(v){filters.printTiming=v;renderTitles();}
function onFilterSort(v){filters.sort=v;renderTitles();}
// Round 31 (2026-08-26) — Reset Filters, David request. Snaps every
// Dashboard filter control back to its default/unfiltered state in one
// click. populateBlockFilter()/renderTitles() both read straight off the
// `filters` object and (for Block) rebuild its own <option> "selected"
// state from filters.block — but the other five controls are plain HTML
// <select>/<input> elements whose DOM .value only ever changes on user
// interaction via their onchange handlers, never re-synced from `filters`
// on a normal render(). So resetting the object alone would silently leave
// stale selections showing in the sidebar while the actual filtered results
// went back to unfiltered underneath — each control's DOM value has to be
// reset explicitly here too.
function resetFilters(){
  filters = { status:'', imprint:'', search:'', block:'', printTiming:'', sort:'alpha' };
  const searchEl=document.getElementById('hdr-search'); if(searchEl) searchEl.value='';
  const sortEl=document.getElementById('filter-sort'); if(sortEl) sortEl.value='alpha';
  const imprintEl=document.getElementById('filter-imprint'); if(imprintEl) imprintEl.value='';
  const statusEl=document.getElementById('filter-status'); if(statusEl) statusEl.value='';
  const ptEl=document.getElementById('filter-printtiming'); if(ptEl) ptEl.value='';
  populateBlockFilter(); // rebuilds the Block <option> list against the now-cleared filters.block
  renderTitles();
}

// ─── ISBN LOCK MECHANISM (item 18 design decision) ───
// Default state: LOCKED (readonly) for every live ISBN field, every time
// the detail view loads — deliberately session-only, not persisted to the
// Sheet. Unlocking requires an explicit click + a confirm() dialog spelling
// out the risk, so overwriting a live, already-in-use ISBN needs a
// deliberate two-step action rather than one stray keystroke landing in an
// always-editable box. This is what replaces the old Backup ISBN fields as
// the actual accidental-overwrite protection — see build report for the
// full reasoning on why a lock-toggle was chosen over e.g. a confirm-on-
// every-keystroke prompt (far too disruptive for a field David might
// legitimately correct a typo in) or a permanent-audit-log approach
// (over-engineered for what's fundamentally a "did you mean to do that"
// guard).
function isbnLockRow(titleId,field){
  const row=isbnLocked[titleId];
  if(!row)return true; // default locked
  return row[field]!==false;
}
function toggleIsbnLock(titleId,field){
  const t=getTitle(titleId);if(!t)return;
  const currentlyLocked=isbnLockRow(titleId,field);
  if(currentlyLocked){
    const ok=confirm('This ISBN is likely already live/in use with distributors and retailers. Unlock to edit it?\n\nOnly do this if you specifically mean to change a real, assigned ISBN.');
    if(!ok)return;
  }
  if(!isbnLocked[titleId])isbnLocked[titleId]={};
  isbnLocked[titleId][field]=currentlyLocked?false:true;
  renderDetail();
}

// ─── COVER & FOLDER LINKS LOCK MECHANISM (Round 22, item 1) ───
// Same pattern as the ISBN lock above — session-only state, explicit
// unlock-toggle button, confirm()-gated when locking-to-unlocked — applied
// to Cover Image URL / Images Folder / Working Folder. The one deliberate
// difference from isbnLockRow(): ISBNs are always default-locked (a blank
// ISBN field is still something you'd want to deliberately unlock before
// typing into, per the original item-18 reasoning); these three link
// fields instead default to UNLOCKED while genuinely empty (a brand-new
// title needs to be able to just type/paste a first value straight in) and
// only flip to locked automatically once a real value is present — "once a
// value is set/established... it should lock", per David's ask this round.
function linkLockRow(titleId,field,hasValue){
  const row=linksLocked[titleId];
  if(row && row[field]!==undefined) return row[field];
  return !!hasValue;
}
function toggleLinkLock(titleId,field){
  const t=getTitle(titleId);if(!t)return;
  const hasValue=!!String(t[field]||'').trim();
  const currentlyLocked=linkLockRow(titleId,field,hasValue);
  if(currentlyLocked){
    const ok=confirm('This value is already set. Unlock to edit it?\n\nOnly do this if you specifically mean to change it.');
    if(!ok)return;
  }
  if(!linksLocked[titleId])linksLocked[titleId]={};
  linksLocked[titleId][field]=currentlyLocked?false:true;
  renderDetail();
}

// ─── QUICK NOTE CAPTURE (item 32) ───
// Fast, low-friction jot against any title — no formal edit flow. Lives
// outside the accordion entirely (floating button, always available in any
// view) and writes straight to that title's own quickNotes_json array, each
// entry timestamped. Recent notes for the selected title also show inline
// in the panel so David can see what he's already jotted without having to
// open the full detail view.
function populateQuickNoteTitles(){
  const sel=document.getElementById('qn-title-select');if(!sel)return;
  const cur=sel.value;
  sel.innerHTML=data.titles.slice().sort((a,b)=>a.title.localeCompare(b.title)).map(t=>`<option value="${t.id}">${esc(t.title)}</option>`).join('');
  if(view==='detail'&&selectedId) sel.value=selectedId;
  else if(cur) sel.value=cur;
  renderQuickNoteRecent();
}
function toggleQuickNote(){
  qnOpen=!qnOpen;
  const panel=document.getElementById('quick-note-panel');
  if(!panel)return;
  panel.classList.toggle('hidden',!qnOpen);
  if(qnOpen){ populateQuickNoteTitles(); document.getElementById('qn-text').focus(); }
}
function renderQuickNoteRecent(){
  const sel=document.getElementById('qn-title-select');
  const box=document.getElementById('qn-recent');
  if(!sel||!box)return;
  const t=getTitle(sel.value);
  // Item 6 (Round 3) — this "recent" preview (inside the floating capture
  // panel) only ever showed a jotting aid, never had its own archive UI, so
  // it now shows ACTIVE notes only — an addressed/archived note dropping
  // out of this quick preview too is the expected read-through of "archived
  // = dealt with", consistent with it also leaving the main Quick Notes list.
  const active=(t&&t.quickNotes)?t.quickNotes.filter(n=>!n.archived):[];
  if(!active.length){ box.innerHTML='<em>No quick notes yet for this title.</em>'; return; }
  box.innerHTML=active.slice().reverse().slice(0,5).map(n=>`<div class="qn-recent-item"><b>${esc(new Date(n.ts).toLocaleDateString('en-GB',{day:'numeric',month:'short'}))}</b> — ${esc(n.text)}</div>`).join('');
}
function saveQuickNote(){
  const sel=document.getElementById('qn-title-select');
  const textEl=document.getElementById('qn-text');
  if(!sel||!textEl)return;
  const text=textEl.value.trim();
  if(!text)return;
  const t=getTitle(sel.value);if(!t)return;
  if(!t.quickNotes)t.quickNotes=[];
  t.quickNotes.push({id:uid(),ts:new Date().toISOString(),text,archived:false,archivedTs:''});
  textEl.value='';
  saveTitle(t.id); // immediate, not debounced — a quick note should feel saved instantly
  renderQuickNoteRecent();
  // If the note's title is the one currently open in detail view, refresh
  // it live too (quick notes aren't shown as their own accordion field
  // today, but this keeps behaviour honest if a future pass surfaces them
  // there — no stale state left behind).
  if(view==='detail'&&selectedId===t.id) renderDetail();
}
// Item 6 (Round 3) — David's live refinement: checking a note off in the
// Quick Notes list is an ARCHIVE action, not an in-place strikethrough/done
// toggle. The note is never deleted — it moves out of the Active list into
// a separate Archived view (toggle in renderQuickNotesList above) so David
// can still look back at what's been addressed. archived/archivedTs live on
// the same note object inside quickNotes_json (no new Sheet column needed —
// this is all inside the existing JSON blob), so nothing about the Sheet
// schema changes for this.
function archiveQuickNote(titleId,noteId){
  const t=getTitle(titleId);if(!t||!t.quickNotes)return;
  const n=t.quickNotes.find(x=>x.id===noteId);if(!n)return;
  n.archived=true;n.archivedTs=new Date().toISOString();
  saveTitle(titleId); // immediate, same "feels instant" rule as saveQuickNote()
  renderQuickNotesList();
  renderQuickNoteRecent();
}
function restoreQuickNote(titleId,noteId){
  const t=getTitle(titleId);if(!t||!t.quickNotes)return;
  const n=t.quickNotes.find(x=>x.id===noteId);if(!n)return;
  n.archived=false;n.archivedTs='';
  saveTitle(titleId);
  renderQuickNotesList();
  renderQuickNoteRecent();
}

// ─── ROUND 6, ITEMS 2/3 — FULL-RECORD EXPORT (HTML + Word/RTF) ───
// Round 4 built "View HTML Output" for Content & Marketing's 6 fields only.
// David wants everything in the sheet viewable this way, one file, each
// box's own heading/subheading structure preserved (matching the
// accordion's own section labels) — so this is expanded to the entire
// title record, plus a new Word (.rtf) export alongside it.
//
// getSectionExportFields() is the single shared source of what goes into
// BOTH exports — one field list per accordion section (SECTION_KEYS order,
// same labels as SECTION_LABELS), each entry tagged with a `kind` so each
// exporter knows how to render it:
//   'html'  — already-stored real HTML (the three rich-text fields from
//             richTa()) — passed through as-is for the HTML export (source
//             preserved exactly, same as round 4); converted tag-by-tag to
//             RTF bold/italic/paragraph runs for the Word export (see
//             htmlFragmentToRtfParagraphs() — a deliberately small
//             converter that handles the actual tags richTa's toolbar can
//             produce: <b>/<strong>, <i>/<em>, <p>/<div>, <br> — not a
//             general-purpose HTML-to-RTF library, since nothing here needs
//             more than that).
//   'text'  — a single plain value (ISBN, a date, a checkbox as Yes/No,
//             multi-line notes) — shown as-is, escaped, no synthetic markup.
//   'list'  — newline-separated items (Selling Points) — rendered as a real
//             <ul>/<li> for the HTML export (matching round 4's exact
//             treatment), bullet-prefixed lines for Word.
//   'quote' — newline-separated items (Quotes) — <blockquote> per line for
//             HTML (matching round 4), curly-quoted lines for Word.
function getSectionExportFields(t,key,blockNameById){
  switch(key){
    case 'dates':{
      const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
      const info=computeDayInfo(t);
      return [
        ['Release Block','text', blockNameById[t.blockId]||t.blockId||''],
        ['Soft Date','text', formatDate(t.dates.softDate)],
        ['Street Date','text', formatDate(t.dates.streetDate)],
        ['Print Date','text', formatDate(pd)+(t.dates.autoPrintDate&&pd?' (auto-calculated: street date minus 60 days)':'')],
        ['Release Note','text', t.dates.releaseNote||''],
        ['Print Status','text', info.label]
      ];
    }
    case 'commercial':{
      const c=t.commercial,p=t.price;
      return [
        ['ISBN (PBK)','text', c.isbnPbk],['ISBN (HBK)','text', c.isbnHbk],['ISBN (EBK)','text', c.isbnEbk],
        ['Cover Price PBK','text', p.pbkGBP],['Cover Price EBK','text', p.ebkUSD],['Cover Price HBK','text', p.hbkGBP],
        ['Trim Size','text', c.trimSize],['Pages','text', c.pages],['Pages Breakdown','text', c.pagesBreakdown],
        ['Category UK','text', c.categoryUK],['Category USA','text', c.categoryUSA],
        ['Nielsen Notified','text', c.nielsenNotified?'Yes':'No'],
        ['Illustrations','text', c.illustrationsText]
      ];
    }
    case 'content':{
      const c=t.content;
      return [
        ['Full Description','html', c.fullDescription],
        ['Jacket Blurb','html', c.jacketBlurb],
        ['Brief Description','html', c.briefDescription],
        ['Sales Handle','text', c.salesHandle],
        ['Selling Points','list', c.sellingPoints],
        ['Quotes','quote', c.quotes],
        ['Target Audience','text', c.targetAudience],
        ['Keywords / Metadata','text', c.keywords]
      ];
    }
    case 'author':{
      const a=t.authorInfo;
      return [
        ['Contributor Role','text', a.contributorRole||'Author(s)'],
        ['Author Bio','html', a.bio],
        ['Author Hometown','text', a.hometown],
        // Round 11, item 7 — renamed/repositioned in the UI (see
        // renderAuthor() above); label matched here so exports read the same.
        ['Contributor(s)','html', a.otherContributors],
        ['Socials & Societies','html', a.socials],
        ['Previous Publications','html', a.previousPublications]
      ];
    }
    case 'pipeline':{
      const byName={}; t.pipeline.stages.forEach(s=>byName[s.name]=s);
      return PIPELINE_GROUPS.map(g=>[g.label,'text', g.stages.map(name=>{
        const s=byName[name]; if(!s) return name+': —';
        let line=name+': '+s.status;
        if(s.expectedDate) line+=' (Expected: '+formatDate(s.expectedDate)+')';
        if(s.notes) line+=' — '+s.notes;
        return line;
      }).join('\n')]);
    }
    case 'print':{
      const p=t.print;
      const contacts=(p.printerContacts||[]).filter(pc=>pc.name||pc.email).map(pc=>pc.name+(pc.email?' — '+pc.email:'')).join('\n');
      return [
        ['Print Estimate / Quotes','html', p.printEstimate],
        ['SCB eBook Cover Spec','text', p.scbEbookCoverSpec],
        ['For LSI Notes','html', p.forLsiNotes],
        ['Printer Contacts','text', contacts]
      ];
    }
    case 'poTracker':{
      // Deliberately excludes the two live-fetched tables (print-estimate /
      // PO & Invoice Tracker matches) — those come from separate Sheets on
      // demand and would need fresh network calls at export time; this
      // export is a snapshot of what's actually stored against the title
      // itself. Manual fields (which ARE this title's own stored data) are
      // included in full.
      const key=t.commercial.isbnPbk||t.commercial.isbnHbk||'';
      return [
        ['PO Tracker ISBN Key (auto)','text', key],
        ['Manual Override (title/tab name)','text', t.poTrackerTitleOverride],
        ['Manual PO/Invoice Notes','html', t.poManualNotes]
      ];
    }
    case 'publicity': return [
      // Round 12, item 1 — label matched to the renamed UI field (see
      // renderPublicity() above) so exports read the same, same pattern as
      // the Contributor(s) rename precedent (item 7, Round 11) above.
      ['Selling Points','html', t.publicity.publicityStatement],
      ['Marketing Notes','html', t.publicity.marketing]
    ];
    case 'toc': return [
      ['Table of Contents','html', t.toc.tableOfContents],
      ['How I Came to Write This Book','html', t.toc.howICameToWriteThis],
      ['Excerpt','html', t.toc.excerpt],
      ['Competing Titles','html', t.toc.competingTitles]
    ];
    case 'productionNotes':{
      const checklistText=(t.productionNotes.checklist||[]).map(c=>'['+(c.checked?'x':' ')+'] '+c.text).join('\n');
      return [
        ['Checklist','text', checklistText],
        ['Proofing Notes','html', t.productionNotes.proofingNotes],
        ['Typesetting Notes','html', t.productionNotes.typesettingNotes]
      ];
    }
    case 'futureEdition': return [
      ['Info & Changes for Future Edition','html', t.futureEdition.infoAndChanges],
      ['Print-Ready Files','text', t.futureEdition.printReadyFilesStatus]
    ];
    default: return [];
  }
}

// ── HTML export ──
function exportFieldToHtmlFragment(kind,value){
  const esc2=s=>esc(s||'');
  if(kind==='html') return value||'';
  if(kind==='list'){
    const items=(value||'').split('\n').map(s=>s.trim()).filter(Boolean);
    return items.length ? `<ul>${items.map(s=>`<li>${esc2(s)}</li>`).join('')}</ul>` : ''; // empty → falls through to fieldBlock's "—" placeholder, not a bare <ul></ul>
  }
  if(kind==='quote'){
    const items=(value||'').split('\n').map(s=>s.trim()).filter(Boolean);
    return items.length ? items.map(s=>`<blockquote>${esc2(s)}</blockquote>`).join('\n') : '';
  }
  return value||'';
}
function buildFullTitleSectionsHtml(t){
  const blockNameById={}; (data.blocks||[]).forEach(b=>{ blockNameById[b.block_id]=b.block_name; });
  const esc2=s=>esc(s||'');
  const fieldBlock=(label,fragment)=>`<div class="src-field">
<h3>${esc2(label)}</h3>
<pre>${fragment?esc(fragment):'<span class="empty-field">—</span>'}</pre>
</div>`;
  const headerSection=`<section class="src-section">
<h2 class="src-section-title">Title Record</h2>
${fieldBlock('Title', t.title)}
${fieldBlock('Subtitle', t.subtitle)}
${fieldBlock((t.authorInfo.contributorRole||'Author(s)'), t.authors)}
${fieldBlock('Displays As', contributorLabel(t))}
${fieldBlock('Imprint', imprintName(t.imprint))}
${fieldBlock('Status', t.status)}
</section>`;
  const keyContactsSection=`<section class="src-section">
<h2 class="src-section-title">Key Contacts</h2>
${fieldBlock('Author Liaison', t.authorLiaison)}
${fieldBlock('PR Contact', t.publicity.prContact)}
</section>`;
  const sectionsHtml=SECTION_KEYS.map(key=>{
    const fields=getSectionExportFields(t,key,blockNameById);
    const fieldsHtml=fields.map(([label,kind,value])=>fieldBlock(label,exportFieldToHtmlFragment(kind,value))).join('\n');
    return `<section class="src-section">
<h2 class="src-section-title">${esc2(SECTION_LABELS[key])}</h2>
${fieldsHtml}
</section>`;
  }).join('\n');
  return headerSection+'\n'+keyContactsSection+'\n'+sectionsHtml;
}
// Item 21/Round 2, expanded Round 6 — full-record HTML output view. Opened
// in a new tab as a self-contained document rather than a modal, since the
// whole point is to copy it out to somewhere else. Items 4/5 (Round 4)'s
// escaped-source-under-a-real-heading pattern (light cream background,
// each field's own <h3>/<pre>, tags visible as literal text so copy-paste
// preserves exact markup) is unchanged — just applied to every section
// (SECTION_KEYS order, matching the accordion) instead of only Content &
// Marketing's 6 fields, with an outer <h2> per accordion box on top of the
// existing per-field <h3>.
function openHtmlOutput(titleId){
  const t=getTitle(titleId);if(!t)return;
  const esc2=s=>esc(s||'');
  const sections=buildFullTitleSectionsHtml(t);
  const sourceViewHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc2(t.title)} — Full Record (HTML Source)</title>
<style>
body{font-family:Georgia,serif;background:#FAF7EF;color:#1c1c1c;margin:0;padding:32px 24px 60px}
h1.doc-title{font-size:1.5rem;margin:0 0 6px;color:#1c1c1c}
p.hint{color:#555;margin:0 0 32px;font-size:.9rem;max-width:720px}
.src-section{max-width:760px;margin:0 0 40px}
h2.src-section-title{font-size:1.05rem;color:#1c1c1c;font-weight:700;border-bottom:2px solid #1c1c1c;padding-bottom:6px;margin:0 0 18px}
.src-field{max-width:720px;margin:0 0 24px;padding-bottom:20px;border-bottom:1px solid #ddd7c6}
.src-field:last-child{border-bottom:none}
h3{font-size:.82rem;text-transform:uppercase;letter-spacing:.05em;color:#7a7362;margin:0 0 10px;font-weight:700}
pre{white-space:pre-wrap;word-break:break-word;font-family:'SFMono-Regular',Consolas,'Courier New',monospace;font-size:13px;line-height:1.6;margin:0;color:#1c1c1c;background:#fff;border:1px solid #e4dfd0;border-radius:4px;padding:10px 12px}
.empty-field{color:#aaa;font-style:italic;font-family:Georgia,serif}
</style>
</head><body>
<h1 class="doc-title">${esc2(t.title)}${t.subtitle?' — '+esc2(t.subtitle):''}</h1>
<p class="hint">Full title record — literal HTML source under each rich-text field (tags included, select/copy exactly as shown), plain values everywhere else — one section per box, in the same order as the app (Round 6, item 2).</p>
${sections}
</body></html>`;
  const blob=new Blob([sourceViewHtml],{type:'text/html'});
  const url=URL.createObjectURL(blob);
  window.open(url,'_blank','noopener');
}

// ── Word (.rtf) export ──
// .rtf chosen over .docx (brief left the choice to judgement): a .docx is a
// zip of several XML parts, which needs either a zip library or hand-rolled
// zip encoding — a real dependency this build-step-free, no-library app
// doesn't have. RTF is a plain text format Word/Google Docs/LibreOffice all
// open natively, and is simple enough to generate by hand with just string
// concatenation, so it's the one that actually fits "simplest to generate
// client-side without a build step/library".
function rtfEscapeText(s){
  return String(s||'').replace(/\\/g,'\\\\').replace(/\{/g,'\\{').replace(/\}/g,'\\}')
    .replace(/[\u0080-\uffff]/g, ch=>{ let code=ch.charCodeAt(0); if(code>32767) code-=65536; return '\\u'+code+'?'; });
}
function decodeEntities(s){
  return String(s||'').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
}
// Small, deliberately-scoped HTML→RTF converter for richTa()'s output —
// only handles the tags its Bold/Italic/¶ toolbar (document.execCommand)
// actually produces: <p>/<div> (paragraphs), <b>/<strong>, <i>/<em>, <br>.
// Anything else gets its tags stripped and the text kept, rather than
// erroring — a safety net for older plain-text data with no tags at all.
function inlineHtmlToRtf(raw){
  const L='\x01',BO='\x02',BC='\x03',IO='\x04',IC='\x05';
  let s=String(raw||'');
  s=s.replace(/<br\s*\/?>/gi,L);
  s=s.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi,(_,inner)=>BO+inner+BC);
  s=s.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi,(_,inner)=>IO+inner+IC);
  s=s.replace(/<[^>]+>/g,'');
  s=decodeEntities(s);
  s=rtfEscapeText(s);
  s=s.split(L).join('\\line ').split(BO).join('{\\b ').split(BC).join('}').split(IO).join('{\\i ').split(IC).join('}');
  return s;
}
function htmlFragmentToRtfParagraphs(html){
  if(!html || !String(html).replace(/<[^>]+>/g,'').trim()) return [];
  let s=String(html).replace(/<div[^>]*>/gi,'<p>').replace(/<\/div>/gi,'</p>');
  // Item 8 (2026-08-11) — numbered lists. execCommand('insertOrderedList')
  // produces a top-level <ol><li>…</li></ol> block sitting OUTSIDE any <p>
  // tag — the <p>-matching pass just below only ever extracts what's inside
  // <p>…</p>, so without this an <ol> block's content would silently vanish
  // from the Word export entirely (dropped, not just unformatted). Pulled
  // out into its own hand-numbered pseudo-paragraphs before the <p> pass
  // runs (and removed from `s` so it isn't double-counted); each <li>'s own
  // inline bold/italic still goes through inlineHtmlToRtf like anything
  // else. RTF's native \pn auto-numbering is real overhead for a converter
  // this deliberately small (see the function-group comment above
  // inlineHtmlToRtf) — a hand-numbered "N. " prefix is the same pragmatic
  // choice already used for bullet lists (exportFieldToRtfParagraphs'
  // 'list' kind, • prefix). Order note: list paragraphs are appended
  // AFTER any surrounding prose rather than interleaved at their original
  // position — a documented simplification, not a precision loss this
  // export has ever promised (see getSectionExportFields's own "everything
  // present, not position-perfect" framing).
  const listParas=[];
  s=s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi,(_,inner)=>{
    let n=0; const liRe=/<li[^>]*>([\s\S]*?)<\/li>/gi; let lm;
    while((lm=liRe.exec(inner))){ n++; listParas.push(n+'.  '+inlineHtmlToRtf(lm[1])); }
    return '';
  });
  const paras=[]; const re=/<p[^>]*>([\s\S]*?)<\/p>/gi; let m,any=false;
  while((m=re.exec(s))){ any=true; paras.push(m[1]); }
  if(!any && s.replace(/<[^>]+>/g,'').trim()) paras.push(s);
  return paras.map(inlineHtmlToRtf).filter(p=>p.trim()!=='').concat(listParas.filter(p=>p.trim()!==''));
}
function plainTextToRtfParagraphs(text){
  return String(text||'').split(/\n+/).map(l=>l.trim()).filter(Boolean).map(l=>rtfEscapeText(l));
}
function exportFieldToRtfParagraphs(kind,value){
  // plainToRichHtml() (see richTa() above) — a field that's now 'html' kind
  // (Round 11, item 5's newly-converted fields) may still hold RAW, un-
  // migrated plain multi-line text from before this round (nothing rewrites
  // the Sheet until David next edits that specific field). Without this,
  // htmlFragmentToRtfParagraphs() would see no <p>/<br> structure at all and
  // collapse the whole value into a single run-on RTF paragraph, silently
  // losing the line breaks in the Word export specifically (the live UI and
  // the HTML "source" export both already handle this fine — richTa()
  // applies the same wrap for display, and the HTML export's <pre> block
  // preserves raw newlines natively either way). Same normalization, same
  // "already has real tags → left untouched" guard, just applied here too
  // so the Word export can't silently regress on legacy data.
  if(kind==='html') return htmlFragmentToRtfParagraphs(plainToRichHtml(value));
  if(kind==='list') return (value||'').split('\n').map(s=>s.trim()).filter(Boolean).map(s=>'\u2022  '+rtfEscapeText(s));
  if(kind==='quote') return (value||'').split('\n').map(s=>s.trim()).filter(Boolean).map(s=>'\u201c'+rtfEscapeText(s)+'\u201d');
  return plainTextToRtfParagraphs(value);
}
// Round 7, item 1 — running footer for the Word export. RTF footers are
// declared with a {\footer ...} group; placed here, right after the font
// table and before any body content, it applies to every page of the
// document (no per-section overrides are used elsewhere in this file, so
// there's only ever the one section to apply it to). \chpgn is the RTF
// control word that inserts the actual current page number at render/print
// time in Word — simpler and more universally supported across RTF readers
// than a {\field{\*\fldinst PAGE}} field code, and gives the same result.
// Creation date is computed once, at export time (i.e. "the date the file
// was created" per the brief) — not tied to any field on the title itself.
function rtfFooterGroup(){
  const year=new Date().getFullYear();
  const created=new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  // Only the human-readable text pieces go through rtfEscapeText — the
  // control words (\tab, \chpgn, \pard etc.) must stay as literal,
  // unescaped RTF or rtfEscapeText's backslash-doubling would corrupt them
  // (e.g. \chpgn becoming the literal text "\chpgn" instead of a real page
  // number field).
  const copyrightText=rtfEscapeText('\u00a9 Headpress '+year+'. All rights reserved.');
  const createdText=rtfEscapeText('Created '+created);
  return '{\\footer\\pard\\qc\\fs16 '+copyrightText+'\\tab\\tab Page \\chpgn\\tab\\tab '+createdText+'\\par}\n';
}
function buildTitleRtf(t){
  const blockNameById={}; (data.blocks||[]).forEach(b=>{ blockNameById[b.block_id]=b.block_name; });
  const h1=s=>'{\\pard\\sa240\\b\\fs36 '+rtfEscapeText(s)+'\\par}\n';
  const h2=s=>'{\\pard\\sb320\\sa200\\b\\fs28\\ul '+rtfEscapeText(s)+'\\par}\n';
  const h3=s=>'{\\pard\\sb160\\sa60\\b\\fs22 '+rtfEscapeText(s)+'\\par}\n';
  const bodyOf=(kind,value)=>{
    const paras=exportFieldToRtfParagraphs(kind,value);
    if(!paras.length) return '{\\pard\\sa200\\fs22\\i - \\i0\\par}\n';
    return paras.map(p=>'{\\pard\\sa200\\fs22 '+p+'\\par}\n').join('');
  };
  let out='{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Calibri;}}\\viewkind4\\uc1\\fs22\\f0\n';
  out+=rtfFooterGroup();
  out+=h1(t.title+(t.subtitle?' \u2014 '+t.subtitle:''));
  out+=bodyOf('text', contributorLabel(t)||'—');
  out+=bodyOf('text','Imprint: '+imprintName(t.imprint)+'   |   Status: '+t.status);
  out+=h2('Key Contacts');
  out+=h3('Author Liaison'); out+=bodyOf('text', t.authorLiaison);
  out+=h3('PR Contact'); out+=bodyOf('text', t.publicity.prContact);
  SECTION_KEYS.forEach(key=>{
    out+=h2(SECTION_LABELS[key]);
    getSectionExportFields(t,key,blockNameById).forEach(([label,kind,value])=>{
      out+=h3(label);
      out+=bodyOf(kind,value);
    });
  });
  out+='}';
  return out;
}
// Downloads the .rtf directly (no new tab — a Word file isn't meant to be
// read in-browser) named after the title, sanitised of characters Windows
// filenames can't contain.
function downloadWordFile(titleId){
  const t=getTitle(titleId);if(!t)return;
  const rtf=buildTitleRtf(t);
  const blob=new Blob([rtf],{type:'application/rtf'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=(t.title||'title').trim().replace(/[\\/:*?"<>|]+/g,'_').slice(0,120)+'.rtf';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}

// ─── PROGRESS REPORT (Round 24, 2026-08-20) — replaces "Push To Todoist"
// entirely, per David's explicit ask (old feature was noisy/not useful).
// Built to match the David-approved mockup: _mockups/
// ProgressReport_Mockup_2026-08-20_v3.html — one row per title (Book Title /
// Pipeline Notes / Print Deadline / Street Date), Street-Date-primary sort
// with a Print-Deadline fallback, dated titles grouped above a divider from
// pipeline-note-only titles, 4-way filter, colour-coded overdue/soon dates,
// and Copy/Export + Print.
//
// Deliberately reuses this app's OWN daysUntil()/formatDate()/
// calcAutoPrint()/isPublished() rather than a second, parallel
// implementation (the mockup used its own pure-UTC date math to sidestep
// the known live calcAutoPrint() timezone/DST edge case — see that
// function's own history — without fixing the underlying bug). Using the
// same helpers here means this report's day-counts always agree with the
// same title's badge everywhere else in the Hub, including inheriting that
// same known edge case rather than quietly diverging with a second "more
// correct" version just for this one screen. Flagged in the build report,
// not silently fixed here either.
//
// Inclusion/exclusion: a title is excluded outright if isPublished(t) is
// true (status==='Complete' — legacy 'Completed'/'Released' literals are
// remapped to it at load, see normalizeStatus(), Round 27). Note this means
// a title whose Street Date has passed can
// vanish from this report the moment applyStatusAutoRules() auto-flips its
// status to 'Complete' on next load, even if it still has real outstanding
// pipeline notes — that's existing app-wide behaviour (not new here), but
// worth knowing if a title unexpectedly disappears.
let reportFilter = 'all';

function reportRows(){
  return data.titles
    .filter(t => !isPublished(t))
    .map(t => {
      const effPrint = t.dates.autoPrintDate ? calcAutoPrint(t.dates.streetDate) : t.dates.printDate;
      const pipelineDated = (t.pipeline.stages||[])
        .filter(s => s.status!=='Complete' && s.status!=='Not Required' && s.expectedDate)
        .slice()
        .sort((a,b) => a.expectedDate<b.expectedDate?-1:a.expectedDate>b.expectedDate?1:0);
      const pipelineNotes = pipelineDated.map(s => s.notes ? `${formatDate(s.expectedDate)} – ${s.name} – ${s.notes}` : `${formatDate(s.expectedDate)} – ${s.name}`);
      const earliestPipelineDate = pipelineDated.length ? pipelineDated[0].expectedDate : null;
      return {
        id: t.id, title: t.title,
        printDate: effPrint, printAuto: !!t.dates.autoPrintDate, printDays: daysUntil(effPrint),
        streetDate: t.dates.streetDate, streetDays: daysUntil(t.dates.streetDate),
        pipelineNotes, earliestPipelineDays: daysUntil(earliestPipelineDate)
      };
    })
    .filter(r => r.printDate || r.streetDate || r.pipelineNotes.length);
}

function reportByTitle(a,b){ return a.title.localeCompare(b.title); }

function getReportRows(filter){
  const rows = reportRows();
  if(filter==='street'){
    return { flat: rows.filter(r=>r.streetDate).sort((a,b)=>a.streetDays-b.streetDays||reportByTitle(a,b)) };
  }
  if(filter==='print'){
    return { flat: rows.filter(r=>r.printDate).sort((a,b)=>a.printDays-b.printDays||reportByTitle(a,b)) };
  }
  if(filter==='pipeline'){
    return { flat: rows.filter(r=>r.pipelineNotes.length).sort((a,b)=>a.earliestPipelineDays-b.earliestPipelineDays||reportByTitle(a,b)) };
  }
  // all — Group A: has Street and/or Print Deadline, Street-Date-primary
  // sort (overdue floats to top, Print Deadline used as fallback placement
  // when no Street Date). Group B: no Street/Print date but has an
  // outstanding pipeline note — sorts to the bottom, by that note's own
  // date, soonest/most-overdue first.
  const groupA = rows.filter(r => r.streetDate || r.printDate).sort((a,b) => {
    const ka = a.streetDate ? a.streetDays : a.printDays;
    const kb = b.streetDate ? b.streetDays : b.printDays;
    return ka - kb || reportByTitle(a,b);
  });
  const groupB = rows.filter(r => !r.streetDate && !r.printDate && r.pipelineNotes.length)
    .sort((a,b) => a.earliestPipelineDays - b.earliestPipelineDays || reportByTitle(a,b));
  return { groupA, groupB };
}

function reportDateColorClass(days){
  if(days===null) return '';
  if(days<0) return 'rpt-overdue';
  if(days<=30) return 'rpt-warn';
  return 'rpt-normal';
}
function reportDayWord(n){ return n===1 ? 'DAY' : 'DAYS'; }
function reportRelLabel(days){
  if(days===null) return '';
  if(days<0){ const n=Math.abs(days); return `OVERDUE ${n} ${reportDayWord(n)}`; }
  if(days===0) return 'TODAY';
  if(days===1) return 'TOMORROW';
  return `IN ${days} ${reportDayWord(days)}`;
}
function reportDateCell(dateStr, days, auto){
  if(!dateStr) return '<span class="rpt-dash">—</span>';
  const cls = reportDateColorClass(days);
  const sub = days!==null ? `<span class="rpt-date-sub">${esc(reportRelLabel(days))}</span>` : '';
  const autoNote = auto ? ' <span class="rpt-dash" style="font-style:italic;font-weight:400">(auto-calc)</span>' : '';
  return `<span class="${cls}">${esc(formatDate(dateStr))}${autoNote}${sub}</span>`;
}
function reportNotesCell(notes){
  if(!notes || !notes.length) return '<span class="rpt-dash">—</span>';
  return notes.map(n => `<div class="rpt-note-line">${esc(n)}</div>`).join('');
}
function reportRowHtml(r){
  return `<tr>
      <td class="rpt-col-title"><button class="rpt-item-title" onclick="gotoDetail('${esc(r.id)}')">${esc(r.title)}</button></td>
      <td class="rpt-col-notes">${reportNotesCell(r.pipelineNotes)}</td>
      <td class="rpt-col-date">${reportDateCell(r.printDate, r.printDays, r.printAuto)}</td>
      <td class="rpt-col-date">${reportDateCell(r.streetDate, r.streetDays, false)}</td>
    </tr>`;
}
function reportSummaryHtml(){
  // Headline count is scoped to titles with a Print Deadline and/or Street
  // Date (the two colour-coded columns) — pipeline-only titles (Group B)
  // aren't reflected here since neither of their columns is colour-coded.
  const dated = reportRows().filter(r => r.streetDate || r.printDate);
  let overdue = 0, soon = 0;
  dated.forEach(r => {
    const days = [r.printDays, r.streetDays].filter(d => d !== null);
    if(days.some(d => d < 0)) overdue++;
    else if(days.some(d => d >= 0 && d <= 30)) soon++;
  });
  return `<span class="rpt-summary-chip"><span class="rpt-summary-dot rpt-overdue-dot"></span>${overdue} overdue</span>`+
    `<span class="rpt-summary-chip"><span class="rpt-summary-dot rpt-warn-dot"></span>${soon} within 30 days</span>`;
}

// ─── RELEASE SCHEDULE block (Round 39, 2026-08-30, David-approved build) ───
// Built for real off the David-approved mockup (release-schedule-preview.html,
// round 2 — flag badge removed since this is now a permanent feature, not a
// proposal under review). Renders ABOVE the existing report table (see
// renderReport() below) per David's own reasoning: this block stays compact
// (one row per In Progress title with a real Release Block assigned) while
// the table below only grows as Pipeline Notes content accumulates.
//
// Scope: status === 'In Progress' AND a real blockId assigned — excludes
// both an unset blockId and the 'not-yet-assigned' placeholder block (see
// the {block_id:'not-yet-assigned', block_name:'Not Yet Assigned'} entry in
// data.blocks, and the blockId/dates.releaseBlock migration comment above
// releaseBlockSelectHtml()). Recomputed live from data.titles on every
// render — not a snapshot — so the count/rows always reflect current data.
// Sorted soonest Street Date first (rows without a Street Date are excluded
// outright, since "Deadline (Street Date)" is the whole point of this
// table — there's nothing to schedule against otherwise).
//
// Margin/date colour classes deliberately reuse reportDateColorClass() (the
// same overdue/warn/normal logic driving every other date in this report)
// rather than a second parallel threshold, so "overdue" means the same
// thing here as everywhere else on this screen.
function scheduleRows(){
  const blockNameById={}; (data.blocks||[]).forEach(b=>{ blockNameById[b.block_id]=b.block_name; });
  return data.titles
    .filter(t => t.status==='In Progress' && t.blockId && t.blockId!=='not-yet-assigned' && t.dates.streetDate)
    .map(t => ({
      id: t.id, title: t.title,
      blockLabel: blockNameById[t.blockId] || t.dates.releaseBlock || t.blockId,
      streetDate: t.dates.streetDate, streetDays: daysUntil(t.dates.streetDate)
    }))
    .sort((a,b) => a.streetDays-b.streetDays || reportByTitle(a,b));
}
function scheduleDateCell(dateStr, days){
  const cls = reportDateColorClass(days);
  return `<span class="${cls}">${esc(formatDate(dateStr))}</span>`;
}
function scheduleMarginCell(days){
  const cls = reportDateColorClass(days);
  const num = days<0 ? ('−'+Math.abs(days)) : String(days);
  const unitWord = Math.abs(days)===1 ? 'day' : 'days';
  const unit = days<0 ? `${unitWord} (overdue)` : unitWord;
  return `<span class="${cls}"><span class="sched-margin-num">${num}</span><span class="sched-margin-unit">${esc(unit)}</span></span>`;
}
function scheduleRowHtml(r){
  return `<tr>
      <td class="sched-col-title"><button class="sched-item-title" onclick="gotoDetail('${esc(r.id)}')">${esc(r.title)}</button></td>
      <td class="sched-col-block">${esc(r.blockLabel)}</td>
      <td class="sched-col-date">${scheduleDateCell(r.streetDate, r.streetDays)}</td>
      <td class="sched-col-margin">${scheduleMarginCell(r.streetDays)}</td>
    </tr>`;
}
function scheduleBlockHtml(){
  const rows = scheduleRows();
  const body = rows.length
    ? `<div class="rpt-table-card schedule-card"><div class="rpt-table-scroll"><table class="schedule-table">
        <thead><tr><th>Title</th><th>Release Block</th><th>Deadline (Street Date)</th><th>Margin</th></tr></thead>
        <tbody>${rows.map(scheduleRowHtml).join('')}</tbody>
      </table></div></div>`
    : `<div class="rpt-table-card schedule-card"><div class="rpt-empty">No In Progress titles have a Release Block assigned right now.</div></div>`;
  return `
    <div class="sched-block-wrap">
      <div class="sched-block-head"><h3>Release Schedule</h3></div>
      <div class="sched-block-sub">In Progress titles with a Release Block assigned &middot; ${rows.length} title${rows.length===1?'':'s'} &middot; sorted soonest Street Date first</div>
      ${body}
    </div>`;
}

function renderReport(){
  const main=document.getElementById('main');
  main.innerHTML = `
    <div class="rpt-page-head">
      <h2 style="font-family:var(--serif);font-weight:normal;font-size:1.3rem">Progress Report</h2>
      <div class="rpt-summary-line" id="rpt-summary-line">${reportSummaryHtml()}</div>
    </div>
    ${scheduleBlockHtml()}
    <div class="rpt-toolbar">
      <div class="filter-group" role="group" aria-label="Filter">
        <!-- Order per David's explicit confirmation (2026-08-20): All,
             Street Date, Print Deadline, Pipeline Notes — All leftmost.
             Differs from the v3 mockup file's own button order
             (Street/Print/All/Pipeline); this live build follows David's
             later word over the mockup. -->
        <button class="filter-btn ${reportFilter==='all'?'active':''}" onclick="setReportFilter('all')">All</button>
        <button class="filter-btn ${reportFilter==='street'?'active':''}" onclick="setReportFilter('street')">Street Date</button>
        <button class="filter-btn ${reportFilter==='print'?'active':''}" onclick="setReportFilter('print')">Print Deadline</button>
        <button class="filter-btn ${reportFilter==='pipeline'?'active':''}" onclick="setReportFilter('pipeline')">Pipeline Notes</button>
      </div>
      <div class="rpt-toolbar-right">
        <button class="btn btn-primary btn-sm" onclick="openReportExport()">Copy / Export</button>
        <button class="btn btn-sm" onclick="window.print()">Print</button>
        ${isPopoutReport
          ? `<button class="btn btn-sm" id="rpt-popout-refresh-btn" onclick="refreshPopoutReport()">&#8635; Refresh</button>`
          : `<button class="btn btn-sm" onclick="openReportPopout()">Open in New Window</button>`}
      </div>
    </div>
    <div class="rpt-table-card">
      <div class="rpt-table-scroll">
        <table class="report-table">
          <thead>
            <tr><th>Book Title</th><th>Pipeline Notes</th><th>Print Deadline</th><th>Street Date</th></tr>
          </thead>
          <tbody id="rpt-tbody"></tbody>
        </table>
      </div>
      <div id="rpt-empty" class="rpt-empty" style="display:none">Nothing matches this filter right now.</div>
    </div>`;
  renderReportTable();
}
function setReportFilter(f){ reportFilter=f; renderReport(); }
function renderReportTable(){
  const result = getReportRows(reportFilter);
  const tbody = document.getElementById('rpt-tbody');
  const empty = document.getElementById('rpt-empty');
  let bodyRows = [];
  let totalCount = 0;
  if(result.flat){
    totalCount = result.flat.length;
    bodyRows = result.flat.map(reportRowHtml);
  } else {
    totalCount = result.groupA.length + result.groupB.length;
    bodyRows = result.groupA.map(reportRowHtml);
    if(result.groupB.length){
      bodyRows.push(`<tr class="rpt-group-divider"><td colspan="4">No Street/Print Date — by Pipeline Note</td></tr>`);
      bodyRows = bodyRows.concat(result.groupB.map(reportRowHtml));
    }
  }
  if(!totalCount){
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = bodyRows.join('');
}

// ── Copy / Export ──
function reportExportLine(r){
  const lines = [];
  lines.push(r.title);
  if(r.pipelineNotes.length) r.pipelineNotes.forEach(n => lines.push('  Pipeline: ' + n));
  else lines.push('  Pipeline: —');
  lines.push('  Print Deadline: ' + (r.printDate ? `${formatDate(r.printDate)}${r.printDays<0?' (OVERDUE)':r.printDays<=30?' (soon)':''}${r.printAuto?' (auto-calc)':''}` : '—'));
  lines.push('  Street Date: ' + (r.streetDate ? `${formatDate(r.streetDate)}${r.streetDays<0?' (OVERDUE)':r.streetDays<=30?' (soon)':''}` : '—'));
  lines.push('');
  return lines;
}
function buildReportExportText(){
  const filterLabel = {all:'All', street:'Street Date', print:'Print Deadline', pipeline:'Pipeline Notes'}[reportFilter];
  const lines = [];
  lines.push('BOOK PRODUCTION HUB — PROGRESS REPORT');
  lines.push('As of ' + formatDate(new Date().toDateString()));
  lines.push('Filter: ' + filterLabel);
  lines.push('');
  const result = getReportRows(reportFilter);
  if(result.flat){
    if(!result.flat.length){ lines.push('(nothing matches this filter)'); return lines.join('\n'); }
    result.flat.forEach(r => lines.push(...reportExportLine(r)));
  } else {
    if(!result.groupA.length && !result.groupB.length){ lines.push('(nothing matches this filter)'); return lines.join('\n'); }
    result.groupA.forEach(r => lines.push(...reportExportLine(r)));
    if(result.groupB.length){
      lines.push('-- NO STREET/PRINT DATE — BY PIPELINE NOTE --');
      lines.push('');
      result.groupB.forEach(r => lines.push(...reportExportLine(r)));
    }
  }
  return lines.join('\n');
}
function openReportExport(){
  document.getElementById('report-export-text').value = buildReportExportText();
  document.getElementById('report-export-modal').classList.remove('hidden');
}
function closeReportExport(){ document.getElementById('report-export-modal').classList.add('hidden'); }
function copyReportExport(){
  const ta = document.getElementById('report-export-text');
  ta.select();
  navigator.clipboard.writeText(ta.value).then(()=>{
    const btn = document.querySelector('#report-export-modal .modal-footer .btn-primary');
    if(btn){ const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(()=>btn.textContent=orig,1500); }
  }).catch(()=>{ document.execCommand('copy'); });
}

// ─── PROGRESS REPORT POPOUT WINDOW (Round 25, 2026-08-20, David request) ───
// David wants the Progress Report visible in its own window alongside the
// main Hub (e.g. second monitor / split-screen) while he works through
// individual title records. Implementation: the popout is this exact same
// page, reopened in a new browser window with ?popout=report on the URL —
// NOT a second, parallel rendering path. init() above detects that flag,
// forces view='report' and adds the popout-mode body class (CSS below
// hides #app-header/#app-footer/nav/quick-note fab so it reads as a clean
// reference window). This means the popout gets every future report change
// "for free" — it can never drift out of sync with the real
// renderReport()/reportRows() logic the way a hand-duplicated version could.
// Manual refresh ONLY, per David's explicit confirmation — no
// polling/auto-sync between the two windows. Deliberately simple: the
// Refresh button just re-runs the same loadAllData() the main window uses.
function openReportPopout(){
  const url = location.origin + location.pathname + '?popout=report';
  const left = Math.max(0, (window.screenX||0) + 80);
  const top = Math.max(0, (window.screenY||0) + 60);
  const w = window.open(url, 'bookhub-progress-report-popout',
    `width=1000,height=760,left=${left},top=${top},resizable=yes,scrollbars=yes`);
  if(!w){
    alert('This browser blocked the popout window. Please allow popups for this site (Book Production Hub) and try again.');
  } else {
    w.focus();
  }
}
async function refreshPopoutReport(){
  const btn = document.getElementById('rpt-popout-refresh-btn');
  if(btn){ btn.disabled = true; btn.innerHTML = '&#8635; Refreshing…'; }
  await loadAllData(); // re-pulls Sheets data + calls render() -> renderReport()
  const freshBtn = document.getElementById('rpt-popout-refresh-btn'); // re-query: loadAllData()'s render() rebuilt #main
  if(freshBtn){ freshBtn.disabled = false; freshBtn.innerHTML = '&#8635; Refresh'; }
}

// ─── CALENDAR (Round 32, 2026-08-26, David request) ───
// Follows the feasibility assessment given earlier the same day: no schema
// changes needed (dates.softDate/streetDate/printDate/autoPrintDate already
// exist per title), in-app calendar built first as the foundation, print
// stylesheet on top of it — Google Calendar sync is a separate, later piece
// (Marcus Webb's lane, one-way push only), not part of this build.
//
// Monday-first month grid, weekends visually muted (see .cal-cell.weekend
// in index.html), multiple titles on one date stack as small colour/tag
// -coded entries with a "+N more" overflow past 3 (print always shows the
// full list — see .cal-cell-extra print override). Click any entry to jump
// straight to that title's record (gotoDetail — nav consistent with every
// other cross-reference in this app, e.g. the Progress Report's title
// links).
function calPrevMonth(){ calMonth--; if(calMonth<0){ calMonth=11; calYear--; } renderCalendar(); }
function calNextMonth(){ calMonth++; if(calMonth>11){ calMonth=0; calYear++; } renderCalendar(); }
function calToday(){ const n=new Date(); calYear=n.getFullYear(); calMonth=n.getMonth(); renderCalendar(); }

// Monday-first grid of Date objects for one month. Always at least 5 weeks
// (35 cells); a 6th week is included only when the month genuinely spans
// one (the trailing all-next-month week is dropped otherwise) so most
// months don't carry a blank extra row.
function calGridDays(year, month){
  const first = new Date(year, month, 1);
  const firstDow = (first.getDay()+6)%7; // Mon=0 .. Sun=6
  const start = new Date(year, month, 1-firstDow);
  let cells = [];
  for(let i=0;i<42;i++){
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate()+i);
    cells.push({dt, inMonth: dt.getMonth()===month, dow: (dt.getDay()+6)%7});
  }
  if(cells.slice(35).every(c=>!c.inMonth)) cells = cells.slice(0,35);
  return cells;
}
// A title's three date fields, resolved (print date honours autoPrintDate,
// same as everywhere else this app reads it — see renderDates()/reportRows()).
function calTitleDateEntries(t){
  const d=t.dates;
  const pd = d.autoPrintDate ? calcAutoPrint(d.streetDate) : d.printDate;
  return [['soft',d.softDate],['street',d.streetDate],['print',pd]]
    .filter(([,ds])=>ds)
    .map(([type,ds])=>({type, dt:new Date(ds)}))
    .filter(e=>!isNaN(e.dt));
}
function calendarEntriesForMonth(year, month){
  const out=[];
  data.titles.forEach(t=>{
    calTitleDateEntries(t).forEach(e=>{
      if(e.dt.getFullYear()===year && e.dt.getMonth()===month){
        out.push({titleId:t.id, title:t.title, day:e.dt.getDate(), type:e.type});
      }
    });
  });
  return out;
}
// Round 36 (2026-08-26, David request) — "Month Name (N)" label format,
// e.g. "January (1)", used on both print outputs (Print Month heading and
// the Year Planner's per-row month labels) per David's explicit format ask.
function calMonthNumLabel(month){
  const name = new Date(2000,month,1).toLocaleDateString('en-GB',{month:'long'});
  return `${name} (${month+1})`;
}
const CAL_TYPE_LABEL = {soft:'Soft', street:'Street', print:'Print'};
// Round 33 (2026-08-26, David feedback) — spelled out in full (was So/St/Pr);
// the abbreviations read as unclear at a glance.
const CAL_TYPE_TAG = {soft:'SOFT', street:'STREET', print:'PRINT'};
function calEntryHtml(e){
  return `<button type="button" class="cal-entry cal-entry-${e.type}" onclick="gotoDetail('${esc(e.titleId)}')" title="${esc(CAL_TYPE_LABEL[e.type])} Date — ${esc(e.title)}"><span class="cal-entry-tag">${CAL_TYPE_TAG[e.type]}</span><span class="cal-entry-title">${esc(e.title)}</span></button>`;
}
// Screen: stack up to 3 entries, "+N more" toggles the rest inline. Print
// (see @media print in index.html) always shows every entry and hides the
// toggle — paper has no hover/click, so nothing should stay hidden on it.
function calCellEntriesHtml(dayEntries){
  if(!dayEntries.length) return '';
  const MAX=3;
  if(dayEntries.length<=MAX) return dayEntries.map(calEntryHtml).join('');
  const shown = dayEntries.slice(0,MAX).map(calEntryHtml).join('');
  const extra = dayEntries.slice(MAX).map(calEntryHtml).join('');
  return `${shown}<div class="cal-more-wrap"><button type="button" class="cal-more-btn" onclick="this.parentElement.classList.toggle('open')">+${dayEntries.length-MAX} more</button><div class="cal-cell-extra">${extra}</div></div>`;
}
function calLegendHtml(){
  return `<div class="cal-legend">
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-entry-soft"></span>Soft Date</span>
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-entry-street"></span>Street Date</span>
    <span class="cal-legend-item"><span class="cal-legend-swatch cal-entry-print"></span>Print Date</span>
  </div>`;
}
function renderCalendar(){
  const main=document.getElementById('main');
  const monthLabel = new Date(calYear,calMonth,1).toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  const entries = calendarEntriesForMonth(calYear,calMonth);
  const byDay={};
  entries.forEach(e=>{ (byDay[e.day]=byDay[e.day]||[]).push(e); });
  const dowNames=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const head = dowNames.map((n,i)=>`<div class="cal-dow-head${i>=5?' weekend':''}">${n}</div>`).join('');
  const cells = calGridDays(calYear,calMonth).map(c=>{
    const dayEntries = c.inMonth ? (byDay[c.dt.getDate()]||[]) : [];
    // Round 35 (2026-08-26, David request) — box outline around any day
    // that has at least one entry, so days with content stand out from
    // empty ones at a glance. Screen and print both pick this up (see
    // .cal-cell.has-entries in index.html).
    const cls=['cal-cell']; if(!c.inMonth) cls.push('outside'); if(c.dow>=5) cls.push('weekend'); if(dayEntries.length) cls.push('has-entries');
    return `<div class="${cls.join(' ')}"><div class="cal-cell-daynum">${c.dt.getDate()}</div><div class="cal-cell-entries">${calCellEntriesHtml(dayEntries)}</div></div>`;
  }).join('');
  main.innerHTML = `
    <div class="cal-page-head">
      <h2 class="cal-page-title" style="font-family:var(--serif);font-weight:normal;font-size:1.3rem">Calendar</h2>
      <!-- Round 36 (2026-08-26, David bug report) — Print Month had NO month
           name anywhere on the printed page: the only place the current
           month showed was .cal-month-label inside .cal-toolbar, and the
           toolbar is explicitly hidden in print (display:none!important,
           see @media print in index.html — toolbar controls are
           meaningless on paper). This heading is the fix: screen-hidden
           (.cal-print-month-head, display:none by default), shown only in
           print, right where the generic "Calendar" title was — so the
           printed page always states which month it is. Format per David's
           explicit ask, item 3: "Month Name (N)". -->
      <h2 class="cal-print-month-head">${esc(calMonthNumLabel(calMonth))} ${calYear}</h2>
      ${calLegendHtml()}
    </div>
    <div class="cal-toolbar">
      <div class="cal-nav">
        <button type="button" class="btn btn-sm" onclick="calPrevMonth()">&larr; Prev</button>
        <div class="cal-month-label">${esc(monthLabel)}</div>
        <button type="button" class="btn btn-sm" onclick="calNextMonth()">Next &rarr;</button>
        <button type="button" class="btn btn-sm" onclick="calToday()">Today</button>
      </div>
      <div class="cal-toolbar-right">
        <button type="button" class="btn btn-sm" onclick="printCalendarMonth()">Print Month</button>
        <button type="button" class="btn btn-sm" onclick="printCalendarYear()">Print Year Planner</button>
        <button type="button" class="btn btn-primary btn-sm" id="gcal-sync-btn" onclick="onGcalSyncClick()">Sync to Google Calendar</button>
      </div>
    </div>
    <div class="cal-sync-status" id="gcal-sync-status">${esc(typeof gcalLastSyncLabel==='function'?gcalLastSyncLabel():'')}</div>
    <div class="cal-grid">${head}${cells}</div>
    <div id="cal-year-print"></div>`;
}
function printCalendarMonth(){ window.print(); }

// ── Year print — redesigned Round 36 (2026-08-26, David request) as a
// row-per-month DESK PLANNER, replacing the old grid-of-mini-months
// layout entirely. David's own framing: he wants "a year/six months
// planner that can sit on my desk" — a physical at-a-glance reference,
// not just a compact overview — and specifically questioned whether the
// old dense 3x2 grid-of-tiny-month-grids actually made it easy to spot
// which days had events. His suggestion, which this implements: one row
// per month, days running left to right, rather than a small grid-shaped
// mini-month.
//
// Design choice: rows run by DAY-OF-MONTH (1..31), not weekday-aligned.
// A weekday-aligned row-per-month layout is a contradiction — each
// month's 1st falls on a different weekday, so aligning by weekday would
// stagger every row's starting column differently, which is exactly the
// dense/hard-to-scan problem being fixed. A day-of-month ruler (this is
// the standard "wall planner" format sold in office supply stores) keeps
// every row starting at column 1, so a given calendar date is always the
// same column down the whole page — genuinely scannable "what's on the
// 15th all year" at a glance, which is the point of a desk planner.
// Weekend shading is still per-cell (each cell knows its real date), so
// the familiar diagonal weekend banding real printed planners have shows
// up naturally — expected, not a bug.
//
// Scope: single page, all 12 months, landscape A4 — tested at this
// density via the print-CSS-as-screen-CSS technique and it holds up
// legibly (each day cell is ~8mm wide, well clear of the shape marks),
// so there's no need for the old 2-page 6-month split. Shape-per-date-
// type marks (circle/square/triangle) are unchanged from the previous
// year view — already B&W-print-safe and working, so kept as-is.
function calPlannerDayCellHtml(year, month, day, daysInMonth, byDay){
  if(day>daysInMonth) return '<div class="cal-pl-cell cal-pl-blocked"></div>';
  const dow = (new Date(year,month,day).getDay()+6)%7; // Mon=0..Sun=6
  const types = Array.from(byDay[day]||[]);
  const dots = types.map(t=>`<span class="cal-mini-dot cal-mini-dot-${t}"></span>`).join('');
  const cls=['cal-pl-cell']; if(dow>=5) cls.push('weekend');
  return `<div class="${cls.join(' ')}"><span class="cal-pl-daynum">${day}</span><span class="cal-pl-dots">${dots}</span></div>`;
}
function calPlannerRowHtml(year, month, monthEntries){
  const byDay={};
  monthEntries.forEach(e=>{ (byDay[e.day]=byDay[e.day]||new Set()).add(e.type); });
  const daysInMonth = new Date(year,month+1,0).getDate();
  const cells = Array.from({length:31},(_,i)=>calPlannerDayCellHtml(year,month,i+1,daysInMonth,byDay)).join('');
  // Month label format per David's explicit ask (item 3): "Month Name (N)".
  return `<div class="cal-pl-row"><div class="cal-pl-label">${esc(calMonthNumLabel(month))}</div>${cells}</div>`;
}
function calPlannerHeaderRowHtml(){
  const cells = Array.from({length:31},(_,i)=>`<div class="cal-pl-cell cal-pl-headcell">${i+1}</div>`).join('');
  return `<div class="cal-pl-row cal-pl-headrow"><div class="cal-pl-label"></div>${cells}</div>`;
}
// Shaped legend for the year-print view — circle/square/triangle so the
// legend itself still reads correctly if photocopied/printed in B&W.
function calYearLegendHtml(){
  return `<div class="cal-year-legend">
    <span class="cal-year-legend-item"><span class="cal-year-legend-swatch soft"></span>Soft Date (circle)</span>
    <span class="cal-year-legend-item"><span class="cal-year-legend-swatch street"></span>Street Date (square)</span>
    <span class="cal-year-legend-item"><span class="cal-year-legend-swatch print"></span>Print Date (triangle)</span>
  </div>`;
}
function calYearPlannerHtml(year){
  const byMonth = Array.from({length:12},()=>[]);
  data.titles.forEach(t=>{
    calTitleDateEntries(t).forEach(e=>{
      if(e.dt.getFullYear()===year) byMonth[e.dt.getMonth()].push({day:e.dt.getDate(), type:e.type});
    });
  });
  const rows = byMonth.map((entries,i)=>calPlannerRowHtml(year,i,entries)).join('');
  return `<div class="cal-year-page cal-planner-page">
    <div class="cal-year-print-head"><h2>${year} — Year Planner</h2>${calYearLegendHtml()}</div>
    <div class="cal-planner-grid">${calPlannerHeaderRowHtml()}${rows}</div></div>`;
}
function printCalendarYear(){
  const container=document.getElementById('cal-year-print');
  if(!container) return;
  container.innerHTML = calYearPlannerHtml(calYear);
  document.body.classList.add('cal-printing-year');
  calYearPrintStyleEl = document.createElement('style');
  calYearPrintStyleEl.textContent = '@media print{@page{size:A4 landscape;margin:10mm}}';
  document.head.appendChild(calYearPrintStyleEl);
  window.print();
}
window.addEventListener('afterprint', function(){
  if(document.body.classList.contains('cal-printing-year')){
    document.body.classList.remove('cal-printing-year');
    if(calYearPrintStyleEl){ calYearPrintStyleEl.remove(); calYearPrintStyleEl=null; }
  }
});

// ─── INIT ───
window.addEventListener('DOMContentLoaded', init);
function init(){
  setSyncStatus('none');
  // Round 25 (2026-08-20) — popout window: strip the Hub chrome and land
  // straight on the report. The auth overlay/sign-in flow underneath is
  // untouched — this is a genuinely separate window with its own JS memory
  // (google-auth.js's token is deliberately never persisted, see that
  // file's header comment), so it signs in independently of the main
  // window. That's expected, not a bug — flagged in the delivery report.
  if(isPopoutReport){
    document.body.classList.add('popout-mode');
    view = 'report';
  }
  if(!CFG.GOOGLE_CLIENT_ID){
    document.getElementById('auth-error').style.display='block';
    document.getElementById('auth-error').textContent = 'GOOGLE_CLIENT_ID is not set in config.js yet — sign-in is disabled until David creates the OAuth Web application Client ID in Google Cloud Console (see MARCUS_BookProductionHubInfra_2026-07-10.md §3) and pastes it in. Use "Load sample data" below to preview the UI in the meantime.';
    document.getElementById('auth-signin-btn').disabled = true;
  }
  render(); // draws the (empty) shell behind the auth overlay
}
