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
const TITLE_COLS = [
  'title_id','title','subtitle','author','authorLiaison','imprint','status',
  'planningSheet','releaseBlock','streetDate','softDate','printDate','printDateAutoCalc',
  'contract','isbn_pbk','isbn_hbk','isbn_ebk','isbn_pbk_backup','isbn_ebk_backup',
  'trim','pages','categoryUK','categoryUSA','nielsenNotified','keywords',
  'imagesFolderLink','workingFolderLink','coverThumbnailFile',
  'poTrackerIsbnKey','poTrackerTitleOverride','bookBiblePresent','lastUpdated',
  'price_json','production_json','publicity_json','editorial_json','authorInfo_json',
  'productionNotes_json','printerContacts_json','filesLinks_json'
];
const ISBN_COLS = ['isbn','format','assignedToTitleId','assignedToTitleName','nielsenNotified','legacyArchived'];

const PIPELINE_STAGES = ['Contract','Manuscript','Cover','Cover Templates','Images',
  'Proofing','Layout','Author Payment','Author Copies','Publicity Statement',
  'Info SCB','Info Turnaround','Product Page','Promo Film','Print Estimate',
  'eBook','Audiobook','Amazon A+','PLS.ORG','Newsletter'];
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
let accordionOpen = {}, filters = { status:'', imprint:'', search:'' }, isbnFilter = 'all';
let assignCtx = null;
let devMode = false; // true when previewing with sample data, no network writes
let poLogRowsCache = null; // lazy-loaded PO Log rows from the PO tracker sheet
let poTabGidCache = null; // tabName(lowercase) -> {gid, title}

