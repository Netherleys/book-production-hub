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
let data = { titles: [], isbns: [] };
let view = 'titles', selectedId = null, saveTimer = null, syncStatus = 'none';
let accordionOpen = {}, filters = { status:'', imprint:'', search:'', block:'', printTiming:'' }, isbnFilter = 'all';
let isbnLocked = {}; // titleId -> {isbnPbk:bool, isbnHbk:bool, isbnEbk:bool} — true = locked (default). Item 18 lock mechanism, session-only by design (see build report).
let qnOpen = false;
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
function dotColor(status){ if(status==='Complete') return 'var(--sage)'; if(status==='In Progress') return 'var(--amber)'; return '#fff'; }
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
function toBool(v){ return v===true || v==='TRUE' || v==='true' || v===1 || v==='1'; }
function fromBool(v){ return v ? 'TRUE' : 'FALSE'; }
function safeJson(str, fallback){ if(!str) return fallback; try{ const p=JSON.parse(str); return p==null?fallback:p; }catch(e){ return fallback; } }
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
  const authorInfo = Object.assign({bio:'',hometown:'',socials:'',otherContributors:'',previousPublications:''}, safeJson(c.authorInfo_json, {}));
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
  const quickNotes = safeJson(c.quickNotes_json, []) || [];
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
function defTitle(o={}){
  const base = {
    id: uid(), title:'', subtitle:'', authors:'', authorLiaison:'David', imprint:'Headpress', status:'Not Scheduled',
    planningSheet:'', bookBiblePresent:false, lastUpdated:'', blockId:'',
    dates:{releaseBlock:'',softDate:'',streetDate:'',printDate:'',autoPrintDate:false},
    commercial:{isbnPbk:'',isbnHbk:'',isbnEbk:'',_backupIsbnPbkRaw:'',_backupIsbnEbkRaw:'',trimSize:'',pages:'',categoryUK:'',categoryUSA:'',nielsenNotified:false,illustrationsText:''},
    price:{pbkGBP:'',pbkUSD:'',ebkUSD:'',hbkGBP:''},
    content:{keywords:'',fullDescription:'',jacketBlurb:'',briefDescription:'',salesHandle:'',sellingPoints:'',quotes:'',targetAudience:''},
    authorInfo:{bio:'',hometown:'',socials:'',otherContributors:'',previousPublications:''},
    pipeline:{stages:PIPELINE_STAGES.map(n=>({name:n,status:'Not Started',expectedDate:'',notes:''}))},
    print:{printEstimate:'',scbEbookCoverSpec:'1400px on shortest side / RGB',forLsiNotes:'',printerContacts:PRINTER_DEF.map(p=>Object.assign({},p))},
    publicity:{publicityStatement:'',prContact:'',marketing:''},
    toc:{tableOfContents:'',howICameToWriteThis:'',excerpt:'',competingTitles:''},
    productionNotes:{checklist:PROD_CHECKLIST.map(t=>({text:t,checked:false})),proofingNotes:'',typesettingNotes:''},
    futureEdition:{infoAndChanges:'',printReadyFilesStatus:'Not Ready'},
    filesLinks:{links:[]},
    quickNotes:[], poManualNotes:'',
    imagesFolderLink:'', workingFolderLink:'', coverThumbnailFile:'', poTrackerIsbnKey:'', poTrackerTitleOverride:'',
    _row: null
  };
  return Object.assign({}, base, o);
}

