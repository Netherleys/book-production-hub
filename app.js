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
  'blockId','quickNotes_json'
];
const TITLE_RANGE_LAST_COL = 'AP'; // keep in lockstep with TITLE_COLS.length (42)
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
  { label:'Production', stages:['Cover','Cover Templates','Manuscript','Images','Proofing','Layout'] },
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
let view = 'titles', selectedId = null, saveTimer = null, syncStatus = 'none';
let accordionOpen = {}, filters = { status:'', imprint:'', search:'', block:'', printTiming:'' }, isbnFilter = 'all';
let isbnLocked = {}; // titleId -> {isbnPbk:bool, isbnHbk:bool, isbnEbk:bool} — true = locked (default). Item 18 lock mechanism, session-only by design (see build report).
let qnOpen = false;
// Item 6 (Round 3) — Active/Archived toggle state for the Quick Notes list
// view. Session-only (not persisted) — always opens back on Active, same
// pattern as isbnFilter above.
let qnListMode = 'active';
let assignCtx = null;
let devMode = false; // true when previewing with sample data, no network writes
let poLogRowsCache = null; // lazy-loaded PO Log rows from the PO tracker sheet
let poTabGidCache = null; // tabName(lowercase) -> {gid, title}

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
function calcAutoPrint(sd){ if(!sd) return ''; const d=new Date(sd); if(isNaN(d)) return ''; d.setDate(d.getDate()-60); return d.toISOString().slice(0,10); }
// Item 7 (Round 2) — default "Not Started" colour changed from the old
// neutral grey to white per the brief (dots are now squares too, see
// index.html .detail-p-dot — a border was added there since a plain white
// square needs one to stay visible against the box's own background).
// Round 6, item 6 — reverted back to grey (#9AA5B1, the --neutral-dot token)
// so these summary dots match the actual Production Pipeline box's own
// "Not Started" stage colour (.stage-not-started, index.html) — David's ask
// was specifically for the two to be consistent with each other.
function dotColor(status){ if(status==='Complete') return 'var(--sage)'; if(status==='In Progress') return 'var(--amber)'; return '#9AA5B1'; }
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
function isPublished(t){ return t.status==='Complete' || t.status==='Completed' || t.status==='Released'; }
// Round 9, item 1 — the values status can hold. Matches the Add Title
// modal's new-status options (Not Scheduled/In Progress/Complete/Released)
// PLUS 'Completed' — the literal legacy string already live on 5 real
// titles (see the item-15 comment above) that the Add Title modal never
// actually offers but which real data already contains, so the edit
// control has to be able to display/keep it, not just the 4 the modal
// writes.
const STATUS_VALUES=['Not Scheduled','In Progress','Complete','Completed','Released'];
// Single source of truth for the badge/edit-control colour class, factored
// out of renderDetail() so the same logic backs both the read-only card
// badge and the new editable one (statusEditSelect below) — previously
// this was inlined once, in renderDetail only.
function statusBadgeClass(status){
  return isPublished({status}) ? (status==='Released'?'badge-released':'badge-complete') : ({'In Progress':'badge-inprogress','Not Scheduled':'badge-notscheduled'}[status]||'badge-notscheduled');
}
function toBool(v){ return v===true || v==='TRUE' || v==='true' || v===1 || v==='1'; }
function fromBool(v){ return v ? 'TRUE' : 'FALSE'; }
function safeJson(str, fallback){ if(!str) return fallback; try{ const p=JSON.parse(str); return p==null?fallback:p; }catch(e){ return fallback; } }

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
function getReleaseBlocks(){
  return (data.blocks||[]).slice()
    .sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0))
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
      showReconnect('Adding release block failed to save to the Sheet: '+e.message+' — the new block is visible locally this session but was NOT saved; a reload will lose it.');
      console.error(e);
    }
  }
  return block_id;
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
function authHeaders(){
  const tok = window.BookHubAuth ? window.BookHubAuth.getAccessToken() : null;
  if(!tok) throw new Error('Not signed in / token expired.');
  return { 'Authorization': 'Bearer '+tok };
}
async function sheetsGet(spreadsheetId, range){
  const url = SHEETS_API+spreadsheetId+'/values/'+encodeURIComponent(range);
  const resp = await fetch(url, { headers: authHeaders() });
  if(!resp.ok){
    const body = await resp.text().catch(()=>'');
    throw new Error('Sheets GET '+resp.status+' on '+range+': '+body.slice(0,300));
  }
  const j = await resp.json();
  return j.values || [];
}
async function sheetsPut(spreadsheetId, range, rowValues){
  const url = SHEETS_API+spreadsheetId+'/values/'+encodeURIComponent(range)+'?valueInputOption=USER_ENTERED';
  const resp = await fetch(url, { method:'PUT', headers: Object.assign({'Content-Type':'application/json'}, authHeaders()), body: JSON.stringify({ values:[rowValues] }) });
  if(!resp.ok){
    const body = await resp.text().catch(()=>'');
    throw new Error('Sheets PUT '+resp.status+' on '+range+': '+body.slice(0,300));
  }
  return resp.json();
}
async function sheetsAppend(spreadsheetId, sheetName, rowValues){
  const range = sheetName+'!A1';
  const url = SHEETS_API+spreadsheetId+'/values/'+encodeURIComponent(range)+':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
  const resp = await fetch(url, { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, authHeaders()), body: JSON.stringify({ values:[rowValues] }) });
  if(!resp.ok){
    const body = await resp.text().catch(()=>'');
    throw new Error('Sheets APPEND '+resp.status+' on '+sheetName+': '+body.slice(0,300));
  }
  const j = await resp.json();
  // updatedRange looks like "Titles!A17:AN17" — pull the row number out.
  const m = /![A-Z]+(\d+):/.exec((j.updates||{}).updatedRange||'');
  return m ? parseInt(m[1],10) : null;
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
async function getSheetGid(spreadsheetId, sheetName){
  const key = spreadsheetId+'::'+sheetName;
  if(_sheetGidCache[key] !== undefined) return _sheetGidCache[key];
  const url = SHEETS_API+spreadsheetId+'?fields='+encodeURIComponent('sheets.properties(sheetId,title)');
  const resp = await fetch(url, { headers: authHeaders() });
  if(!resp.ok){
    const body = await resp.text().catch(()=>'');
    throw new Error('Sheets metadata GET '+resp.status+': '+body.slice(0,300));
  }
  const j = await resp.json();
  const sheet = (j.sheets||[]).find(s=>s.properties && s.properties.title===sheetName);
  if(!sheet) throw new Error('Could not find a "'+sheetName+'" tab in the spreadsheet.');
  _sheetGidCache[key] = sheet.properties.sheetId;
  return sheet.properties.sheetId;
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
  const url = SHEETS_API+spreadsheetId+':batchUpdate';
  const body = { requests: [{ deleteDimension: { range: {
    sheetId, dimension: 'ROWS',
    startIndex: rowNumber1Based-1, // 0-indexed, inclusive
    endIndex: rowNumber1Based      // exclusive — removes exactly this one row
  } } }] };
  const resp = await fetch(url, { method:'POST', headers: Object.assign({'Content-Type':'application/json'}, authHeaders()), body: JSON.stringify(body) });
  if(!resp.ok){
    const errBody = await resp.text().catch(()=>'');
    throw new Error('Sheets batchUpdate (delete row) '+resp.status+': '+errBody.slice(0,300));
  }
  return resp.json();
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
  const pn = Object.assign({checklist:[],proofingNotes:'',typesettingNotes:'',lsiNotes:'',scbEbookCover:'1400px on shortest side / RGB',printerEstimates:'',futureEditionNotes:'',printReadyFiles:'Not Ready',illustrations:false,illustrationCount:0,illustrationsText:'',poManualNotes:''}, safeJson(c.productionNotes_json, {}));
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
    title: c.title||'', subtitle: c.subtitle||'', authors: c.author||'',
    authorLiaison: c.authorLiaison||'David', imprint: c.imprint||'Headpress', status: c.status||'Not Scheduled',
    planningSheet: c.planningSheet||'', bookBiblePresent: toBool(c.bookBiblePresent), lastUpdated: c.lastUpdated||'',
    blockId: c.blockId||'',
    dates: { releaseBlock: c.releaseBlock||'', softDate: c.softDate||'', streetDate: c.streetDate||'', printDate: c.printDate||'', autoPrintDate: toBool(c.printDateAutoCalc) },
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
      illustrationsText: illustrationsText||''
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
    illustrationsText: t.commercial.illustrationsText||'', poManualNotes: t.poManualNotes||''
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
    dates:{releaseBlock:'',softDate:'',streetDate:'',printDate:'',autoPrintDate:false},
    commercial:{isbnPbk:'',isbnHbk:'',isbnEbk:'',_backupIsbnPbkRaw:'',_backupIsbnEbkRaw:'',trimSize:'',pages:'',categoryUK:'',categoryUSA:'',nielsenNotified:false,illustrationsText:''},
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
    imagesFolderLink:'', workingFolderLink:'', coverThumbnailFile:DEFAULT_COVER_PLACEHOLDER, poTrackerIsbnKey:'', poTrackerTitleOverride:'',
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
    defTitle({id:'sample-2', title:'Sample Not Scheduled Title', authors:'Jane Author', status:'Not Scheduled', imprint:'Oil and Water Press'})
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
    data.isbns = isbnRows.map((r,i) => { const o = isbnRowToObj(r); o._row = i+2; return o; });
    data.blocks = blockRows.filter(r=>r[0]).map(r=>({
      block_id: r[0]||'', block_name: r[1]||r[0]||'',
      sortOrder: (r[2]!==undefined && r[2]!=='') ? Number(r[2]) : 999,
      notes: r[3]||''
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

function showReconnect(msg){
  document.getElementById('reconnect-msg').textContent = msg;
  document.getElementById('reconnect-banner').classList.remove('hidden');
}
function setSyncStatus(s){
  syncStatus = s;
  ['sync-dot','footer-sync-dot'].forEach(id=>{ const el=document.getElementById(id); if(el) el.className='sync-dot '+s; });
}

// ─── SAVE (debounced full-row rewrite, mirrors headpress.html's debounced-save pattern) ───
function debouncedSave(titleId){
  if(devMode) return; // preview only, never writes
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>saveTitle(titleId), 1000);
}
async function saveTitle(titleId){
  if(devMode) return; // preview only, never writes — guarded here too since
                       // confirmAddTitle() calls saveTitle() directly rather
                       // than via the debounced path.
  const t = getTitle(titleId); if(!t) return;
  setSyncStatus('saving');
  try{
    const row = titleToRow(t);
    if(t._row){
      await sheetsPut(CFG.TITLES_SHEET_ID, 'Titles!A'+t._row+':'+TITLE_RANGE_LAST_COL+t._row, row);
    } else {
      const assignedRow = await sheetsAppend(CFG.TITLES_SHEET_ID, 'Titles', row);
      if(assignedRow) t._row = assignedRow;
    }
    setSyncStatus('saved');
    document.getElementById('footer-last-saved').textContent = 'Saved '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }catch(e){
    setSyncStatus('error');
    showReconnect('Save failed: '+e.message);
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
    showReconnect('ISBN save failed: '+e.message);
    console.error(e);
  }
}

// ─── SECTION STATUS / ATTENTION ───
function hasAttention(t){
  const now=new Date();now.setHours(0,0,0,0);
  if(t.pipeline.stages.some(s=>s.status==='In Progress'&&s.expectedDate&&new Date(s.expectedDate)<now))return true;
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  if(pd){const d=daysUntil(pd);if(d!==null&&d<=60&&!isPublished(t))return true;}
  return false;
}
// 2026-07-26 (items 13/14/15) — single source of truth for the
// print-timing status shown on cards, detail view, and the new print-
// timing filter, so all three can never drift out of sync with each other.
//   kind: 'published' | 'nodate' | 'overdue' | 'counting'
//   colorClass: which of the 4 status colours to paint (published/overdue
//   share their kind's colour; 'counting' has 3 shade tiers — ok/notice/
//   due-soon — all deliberately short of the alarm red reserved for overdue)
function computeDayInfo(t){
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
      return t.pipeline.stages.every(s=>s.status==='Complete')?'complete':'partial';
    }
    case 'dates':{
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
// links row already added 2026-07-15, see renderFolderLinksRow()).
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
  document.getElementById('search-wrap').style.display=view==='titles'?'flex':'none';
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
  populateQuickNoteTitles();
  // Items 1/2 (Round 2) — header is no longer a fixed height (see
  // #app-header in index.html), so its real rendered height is re-measured
  // on every render (the filter row only exists in the 'titles' view, so
  // the header's actual height genuinely changes between views) and synced
  // into --hh, which body padding-top and everything else keyed to --hh
  // reads from. This is what actually prevents the header from ever
  // overlapping the content below it, regardless of how many rows the
  // filter toolbar wraps to.
  syncHeaderHeight();
}
function gotoTitles(){view='titles';selectedId=null;render();}
function gotoISBNs(){view='isbns';render();}
function gotoDetail(id){view='detail';selectedId=id;render();}
function gotoQuickNotesList(){view='quicknotes';render();}
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
  let html='<option value="">All Blocks</option>';
  Array.from(blocks.keys()).sort().forEach(bid=>{ html+=`<option value="${esc(bid)}" ${cur===bid?'selected':''}>${esc(blocks.get(bid))}</option>`; });
  if(hasUnassigned) html+=`<option value="__unassigned__" ${cur==='__unassigned__'?'selected':''}>Unassigned</option>`;
  sel.innerHTML=html;
}

// ─── TITLES VIEW ───
function renderTitles(){
  let titles=data.titles.filter(t=>{
    if(filters.status&&t.status!==filters.status)return false;
    if(filters.imprint&&t.imprint!==filters.imprint)return false;
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
  const main=document.getElementById('main');
  if(!titles.length){main.innerHTML='<div class="empty-state"><h3>No titles found</h3><p>Try changing your filters, or add a new title. If this is a fresh sheet, Fred\'s Book Bible migration may not have landed yet.</p></div>';return;}
  main.innerHTML='<div class="titles-grid">'+titles.map(renderCard).join('')+'</div>';
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
// exactly ("Headpress" / "Oil and Water Press") so round-tripping through
// the Sheet's imprint column is unaffected.
function imprintEditSelect(t){
  const ik=imprintKey(t.imprint);
  return `<select class="imprint-edit-select" title="Change imprint" onchange="onImprintChange('${t.id}',this.value)">
    <option value="Headpress" ${ik==='headpress'?'selected':''}>Headpress</option>
    <option value="Oil and Water Press" ${ik==='oowp'?'selected':''}>Oil and Water Press</option>
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
  fc(titleId,field,value);
  const t=getTitle(titleId);if(!t)return;
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
  const attn=hasAttention(t)?'<div class="card-attention" title="Needs attention"></div>':'';
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
  const doneStages=t.pipeline.stages.filter(s=>s.status==='Complete').length;
  const pct=totalStages?Math.round(doneStages/totalStages*100):0;
  const barDone=isPublished(t);
  const progressHtml=`<div class="progress-wrap"><div class="progress-track"><div class="progress-fill ${barDone?'done':''}" style="width:${barDone?100:pct}%"></div></div><div class="progress-label">${barDone?'Published':doneStages+'/'+totalStages}</div></div>`;
  const info=computeDayInfo(t);
  const deadlineHtml=`<div class="card-deadline ${info.colorClass}">${esc(info.label)}</div>`;
  const ik=imprintKey(t.imprint);
  return `<div class="book-card" data-imprint="${ik}" onclick="gotoDetail('${t.id}')">${attn}
    <div class="book-cover">${cover}</div>
    <div class="card-info">
      <div class="card-title-row"><span class="imprint-dot" title="${esc(imprintName(t.imprint))}"></span><span class="card-title">${esc(t.title)}</span></div>
      ${t.authors?`<div class="card-author">${esc(contributorLabel(t))}</div>`:''}
      ${deadlineHtml}
    </div>
    <div class="card-footer">${progressHtml}</div>
  </div>`;
}

// ─── DETAIL VIEW ───
function renderDetail(){
  const t=getTitle(selectedId);
  if(!t){gotoTitles();return;}
  const main=document.getElementById('main');
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  const info=computeDayInfo(t);
  const daysHtml=`<span class="card-deadline ${info.colorClass}" style="font-size:.85rem">${esc(info.kind==='overdue'?'OVERDUE':info.label)}</span>`;
  // Badge: 'Completed' (the literal live-data string, see isPublished()) now
  // maps onto the same badge-complete style as 'Complete' — item 15's
  // underlying status-string mismatch fix. (Round 9: factored into
  // statusBadgeClass() so statusEditSelect() below can share it.)
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
  const tocNavHtml=`<nav class="toc-sidenav" id="toc-nav">${SECTION_KEYS.map(k=>`<a class="toc-side-item" href="#asec-${t.id}-${k}">${esc(SECTION_LABEL_TEXT[k]||k)}</a>`).join('')}</nav>`;
  main.innerHTML=`
    <div class="detail-header-row">
      <button class="detail-back" onclick="gotoTitles()">&#8592; All Titles</button>
      <button class="btn-delete-title" onclick="openDeleteConfirm('${t.id}')" title="Permanently delete this title">Delete Title&hellip;</button>
    </div>
    <div class="detail-layout">
      ${tocNavHtml}
      <div class="detail-content">
        <div class="detail-top">
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
            ${renderFolderLinksRow(t)}
          </div>
        </div>
        ${renderKeyContacts(t)}
        ${renderExportButtons(t)}
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
}

// New fields from brief §3: images folder link + working folder link
// (reveal helper). Placed on the always-visible top panel per the brief's
// instruction to add them to "the title detail view".
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
function renderFolderLinksRow(t){
  const id=t.id;
  return `<div class="folder-links-row">
    <div class="folder-link-group">
      <label class="field-label">Cover Image URL</label>
      <div class="folder-link-row">
        <input type="text" id="f-${id}-coverThumbnailFile" value="${esc(t.coverThumbnailFile)}" placeholder="covers/title-id.jpg, or a direct image URL (NOT a 1drv.ms/OneDrive share link — see code comment)" oninput="onCoverUrlChange('${id}',this.value)">
      </div>
      <div class="cover-url-msg" id="cover-url-msg-${id}"></div>
    </div>
    <div class="folder-link-group">
      <label class="field-label">Images Folder (OneDrive)</label>
      <div class="folder-link-row">
        <input type="url" id="f-${id}-imagesFolderLink" value="${esc(t.imagesFolderLink)}" placeholder="https://onedrive.live.com/…" oninput="fc('${id}','imagesFolderLink',this.value)">
        <button class="btn btn-sm" onclick="openImagesFolder('${id}')">Open</button>
      </div>
    </div>
    <div class="folder-link-group">
      <label class="field-label">Working Folder (local)</label>
      <div class="folder-link-row">
        <input type="text" id="f-${id}-workingFolderLink" value="${esc(t.workingFolderLink)}" placeholder="D:\\PROJECTS - BOOKS\\Book_…" oninput="fc('${id}','workingFolderLink',this.value)">
        <button class="btn btn-sm" onclick="revealWorkingFolder('${id}')">Reveal in Explorer</button>
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
// cover-url-msg-${id} box added next to the field in renderFolderLinksRow().
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
// Reveal-in-Explorer, same fetch pattern as Photo Gallery's
// revealInExplorer() in js/gallery.js (1.2s timeout, GET ?path=, treat any
// non-ok/failed fetch as "helper not running" and fall back). Book
// Production Hub has no FileSystemDirectoryHandle / "Connect Library"
// concept, so there's no Layer-2 native-picker fallback to reuse here like
// gallery.js has — on failure this instead surfaces the raw path so David
// can navigate to it by hand. Documented as a scoped-down fallback in the
// build report, not a silent gap.
async function revealWorkingFolder(titleId){
  const t=getTitle(titleId);if(!t)return;
  const path=t.workingFolderLink;
  if(!path){alert('No working folder path set for this title yet.');return;}
  const helperUrl=(CFG.BOOK_REVEAL_HELPER_URL||'http://127.0.0.1:8744')+'/reveal';
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),1200);
    const resp=await fetch(helperUrl+'?path='+encodeURIComponent(path),{signal:controller.signal});
    clearTimeout(timer);
    if(resp.ok)return; // Explorer opened by the helper — done.
    console.warn('Reveal helper responded but not OK (status '+resp.status+').');
  }catch(e){
    console.warn('Reveal helper not reachable (is book_reveal_helper.py running?):',e);
  }
  // Fallback: no live-folder-handle mechanism in this app (see note above)
  // — give David the path directly so he can navigate to it himself.
  try{ await navigator.clipboard.writeText(path); }catch(e){}
  alert('Could not reach the local reveal helper (is book_reveal_helper.py running on port 8744?).\n\nPath copied to clipboard:\n'+path);
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
function renderExportButtons(t){
  return `<div class="export-actions-row">
    <button class="btn btn-sm" onclick="openHtmlOutput('${t.id}')">View HTML Output &#8599;</button>
    <button class="btn btn-sm" onclick="downloadWordFile('${t.id}')">View Word File &#8681;</button>
    <p class="export-hint">Both export the full title record — every section below, each under its own heading, whether or not it's currently expanded. HTML opens in a new tab as plain text source (select all &amp; copy into distributor systems); Word downloads a .rtf file that opens directly in Word or Google Docs.</p>
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
function toggleAccord(tid,key){
  const k=`${tid}-${key}`;
  const cur=isOpen(tid,key);accordionOpen[k]=!cur;
  const body=document.querySelector(`[data-accord="${k}"]`);if(body)body.classList.toggle('open',accordionOpen[k]);
  const hdr=document.querySelector(`[data-accord-header="${k}"]`);if(hdr){const arr=hdr.querySelector('.accord-arrow');if(arr)arr.classList.toggle('open',accordionOpen[k]);}
  // PO Tracker's live-fetched tables (print estimates / PO & Invoice pulls)
  // used to load automatically because the section was always open on
  // render — now that it starts closed like everything else, kick the fetch
  // off the first time it's actually opened instead (once per title per
  // session; the "Loading…" placeholder in renderPoTracker() is what's
  // sitting there until this fires).
  if(key==='poTracker' && accordionOpen[k] && !poTrackerLoadedFor[tid]){
    poTrackerLoadedFor[tid]=true;
    loadPoTrackerFor(tid);
  }
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
function richTa(titleId,fieldKey,path,val,ph){
  const editId=`f-${titleId}-${fieldKey}`;
  const isEmpty = !val || !val.replace(/<[^>]+>/g,'').trim();
  return `<div class="richtext-wrap">
    <div class="richtext-toolbar">
      <button type="button" class="rt-btn" onmousedown="event.preventDefault()" onclick="document.execCommand('bold')"><b>B</b></button>
      <button type="button" class="rt-btn" onmousedown="event.preventDefault()" onclick="document.execCommand('italic')"><i>I</i></button>
      <button type="button" class="rt-btn" onmousedown="event.preventDefault()" onclick="document.execCommand('formatBlock',false,'p')">¶</button>
    </div>
    <div id="${editId}" class="richtext" contenteditable="true" data-placeholder="${esc(ph)}" data-empty="${isEmpty?'1':'0'}"
      oninput="fc('${titleId}','${path}',this.innerHTML);this.dataset.empty=this.innerText.trim()?'0':'1'"
      onfocus="this.dataset.wasEmpty=this.dataset.empty;try{document.execCommand('defaultParagraphSeparator',false,'p')}catch(e){}" onblur="this.dataset.empty=this.innerText.trim()?'0':'1'"
      >${val||''}</div>
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
    ${frow('Cover Price PBK (£)',inp(`f-${id}-pbkGBP`,p.pbkGBP,'e.g. 14.99','fc(\''+id+'\',\'price.pbkGBP\',this.value)'))}
    ${frow('Cover Price HBK (£)',inp(`f-${id}-hbkGBP`,p.hbkGBP,'','fc(\''+id+'\',\'price.hbkGBP\',this.value)'))}
    ${frow('Cover Price PBK ($)',inp(`f-${id}-pbkUSD`,p.pbkUSD,'','fc(\''+id+'\',\'price.pbkUSD\',this.value)'))}
    ${frow('Cover Price EBK ($)',inp(`f-${id}-ebkUSD`,p.ebkUSD,'','fc(\''+id+'\',\'price.ebkUSD\',this.value)'))}
    ${frow('Trim Size',inp(`f-${id}-trimSize`,c.trimSize,'e.g. 198x129mm','fc(\''+id+'\',\'commercial.trimSize\',this.value)'))}
    ${frow('Pages',`<input type="number" id="f-${id}-pages" value="${esc(c.pages)}" min="0" oninput="fc('${id}','commercial.pages',this.value)">`)}
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
  // Item 24 (7/26) — "Other contributors" sits BELOW "Previous publications"
  // (was reversed before). Item 21/23 (7/26) — Socials field widened to a
  // proper auto-expanding textarea (was a single-line input) so it
  // comfortably holds multiple lines/entries.
  // Item 12 (Round 2) — Author Liaison moved OUT of this box entirely, into
  // the new standalone Key Contacts block under the title header (see
  // renderKeyContacts()) — it's no longer rendered here.
  return `<div class="field-grid">
    ${frow('Author Bio',taAuto(`f-${id}-bio`,a.bio,'',`fc('${id}','authorInfo.bio',this.value)`),'full')}
    ${frow('Author Hometown',inp(`f-${id}-hometown`,a.hometown,'',`fc('${id}','authorInfo.hometown',this.value)`))}
    ${frow('Socials & Societies',taAuto(`f-${id}-socials`,a.socials,'One per line is fine…',`fc('${id}','authorInfo.socials',this.value)`),'full')}
    ${frow('Previous Publications',taAuto(`f-${id}-prevPubs`,a.previousPublications,'',`fc('${id}','authorInfo.previousPublications',this.value)`),'full')}
    ${frow('Other Contributors',taAuto(`f-${id}-otherContribs`,a.otherContributors,'',`fc('${id}','authorInfo.otherContributors',this.value)`),'full')}
  </div>`;}

// Items 25/26 — reworked pipeline: each stage is its own bounded box with
// its status shown inside it (not a floating pill elsewhere), grouped into
// PIPELINE_GROUPS with zero gap between adjacent stages in the same group
// (reads as one connected chain) and a visible gap between groups (matches
// the row-blocking pattern in David's "Book Planning 2025" source sheet —
// see PIPELINE_GROUPS comment above for exactly which rows that was read
// from). Items 27/28 — Expected Date shrunk, Notes widened, via the
// .stage-box grid-template-columns in index.html rather than equal columns.
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
    return `<div><div class="pipeline-group-label">${esc(g.label)}</div><div class="pipeline-group-boxes">${boxes}</div></div>`;
  }).join('');
  return `<div class="pipeline-chain">${groupsHtml}</div>`;}

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
    ${frow('Soft Date',`<input type="date" id="f-${id}-softDate" value="${esc(d.softDate)}" onchange="fc('${id}','dates.softDate',this.value)">`)}
    ${frow('Street Date',`<input type="date" id="f-${id}-streetDate" value="${esc(d.streetDate)}" onchange="onStreetDateChange('${id}',this.value)">`)}
    ${frow('Print Date',`<input type="date" id="f-${id}-printDate" value="${esc(pdVal)}" ${d.autoPrintDate?'readonly':''} onchange="fc('${id}','dates.printDate',this.value)"><label style="font-size:.72rem;color:var(--text3);display:flex;align-items:center;gap:4px;margin-top:4px"><input type="checkbox" ${d.autoPrintDate?'checked':''} onchange="onAutoPrint('${id}',this.checked)"> Auto-calculate (street date −60 days)</label>`)}
    ${frow('Print Status',`<div id="f-${id}-daysToprint" style="padding:8px 0;font-size:.9rem">${ddHtml}</div>`)}
  </div>`;}

function renderPrint(t){const id=t.id;const p=t.print;
  const contactRows=(p.printerContacts||[]).map((pc,i)=>`<div class="printer-row">
      <input class="pname" type="text" value="${esc(pc.name)}" placeholder="Printer name" oninput="printerContactChange('${id}',${i},'name',this.value)">
      <input type="email" value="${esc(pc.email)}" placeholder="email" oninput="printerContactChange('${id}',${i},'email',this.value)">
      <button class="btn-danger btn-sm" onclick="removePrinterContact('${id}',${i})">Remove</button>
    </div>`).join('');
  return `<div class="field-grid">
    ${frow('Print Estimate / Quotes',taAuto(`f-${id}-printEstimate`,p.printEstimate,'Record printer quotes here…',`fc('${id}','print.printEstimate',this.value)`),'full')}
    ${frow('SCB eBook Cover Spec',inp(`f-${id}-scbSpec`,p.scbEbookCoverSpec,'',`fc('${id}','print.scbEbookCoverSpec',this.value)`),'full')}
    ${frow('For LSI Notes',taAuto(`f-${id}-forLsi`,p.forLsiNotes,'',`fc('${id}','print.forLsiNotes',this.value)`),'full')}
    <div class="field-group full"><label class="field-label">Printer Contacts</label>
      <div class="printer-contacts">${contactRows}</div>
      <button class="btn btn-sm" style="margin-top:8px" onclick="addPrinterContact('${id}')">+ Add Printer Contact</button>
    </div>
  </div>`;}

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
    ${frow('Manual PO/Invoice Notes',taAuto(`f-${id}-poManual`,t.poManualNotes,'Jot anything here manually — a PO number, a note about an invoice, whatever’s useful, independent of the linked pulls above…',`fc('${id}','poManualNotes',this.value)`),'full')}
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
    container.innerHTML='<div class="po-empty">Could not load print-estimate tracker data: '+esc(e.message)+'</div>'+printEstimateOpenLink();
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
    container.innerHTML='<div class="po-empty">Could not load PO &amp; Invoice Tracker data: '+esc(e.message)+'</div>'+poInvoiceOpenLink();
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
  return `<div class="field-grid">
    ${frow('Publicity Statement',taAuto(`f-${id}-pubStmt`,p.publicityStatement,'',`fc('${id}','publicity.publicityStatement',this.value)`),'full')}
    ${frow('Marketing Notes',taAuto(`f-${id}-marketing`,p.marketing,'',`fc('${id}','publicity.marketing',this.value)`),'full')}
    <p style="grid-column:1/-1;font-size:.78rem;color:var(--text3)">Amazon A+, PLS.ORG, Newsletter and Promo Film status now live in the Production Pipeline section above (they were duplicated in both places in the original app) — use each stage's Notes field for detail.</p>
  </div>`;}

function renderTOC(t){const id=t.id;const c=t.toc;
  return `<div class="field-grid">
    ${frow('Table of Contents',taAuto(`f-${id}-toc`,c.tableOfContents,'',`fc('${id}','toc.tableOfContents',this.value)`),'full')}
    ${frow('How I Came to Write This Book',taAuto(`f-${id}-howIWrote`,c.howICameToWriteThis,'',`fc('${id}','toc.howICameToWriteThis',this.value)`),'full')}
    ${frow('Excerpt',taAuto(`f-${id}-excerpt`,c.excerpt,'',`fc('${id}','toc.excerpt',this.value)`),'full')}
    ${frow('Competing Titles',taAuto(`f-${id}-competing`,c.competingTitles,'',`fc('${id}','toc.competingTitles',this.value)`),'full')}
  </div>`;}

function renderProductionNotes(t){const id=t.id;
  const items=t.productionNotes.checklist.map((c,i)=>`<div class="check-item ${c.checked?'done':''}">
    <input type="checkbox" id="chk-${id}-${i}" ${c.checked?'checked':''} onchange="checklistChange('${id}',${i},this.checked)">
    <label for="chk-${id}-${i}">${esc(c.text)}</label>
  </div>`).join('');
  return `<div class="checklist">${items}</div>
  <div class="field-grid" style="margin-top:14px">
    ${frow('Proofing Notes',taAuto(`f-${id}-proofingNotes`,t.productionNotes.proofingNotes,'',`fc('${id}','productionNotes.proofingNotes',this.value)`),'full')}
    ${frow('Typesetting Notes',taAuto(`f-${id}-typesettingNotes`,t.productionNotes.typesettingNotes,'',`fc('${id}','productionNotes.typesettingNotes',this.value)`),'full')}
  </div>`;}

function renderFutureEdition(t){const id=t.id;const f=t.futureEdition;
  return `<div class="field-grid">
    ${frow('Info & Changes for Future Edition',taAuto(`f-${id}-futureInfo`,f.infoAndChanges,'',`fc('${id}','futureEdition.infoAndChanges',this.value)`),'full')}
    ${frow('Print-Ready Files',`<select id="f-${id}-prf" onchange="fc('${id}','futureEdition.printReadyFilesStatus',this.value)"><option ${f.printReadyFilesStatus==='Not Ready'?'selected':''}>Not Ready</option><option ${f.printReadyFilesStatus==='Ready'?'selected':''}>Ready</option><option ${f.printReadyFilesStatus==='Submitted'?'selected':''}>Submitted</option></select>`)}
  </div>`;}

// Item 31 — Files & Links box removed entirely (renderFilesLinks/addLink/
// removeLink deleted along with it, 2026-07-26). That information is
// already effectively available at the top of the page via
// renderFolderLinksRow() (Cover Image URL / Images Folder / Working
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
  el.innerHTML=avail.map(r=>`<div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;cursor:pointer" onclick="pickISBN('${esc(r.isbn)}')" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background=''">
    <span style="font-family:monospace;font-size:.85rem">${esc(r.isbn)}</span>
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
function cycleStage(titleId,idx){
  const t=getTitle(titleId);if(!t)return;
  const s=['Not Started','In Progress','Complete'];
  const cur=s.indexOf(t.pipeline.stages[idx].status);
  t.pipeline.stages[idx].status=s[(cur+1)%3];
  const btn=document.querySelector(`[data-stage-btn="${titleId}-${idx}"]`);
  if(btn){const ns=t.pipeline.stages[idx].status;btn.textContent=ns;btn.className='stage-btn stage-'+ns.toLowerCase().replace(/ /g,'-');}
  const strip=document.getElementById(`detail-strip-${titleId}`);
  if(strip)strip.innerHTML=t.pipeline.stages.map((ss,i)=>`<div class="detail-p-dot" style="background:${dotColor(ss.status)}" title="${esc(ss.name)}: ${esc(ss.status)}" onclick="cycleStage('${titleId}',${i})"></div>`).join('');
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
    if(pdInput)pdInput.value=calcAutoPrint(value);
    updateDaysDisplay(titleId);
  }
  debouncedSave(titleId);updateSectionHeaders(titleId);
}
function onAutoPrint(titleId,checked){
  const t=getTitle(titleId);if(!t)return;
  t.dates.autoPrintDate=checked;
  const pdInput=document.getElementById(`f-${titleId}-printDate`);
  if(pdInput){pdInput.readOnly=checked;if(checked)pdInput.value=calcAutoPrint(t.dates.streetDate);}
  updateDaysDisplay(titleId);debouncedSave(titleId);
}
function updateDaysDisplay(titleId){
  const t=getTitle(titleId);if(!t)return;
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  const el=document.getElementById(`f-${titleId}-daysToprint`);
  if(!el)return;
  if(!pd){el.innerHTML='—';return;}
  const d=daysUntil(pd);
  const cls=d<0?'var(--terra)':d<=60?'var(--terra)':d<=90?'var(--amber)':'var(--sage)';
  el.innerHTML=`<span style="color:${cls};font-weight:600">${d<0?'OVERDUE — '+Math.abs(d)+' days ago':d+' days'}</span>`;
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

// ─── FILTERS ───
function onSearch(v){filters.search=v;renderTitles();}
function onFilterStatus(v){filters.status=v;renderTitles();}
function onFilterImprint(v){filters.imprint=v;renderTitles();}
function onFilterBlock(v){filters.block=v;renderTitles();}
function onFilterPrintTiming(v){filters.printTiming=v;renderTitles();}

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
        ['Print Status','text', info.label]
      ];
    }
    case 'commercial':{
      const c=t.commercial,p=t.price;
      return [
        ['ISBN (PBK)','text', c.isbnPbk],['ISBN (HBK)','text', c.isbnHbk],['ISBN (EBK)','text', c.isbnEbk],
        ['Cover Price PBK (£)','text', p.pbkGBP],['Cover Price HBK (£)','text', p.hbkGBP],
        ['Cover Price PBK ($)','text', p.pbkUSD],['Cover Price EBK ($)','text', p.ebkUSD],
        ['Trim Size','text', c.trimSize],['Pages','text', c.pages],
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
        ['Author Bio','text', a.bio],
        ['Author Hometown','text', a.hometown],
        ['Socials & Societies','text', a.socials],
        ['Previous Publications','text', a.previousPublications],
        ['Other Contributors','text', a.otherContributors]
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
        ['Print Estimate / Quotes','text', p.printEstimate],
        ['SCB eBook Cover Spec','text', p.scbEbookCoverSpec],
        ['For LSI Notes','text', p.forLsiNotes],
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
        ['Manual PO/Invoice Notes','text', t.poManualNotes]
      ];
    }
    case 'publicity': return [
      ['Publicity Statement','text', t.publicity.publicityStatement],
      ['Marketing Notes','text', t.publicity.marketing]
    ];
    case 'toc': return [
      ['Table of Contents','text', t.toc.tableOfContents],
      ['How I Came to Write This Book','text', t.toc.howICameToWriteThis],
      ['Excerpt','text', t.toc.excerpt],
      ['Competing Titles','text', t.toc.competingTitles]
    ];
    case 'productionNotes':{
      const checklistText=(t.productionNotes.checklist||[]).map(c=>'['+(c.checked?'x':' ')+'] '+c.text).join('\n');
      return [
        ['Checklist','text', checklistText],
        ['Proofing Notes','text', t.productionNotes.proofingNotes],
        ['Typesetting Notes','text', t.productionNotes.typesettingNotes]
      ];
    }
    case 'futureEdition': return [
      ['Info & Changes for Future Edition','text', t.futureEdition.infoAndChanges],
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
  const paras=[]; const re=/<p[^>]*>([\s\S]*?)<\/p>/gi; let m,any=false;
  while((m=re.exec(s))){ any=true; paras.push(m[1]); }
  if(!any) paras.push(s);
  return paras.map(inlineHtmlToRtf).filter(p=>p.trim()!=='');
}
function plainTextToRtfParagraphs(text){
  return String(text||'').split(/\n+/).map(l=>l.trim()).filter(Boolean).map(l=>rtfEscapeText(l));
}
function exportFieldToRtfParagraphs(kind,value){
  if(kind==='html') return htmlFragmentToRtfParagraphs(value);
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

// ─── TODOIST MODAL (unchanged from headpress.html — deliberately still a
// copy-paste summary, not a live API push, per the original brief's
// browser-standalone reasoning) ───
function openTodoistModal(){
  const now=new Date();now.setHours(0,0,0,0);
  const lines=[];
  data.titles.forEach(t=>{
    const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
    if(pd){
      const d=daysUntil(pd);
      if(d!==null&&d<=60&&!t.pipeline.stages.every(s=>s.status==='Complete'))
        lines.push(`[p1] PRINT DEADLINE: ${t.title} — ${d<0?'OVERDUE '+Math.abs(d)+' days':d+' days'}`);
    }
    if(t.dates.streetDate){
      const d=daysUntil(t.dates.streetDate);
      if(d!==null&&d<=90&&!t.pipeline.stages.every(s=>s.status==='Complete'))
        lines.push(`[p2] STREET DATE APPROACHING: ${t.title} — ${formatDate(t.dates.streetDate)}`);
    }
    t.pipeline.stages.forEach(s=>{
      if(s.status==='In Progress'&&s.expectedDate&&new Date(s.expectedDate)<now)
        lines.push(`[p2] OVERDUE: ${t.title} — ${s.name} (expected ${formatDate(s.expectedDate)})`);
    });
  });
  const ta=document.getElementById('todoist-text');
  ta.value=lines.length?lines.join('\n'):'No urgent items found. All titles are on track.';
  document.getElementById('todoist-modal').classList.remove('hidden');
}
function copyTodoist(){
  const ta=document.getElementById('todoist-text');
  navigator.clipboard.writeText(ta.value).then(()=>{
    const btn=document.querySelector('#todoist-modal .modal-footer button');
    if(btn){const orig=btn.textContent;btn.textContent='Copied!';setTimeout(()=>btn.textContent=orig,1500);}
  }).catch(()=>{ta.select();document.execCommand('copy');});
}

// ─── INIT ───
window.addEventListener('DOMContentLoaded', init);
function init(){
  setSyncStatus('none');
  if(!CFG.GOOGLE_CLIENT_ID){
    document.getElementById('auth-error').style.display='block';
    document.getElementById('auth-error').textContent = 'GOOGLE_CLIENT_ID is not set in config.js yet — sign-in is disabled until David creates the OAuth Web application Client ID in Google Cloud Console (see MARCUS_BookProductionHubInfra_2026-07-10.md §3) and pastes it in. Use "Load sample data" below to preview the UI in the meantime.';
    document.getElementById('auth-signin-btn').disabled = true;
  }
  render(); // draws the (empty) shell behind the auth overlay
}