// ─── HELPERS (unchanged from headpress.html) ───
function esc(s){ if(s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function getTitle(id){ return data.titles.find(t=>t.id===id)||null; }
function daysUntil(ds){ if(!ds) return null; const d=new Date(ds); d.setHours(0,0,0,0); const t=new Date(); t.setHours(0,0,0,0); return Math.round((d-t)/86400000); }
function formatDate(ds){ if(!ds) return ''; const d=new Date(ds); if(isNaN(d)) return ds; return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
function calcAutoPrint(sd){ if(!sd) return ''; const d=new Date(sd); if(isNaN(d)) return ''; d.setDate(d.getDate()-60); return d.toISOString().slice(0,10); }
function dotColor(status){ if(status==='Complete') return 'var(--sage)'; if(status==='In Progress') return 'var(--amber)'; return 'var(--neutral-dot)'; }
function toBool(v){ return v===true || v==='TRUE' || v==='true' || v===1 || v==='1'; }
function fromBool(v){ return v ? 'TRUE' : 'FALSE'; }
function safeJson(str, fallback){ if(!str) return fallback; try{ const p=JSON.parse(str); return p==null?fallback:p; }catch(e){ return fallback; } }

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
  const pn = Object.assign({checklist:[],proofingNotes:'',typesettingNotes:'',lsiNotes:'',scbEbookCover:'1400px on shortest side / RGB',printerEstimates:'',futureEditionNotes:'',printReadyFiles:'Not Ready',illustrations:false,illustrationCount:0}, safeJson(c.productionNotes_json, {}));
  let checklist = pn.checklist && pn.checklist.length ? pn.checklist.map(x=>({text:x.item||x.text||'',checked:!!x.checked})) : PROD_CHECKLIST.map(t=>({text:t,checked:false}));
  const pc = safeJson(c.printerContacts_json, {});
  let contacts = (pc.contacts && pc.contacts.length) ? pc.contacts.slice() : PRINTER_DEF.map(p=>Object.assign({},p));
  const filesLinks = Object.assign({links:[]}, safeJson(c.filesLinks_json, {}));
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
    dates: { releaseBlock: c.releaseBlock||'', softDate: c.softDate||'', streetDate: c.streetDate||'', printDate: c.printDate||'', autoPrintDate: toBool(c.printDateAutoCalc) },
    commercial: {
      isbnPbk: c.isbn_pbk||'', isbnHbk: c.isbn_hbk||'', isbnEbk: c.isbn_ebk||'',
      backupIsbnPbk: c.isbn_pbk_backup||'', backupIsbnEbk: c.isbn_ebk_backup||'',
      trimSize: c.trim||'', pages: c.pages||'', categoryUK: c.categoryUK||'', categoryUSA: c.categoryUSA||'',
      nielsenNotified: toBool(c.nielsenNotified),
      illustrations: !!pn.illustrations, illustrationCount: pn.illustrationCount||0
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
    illustrations: !!t.commercial.illustrations, illustrationCount: t.commercial.illustrationCount||0
  });
  const printerContacts_json = JSON.stringify({ contacts: t.print.printerContacts||[] });
  const filesLinks_json = JSON.stringify({ links: t.filesLinks.links||[] });
  const contractStage = t.pipeline.stages.find(s=>s.name==='Contract');
  const c = {
    title_id: t.id, title: t.title, subtitle: t.subtitle, author: t.authors, authorLiaison: t.authorLiaison,
    imprint: t.imprint, status: t.status, planningSheet: t.planningSheet||'',
    releaseBlock: t.dates.releaseBlock, streetDate: t.dates.streetDate, softDate: t.dates.softDate, printDate: t.dates.printDate,
    printDateAutoCalc: fromBool(t.dates.autoPrintDate),
    contract: contractStage ? contractStage.status : '',
    isbn_pbk: t.commercial.isbnPbk, isbn_hbk: t.commercial.isbnHbk, isbn_ebk: t.commercial.isbnEbk,
    isbn_pbk_backup: t.commercial.backupIsbnPbk, isbn_ebk_backup: t.commercial.backupIsbnEbk,
    trim: t.commercial.trimSize, pages: t.commercial.pages, categoryUK: t.commercial.categoryUK, categoryUSA: t.commercial.categoryUSA,
    nielsenNotified: fromBool(t.commercial.nielsenNotified), keywords: t.content.keywords,
    imagesFolderLink: t.imagesFolderLink, workingFolderLink: t.workingFolderLink, coverThumbnailFile: t.coverThumbnailFile,
    poTrackerIsbnKey: t.commercial.isbnPbk || t.commercial.isbnHbk || t.poTrackerIsbnKey || '',
    poTrackerTitleOverride: t.poTrackerTitleOverride||'',
    bookBiblePresent: fromBool(t.bookBiblePresent), lastUpdated: new Date().toISOString(),
    price_json, production_json, publicity_json, editorial_json, authorInfo_json,
    productionNotes_json, printerContacts_json, filesLinks_json
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
    planningSheet:'', bookBiblePresent:false, lastUpdated:'',
    dates:{releaseBlock:'',softDate:'',streetDate:'',printDate:'',autoPrintDate:false},
    commercial:{isbnPbk:'',isbnHbk:'',isbnEbk:'',backupIsbnPbk:'',backupIsbnEbk:'',trimSize:'',pages:'',categoryUK:'',categoryUSA:'',nielsenNotified:false,illustrations:false,illustrationCount:0},
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
    const titleRows = await sheetsGet(CFG.TITLES_SHEET_ID, 'Titles!A2:AN2000');
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
      await sheetsPut(CFG.TITLES_SHEET_ID, 'Titles!A'+t._row+':AN'+t._row, row);
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

// ─── SECTION STATUS / ATTENTION (unchanged logic from headpress.html) ───
function hasAttention(t){
  const now=new Date();now.setHours(0,0,0,0);
  if(t.pipeline.stages.some(s=>s.status==='In Progress'&&s.expectedDate&&new Date(s.expectedDate)<now))return true;
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  if(pd){const d=daysUntil(pd);if(d!==null&&d<=60&&!t.pipeline.stages.every(s=>s.status==='Complete'))return true;}
  return false;
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
      if(!t.dates.streetDate)return 'partial';
      const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
      if(pd&&new Date(pd)<new Date())return 'overdue';
      return 'complete';
    }
    case 'print':return t.print.printEstimate?'complete':'partial';
    case 'poTracker': return (t.commercial.isbnPbk||t.commercial.isbnHbk||t.poTrackerTitleOverride)?'complete':'partial';
    case 'publicity':return t.publicity.publicityStatement?'complete':'partial';
    case 'toc':return t.toc.tableOfContents?'complete':'partial';
    case 'productionNotes':return t.productionNotes.checklist.every(c=>c.checked)?'complete':'partial';
    case 'futureEdition':return t.futureEdition.printReadyFilesStatus==='Submitted'?'complete':'partial';
    case 'filesLinks':return(t.filesLinks&&t.filesLinks.links&&t.filesLinks.links.length>0)?'complete':'partial';
    default:return 'partial';
  }
}
const SECTION_KEYS = ['commercial','content','author','pipeline','dates','print','poTracker','publicity','toc','productionNotes','futureEdition','filesLinks'];
const SECTION_LABELS = {commercial:'1. Commercial',content:'2. Content & Marketing',author:'3. Author',pipeline:'4. Production Pipeline',dates:'5. Dates & Scheduling',print:'6. Print & Distribution',poTracker:'7. PO Tracker / Print Estimates',publicity:'8. Publicity & Marketing',toc:'9. TOC / Excerpt / Insight',productionNotes:'10. Production Notes',futureEdition:'11. Info & Future Edition',filesLinks:'12. Files & Links'};
function isOpen(titleId,key){
  if(key==='pipeline')return true;
  const k=`${titleId}-${key}`;
  if(accordionOpen.hasOwnProperty(k))return accordionOpen[k];
  const t=getTitle(titleId);return t?getSectionStatus(t,key)!=='complete':true;
}

// ─── RENDER ROUTING ───
function render(){
  document.getElementById('tab-titles').classList.toggle('active',view==='titles');
  document.getElementById('tab-isbns').classList.toggle('active',view==='isbns');
  document.getElementById('search-wrap').style.display=view==='titles'?'flex':'none';
  document.getElementById('btn-add-title').style.display=view==='titles'?'inline-block':'none';
  if(view==='titles')renderTitles();
  else if(view==='detail')renderDetail();
  else if(view==='isbns')renderISBNs();
}
function gotoTitles(){view='titles';selectedId=null;render();}
function gotoISBNs(){view='isbns';render();}
function gotoDetail(id){view='detail';selectedId=id;render();}

// ─── TITLES VIEW ───
function renderTitles(){
  let titles=data.titles.filter(t=>{
    if(filters.status&&t.status!==filters.status)return false;
    if(filters.imprint&&t.imprint!==filters.imprint)return false;
    if(filters.search){const q=filters.search.toLowerCase();if(!t.title.toLowerCase().includes(q)&&!t.authors.toLowerCase().includes(q))return false;}
    return true;
  });
  const main=document.getElementById('main');
  if(!titles.length){main.innerHTML='<div class="empty-state"><h3>No titles found</h3><p>Try changing your filters, or add a new title. If this is a fresh sheet, Fred\'s Book Bible migration may not have landed yet.</p></div>';return;}
  main.innerHTML='<div class="titles-grid">'+titles.map(renderCard).join('')+'</div>';
}
function renderCard(t){
  const attn=hasAttention(t)?'<div class="card-attention" title="Needs attention"></div>':'';
  // No reliable way to render an actual thumbnail image from an arbitrary
  // OneDrive FOLDER share link + filename without a Graph API integration
  // (out of scope here — flagged in the build report, not silently faked).
  // Placeholder cover, same as the original app, plus a small folder
  // indicator if an images folder link exists.
  const cover = `<div class="cover-ph"><div class="cover-ph-h">B</div><div class="cover-ph-title">${esc(t.title)}</div><div class="cover-ph-imprint">${esc(t.imprint)}</div>${t.imagesFolderLink?'<div class="cover-ph-folder">&#128193; images linked</div>':''}</div>`;
  const strip=t.pipeline.stages.map(s=>`<div class="p-dot" style="background:${dotColor(s.status)}" title="${esc(s.name)}: ${esc(s.status)}"></div>`).join('');
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  let deadlineHtml='';
  if(pd){
    const d=daysUntil(pd);
    if(d===null)deadlineHtml='';
    else if(d<0)deadlineHtml=`<div class="card-deadline overdue">Print date passed</div>`;
    else if(d<=60)deadlineHtml=`<div class="card-deadline urgent">${d} days to print</div>`;
    else if(d<=90)deadlineHtml=`<div class="card-deadline warn">${d} days to print</div>`;
    else deadlineHtml=`<div class="card-deadline ok">${d} days to print</div>`;
  }else if(t.dates.streetDate){
    deadlineHtml=`<div class="card-meta">Street: ${esc(formatDate(t.dates.streetDate))}</div>`;
  }else{deadlineHtml=`<div class="card-meta">Not scheduled</div>`;}
  return `<div class="book-card" onclick="gotoDetail('${t.id}')">${attn}
    <div class="book-cover">${cover}</div>
    <div class="card-info">
      <div class="card-title">${esc(t.title)}</div>
      ${t.authors?`<div class="card-author">${esc(t.authors)}</div>`:''}
      <div class="card-meta">${esc(t.imprint)}</div>
      ${deadlineHtml}
    </div>
    <div class="card-footer"><div class="pipeline-strip">${strip}</div></div>
  </div>`;
}

// ─── DETAIL VIEW ───
function renderDetail(){
  const t=getTitle(selectedId);
  if(!t){gotoTitles();return;}
  const main=document.getElementById('main');
  const pd=t.dates.autoPrintDate?calcAutoPrint(t.dates.streetDate):t.dates.printDate;
  const days=pd?daysUntil(pd):null;
  let daysHtml='';
  if(days!==null){
    const cls=days<0?'urgent':days<=60?'urgent':days<=90?'warn':'ok';
    daysHtml=`<span class="card-deadline ${cls}" style="font-size:.85rem">${days<0?'OVERDUE':days+' days to print'}</span>`;
  }
  const badgeClass={'In Progress':'badge-inprogress','Not Scheduled':'badge-notscheduled','Complete':'badge-complete','Released':'badge-released'}[t.status]||'badge-notscheduled';
  const coverHtml=`<div class="cover-ph"><div class="cover-ph-h">B</div><div class="cover-ph-title">${esc(t.title)}</div></div>`;
  const detailStrip=t.pipeline.stages.map((s,i)=>`<div class="detail-p-dot" style="background:${dotColor(s.status)}" title="${esc(s.name)}: ${esc(s.status)}" onclick="cycleStage('${t.id}',${i})"></div>`).join('');
  const accordionHtml=SECTION_KEYS.map(k=>renderAccordionSection(t,k)).join('');
  main.innerHTML=`
    <button class="detail-back" onclick="gotoTitles()">&#8592; All Titles</button>
    <div class="detail-top">
      <div class="detail-cover" title="Cover images are managed in the linked images folder, not uploaded here — see brief §3">${coverHtml}</div>
      <div class="detail-info">
        <div class="detail-title-text">${esc(t.title)}</div>
        ${t.subtitle?`<div class="detail-subtitle-text">${esc(t.subtitle)}</div>`:''}
        ${t.authors?`<div class="detail-author-text">${esc(t.authors)}</div>`:''}
        <div class="detail-meta-row">
          <span class="status-badge ${badgeClass}">${esc(t.status)}</span>
          <span>${esc(t.imprint)}</span>
          ${t.dates.streetDate?`<span>Street: ${esc(formatDate(t.dates.streetDate))}</span>`:''}
          ${pd?`<span>Print: ${esc(formatDate(pd))}</span>`:''}
          ${daysHtml}
        </div>
        <div class="detail-strip-wrap">
          <div class="detail-strip-label">Production Pipeline — click to cycle status</div>
          <div class="detail-strip" id="detail-strip-${t.id}">${detailStrip}</div>
        </div>
        ${renderFolderLinksRow(t)}
      </div>
    </div>
    <div class="accordion" id="accordion-${t.id}">${accordionHtml}</div>`;
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
function renderFolderLinksRow(t){
  const id=t.id;
  return `<div class="folder-links-row">
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

function renderAccordionSection(t,key){
  const st=getSectionStatus(t,key);
  const open=isOpen(t.id,key);
  const akey=`${t.id}-${key}`;
  return `<div class="accord-section" id="asec-${akey}">
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
    case 'filesLinks':return renderFilesLinks(t);
    default:return '';
  }
}
function toggleAccord(tid,key){
  if(key==='pipeline')return;
  const k=`${tid}-${key}`;
  const cur=isOpen(tid,key);accordionOpen[k]=!cur;
  const body=document.querySelector(`[data-accord="${k}"]`);if(body)body.classList.toggle('open',accordionOpen[k]);
  const hdr=document.querySelector(`[data-accord-header="${k}"]`);if(hdr){const arr=hdr.querySelector('.accord-arrow');if(arr)arr.classList.toggle('open',accordionOpen[k]);}
  if(key==='poTracker' && accordionOpen[k]) loadPoTrackerFor(tid);
}

// ─── SECTION RENDERS ───
function frow(label,inputHtml,cls=''){return `<div class="field-group ${cls}"><label class="field-label">${label}</label>${inputHtml}</div>`;}
function inp(id,val,ph,handler){return `<input type="text" id="${id}" value="${esc(val)}" placeholder="${esc(ph)}" oninput="${handler}">`;}
function ta(id,val,ph,handler,tall=''){return `<textarea id="${id}" class="${tall}" placeholder="${esc(ph)}" oninput="${handler}">${esc(val)}</textarea>`;}

function renderCommercial(t){const id=t.id;const c=t.commercial;const p=t.price;
  return `<div class="field-grid">
    ${frow('ISBN (PBK)',`<div class="isbn-row"><input type="text" id="f-${id}-isbnPbk" value="${esc(c.isbnPbk)}" oninput="fc('${id}','commercial.isbnPbk',this.value)"><button class="btn btn-sm" onclick="openPool('${id}','commercial.isbnPbk','ISBN (PBK)')">Assign</button></div>`)}
    ${frow('ISBN (HBK)',`<div class="isbn-row"><input type="text" id="f-${id}-isbnHbk" value="${esc(c.isbnHbk)}" oninput="fc('${id}','commercial.isbnHbk',this.value)"><button class="btn btn-sm" onclick="openPool('${id}','commercial.isbnHbk','ISBN (HBK)')">Assign</button></div>`)}
    ${frow('ISBN (EBK)',`<div class="isbn-row"><input type="text" id="f-${id}-isbnEbk" value="${esc(c.isbnEbk)}" oninput="fc('${id}','commercial.isbnEbk',this.value)"><button class="btn btn-sm" onclick="openPool('${id}','commercial.isbnEbk','ISBN (EBK)')">Assign</button></div>`)}
    ${frow('Backup ISBN (PBK)',inp(`f-${id}-backupIsbnPbk`,c.backupIsbnPbk,'','fc(\''+id+'\',\'commercial.backupIsbnPbk\',this.value)'))}
    ${frow('Backup ISBN (EBK)',inp(`f-${id}-backupIsbnEbk`,c.backupIsbnEbk,'','fc(\''+id+'\',\'commercial.backupIsbnEbk\',this.value)'))}
    ${frow('Cover Price PBK (£)',inp(`f-${id}-pbkGBP`,p.pbkGBP,'e.g. 14.99','fc(\''+id+'\',\'price.pbkGBP\',this.value)'))}
    ${frow('Cover Price HBK (£)',inp(`f-${id}-hbkGBP`,p.hbkGBP,'','fc(\''+id+'\',\'price.hbkGBP\',this.value)'))}
    ${frow('Cover Price PBK ($)',inp(`f-${id}-pbkUSD`,p.pbkUSD,'','fc(\''+id+'\',\'price.pbkUSD\',this.value)'))}
    ${frow('Cover Price EBK ($)',inp(`f-${id}-ebkUSD`,p.ebkUSD,'','fc(\''+id+'\',\'price.ebkUSD\',this.value)'))}
    ${frow('Trim Size',inp(`f-${id}-trimSize`,c.trimSize,'e.g. 198x129mm','fc(\''+id+'\',\'commercial.trimSize\',this.value)'))}
    ${frow('Pages',`<input type="number" id="f-${id}-pages" value="${esc(c.pages)}" min="0" oninput="fc('${id}','commercial.pages',this.value)">`)}
    ${frow('Illustrations',`<label class="field-row"><input type="checkbox" ${c.illustrations?'checked':''} onchange="fc('${id}','commercial.illustrations',this.checked)"> Yes &nbsp;<input type="number" id="f-${id}-illustrationCount" value="${c.illustrationCount}" min="0" style="width:70px" placeholder="count" oninput="fc('${id}','commercial.illustrationCount',this.value)"></label>`)}
    ${frow('Category UK',inp(`f-${id}-categoryUK`,c.categoryUK,'','fc(\''+id+'\',\'commercial.categoryUK\',this.value)'))}
    ${frow('Category USA',inp(`f-${id}-categoryUSA`,c.categoryUSA,'','fc(\''+id+'\',\'commercial.categoryUSA\',this.value)'))}
    ${frow('Nielsen Notified',`<label class="field-row"><input type="checkbox" ${c.nielsenNotified?'checked':''} onchange="fc('${id}','commercial.nielsenNotified',this.checked)"> Notified</label>`)}
  </div>`;}

function renderContent(t){const id=t.id;const c=t.content;
  return `<div class="field-grid">
    ${frow('Full Description',ta(`f-${id}-fullDesc`,c.fullDescription,'Full marketing description…',`fc('${id}','content.fullDescription',this.value)`,'tall'),'full')}
    ${frow('Jacket Blurb',ta(`f-${id}-jacketBlurb`,c.jacketBlurb,'Back cover blurb…',`fc('${id}','content.jacketBlurb',this.value)`),'full')}
    ${frow('Brief Description',ta(`f-${id}-briefDesc`,c.briefDescription,'Short description…',`fc('${id}','content.briefDescription',this.value)`),'full')}
    ${frow('Sales Handle',inp(`f-${id}-salesHandle`,c.salesHandle,'One-line sales handle…',`fc('${id}','content.salesHandle',this.value)`),'full')}
    ${frow('Selling Points (one per line)',ta(`f-${id}-sellingPoints`,c.sellingPoints,'One selling point per line…',`fc('${id}','content.sellingPoints',this.value)`),'full')}
    ${frow('Quotes (one per line)',ta(`f-${id}-quotes`,c.quotes,'Online and print quotes, one per line…',`fc('${id}','content.quotes',this.value)`),'full')}
    ${frow('Target Audience',inp(`f-${id}-targetAud`,c.targetAudience,'',`fc('${id}','content.targetAudience',this.value)`))}
    ${frow('Keywords / Metadata',inp(`f-${id}-keywords`,c.keywords,'',`fc('${id}','content.keywords',this.value)`))}
  </div>`;}

function renderAuthor(t){const id=t.id;const a=t.authorInfo;
  return `<div class="field-grid">
    ${frow('Author Bio',ta(`f-${id}-bio`,a.bio,'',`fc('${id}','authorInfo.bio',this.value)`),'full')}
    ${frow('Author Hometown',inp(`f-${id}-hometown`,a.hometown,'',`fc('${id}','authorInfo.hometown',this.value)`))}
    ${frow('Socials & Societies',inp(`f-${id}-socials`,a.socials,'',`fc('${id}','authorInfo.socials',this.value)`))}
    ${frow('Other Contributors',ta(`f-${id}-otherContribs`,a.otherContributors,'',`fc('${id}','authorInfo.otherContributors',this.value)`),'full')}
    ${frow('Previous Publications',ta(`f-${id}-prevPubs`,a.previousPublications,'',`fc('${id}','authorInfo.previousPublications',this.value)`),'full')}
    ${frow('Author Liaison',`<select id="f-${id}-liaison" onchange="fc('${id}','authorLiaison',this.value)"><option ${t.authorLiaison==='David'?'selected':''}>David</option><option ${t.authorLiaison==='Jen'?'selected':''}>Jen</option><option ${t.authorLiaison==='Other'?'selected':''}>Other</option></select>`)}
  </div>`;}

function renderPipeline(t){const id=t.id;
  const rows=t.pipeline.stages.map((s,i)=>{
    const cls='stage-'+s.status.toLowerCase().replace(/ /g,'-');
    return `<tr><td class="stage-name-cell"><span class="stage-num">${i+1}.</span>${esc(s.name)}</td>
      <td><button class="stage-btn ${cls}" data-stage-btn="${id}-${i}" onclick="cycleStage('${id}',${i})">${esc(s.status)}</button></td>
      <td><input type="date" class="stage-date-input" value="${esc(s.expectedDate)}" onchange="stageChange('${id}',${i},'expectedDate',this.value)"></td>
      <td><input type="text" class="stage-notes-input" value="${esc(s.notes)}" placeholder="Notes…" oninput="stageChange('${id}',${i},'notes',this.value)"></td></tr>`;
  }).join('');
  return `<table class="stages-table"><thead><tr><th>Stage</th><th>Status</th><th>Expected Date</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;}

function renderDates(t){const id=t.id;const d=t.dates;
  const compPrint=calcAutoPrint(d.streetDate);
  const pdVal=d.autoPrintDate?compPrint:d.printDate;
  const printDays=pdVal?daysUntil(pdVal):null;
  const ddHtml=printDays!==null?`<span style="color:${printDays<0?'var(--terra)':printDays<=60?'var(--terra)':printDays<=90?'var(--amber)':'var(--sage)'};font-weight:600">${printDays<0?'OVERDUE — '+Math.abs(printDays)+' days ago':printDays+' days'}</span>`:'—';
  return `<div class="field-grid">
    ${frow('Release Block',inp(`f-${id}-releaseBlock`,d.releaseBlock,'e.g. 2027 Q1',`fc('${id}','dates.releaseBlock',this.value)`))}
    ${frow('Soft Date',`<input type="date" id="f-${id}-softDate" value="${esc(d.softDate)}" onchange="fc('${id}','dates.softDate',this.value)">`)}
    ${frow('Street Date',`<input type="date" id="f-${id}-streetDate" value="${esc(d.streetDate)}" onchange="onStreetDateChange('${id}',this.value)">`)}
    ${frow('Print Date',`<div style="display:flex;flex-direction:column;gap:4px"><label style="font-size:.8rem;color:var(--text3)"><input type="checkbox" ${d.autoPrintDate?'checked':''} onchange="onAutoPrint('${id}',this.checked)"> Auto-calculate (street date −60 days)</label><input type="date" id="f-${id}-printDate" value="${esc(pdVal)}" ${d.autoPrintDate?'readonly':''} onchange="fc('${id}','dates.printDate',this.value)"></div>`)}
    ${frow('Days to Print Deadline',`<div id="f-${id}-daysToprint" style="padding:8px 0;font-size:.9rem">${ddHtml}</div>`)}
  </div>`;}

function renderPrint(t){const id=t.id;const p=t.print;
  const contactRows=(p.printerContacts||[]).map((pc,i)=>`<div class="printer-row">
      <input class="pname" type="text" value="${esc(pc.name)}" placeholder="Printer name" oninput="printerContactChange('${id}',${i},'name',this.value)">
      <input type="email" value="${esc(pc.email)}" placeholder="email" oninput="printerContactChange('${id}',${i},'email',this.value)">
      <button class="btn-danger btn-sm" onclick="removePrinterContact('${id}',${i})">Remove</button>
    </div>`).join('');
  return `<div class="field-grid">
    ${frow('Print Estimate / Quotes',ta(`f-${id}-printEstimate`,p.printEstimate,'Record printer quotes here…',`fc('${id}','print.printEstimate',this.value)`),'full')}
    ${frow('SCB eBook Cover Spec',inp(`f-${id}-scbSpec`,p.scbEbookCoverSpec,'',`fc('${id}','print.scbEbookCoverSpec',this.value)`),'full')}
    ${frow('For LSI Notes',ta(`f-${id}-forLsi`,p.forLsiNotes,'',`fc('${id}','print.forLsiNotes',this.value)`),'full')}
    <div class="field-group full"><label class="field-label">Printer Contacts</label>
      <div class="printer-contacts">${contactRows}</div>
      <button class="btn btn-sm" style="margin-top:8px" onclick="addPrinterContact('${id}')">+ Add Printer Contact</button>
    </div>
  </div>`;}

// New §5 requirement: surface linked PO/print-estimate data per title,
// read-only, joined by ISBN per Marcus's poTrackerIsbnKey design (documented
// in the Sheet's ReadMe). Loaded lazily (only when this section is opened)
// to avoid an extra API round-trip on every title-detail view.
function renderPoTracker(t){const id=t.id;
  const key = t.commercial.isbnPbk || t.commercial.isbnHbk || '';
  return `<div class="field-grid">
    ${frow('PO Tracker ISBN Key (auto)',`<input type="text" value="${esc(key)}" readonly>`)}
    ${frow('Manual Override (title/tab name)',inp(`f-${id}-poOverride`,t.poTrackerTitleOverride,'Exact PO Log "Book Title" text or tab name — use if no ISBN yet','fc(\''+id+'\',\'poTrackerTitleOverride\',this.value)'))}
    <div class="field-group full" id="po-tracker-results-${id}">
      <label class="field-label">Matching Purchase Orders</label>
      <div class="po-empty">Loading… (if this doesn't update, the PO tracker sheet may not be shared with your signed-in account)</div>
    </div>
  </div>`;}

async function loadPoTrackerFor(titleId){
  const t=getTitle(titleId);if(!t)return;
  const container=document.getElementById('po-tracker-results-'+titleId);
  if(!container)return;
  if(devMode){ container.innerHTML='<div class="po-empty">Dev preview mode — PO tracker data isn\'t fetched (no live sign-in).</div>'; return; }
  const key=(t.commercial.isbnPbk||t.commercial.isbnHbk||'').trim();
  const override=(t.poTrackerTitleOverride||'').trim();
  if(!key && !override){ container.innerHTML='<div class="po-empty">No ISBN or manual override set — nothing to match against the PO tracker yet.</div>'; return; }
  try{
    if(!poLogRowsCache){
      // Header row confirmed at row 3 of the live PO Log tab (rows 1-2 are
      // a title banner + blank spacer row, not part of the table).
      poLogRowsCache = await sheetsGet(CFG.PO_TRACKER_SHEET_ID, "'PO Log'!A3:L2000");
    }
    const headers = poLogRowsCache[0] || ['Date','Book Title','Printer Name','Quantity','PO Number','Unit Cost','Total Order Value','Payment Status','Amount Paid','Payment Date','Balance Outstanding','Notes'];
    const dataRows = poLogRowsCache.slice(1);
    const matches = dataRows.filter(r=>{
      const bookTitle = (r[1]||'').toString();
      if(key && bookTitle.includes(key)) return true;
      if(override && bookTitle.toLowerCase().includes(override.toLowerCase())) return true;
      return false;
    });
    if(!matches.length){
      container.innerHTML='<div class="po-empty">No matching rows found in the PO tracker\'s \'PO Log\' tab for this ISBN/override.</div>'+poTrackerOpenLink();
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
    container.innerHTML = `<table class="po-table"><thead><tr><th>Date</th><th>Printer</th><th>Qty</th><th>PO Number</th><th>Total Value</th><th>Status</th><th>Balance</th></tr></thead><tbody>${rows}</tbody></table>`+poTrackerOpenLink();
  }catch(e){
    container.innerHTML='<div class="po-empty">Could not load PO tracker data: '+esc(e.message)+'</div>'+poTrackerOpenLink();
    console.error(e);
  }
}
function poTrackerOpenLink(){
  return `<p style="margin-top:8px"><a href="https://docs.google.com/spreadsheets/d/${esc(CFG.PO_TRACKER_SHEET_ID)}/edit" target="_blank" rel="noopener">Open full PO tracker / print-estimate sheet &#8599;</a></p>`;
}

function renderPublicity(t){const id=t.id;const p=t.publicity;
  return `<div class="field-grid">
    ${frow('Publicity Statement',ta(`f-${id}-pubStmt`,p.publicityStatement,'',`fc('${id}','publicity.publicityStatement',this.value)`),'full')}
    ${frow('PR Contact',inp(`f-${id}-prContact`,p.prContact,'Name and contact info',`fc('${id}','publicity.prContact',this.value)`),'full')}
    ${frow('Marketing Notes',ta(`f-${id}-marketing`,p.marketing,'',`fc('${id}','publicity.marketing',this.value)`),'full')}
    <p style="grid-column:1/-1;font-size:.78rem;color:var(--text3)">Amazon A+, PLS.ORG, Newsletter and Promo Film status now live in the Production Pipeline section above (they were duplicated in both places in the original app) — use each stage's Notes field for detail.</p>
  </div>`;}

function renderTOC(t){const id=t.id;const c=t.toc;
  return `<div class="field-grid">
    ${frow('Table of Contents',ta(`f-${id}-toc`,c.tableOfContents,'',`fc('${id}','toc.tableOfContents',this.value)`),'full')}
    ${frow('How I Came to Write This Book',ta(`f-${id}-howIWrote`,c.howICameToWriteThis,'',`fc('${id}','toc.howICameToWriteThis',this.value)`),'full')}
    ${frow('Excerpt',ta(`f-${id}-excerpt`,c.excerpt,'',`fc('${id}','toc.excerpt',this.value)`),'full')}
    ${frow('Competing Titles',ta(`f-${id}-competing`,c.competingTitles,'',`fc('${id}','toc.competingTitles',this.value)`),'full')}
  </div>`;}

function renderProductionNotes(t){const id=t.id;
  const items=t.productionNotes.checklist.map((c,i)=>`<div class="check-item ${c.checked?'done':''}">
    <input type="checkbox" id="chk-${id}-${i}" ${c.checked?'checked':''} onchange="checklistChange('${id}',${i},this.checked)">
    <label for="chk-${id}-${i}">${esc(c.text)}</label>
  </div>`).join('');
  return `<div class="checklist">${items}</div>
  <div class="field-grid" style="margin-top:14px">
    ${frow('Proofing Notes',ta(`f-${id}-proofingNotes`,t.productionNotes.proofingNotes,'',`fc('${id}','productionNotes.proofingNotes',this.value)`),'full')}
    ${frow('Typesetting Notes',ta(`f-${id}-typesettingNotes`,t.productionNotes.typesettingNotes,'',`fc('${id}','productionNotes.typesettingNotes',this.value)`),'full')}
  </div>`;}

function renderFutureEdition(t){const id=t.id;const f=t.futureEdition;
  return `<div class="field-grid">
    ${frow('Info & Changes for Future Edition',ta(`f-${id}-futureInfo`,f.infoAndChanges,'',`fc('${id}','futureEdition.infoAndChanges',this.value)`),'full')}
    ${frow('Print-Ready Files',`<select id="f-${id}-prf" onchange="fc('${id}','futureEdition.printReadyFilesStatus',this.value)"><option ${f.printReadyFilesStatus==='Not Ready'?'selected':''}>Not Ready</option><option ${f.printReadyFilesStatus==='Ready'?'selected':''}>Ready</option><option ${f.printReadyFilesStatus==='Submitted'?'selected':''}>Submitted</option></select>`)}
  </div>`;}

function renderFilesLinks(t){const id=t.id;
  const links=t.filesLinks&&t.filesLinks.links?t.filesLinks.links:[];
  const listHtml=links.length?links.map((lnk,i)=>`<div class="link-item">
    <span class="link-label">${esc(lnk.label)}</span>
    <a href="${esc(lnk.url)}" target="_blank" rel="noopener">${esc(lnk.url)}</a>
    <button class="btn-danger btn-sm" onclick="removeLink('${id}',${i})">Remove</button>
  </div>`).join(''):'<p style="color:var(--text3);font-size:.85rem;margin-bottom:8px">No links added yet.</p>';
  return `<div id="links-list-${id}" class="links-list">${listHtml}</div>
  <div class="add-link-form">
    <div><label class="field-label">Label</label><input type="text" id="new-link-label-${id}" placeholder="e.g. Cover File"></div>
    <div><label class="field-label">URL</label><input type="url" id="new-link-url-${id}" placeholder="https://…"></div>
    <div style="padding-top:18px"><button class="btn btn-sm" onclick="addLink('${id}')">+ Add Link</button></div>
  </div>`;}

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
function addLink(titleId){
  const labelEl=document.getElementById(`new-link-label-${titleId}`);
  const urlEl=document.getElementById(`new-link-url-${titleId}`);
  if(!labelEl||!urlEl)return;
  const label=labelEl.value.trim();const url=urlEl.value.trim();
  if(!label||!url)return;
  const t=getTitle(titleId);if(!t)return;
  if(!t.filesLinks)t.filesLinks={links:[]};
  t.filesLinks.links.push({label,url});
  labelEl.value='';urlEl.value='';
  renderDetail();
  debouncedSave(titleId);
}
function removeLink(titleId,idx){
  const t=getTitle(titleId);if(!t||!t.filesLinks)return;
  t.filesLinks.links.splice(idx,1);
  renderDetail();
  debouncedSave(titleId);
}

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