// ─── DEV SAMPLE DATA (offline preview only — no sign-in, no network) ───
function loadDevSampleData(){
  devMode = true;
  data = { titles:[
    defTitle({id:'sample-1', title:'Beyond Bone Tomahawk', subtitle:'On The Borders And The Brutality Of The Western', authors:'Rich Johnson', status:'In Progress', imprint:'Headpress',
      commercial:Object.assign({},defTitle().commercial,{isbnPbk:'978-1-915316-62-2', isbnEbk:'978-1-915316-63-9'}),
      dates:{releaseBlock:'2027 Q1',softDate:'',streetDate: new Date(Date.now()+45*86400000).toISOString().slice(0,10), printDate:'', autoPrintDate:true},
      imagesFolderLink:'https://onedrive.live.com/example-images-folder', workingFolderLink:'D:\\PROJECTS - BOOKS\\Book_Beyond Bone Tomahawk',
      content:Object.assign({},defTitle().content,{fullDescription:'Sample description for dev preview.'})
    }),
    defTitle({id:'sample-2', title:'Sample Not Scheduled Title', authors:'Jane Author', status:'Not Scheduled', imprint:'Oil and Water Press'})
  ], isbns:[
    {isbn:'978-1-909394-11-7', format:'', assignedToTitleId:'', assignedToTitleName:'', nielsenNotified:false, legacyArchived:false, _row:null},
    {isbn:'978-1-909394-12-4', format:'PBK', assignedToTitleId:'', assignedToTitleName:'', nielsenNotified:false, legacyArchived:false, _row:null}
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
    data.titles = titleRows
      .filter(r => r[0] && r[0] !== 'EXAMPLE-DELETE-ME')
      .map((r,i) => { const t = rowToTitle(r); t._row = findRowIndex(titleRows, r) + 2; return t; });
    data.isbns = isbnRows.map((r,i) => { const o = isbnRowToObj(r); o._row = i+2; return o; });
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
const SECTION_KEYS = ['commercial','content','author','pipeline','dates','print','publicity','toc','productionNotes','poTracker','futureEdition'];
const SECTION_LABEL_TEXT = {commercial:'Commercial',poTracker:'PO Tracker / Print Estimates',content:'Content & Marketing',author:'Author',pipeline:'Production Pipeline',dates:'Dates & Scheduling',print:'Print & Distribution',publicity:'Publicity & Marketing',toc:'TOC / Excerpt / Insight',productionNotes:'Production Notes',futureEdition:'Info & Future Edition'};
const SECTION_LABELS = {};
SECTION_KEYS.forEach((k,i)=>{ SECTION_LABELS[k] = (i+1)+'. '+SECTION_LABEL_TEXT[k]; });
function isOpen(titleId,key){
  if(key==='pipeline'||key==='poTracker')return true;
  const k=`${titleId}-${key}`;
  if(accordionOpen.hasOwnProperty(k))return accordionOpen[k];
  const t=getTitle(titleId);return t?getSectionStatus(t,key)!=='complete':true;
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
// actually present on titles (not a separate Blocks-tab fetch — the Blocks
// tab only holds display names/sort order for a small fixed set, and we
// don't have those names loaded client-side; using the human-readable
// releaseBlock text already on each title row is simpler and can't drift
// out of sync with what's actually assigned). Titles with no block at all
// group under "Unassigned" — deliberately surfaced rather than hidden,
// since that's a real known gap (5 titles, see build report).
function populateBlockFilter(){
  const sel=document.getElementById('filter-block');if(!sel)return;
  const cur=filters.block;
  const blocks=new Map(); // blockId -> display label
  data.titles.forEach(t=>{
    if(t.blockId) blocks.set(t.blockId, t.dates.releaseBlock||t.blockId);
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
      ${t.authors?`<div class="card-author">${esc(t.authors)}</div>`:''}
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
  // underlying status-string mismatch fix.
  const badgeClass=isPublished(t)?(t.status==='Released'?'badge-released':'badge-complete'):({'In Progress':'badge-inprogress','Not Scheduled':'badge-notscheduled'}[t.status]||'badge-notscheduled');
  // 2026-07-15: real thumbnail if a Cover Image URL is set (see renderCard()
  // for why this is a pasted direct URL rather than a Graph API fetch),
  // same onerror fallback pattern as the card grid.
  const coverPlaceholder=`<div class="cover-ph"><div class="cover-ph-h">B</div><div class="cover-ph-title">${esc(t.title)}</div></div>`;
  const coverHtml=t.coverThumbnailFile
    ? `<img src="${esc(t.coverThumbnailFile)}" alt="${esc(t.title)} cover" onerror="this.outerHTML=${escAttrJson(coverPlaceholder)}">`
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
    <button class="detail-back" onclick="gotoTitles()">&#8592; All Titles</button>
    <div class="detail-layout">
      ${tocNavHtml}
      <div class="detail-content">
        <div class="detail-top">
          <div class="detail-cover" title="Set the Cover Image URL below to show a real thumbnail here">${coverHtml}</div>
          <div class="detail-info">
            <div class="detail-title-row"><span class="imprint-dot" data-imprint="${imprintKey(t.imprint)}" style="background:var(--imprint-${imprintKey(t.imprint)==='oowp'?'oowp':'headpress'})" title="${esc(imprintName(t.imprint))}"></span><span class="detail-title-text">${esc(t.title)}</span></div>
            ${t.subtitle?`<div class="detail-subtitle-text">${esc(t.subtitle)}</div>`:''}
            ${t.authors?`<div class="detail-author-text">${esc(t.authors)}</div>`:''}
            <div class="detail-meta-row">
              <span class="status-badge ${badgeClass}">${esc(t.status)}</span>
              <span>${esc(t.imprint)}</span>
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
        <div class="accordion" id="accordion-${t.id}">${accordionHtml}</div>
      </div>
    </div>`;
  autoGrowAll(main);
  // PO Tracker data isn't in the row payload (it lives in a different
  // spreadsheet, fetched on demand) — if that section is already open on
  // this render (e.g. its default-open-when-incomplete rule fired, not
  // just a manual click), kick off the fetch now rather than leaving the
  // "Loading…" placeholder stuck.
  if(isOpen(t.id,'poTracker')) loadPoTrackerFor(t.id);
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
// Updates the field, saves, and refreshes the visible detail-cover thumbnail
// immediately (rather than waiting on the next full renderDetail()) so
// David gets instant feedback that the URL he pasted actually renders.
function onCoverUrlChange(titleId,value){
  fc(titleId,'coverThumbnailFile',value);
  const t=getTitle(titleId);if(!t)return;
  const coverEl=document.querySelector('.detail-cover');
  if(!coverEl)return;
  const placeholder=`<div class="cover-ph"><div class="cover-ph-h">B</div><div class="cover-ph-title">${esc(t.title)}</div></div>`;
  coverEl.innerHTML = value
    ? `<img src="${esc(value)}" alt="${esc(t.title)} cover" onerror="this.outerHTML=${escAttrJson(placeholder)}">`
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
function renderKeyContacts(t){const id=t.id;
  return `<div class="key-contacts-box">
    <div class="key-contacts-label">Key Contacts</div>
    <div class="field-grid">
      ${frow('Author Liaison',`<select id="f-${id}-liaison" onchange="fc('${id}','authorLiaison',this.value)"><option ${t.authorLiaison==='David'?'selected':''}>David</option><option ${t.authorLiaison==='Jen'?'selected':''}>Jen</option><option ${t.authorLiaison==='Other'?'selected':''}>Other</option></select>`)}
      ${frow('PR Contact',inp(`f-${id}-prContact`,t.publicity.prContact,'Name and contact info',`fc('${id}','publicity.prContact',this.value)`))}
    </div>
  </div>`;}

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
function toggleAccord(tid,key){
  if(key==='pipeline'||key==='poTracker')return; // always-open, prominent sections (items 25/30) — not collapsible
  const k=`${tid}-${key}`;
  const cur=isOpen(tid,key);accordionOpen[k]=!cur;
  const body=document.querySelector(`[data-accord="${k}"]`);if(body)body.classList.toggle('open',accordionOpen[k]);
  const hdr=document.querySelector(`[data-accord-header="${k}"]`);if(hdr){const arr=hdr.querySelector('.accord-arrow');if(arr)arr.classList.toggle('open',accordionOpen[k]);}
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
      onfocus="this.dataset.wasEmpty=this.dataset.empty" onblur="this.dataset.empty=this.innerText.trim()?'0':'1'"
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
    return frow(label, `<div class="isbn-row">
      <input type="text" id="f-${id}-${field}" value="${esc(val)}" ${locked?'readonly':''} oninput="fc('${id}','commercial.${field}',this.value)">
      <button class="lock-btn ${locked?'locked':'unlocked'}" title="${locked?'Locked — click to unlock and edit':'Unlocked — click to lock again'}" onclick="toggleIsbnLock('${id}','${field}')">${locked?'&#128274;':'&#128275;'}</button>
      <button class="btn btn-sm" onclick="openPool('${id}','commercial.${field}','${esc(label)}')">Assign</button>
    </div>`);
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
    <div class="field-group full">
      <button class="btn btn-sm" onclick="openHtmlOutput('${id}')">View HTML Output &#8599;</button>
      <p style="font-size:.72rem;color:var(--text3);margin-top:4px">Opens the literal HTML source of the fields above as plain text (e.g. an italicised word shows as the actual characters &lt;i&gt;word&lt;/i&gt;, not styled italics) — select all and copy (item 11, Round 2).</p>
    </div>
  </div>`;}

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
    ${frow('Release Block',inp(`f-${id}-releaseBlock`,d.releaseBlock,'e.g. 2027 Q1',`fc('${id}','dates.releaseBlock',this.value)`))}
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
    </div>
  </div>
  ${!data.isbns.length?'<p style="color:var(--text3);margin-bottom:14px">The ISBNs tab is empty — per Marcus\'s delivery report, pool migration wasn\'t in his scope for this build. Whoever owns this needs to confirm where the live pool currently lives (e.g. the old ISBN Headpress.xlsx / Headpress Hub\'s local data) and import it here.</p>':''}
  <table class="isbn-table"><thead><tr><th>ISBN</th><th>Format</th><th>Assigned To</th><th>Nielsen Notified</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div id="add-isbn-form" class="hidden" style="margin-top:14px;background:var(--surface);border-radius:var(--r8);padding:16px;box-shadow:var(--shadow-sm)">
    <div class="field-grid"><div class="field-group"><label class="field-label">ISBN</label><input type="text" id="new-isbn-val" placeholder="978-1-..."></div>
    <div class="field-group"><label class="field-label">Format</label><select id="new-isbn-fmt"><option value="">—</option><option value="PBK">PBK</option><option value="EBK">EBK</option><option value="HBK">HBK</option></select></div></div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="btn btn-primary btn-sm" onclick="confirmAddISBN()">Add</button><button class="btn btn-sm" onclick="document.getElementById('add-isbn-form').classList.add('hidden')">Cancel</button></div>
  </div>`;}

// ─── QUICK NOTES — LIST/INDEX VIEW (item 5, Round 2) ───
// Before this, the only way to know a title had a quick note at all was to
// open its detail view and scroll to notice the floating panel's "recent"
// list — there was no way to see, at a glance, which titles across the
// whole catalogue had notes. This is a dedicated view (its own header tab)
// listing every title with at least one note, most-recently-noted title
// first, each row showing a preview snippet of its latest note — clicking
// a row jumps straight into that title's detail view.
function renderQuickNotesList(){
  const main=document.getElementById('main');
  const withNotes = data.titles.filter(t=>t.quickNotes && t.quickNotes.length);
  if(!withNotes.length){
    main.innerHTML='<div class="empty-state"><h3>No quick notes yet</h3><p>Jot one against any title using the &#128221; button (bottom-right) — it\'ll show up here, most recent first.</p></div>';
    return;
  }
  const sorted = withNotes.slice().sort((a,b)=>{
    const la=a.quickNotes[a.quickNotes.length-1], lb=b.quickNotes[b.quickNotes.length-1];
    return new Date(lb.ts) - new Date(la.ts);
  });
  const rows = sorted.map(t=>{
    const latest = t.quickNotes[t.quickNotes.length-1];
    const when = new Date(latest.ts).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
    return `<div class="qn-list-item" onclick="gotoDetail('${t.id}')">
      <div class="qn-list-body">
        <span class="qn-list-title">${esc(t.title)}</span>
        <span class="qn-list-snippet">${esc(latest.text)}</span>
        <span class="qn-list-meta">Last noted ${esc(when)}</span>
      </div>
      <span class="qn-list-count">${t.quickNotes.length} note${t.quickNotes.length===1?'':'s'}</span>
    </div>`;
  }).join('');
  main.innerHTML=`<h2 style="font-family:var(--serif);font-weight:600;font-size:1.3rem;color:var(--text-oncream);margin-bottom:14px">Quick Notes — ${withNotes.length} title${withNotes.length===1?'':'s'} with notes</h2>${rows}`;
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
function openAddISBN(){document.getElementById('add-isbn-form').classList.remove('hidden');}
function confirmAddISBN(){
  const v=document.getElementById('new-isbn-val').value.trim();if(!v)return;
  const fmt=document.getElementById('new-isbn-fmt').value;
  const rec={isbn:v,format:fmt,assignedToTitleId:'',assignedToTitleName:'',nielsenNotified:false,legacyArchived:false,_row:null};
  data.isbns.push(rec);saveIsbn(rec);renderISBNs();
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
  if(!t||!t.quickNotes||!t.quickNotes.length){ box.innerHTML='<em>No quick notes yet for this title.</em>'; return; }
  box.innerHTML=t.quickNotes.slice().reverse().slice(0,5).map(n=>`<div class="qn-recent-item"><b>${esc(new Date(n.ts).toLocaleDateString('en-GB',{day:'numeric',month:'short'}))}</b> — ${esc(n.text)}</div>`).join('');
}
function saveQuickNote(){
  const sel=document.getElementById('qn-title-select');
  const textEl=document.getElementById('qn-text');
  if(!sel||!textEl)return;
  const text=textEl.value.trim();
  if(!text)return;
  const t=getTitle(sel.value);if(!t)return;
  if(!t.quickNotes)t.quickNotes=[];
  t.quickNotes.push({ts:new Date().toISOString(),text});
  textEl.value='';
  saveTitle(t.id); // immediate, not debounced — a quick note should feel saved instantly
  renderQuickNoteRecent();
  // If the note's title is the one currently open in detail view, refresh
  // it live too (quick notes aren't shown as their own accordion field
  // today, but this keeps behaviour honest if a future pass surfaces them
  // there — no stale state left behind).
  if(view==='detail'&&selectedId===t.id) renderDetail();
}

// Item 21 — HTML output view for Content & Marketing. Generates a simple,
// copy-pasteable HTML rendering of the marketing fields (paragraphs from
// each textarea, one <p> per non-blank line) so David can paste into
// distributor portals or email without losing structure. Opened in a new
// tab as a self-contained HTML document rather than a modal, since the
// whole point is to copy it out to somewhere else.
function openHtmlOutput(titleId){
  const t=getTitle(titleId);if(!t)return;
  const esc2=s=>esc(s||'');
  const para=s=>(s||'').split(/\n+/).map(l=>l.trim()).filter(Boolean).map(l=>`<p>${esc2(l)}</p>`).join('\n');
  // Full/Jacket/Brief now come from the rich-text fields (richTa()) and are
  // stored as real HTML (bold/italic/paragraphs) — passed through as-is
  // here rather than re-escaped, so formatting actually survives into the
  // output. Falls back gracefully for older plain-text values too, since
  // plain text has no tags to preserve or break.
  const rich=s=>s||'';
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc2(t.title)} — Content &amp; Marketing (HTML Output)</title>
<style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}h1{font-size:1.4rem}h2{font-size:1rem;text-transform:uppercase;letter-spacing:.04em;color:#888;margin-top:2em}</style>
</head><body>
<h1>${esc2(t.title)}${t.subtitle?' — '+esc2(t.subtitle):''}</h1>
<h2>Full Description</h2>${rich(t.content.fullDescription)}
<h2>Jacket Blurb</h2>${rich(t.content.jacketBlurb)}
<h2>Brief Description</h2>${rich(t.content.briefDescription)}
<h2>Sales Handle</h2><p>${esc2(t.content.salesHandle)}</p>
<h2>Selling Points</h2><ul>${(t.content.sellingPoints||'').split('\n').map(s=>s.trim()).filter(Boolean).map(s=>`<li>${esc2(s)}</li>`).join('')}</ul>
<h2>Quotes</h2>${(t.content.quotes||'').split('\n').map(s=>s.trim()).filter(Boolean).map(s=>`<blockquote>${esc2(s)}</blockquote>`).join('\n')}
</body></html>`;
  // Item 11 (Round 2) — this button was doing the wrong job: it opened the
  // HTML above RENDERED (an italicised word showed as actual italics, not
  // as the characters "<i>word</i>"). David wants the literal HTML SOURCE
  // as visible plain text instead, so he can see/copy the exact markup.
  // Fix: esc() the whole generated `html` string (turning every real "<"
  // and ">" into "&lt;"/"&gt;" so the browser can't interpret them as tags)
  // and place it inside a <pre> block in a NEW, separate wrapper document —
  // the `html` string itself is unchanged/still generated the same way, it
  // is just no longer served as live markup, only as escaped text content.
  const escapedSource = esc(html);
  const sourceViewHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc2(t.title)} — HTML Source</title>
<style>body{font-family:'SFMono-Regular',Consolas,'Courier New',monospace;background:#1c1c1c;color:#d9d5c9;margin:0;padding:24px}
p.hint{font-family:Georgia,serif;color:#9c9686;margin:0 0 16px;font-size:.9rem}
pre{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;margin:0}</style>
</head><body>
<p class="hint">Literal HTML source for "${esc2(t.title)}" — select all and copy, exactly as shown (tags included).</p>
<pre>${escapedSource}</pre>
</body></html>`;
  const blob=new Blob([sourceViewHtml],{type:'text/html'});
  const url=URL.createObjectURL(blob);
  window.open(url,'_blank','noopener');
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
