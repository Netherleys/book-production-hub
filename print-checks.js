/* r98 09-11 (Mia Chen): proof-query panel (Proof Query Log) + per-page checklist in grouped findings (Group Pages, group status derived).
 * print-checks.js — Book Production Hub, Round 93 (+ r95 04-11: schema v2 grouped rows, merge rule, run_id seconds; + r96 04-11: clearer button row with descriptions) (Mia Chen, 04-11-2026, David GO:
 * "Keep the ILLOS box, add an actual page count and also trim size box which is
 * flagged if the PDF is not the same as Commercial. Go build!").
 *
 * The "Print Checks" section on every title page. BPH is the single point of
 * truth: every finding (PC check or browser check) is one row in the Sheet tab
 * "Print Checks"; every run is one row in "Print Check Runs". Schema agreed with
 * Dean Thorn: Team Inbox\_Files\BPH - Print Checks Schema\print_checks_schema.md.
 *
 * Writes (never in dev preview):
 *  - status / david_note / note_date of one row (David's marks), debounced;
 *  - an imported or browser run: merge rules (schema §5) + one run row.
 * Never deletes a row; never touches another title's rows.
 * Titles fields (inside productionNotes_json, no new columns): interior,
 * humanAuthored, illosCount. Pages + Trim REUSE the existing Commercial fields.
 */
(function(){
'use strict';
const PCK_TAB='Print Checks', PCK_RUNS='Print Check Runs';
const PCK_STATUSES=['Open','Resolved','Deliberate',"Won't fix"];
const PCK_SCRIPT='C:\\Users\\Administrator\\OneDrive\\Documents\\PKA MANAGEMENT\\Scripts\\print_pdf_check.py';
const PCK_PRINTER_LINE='<b>LSI:</b> any colour page = whole book printed + billed as colour. <b>Biddles and most others:</b> colour pages counted and priced separately, so quote with the list above.';
let pck={ loaded:false, loading:null, err:'', fH:[], rH:[], rows:[], runs:[], pH:[], lH:[], pages:[], log:[], pg:new Map(), pkey:new Map() };
const ui={}; // titleId -> {filter, showAll, runSel, queue:[]}
function U(id){ return ui[id]||(ui[id]={filter:'all',cat:'all',ticks:new Set(),open:new Set(),hide:new Set(),vp:false,showAll:false,runSel:'',queue:[],qState:''}); }

// ── helpers ──
const e=s=>esc(s);
function colL(i){ let s=''; i++; while(i>0){ const m=(i-1)%26; s=String.fromCharCode(65+m)+s; i=Math.floor((i-1)/26); } return s; }
function dm(s){ const m=/^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d:\d\d))?/.exec(String(s||'')); return m?(m[3]+'-'+m[2]+(m[4]?' '+m[4]:'')):String(s||''); }
function nowStamp(sec){ const d=new Date(), p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+(sec?':'+p(d.getSeconds()):''); } // r95: sec=true for run_id (schema v2 §6)
function isbnKey(t){ const c=t.commercial||{}; return String(c.isbnPbk||c.isbnHbk||'').replace(/[^0-9Xx]/g,'') || t.id; }
function rowsFor(t){ const k=isbnKey(t); return pck.rows.filter(r=>r.title_id===t.id || (k && r.isbn===k && !r.title_id)); }
function runsFor(t){ const k=isbnKey(t); return pck.runs.filter(r=>r.title_id===t.id || (k && r.isbn===k && !r.title_id))
  .sort((a,b)=>(a.export_date+a.run_at).localeCompare(b.export_date+b.run_at) || runKeyTime(a).localeCompare(runKeyTime(b))); }
// r95: run_id = <key>|YYYY-MM-DD HH:MM[:SS]; the seconds order two runs made in the same minute
function runKeyTime(r){ const m=/\|(\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?)$/.exec(String(r.run_id||'')); return m?(m[1].length===16?m[1]+':00':m[1]):String(r.run_at||''); }
function latestRun(t){ const r=runsFor(t); return r.length?r[r.length-1]:null; }
function toObjs(vals){ const h=(vals[0]||[]).map(x=>String(x||'').trim()); const out=[];
  for(let i=1;i<vals.length;i++){ const r=vals[i]; if(!r||!r[0]) continue; const o={_row:i+1}; h.forEach((k,j)=>{ if(k) o[k]=r[j]==null?'':String(r[j]); }); out.push(o); }
  return {h,out}; }
function isAutoClosed(r){ return r.status==='Resolved' && !r.note_date && !r.david_note && !isMerged(r); }
// r95 (schema v2): grouped rows = one row per check + kind for ink / text / colour / res, page token `all`
const PCK_GROUP_CHECKS=new Set(['ink','text','colour','res','layout']);
function isMerged(r){ return r.status==='Resolved' && /^merged into grouped row/.test(String(r.auto_note||'')); }
function grpInfo(r){
  if(String(r.page)!=='all' || !PCK_GROUP_CHECKS.has(r.check) || String(r.findingId||'').split('|')[2]!=='all') return null;
  const parts=String(r.detail||'').split('; '), m=/^(\d+) page\(s\): (.*)$/.exec(parts[0]||''); if(!m) return null;
  const wp=parts.find(x=>/^worst: /.test(x)), worstList=wp?wp.slice(7).split(', ').filter(Boolean):[];
  const pw=/\b(max|lowest) ([^,()]+?)\s*\(p(\d+)\)/.exec(String(r.problem||''));
  const worst=pw?(pw[2]+' on p'+pw[3]):(worstList[0]?worstList[0].replace(/^p(\d+) (.*)$/,'$2 on p$1'):'');
  const dl=m[2].replace(/-/g,'–'), pr=String(r.problem||''); // drop the page list from the headline (it sits under "Pages")
  const head=[', pp '+dl, ', p '+dl].reduce((x,y)=>x.includes(y)?x.replace(y,''):x, pr).replace(/,\s*pp \d+–\d+ \(gaps: see detail\)/,'');
  const first=parseInt(m[2],10);
  return {n:+m[1], list:m[2], worst, worstList, head, first:isNaN(first)?99999:first, rest:parts.filter(x=>x!==parts[0]&&x!==wp)};
}
function pnum(v){ const m=/^\s*(\d+)\s*$/.exec(String(v==null?'':v)); return m?+m[1]:null; }

// ── load ──
async function pckLoad(force){
  if(pck.loaded && !force) return pck;
  if(pck.loading && !force) return pck.loading;
  pck.loading=(async()=>{
    try{
      if(devMode){ const fx=window.PCK_DEV_FIXTURE||{rows:[],runs:[],fH:[],rH:[]}; pck.rows=fx.rows.map((r,i)=>Object.assign({_row:i+2},r)); pck.runs=fx.runs.map((r,i)=>Object.assign({_row:i+2},r)); pck.fH=fx.fH; pck.rH=fx.rH; pck.pages=(fx.pages||[]).map((r,i)=>Object.assign({_row:i+2},r)); pck.log=(fx.log||[]).map((r,i)=>Object.assign({_row:i+2},r)); pck.pH=fx.pH||[]; pck.lH=fx.lH||[]; pckIndexPages(); pckNormGroups(); pck.loaded=true; pck.err=''; return pck; }
      // r98: the two newer tabs may not exist yet on an older Sheet: treat a missing tab as empty
      const opt=r=>sheetsGet(CFG.TITLES_SHEET_ID,r).catch(err=>{ if(isAuthFailure(err)) throw err; return []; });
      const [a,b,c,d]=await Promise.all([sheetsGet(CFG.TITLES_SHEET_ID,"'"+PCK_TAB+"'!A1:AF5000"), sheetsGet(CFG.TITLES_SHEET_ID,"'"+PCK_RUNS+"'!A1:AF3000"), opt("'"+PCK_PAGES+"'!A1:P20000"), opt("'"+PCK_LOG+"'!A1:S5000")]);
      const A=toObjs(a), B=toObjs(b), C=toObjs(c), D=toObjs(d); pck.fH=A.h; pck.rH=B.h; pck.rows=A.out; pck.runs=B.out; pck.pH=C.h; pck.pages=C.out; pck.lH=D.h; pck.log=D.out; pckIndexPages(); pckNormGroups(); pck.loaded=true; pck.err='';
    }catch(err){ pck.err=(err&&err.message)||String(err); pck.loaded=false; }
    finally{ pck.loading=null; }
    return pck;
  })();
  return pck.loading;
}

// ── Sheet writes ──
async function valuesBatch(data){
  if(devMode) return;
  return withAuthRetry(async()=>{
    const resp=await fetch(SHEETS_API+CFG.TITLES_SHEET_ID+'/values:batchUpdate',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},await authHeaders()),body:JSON.stringify({valueInputOption:'RAW',data})});
    if(resp.status===401) throw new AuthExpiredError('Sheets PUT 401 on Print Checks');
    if(!resp.ok){ const x=await resp.text().catch(()=>''); throw new Error('Sheets PUT '+resp.status+': '+x.slice(0,200)); }
    return resp.json();
  });
}
async function appendRows(tab,rows){
  if(devMode||!rows.length) return null;
  return withAuthRetry(async()=>{
    const url=SHEETS_API+CFG.TITLES_SHEET_ID+'/values/'+encodeURIComponent("'"+tab+"'!A1")+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    const resp=await fetch(url,{method:'POST',headers:Object.assign({'Content-Type':'application/json'},await authHeaders()),body:JSON.stringify({values:rows})});
    if(resp.status===401) throw new AuthExpiredError('Sheets APPEND 401 on '+tab);
    if(!resp.ok){ const x=await resp.text().catch(()=>''); throw new Error('Sheets APPEND '+resp.status+': '+x.slice(0,200)); }
    const j=await resp.json(); const m=/![A-Z]+(\d+):/.exec((j.updates||{}).updatedRange||''); return m?+m[1]:null;
  });
}
function cellRange(tab,h,row,fields){ // contiguous run of header fields -> one range
  const idx=fields.map(f=>h.indexOf(f)); if(idx.some(i=>i<0)) throw new Error('Print Checks tab is missing a column: '+fields[idx.findIndex(i=>i<0)]);
  for(let i=1;i<idx.length;i++) if(idx[i]!==idx[i-1]+1) throw new Error('Print Checks columns moved; not saving.');
  return "'"+tab+"'!"+colL(idx[0])+row+':'+colL(idx[idx.length-1])+row;
}

// David's marks: status + note + note_date, one row, debounced
const markTimers={};
function pckMark(fid,field,value,tid){
  const r=pck.rows.find(x=>x.findingId===fid); if(!r) return;
  r[field]=value; r.note_date=nowStamp().slice(0,10);
  const st=document.getElementById('pck-sv-'+cssId(fid)); if(st) st.textContent='saving…';
  if(field==='status') pckRender(tid,true);
  clearTimeout(markTimers[fid]);
  markTimers[fid]=setTimeout(async()=>{
    const el=()=>document.getElementById('pck-sv-'+cssId(fid));
    try{
      if(!devMode){
        // guard: the row must still hold this findingId
        const chk=await sheetsGet(CFG.TITLES_SHEET_ID,"'"+PCK_TAB+"'!A"+r._row);
        if(!chk[0]||chk[0][0]!==fid){ pck.loaded=false; throw new Error('the tab changed under us; reload the page'); }
        await valuesBatch([{range:cellRange(PCK_TAB,pck.fH,r._row,['status','david_note','note_date']),values:[[r.status,r.david_note||'',r.note_date]]}]);
      }
      const s=el(); if(s) s.textContent='✓ saved '+dm(nowStamp())+(devMode?' (preview, not written)':'');
    }catch(err){ const s=el(); if(s) s.textContent='not saved'; showReconnect('Print check mark not saved: '+(err.message||err), isAuthFailure(err)); }
  }, field==='status'?150:800);
}
function cssId(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'_'); }

// ── merge one run (schema §5). Used by the queue import and the browser check ──
async function pckMergeRun(q){
  await pckLoad();
  const run=q.run||{}; if(!run.run_id) throw new Error('run has no run_id');
  if(pck.runs.some(r=>r.run_id===run.run_id)) return {skipped:true};
  const tid=run.title_id, ran=new Set(q.checks_run||[]), when=dm(run.export_date||run.run_at);
  const present=new Map((q.findings||[]).map(f=>[f.findingId,f]));
  // Round 95 (schema v2 §5a, same rule as Dean's print_checks_bph.py v2.5): a grouped finding
  // <key>|<check>|all|<item> replaces the old per-page rows <key>|<check>|p<N>|<item>[-k].
  const grp=new Map();
  (q.findings||[]).forEach(f=>{ if(!f.grouped) return; const p=String(f.findingId).split('|'); if(p.length===4){ const k=p[1]+'|'+p[3].replace(/-\d+$/,''); if(!grp.has(k)) grp.set(k,f.findingId); } });
  const mergedInto=fid=>{ const p=String(fid).split('|'); return (p.length===4&&/^p\d+$/.test(p[2]))?(grp.get(p[1]+'|'+p[3].replace(/-\d+$/,''))||null):null; };
  const upd=[], add=[]; let merged=0;
  pck.rows.filter(r=>(r.title_id===tid || (!r.title_id && run.isbn && r.isbn===run.isbn)) && ran.has(r.check)).forEach(r=>{
    const f=present.get(r.findingId), here=!!f; present.delete(r.findingId);
    const st=r.status||'Open', an=String(r.auto_note||'');
    const o={status:st,last_seen:r.last_seen,auto_note:r.auto_note,problem:r.problem,detail:r.detail};
    if(here){ o.last_seen=run.export_date; o.problem=f.problem; o.detail=f.detail||''; }
    const byEye=r.by_eye==='TRUE'||(here&&!!f.by_eye);
    const gid=here?null:mergedInto(r.findingId);
    if(st==='Deliberate'||st==="Won't fix"){ o.auto_note='skipped ('+st+')'; }
    else if(gid && !byEye && !(st==='Resolved' && /^(confirmed fixed|gone in export)/.test(an))){
      // replaced by a grouped row, not fixed: Open -> Resolved; the first merge note is kept
      if(st==='Open') o.status='Resolved';
      if(!/^merged into grouped row/.test(an)){ o.auto_note='merged into grouped row '+gid; merged++; }
    }
    else if(byEye){ o.auto_note=st==='Resolved'?"by eye: David's mark kept":(here?'still present in export '+when:'gone in export '+when+' (by eye: status kept)'); }
    else if(!here){ if(st==='Open'){ o.status='Resolved'; o.auto_note='gone in export '+when+' (auto-closed by run '+dm(run.run_at)+')'; }
      else if(!/^(confirmed fixed|gone in export|merged into)/.test(an)) o.auto_note='confirmed fixed in export '+when; }
    else { if(st==='Resolved'){ o.status='Open'; o.auto_note='still present in export '+when+(r.note_date?' (you marked Resolved '+dm(r.note_date)+')':''); } else o.auto_note='still present in export '+when; }
    Object.assign(r,o,{export_file:run.export_file,export_date:run.export_date,run_id:run.run_id});
    upd.push(r);
  });
  // run-row counts = OPEN items only, after the merge (same as print_checks_bph.py: a queued
  // run gets its counts set at import, so David's Resolved / Deliberate / Won't fix marks apply)
  if(Array.isArray(q.findings)){
    const stOf=new Map(pck.rows.map(r=>[r.findingId,r.status||'Open']));
    const isOpen=(q.findings||[]).filter(f=>(stOf.get(f.findingId)||'Open')==='Open');
    const fc=isOpen.filter(f=>f.severity==='FAIL').length, wc=isOpen.filter(f=>f.severity==='WARN'||f.severity==='CHECK').length;
    run.fail_count=String(fc); run.warn_count=String(wc); run.verdict=fc?'FAIL':'OK';
  }
  present.forEach(f=>{
    if(pck.rows.some(r=>r.findingId===f.findingId)) return; // row exists but its check wasn't in checks_run: leave it
    add.push({findingId:f.findingId,title_id:tid,title:run.title,isbn:run.isbn,check:f.check,category:f.category,page:String(f.page||''),pdf_page:String(f.pdf_page||''),
      problem:f.problem,detail:f.detail||'',by_eye:f.by_eye?'TRUE':'FALSE',source:run.source||'PC',first_seen:run.export_date,last_seen:run.export_date,
      export_file:run.export_file,export_date:run.export_date,status:'Open',david_note:'',note_date:'',auto_note:'new in export '+when,run_id:run.run_id});
  });
  const runRow=Object.assign({},run,{passes_json:run.passes_json||JSON.stringify(run.passes||[])});
  if(!devMode){
    const data=[];
    upd.forEach(r=>{ data.push({range:cellRange(PCK_TAB,pck.fH,r._row,['last_seen','export_file','export_date','status']),values:[[r.last_seen,r.export_file,r.export_date,r.status]]});
                     data.push({range:cellRange(PCK_TAB,pck.fH,r._row,['auto_note','run_id']),values:[[r.auto_note,r.run_id]]});
                     data.push({range:cellRange(PCK_TAB,pck.fH,r._row,['problem','detail']),values:[[r.problem||'',r.detail||'']]}); }); // r95: grouped rows carry fresh counts
    for(let i=0;i<data.length;i+=500) await valuesBatch(data.slice(i,i+500)); // r95: TR merges ~400 rows at once
    if(add.length) await appendRows(PCK_TAB, add.map(o=>pck.fH.map(k=>o[k]==null?'':String(o[k]))));
    await appendRows(PCK_RUNS, [pck.rH.map(k=>runRow[k]==null?'':String(runRow[k]))]);
    pck.loaded=false; await pckLoad(true);
  } else { add.forEach((o,i)=>pck.rows.push(Object.assign({_row:pck.rows.length+2+i},o))); pck.runs.push(Object.assign({_row:pck.runs.length+2},runRow)); }
  return {updated:upd.length, added:add.length, merged};
}

// ── PC queue: <PDF folder>\Checks\_queue\*.json, read with folder access ──
const IDB='bph-pck', IDBS='h';
function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open(IDB,1); r.onupgradeneeded=()=>r.result.createObjectStore(IDBS); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbGet(k){ try{ const d=await idb(); return await new Promise(res=>{ const q=d.transaction(IDBS).objectStore(IDBS).get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>res(null); }); }catch(_){ return null; } }
async function idbSet(k,v){ try{ const d=await idb(); d.transaction(IDBS,'readwrite').objectStore(IDBS).put(v,k); }catch(_){} }
function relParts(full,rootName){ // "D:\PROJECTS - BOOKS\Book_X\BHF_Print PDFs" -> parts below the granted folder
  const p=String(full||'').split(/[\\/]+/).filter(Boolean); const i=p.findIndex(x=>x.toLowerCase()===String(rootName||'').toLowerCase());
  return i<0?null:p.slice(i+1); }
async function walk(dir,parts){ for(const n of parts){ dir=await dir.getDirectoryHandle(n); } return dir; }
async function findQueueDirs(root,t){
  const out=[]; const lr=latestRun(t);
  const tryPath=async parts=>{ if(!parts) return; try{ const d=await walk(root,parts.concat(['Checks','_queue'])); out.push(d); }catch(_){} };
  if(lr&&lr.pdf_folder) await tryPath(relParts(lr.pdf_folder,root.name));
  if(!out.length && t.workingFolderLink){ const base=relParts(t.workingFolderLink,root.name);
    if(base){ let bd=null; try{ bd=await walk(root,base); }catch(_){}
      if(bd){ for await (const [n,h] of bd.entries()){ if(h.kind!=='directory') continue; try{ out.push(await walk(h,['Checks','_queue'])); }catch(_){} }
        try{ out.push(await walk(bd,['Checks','_queue'])); }catch(_){} } } }
  return out;
}
async function pckScanQueue(tid,ask){
  const t=getTitle(tid); if(!t||!window.showDirectoryPicker) return;
  const u=U(tid); let root=await idbGet('root');
  // r96 (David 04-11): a click always ends with a clear result line (u.qMsg); the silent scan on open only fills the banner
  const fail=why=>{ if(ask) u.qMsg={k:'err',t:"Couldn't read the folder: "+why}; };
  if(ask){ u.qMsg={k:'busy',t:'Looking…'}; pckRender(tid,true); }
  try{
    if(root){ let p=await root.queryPermission({mode:'readwrite'}); if(p!=='granted'&&ask) p=await root.requestPermission({mode:'readwrite'}); if(p!=='granted'){ u.qState='need'; fail('folder access was not given.'); pckRender(tid,true); return; } }
    else if(ask){ root=await window.showDirectoryPicker({id:'bph-books',mode:'readwrite'}); await idbSet('root',root); }
    else { u.qState='need'; pckRender(tid,true); return; }
    const dirs=await findQueueDirs(root,t); const files=[]; let bad=0;
    for(const d of dirs){ for await (const [n,h] of d.entries()){ if(h.kind==='file' && /\.json$/i.test(n)){ try{ const j=JSON.parse(await (await h.getFile()).text()); if(j&&j.run&&(j.run.title_id===tid||j.run.isbn===isbnKey(t))) files.push({name:n,dir:d,handle:h,json:j}); }catch(_){ bad++; } } } }
    u.queue=files.filter(f=>!pck.runs.some(r=>r.run_id===f.json.run.run_id)); u.qState=dirs.length?'ok':'nofolder';
    if(ask){
      if(u.queue.length){ await pckImportQueue(tid); return; } // click = find + import in one go
      u.qMsg={k:'ok',t:'Nothing waiting: all PC checks are in BPH.'+(dirs.length?'':' (This title has no Checks\\_queue folder.)')+(bad?' '+bad+' unreadable file'+(bad>1?'s':'')+' skipped.':'')};
    }
  }catch(err){ u.qState=(err&&err.name==='AbortError')?'need':'err'; fail(err&&err.name==='AbortError'?'no folder was picked.':String((err&&err.message)||err)); }
  pckRender(tid,true);
}
async function pckImportQueue(tid){
  const u=U(tid); let n=0, mg=0, skip=0, why='';
  for(const f of u.queue.slice()){
    try{ const res=await pckMergeRun(f.json); if(res.skipped) skip++; else { n++; mg+=(res.merged||0); }
      if(!devMode){ try{ const done=await f.dir.getDirectoryHandle('_imported',{create:true}); if(f.handle.move) await f.handle.move(done); else { const w=await (await done.getFileHandle(f.name,{create:true})).createWritable(); await w.write(await (await f.handle.getFile()).text()); await w.close(); } }catch(_){ /* leave it: re-import is idempotent */ } }
      u.queue=u.queue.filter(x=>x!==f);
    }catch(err){ why=String(err.message||err); showReconnect('PC check not imported: '+why, isAuthFailure(err)); break; }
  }
  if(n) ctToast(n+' PC check'+(n>1?'s':'')+' imported.'+(mg?' '+mg+' per-page rows merged into grouped rows.':''));
  // r96: result line under the Look button (also after "Import now" in the banner)
  const cs=k=>k+' check'+(k>1?'s':'');
  u.qMsg=why?{k:'err',t:(n?'Imported '+cs(n)+', then stopped: ':"Couldn't import: ")+why}
    :{k:'imp',t:n?'Imported '+cs(n)+(devMode?' (preview: not written).':', saved to BPH.')+(skip?' '+skip+' already in BPH.':''):'Nothing waiting: all PC checks are in BPH.'};
  pckRender(tid,true);
}
async function pckImportFile(tid,input){
  const files=[...(input.files||[])]; let n=0, mg=0;
  for(const f of files){ try{ const j=JSON.parse(await f.text()); if(!j.run) throw new Error('not a PC check file'); const r=await pckMergeRun(j); if(!r.skipped){ n++; mg+=(r.merged||0); } }catch(err){ showReconnect('Import failed ('+f.name+'): '+(err.message||err), isAuthFailure(err)); } }
  input.value=''; if(n) ctToast(n+' run'+(n>1?'s':'')+' imported.'+(mg?' '+mg+' per-page rows merged into grouped rows.':'')); pckRender(tid,true);
}

// ── Titles fields (Commercial + panel) ──
function pckSetField(tid,k,v){
  const t=getTitle(tid); if(!t) return;
  if(k==='illosCount'){ v=String(v||'').replace(/[^0-9]/g,''); }
  fc(tid,'commercial.'+k,v);
  pckRender(tid,true); pckCommRefresh(tid);
}
function illosFromText(t){ const m=/\d+/.exec(String((t.commercial||{}).illustrationsText||'')); return m?m[0]:(/^\s*(none|no)\s*$/i.test((t.commercial||{}).illustrationsText||'')?'0':''); }
function segHtml(tid,val,idp){
  return `<span class="pck-seg" role="radiogroup" aria-label="Interior">${['Mono','Colour','Mixed'].map(x=>`<button type="button" role="radio" aria-checked="${val===x}" class="${val===x?'on':''}" onclick="pckSetField('${tid}','interior','${x}')">${x}</button>`).join('')}</span>`;
}
// Commercial rows (called from renderCommercial)
function pckCommercialHtml(t){
  const id=t.id, c=t.commercial||{}, sug=illosFromText(t);
  return `<div class="field-group pck-comm" id="pck-comm-${id}"><label class="field-label">Illos number <span class="pck-newtag">for the print check</span></label>
      <div class="pck-inl"><input type="number" min="0" id="f-${id}-illosCount" value="${e(c.illosCount||'')}" placeholder="blank" oninput="pckSetField('${id}','illosCount',this.value)">
      ${!c.illosCount&&sug!==''?`<button type="button" class="btn btn-sm" onclick="pckSetField('${id}','illosCount','${sug}')">Use ${e(sug)} (from the text)</button>`:''}</div>
      <div class="pck-hint">Compared with the pictures in the PDF; flagged if more than ~10% off. A guide, never a fail. The Illustrations text stays as it is (sales sheets).</div></div>
    <div class="field-group"><label class="field-label">Interior</label>${segHtml(id,c.interior||'')}
      <div class="pck-hint">Mixed = some colour pages: the print check lists them for the printer quote.</div></div>
    <div class="field-group"><label class="field-label">Human Authored</label><label class="pck-tick pck-tick-comm"><input type="checkbox" ${c.humanAuthored===true?'checked':''} onchange="pckSetField('${id}','humanAuthored',this.checked)"> Line + logo required on the copyright page</label></div>`;
}
function pckCommRefresh(tid){ const t=getTitle(tid), el=document.getElementById('pck-comm-'+tid); if(!t||!el) return;
  const wrap=document.createElement('div'); wrap.innerHTML=pckCommercialHtml(t);
  // replace the 3 groups in place
  let n=el; const nodes=[n, n.nextElementSibling, n.nextElementSibling&&n.nextElementSibling.nextElementSibling];
  [...wrap.children].forEach((ch,i)=>{ if(nodes[i]) nodes[i].replaceWith(ch); });
}

// ── comparison flags ──
function trimOf(s){ const m=/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/.exec(String(s||'')); return m?[+m[1],+m[2]]:null; }
function pckFlags(t,lr){
  const c=t.commercial||{}, f={};
  const cp=pnum(c.pages), pp=lr?pnum(lr.page_count):null;
  const lsiOpen=rowsFor(t).some(r=>r.check==='lsi'&&r.status==='Open');
  f.pages={pdf:pp, comm:cp, raw:c.pages, ok:pp!=null&&cp!=null&&pp===cp,
    note:pp==null?'':(pp%2?'Odd page count: printers need an even count.':'')+(lsiOpen?' LSI will count '+(pp+2)+'pp (last page not blank).':'')};
  const ct=(typeof distTrim==='function')?distTrim(t):null, pt=lr?trimOf(lr.trim_mm):null;
  let tok=null; if(ct&&pt){ const a=[ct.wMm,ct.hMm], b=pt; tok=(Math.abs(a[0]-b[0])<=0.5&&Math.abs(a[1]-b[1])<=0.5)||(Math.abs(a[0]-b[1])<=0.5&&Math.abs(a[1]-b[0])<=0.5); }
  f.trim={pdf:pt, comm:ct, raw:c.trimSize, ok:tok};
  const ic=pnum(c.illosCount), ip=lr?pnum(lr.illos_pdf):null;
  f.illos={pdf:ip, comm:ic, ok:(ic==null||ip==null)?null:(ic===0?ip===0:Math.abs(ip-ic)<=Math.max(1,ic*0.10))};
  return f;
}

// ── r97 (09-11): proof-query verdict line, category chips, group bulk marks + undo ──
const statusKey=r=>r.status==="Won't fix"?'wontfix':String(r.status||'Open').toLowerCase();
function ddmmyyyy(){ const d=new Date(), p=n=>String(n).padStart(2,'0'); return p(d.getDate())+'-'+p(d.getMonth()+1)+'-'+d.getFullYear(); }
// Line at the top of the section, read from the latest run row: summary leads with the verdict
// ("UP TO DATE vs proof queries (...)" or "NOT CONFIRMED: <reasons>"), notes_file lists the files.
function pckProofLine(lr){
  if(!lr) return '';
  const lead=String(lr.summary||'').split(' | ')[0], m=/^(UP TO DATE|NOT CONFIRMED)\b/.exec(lead); if(!m) return '';
  const ok=m[1]==='UP TO DATE', tot=pnum(lr.corr_total), cin=pnum(lr.corr_in);
  const miss=/(\d+) MISSING/.exec(lead), eye=/(\d+) not machine-checked/.exec(lead);
  const counts=(tot==null?'':tot+' item'+(tot===1?'':'s')+': <b>'+(cin==null?0:cin)+' IN</b> / <b>'+(miss?miss[1]:0)+' MISSING</b> / <b>'+(eye?eye[1]:Math.max(0,tot-(cin||0)-(miss?+miss[1]:0)))+' check by eye</b>');
  const files=String(lr.notes_file||'').split('; ').filter(Boolean).map(x=>{ const k=/^(.*?)(\s*\(.*\))?$/.exec(x); return '<b>'+e(k[1])+'</b>'+e(k[2]||''); }).join(' + ');
  const pdf=lr.export_file?'<b>'+e(lr.export_file)+'</b> ('+e(dm(lr.export_date))+')':'';
  const why=ok?'':'<b>Reason: '+e(lead.replace(/^NOT CONFIRMED:\s*/,''))+'.</b> Re-export and re-run. ';
  return `<div class="pck-pq ${ok&&!(miss&&+miss[1])?'ok':'f'}" role="status"><span class="big">${ok?'✔':'✖'} PROOF QUERIES: ${m[1]}</span>
    <span class="txt">${why}${pdf}${files?' · '+files:''}${counts?`<small>${ok?'':'Last result, may be stale: '}${counts}</small>`:''}</span></div>`;
}
function pckShort(l){ if(l.length<=110) return l; const i=l.lastIndexOf(',',110); return l.slice(0,i>0?i:110)+' …'; }
// ── r98 (09-11): per-page checklist inside grouped findings (Sheet tab "Group Pages") ──
// BPH writes ONLY status / david_note / note_date of a page row. A grouped finding's status is DERIVED
// from its pages: Open until every page is handled (Resolved / Deliberate / Won't fix).
const PCK_PAGES='Group Pages', PCK_LOG='Proof Query Log';
const PCK_WORD={'Resolved':'OK','Deliberate':'Deliberate',"Won't fix":"Won't fix",'Open':'reopened'};
function pgSt(o){ const v=o.status||'Open'; return PCK_STATUSES.includes(v)?v:'Open'; }
function pckIndexPages(){
  const m=new Map(), k=new Map(); pck.pages.forEach(p=>{ k.set(p.key,p); if(!m.has(p.group_id)) m.set(p.group_id,[]); m.get(p.group_id).push(p); });
  m.forEach(a=>a.sort((x,y)=>((pnum(x.page)==null?1e9:pnum(x.page))-(pnum(y.page)==null?1e9:pnum(y.page)))||String(x.page).localeCompare(String(y.page)))); pck.pg=m; pck.pkey=k; }
const grpPages=r=>(r&&pck.pg.get(r.findingId))||[];
function grpState(pg){ const c={'Open':0,'Resolved':0,'Deliberate':0,"Won't fix":0}; pg.forEach(p=>{ c[pgSt(p)]++; });
  const M=pg.length, done=M-c.Open, kinds=PCK_STATUSES.slice(1).filter(x=>c[x]);
  return {c,M,done,st:c.Open?'Open':(kinds.length===1?kinds[0]:'Resolved'),mix:kinds.map(x=>c[x]+' '+x).join(' · ')}; }
// group row status follows its pages. Returns true if it changed.
function pckSyncGroup(r){ const pg=grpPages(r); if(!pg.length) return false; const st=grpState(pg).st; if(r.status===st) return false; r.status=st; return true; }
function pckNormGroups(){ pck.rows.forEach(r=>{ if(grpPages(r).length) pckSyncGroup(r); }); } // in memory only; the Sheet is corrected on David's next mark
// items governed by a bulk action: a grouped row = its pages, any other row = itself
const itId=i=>i.t==='page'?i.o.key:i.o.findingId;
function pckItems(t,sc){
  const rows=rowsFor(t);
  if(sc.fid){ const r=rows.find(x=>x.findingId===sc.fid); return r?grpPages(r).map(p=>({t:'page',o:p,g:r})):[]; }
  const out=[]; rows.filter(r=>r.category===sc.cat && !isMerged(r) && (grpPages(r).length||!isAutoClosed(r))).forEach(r=>{ const pg=grpPages(r); if(pg.length) pg.forEach(p=>out.push({t:'page',o:p,g:r})); else out.push({t:'row',o:r}); });
  return out; }
function pckTargets(tid,sc,mode,status){
  const u=U(tid); let its=pckItems(getTitle(tid),sc);
  its=status==='Open'?its.filter(i=>pgSt(i.o)!=='Open'):its.filter(i=>pgSt(i.o)==='Open');
  return mode==='ticked'?its.filter(i=>u.ticks.has(itId(i))):its; }
function pckTick(tid,id,on){ const u=U(tid); if(on) u.ticks.add(id); else u.ticks.delete(id); pckRender(tid,true); }
function pckCat(tid,k){ const u=U(tid); u.cat=k; pckRender(tid,true); }
function pckTogglePages(tid,fid){ const u=U(tid); if(u.open.has(fid)) u.open.delete(fid); else u.open.add(fid); pckRender(tid,true); }
function pckHideHandled(tid,fid){ const u=U(tid); if(u.hide.has(fid)) u.hide.delete(fid); else u.hide.add(fid); pckRender(tid,true); }
function pckVpToggle(tid,on){ U(tid).vp=!!on; }
function pckGroupSetAll(tid,sel){ const v=sel.value, fid=sel.dataset.k; sel.value=''; if(v) pckBulkAsk(tid,'group',v,fid); }
// the Sheet write for a set of rows: status + david_note + note_date (same three cells pckMark writes)
function pckRowsWriteData(rs){ return rs.map(r=>({range:cellRange(PCK_TAB,pck.fH,r._row,['status','david_note','note_date']),values:[[r.status||'',r.david_note||'',r.note_date||'']]})); }
function pckPagesWriteData(ps){ return ps.map(p=>({range:cellRange(PCK_PAGES,pck.pH,p._row,['status','david_note','note_date']),values:[[p.status||'',p.david_note||'',p.note_date||'']]})); }
// guard: re-read column A of each tab; abort (writing nothing) if any row no longer holds the key we expect
async function pckWriteMulti(ps,rs){
  if(devMode||(!ps.length&&!rs.length)) return;
  const bad=()=>{ const x=new Error('the tab changed under us, so BPH re-read it. Nothing was saved: try again'); x.stale=true; return x; };
  if(ps.length){ const col=await sheetsGet(CFG.TITLES_SHEET_ID,"'"+PCK_PAGES+"'!A1:A20000"); if(ps.some(p=>!col[p._row-1]||col[p._row-1][0]!==p.key)) throw bad(); }
  if(rs.length){ const col=await sheetsGet(CFG.TITLES_SHEET_ID,"'"+PCK_TAB+"'!A1:A5000"); if(rs.some(r=>!col[r._row-1]||col[r._row-1][0]!==r.findingId)) throw bad(); }
  const data=pckPagesWriteData(ps).concat(pckRowsWriteData(rs)); for(let i=0;i<data.length;i+=500) await valuesBatch(data.slice(i,i+500));
}
let undoT=null;
function pckToast(msg,undoFn){
  let el=document.getElementById('pck-undo'); if(!el){ el=document.createElement('div'); el.id='pck-undo'; el.className='pck-toast'; el.setAttribute('role','status'); document.body.appendChild(el); }
  el.innerHTML='<span></span>'; el.firstChild.textContent=msg;
  if(undoFn){ const a=document.createElement('button'); a.type='button'; a.textContent='Undo'; a.onclick=()=>{ el.classList.remove('show'); undoFn(); }; el.appendChild(a); }
  el.classList.add('show'); clearTimeout(undoT); undoT=setTimeout(()=>el.classList.remove('show'),20000);
}
// one page's mark (status / note), debounced; the group row follows (derived) and is written with it
const pmTimers={};
function pckPageMark(tid,key,field,value){
  const p=pck.pkey.get(key); if(!p) return; const g=pck.rows.find(x=>x.findingId===p.group_id);
  p[field]=value; p.note_date=nowStamp().slice(0,10);
  if(field==='status' && g && pckSyncGroup(g)){ g.note_date=p.note_date; g._dirty=true; }
  const el=()=>document.getElementById('pck-psv-'+cssId(key)); if(el()) el().textContent='saving…';
  if(field==='status') pckRender(tid,true);
  clearTimeout(pmTimers[key]);
  pmTimers[key]=setTimeout(async()=>{
    try{ await pckWriteMulti([p],g&&g._dirty?[g]:[]); if(g) g._dirty=false; const s=el(); if(s) s.textContent='✓ saved '+dm(nowStamp())+(devMode?' (preview)':''); }
    catch(err){ const s=el(); if(s) s.textContent='not saved'; showReconnect('Page mark not saved: '+(err.message||err), isAuthFailure(err)); if(err.stale) pckReload(tid); }
  }, field==='status'?150:800);
}
function pckBulkAsk(tid,mode,status,fid){ // status: 'Resolved' (shown as OK) | 'Deliberate' | "Won't fix" | 'Open' (reopen); fid = one grouped finding, else the selected category
  const u=U(tid), t=getTitle(tid), sc=fid?{fid}:{cat:u.cat}, all=pckItems(t,sc), tg=pckTargets(tid,sc,mode,status); if(!tg.length) return;
  const word=PCK_WORD[status], re=status==='Open', M=all.length, done=all.filter(i=>pgSt(i.o)!=='Open').length, after=re?done-tg.length:done+tg.length;
  const unit=all.every(i=>i.t==='page')?'page':all.some(i=>i.t==='page')?'item':'row', n=tg.length, pl=(k,w)=>k+' '+w+(k===1?'':'s');
  const gr=fid?rowsFor(t).find(x=>x.findingId===fid):null, gi=gr&&grpInfo(gr), label=gr?(gi?gi.head:gr.problem):sc.cat;
  const ov=document.createElement('div'); ov.className='pck-modal-bg'; ov.id='pck-modal';
  ov.innerHTML=`<div class="pck-modal" role="dialog" aria-modal="true" aria-labelledby="pck-mh"><h3 id="pck-mh">${re?'Reopen':'Mark'} ${pl(n,unit)}${mode==='ticked'?' you ticked':''}${re?'':' as '+e(word)}?</h3>
    <p>${gr?'Finding':'Category'}: <b>${e(label)}</b>. ${mode==='ticked'?`Only the <b>${pl(n,unit)} you ticked</b> ${n>1?'change':'changes'}.`:`This changes the <b>${pl(n,unit)} ${re?'now handled':'still Open'}</b>.`}</p>
    <p class="pck-sub">${!re&&done?`The <b>${done} already handled</b> are left alone. `:''}After this: <b>${after} of ${M}</b> ${unit}s confirmed${after>=M?', so the finding closes':' and it stays Open'}. Each ${unit} gets the note “bulk: ${re?'reopened':'marked '+e(word)} by David ${ddmmyyyy()}” (existing notes kept). You can undo straight afterwards.</p>
    <div class="row"><button type="button" class="btn" id="pck-mc">Cancel</button><button type="button" class="btn pck-go" id="pck-my">Yes, ${re?'reopen':'mark'} ${n}${re?'':' as '+e(word)}</button></div></div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove(); ov.querySelector('#pck-mc').onclick=close; ov.addEventListener('click',ev=>{ if(ev.target===ov) close(); });
  ov.addEventListener('keydown',ev=>{ if(ev.key==='Escape') close(); }); const go=ov.querySelector('#pck-my'); go.focus();
  go.onclick=()=>{ close(); pckBulkApply(tid,tg,status,sc); };
}
async function pckBulkApply(tid,tg,status,sc){
  const word=PCK_WORD[status], line=status==='Open'?'bulk: reopened by David '+ddmmyyyy():'bulk: marked '+word+' by David '+ddmmyyyy(), today=nowStamp().slice(0,10), u=U(tid);
  const gs=[...new Set(tg.filter(i=>i.g).map(i=>i.g))];
  const snap=o=>({o,status:o.status||'',david_note:o.david_note||'',note_date:o.note_date||''}), prevI=tg.map(i=>snap(i.o)), prevG=gs.map(snap);
  const restore=()=>prevI.concat(prevG).forEach(p=>Object.assign(p.o,{status:p.status,david_note:p.david_note,note_date:p.note_date}));
  tg.forEach(i=>{ const o=i.o; o.status=status; o.david_note=o.david_note?o.david_note+'\n'+line:line; o.note_date=today; u.ticks.delete(itId(i)); });
  const gch=gs.filter(g=>pckSyncGroup(g)); gch.forEach(g=>{ g.note_date=today; }); // the group row follows its pages
  const isPg=o=>o.group_id!=null && pck.pkey.get(o.key)===o;
  const wr=(prev,extra)=>[prev.filter(p=>isPg(p.o)).map(p=>p.o), prev.filter(p=>!isPg(p.o)).map(p=>p.o).concat(extra)];
  pckRender(tid,true);
  try{ const [ps,rs]=wr(prevI,gch); await pckWriteMulti(ps,rs); }
  catch(err){ restore(); pckRender(tid,true); showReconnect('Bulk mark not saved: '+(err.message||err), isAuthFailure(err)); if(err.stale) pckReload(tid); return; }
  const its=pckItems(getTitle(tid),sc), done=its.filter(i=>pgSt(i.o)!=='Open').length, unit=its.every(i=>i.t==='page')?'page':'item', n=tg.length;
  pckToast(n+' '+unit+(n>1?'s':'')+(status==='Open'?' reopened':' marked '+word)+(devMode?' (preview, not written)':'')+'. '+done+' of '+its.length+' confirmed'+(done>=its.length?', all handled.':'.'),async()=>{
    restore(); pckRender(tid,true);
    try{ const [ps,rs]=wr(prevI,prevG.map(p=>p.o)); await pckWriteMulti(ps,rs); pckToast('Undone: '+n+' '+unit+(n>1?'s':'')+' restored.'); }
    catch(err){ showReconnect('Undo not saved: '+(err.message||err), isAuthFailure(err)); if(err.stale) pckReload(tid); } });
}
// page checklist under a grouped row
function pckPagesHtml(tid,g){
  const u=U(tid), pg=grpPages(g), S=grpState(pg), fid=g.findingId, hide=u.hide.has(fid), op=S.M-S.done, dis=n=>n?'':' disabled';
  const tk=pg.filter(p=>pgSt(p)==='Open'&&u.ticks.has(p.key)).length, k=e(fid);
  const lines=pg.filter(p=>!hide||pgSt(p)==='Open').map(p=>{ const st=pgSt(p), key=e(p.key), msg=String(p.message||'').replace(/^p\d+:\s*/,'');
    return `<div class="pck-pgln ${st==='Open'?'o':st==='Deliberate'?'d':st==="Won't fix"?'w':'r'}"><span class="cb">${st==='Open'?`<input type="checkbox" aria-label="Tick page ${e(p.page)}" data-k="${key}" data-f="tick" ${u.ticks.has(p.key)?'checked':''} onchange="pckTick('${tid}',this.dataset.k,this.checked)">`:''}</span>
      <span class="pp">PDF p${e(p.page)}</span><span class="msg" title="${e(p.auto_note||'')}">${e(msg)}</span>
      <select class="pck-sel" aria-label="Status of page ${e(p.page)}" data-k="${key}" data-f="st" onchange="pckPageMark('${tid}',this.dataset.k,'status',this.value)">${PCK_STATUSES.map(x=>`<option${x===st?' selected':''}>${e(x)}</option>`).join('')}</select>
      <input class="pck-pnote" type="text" placeholder="note (optional)" aria-label="Note for page ${e(p.page)}" data-k="${key}" data-f="note" value="${e(p.david_note||'')}" oninput="pckPageMark('${tid}',this.dataset.k,'david_note',this.value)"><span class="pck-saved" id="pck-psv-${cssId(p.key)}">${p.note_date?'saved '+e(dm(p.note_date)):''}</span></div>`; }).join('');
  return `<div class="pck-pgs"><div class="pck-pgh"><span><b>${S.done} of ${S.M}</b> pages confirmed</span><span class="pck-prog"><i style="width:${Math.round(S.done/S.M*100)}%"></i></span>${S.done?`<span class="pck-sub">${e(S.mix)}${op?' · '+op+' still open':''}</span>`:''}<span class="pck-grow"></span>
    <span class="pck-sub">Mark all <u>open</u> pages:</span><button type="button" class="btn pck-go" data-k="${k}" onclick="pckBulkAsk('${tid}','group','Resolved',this.dataset.k)"${dis(op)}>OK (${op})</button><button type="button" class="btn" data-k="${k}" onclick="pckBulkAsk('${tid}','group','Deliberate',this.dataset.k)"${dis(op)}>Deliberate (${op})</button>
    <span class="pck-sub">or tick pages, then</span><button type="button" class="btn pck-go" data-k="${k}" onclick="pckBulkAsk('${tid}','ticked','Resolved',this.dataset.k)"${dis(tk)}>OK ticked (${tk})</button><button type="button" class="btn" data-k="${k}" onclick="pckBulkAsk('${tid}','ticked','Deliberate',this.dataset.k)"${dis(tk)}>Deliberate ticked (${tk})</button>
    ${S.done?`<button type="button" class="pck-link" data-k="${k}" onclick="pckHideHandled('${tid}',this.dataset.k)">${hide?'Show':'Hide'} handled pages</button>`:''}</div>
    <div class="pck-pgbox" data-gid="${k}" tabindex="0" aria-label="Pages of this finding">${lines||'<div class="pck-na">Every page is handled.</div>'}</div></div>`;
}

// ── r98: "Verified against proof queries (N)" panel, from Sheet tab "Proof Query Log" ──
function pckProofPanel(t,lr,tid){
  if(!lr) return ''; const k=isbnKey(t);
  const rs=pck.log.filter(l=>(l.isbn===k||l.title_id===t.id) && l.run_id===lr.run_id); if(!rs.length) return '';
  const rank=x=>x==='MISSING'?0:x==='CHECK BY EYE'?1:x==='not checked'?2:x==='IN'?3:2, n=x=>pnum(x)==null?1e9:pnum(x);
  rs.sort((a,b)=>rank(a.result)-rank(b.result)||String(a.source_file).localeCompare(String(b.source_file))||n(a.item_no)-n(b.item_no));
  const c={}; rs.forEach(l=>{ c[l.result]=(c[l.result]||0)+1; });
  const chip=r=>{ const cls=r==='IN'?'in':r==='MISSING'?'miss':r==='CHECK BY EYE'?'eye':'nc'; return `<span class="pck-vchip ${cls}">${e(r||'not checked')}</span>`; };
  const sm=[['MISSING','missing'],['CHECK BY EYE','check by eye'],['not checked','not checked'],['IN','IN']].filter(x=>c[x[0]]).map(x=>`<b>${c[x[0]]}</b> ${x[1]}`).join(' · ');
  const rows=rs.map(l=>{ const hot=l.result==='MISSING'||l.result==='CHECK BY EYE';
    const loc=(l.proof_page?'proof p'+e(l.proof_page):'no proof page')+' → '+(l.pdf_page?'PDF p'+e(l.pdf_page):'<i>no page</i>');
    const what=l.quote?'“'+e(l.quote)+'”':'', ent=l.entry?`<div class="en">Entry: <b>${e(l.entry)}</b></div>`:'';
    return `<div class="pck-vq${hot?' hot':''}"><span class="no">#${e(l.item_no)}</span><div class="bd"><div class="q">${what||'<i>(no quote)</i>'}</div>${ent}<div class="mt"><span class="loc">${loc}</span> · <span class="sf">${e(l.source_file)}</span>${l.david_addition?` · <span class="da">David’s addition: ${e(l.david_addition)}</span>`:''}</div>${l.detail?`<div class="dt">${e(l.detail)}</div>`:''}</div>${chip(l.result)}</div>`; }).join('');
  return `<details class="pck-vp"${U(tid).vp?' open':''} ontoggle="pckVpToggle('${tid}',this.open)"><summary><b>Verified against proof queries (${rs.length})</b> <span class="pck-vsum">${sm}</span></summary><div class="pck-vlist">${rows}</div></details>`;
}

// ── render ──
function pckSectionHtml(t){ return `<div class="pck" id="pck-${t.id}"><div class="po-empty">Loading print checks…</div></div>`; }
async function pckOpen(tid){ await pckLoad(); pckRender(tid); }
function pckRender(tid,keep){
  const box=document.getElementById('pck-'+tid), t=getTitle(tid); if(!box||!t) return;
  if(pck.err){ box.innerHTML=`<div class="po-empty">Print checks could not be read: ${e(pck.err)}</div><button class="btn btn-sm" onclick="pckReload('${tid}')">Try again</button>`; return; }
  if(!pck.loaded){ box.innerHTML='<div class="po-empty">Loading print checks…</div>'; return; }
  const snapScroll=[...box.querySelectorAll('.pck-pgbox')].map(b=>[b.dataset.gid,b.scrollTop]), ae=document.activeElement, snapFocus=ae&&box.contains(ae)&&ae.dataset&&ae.dataset.f?[ae.dataset.k,ae.dataset.f]:null;
  const u=U(tid), rows=rowsFor(t), runs=runsFor(t), lr=runs[runs.length-1]||null, c=t.commercial||{}, fl=pckFlags(t,lr);
  const lastOkIdx=runs.map(r=>r.verdict).lastIndexOf('OK');
  const sel=runs.find(r=>r.run_id===u.runSel)||lr;
  const cnt={all:rows.length,open:0,deliberate:0,resolved:0,wontfix:0};
  rows.forEach(r=>{ const k=r.status==="Won't fix"?'wontfix':String(r.status||'').toLowerCase(); if(k in cnt) cnt[k]++; });
  const byYou=rows.filter(r=>r.status==='Resolved'&&!isAutoClosed(r)&&!isMerged(r)).length, auto=rows.filter(isAutoClosed).length, mergedN=rows.filter(isMerged).length;
  const flag=(ok,txt)=>ok===null||ok===undefined?`<span class="pck-na">${txt||'no run yet'}</span>`:(ok?'<span class="pck-ok">✓ same</span>':'<span class="pck-bad">⚠ differs</span>');
  // settings
  const isb=[c.isbnPbk?e(c.isbnPbk)+' <small>pbk</small>':'',c.isbnEbk?e(c.isbnEbk)+' <small>ebk</small>':'',c.isbnHbk?e(c.isbnHbk)+' <small>hbk</small>':''].filter(Boolean).join(' · ')||'<span class="pck-na">none</span>';
  const trimTxt=a=>a?(Array.isArray(a)?a[0]+' × '+a[1]:Math.round(a.wMm*10)/10+' × '+Math.round(a.hMm*10)/10)+' mm':'';
  const settings=`<div class="pck-sgrid">
    <div class="pck-sf ${fl.pages.ok===false?'bad':''}"><span class="l">Pages</span><span class="v">PDF <b>${fl.pages.pdf==null?'–':fl.pages.pdf}</b> · Commercial <b>${fl.pages.comm==null?e(c.pages||'–'):fl.pages.comm}</b></span>${flag(fl.pages.pdf==null||fl.pages.comm==null?null:fl.pages.ok, fl.pages.pdf==null?'no run yet':'Commercial has no number')}${fl.pages.note?`<span class="pck-sub">${e(fl.pages.note.trim())}</span>`:''}</div>
    <div class="pck-sf ${fl.trim.ok===false?'bad':''}"><span class="l">Trim size</span><span class="v">PDF <b>${fl.trim.pdf?trimTxt(fl.trim.pdf):'–'}</b> · Commercial <b>${fl.trim.comm?trimTxt(fl.trim.comm):e(c.trimSize||'–')}</b></span>${flag(fl.trim.ok, !fl.trim.pdf?'no run yet':'Commercial trim unreadable')}<span class="pck-sub">within 0.5 mm, either way round</span></div>
    <div class="pck-sf"><span class="l">ISBNs</span><span class="v pck-isbn">${isb}</span></div>
    <div class="pck-sf"><span class="l">Interior</span>${segHtml(tid,c.interior||'')}</div>
    <div class="pck-sf"><span class="l">Human Authored</span><label class="pck-tick"><input type="checkbox" ${c.humanAuthored===true?'checked':''} onchange="pckSetField('${tid}','humanAuthored',this.checked)"> required</label></div>
    <div class="pck-sf ${fl.illos.ok===false?'warn':''}"><span class="l">Illos number</span><span class="v"><input class="pck-inp" type="number" min="0" value="${e(c.illosCount||'')}" placeholder="blank" onchange="pckSetField('${tid}','illosCount',this.value)"> · PDF <b>${fl.illos.pdf==null?'–':'~'+fl.illos.pdf}</b></span>${fl.illos.ok===false?'<span class="pck-warn">⚠ more than ~10% off (a guide)</span>':flag(fl.illos.ok, c.illosCount===''||c.illosCount==null?'blank: no flag':'no run yet')}<span class="pck-sub">Commercial text: “${e(c.illustrationsText||'–')}”</span></div>
  </div>`;
  // colour pages
  const P=lr?pnum(lr.page_count):null, cpN=lr?pnum(lr.colour_pages):null, cpL=lr?(lr.colour_page_list||''):'';
  const runAt=lr?dm(lr.export_date).slice(6):'';
  let cpages='';
  const iv=c.interior||'';
  if(!lr) cpages=`<div class="pck-cp-row"><span class="pck-na">Colour pages: no run yet.</span></div>`;
  else if(iv==='Mixed') cpages=`<div class="pck-cp-row"><span class="k">Colour pages</span><b>${cpN==null?'–':cpN}${P?' of '+P:''}</b></div>
      <div class="pck-cp-row"><span class="k">Page list</span><span class="pck-list">${cpL?'pp '+e(cpL):'none found'}</span>${cpL?`<button type="button" class="btn btn-sm" onclick="pckCopyColour('${tid}',this)">⧉ Copy for printer quote</button>`:''}</div>
      <div class="pck-cp-row"><span class="k">Mono pages</span><b>${P!=null&&cpN!=null?P-cpN:'–'}</b><span class="pck-sub">from the ${e(runAt)} run · re-runs update it</span></div>`;
  else if(iv==='Colour') cpages=`<div class="pck-cp-row"><span class="k">Colour pages</span><b>all ${P||''}</b><span class="pck-sub">whole book printed in colour · no mono check</span></div>`;
  else if(cpN) cpages=`<div class="pck-cp-row pck-cp-flag">⚠️ Colour in a ${iv==='Mono'?'Mono':'mono'} book: <b>${cpN} page${cpN>1?'s':''}</b> <span class="pck-list">pp ${e(cpL)}</span> Convert to greyscale, or switch to <b>Mixed</b>.</div>`;
  else cpages=`<div class="pck-cp-row"><span class="k">Colour pages</span><b>${cpN==null?'–':'0'}</b>${cpN==null?'<span class="pck-sub">this run did not report colour pages</span>':`<span class="pck-ok">✓ ${iv==='Mono'?'Mono book, ':''}no colour found in the ${e(runAt)} run</span>`}</div>`;
  if(lr) cpages+=`<div class="pck-printers">${PCK_PRINTER_LINE}</div>`;
  if(!iv) cpages+=`<div class="pck-sub">Interior not set: pick Mono, Colour or Mixed above.</div>`;
  // run strip
  const strip=runs.length?`<div class="pck-hist">${runs.slice(-6).map(r=>{ const i=runs.indexOf(r), ok=r.verdict==='OK', old=!ok&&lastOkIdx>i, cur=r===sel;
      return `<button type="button" class="pck-run ${ok?'ok':'f'}${old?' old':''}${cur?' cur':''}" onclick="pckSelRun('${tid}','${e(r.run_id)}')" title="${old?'Superseded by a later OK run. ':''}${e(pdfPath(r))}${r.pdf_sha256?' · fingerprint '+e(String(r.pdf_sha256).slice(0,8)):''} · click to see this run's full result"><span class="dot"></span><span class="rt">${e(dm(r.export_date))} <i>${ok?'OK':'FAIL'}</i></span><span class="rs">${e(r.export_file)} · ${e(r.source||'PC')}<br>${e(r.summary||'')}</span></button>`; }).join('')}</div>
    ${sel?pckFileLine(tid,sel):''}
    <div class="pck-key">Green = OK / ready. Red = fail. Greyed = a fail already superseded by a later OK run (still clickable).</div>`
    :`<div class="po-empty">No print checks for this title yet. Run one on the PC (drag the PDF onto <b>Desktop\\Print PDF Check.bat</b>) or in the browser (button below).</div>`;
  // verdict
  const openN=cnt.open;
  const verdict=lr?`<div class="pck-verdict ${lr.verdict==='OK'?'ok':'f'}"><span class="big">${lr.verdict==='OK'?'✔ READY TO UPLOAD':'✖ NOT READY'}</span>
     <span class="txt">${e(lr.fail_count||0)} failure${lr.fail_count==='1'?'':'s'}. ${openN} open · ${cnt.deliberate} Deliberate · ${byYou} resolved by you · ${auto} confirmed fixed by re-runs${cnt.wontfix?' · '+cnt.wontfix+" won't fix":''}${mergedN?' · '+mergedN+' merged into grouped rows':''}.</span>
     <span class="when">${e(lr.export_file)}<br>checked ${e(dm(lr.run_at))} ${lr.source==='BPH'?'in the browser':'on the PC'}</span></div>`:'';
  // queue banner
  let qb='';
  if(u.queue.length){ const f=u.queue[0].json.run; qb=`<div class="pck-queued"><span class="big">⏳ PC check waiting to sync</span><span class="txt">${u.queue.length} run${u.queue.length>1?'s':''} from <b>${e(dm(f.run_at))}</b> (${e(f.export_file)}) saved on this PC. The PC's Google sign-in had expired, so it couldn't write here.</span><button type="button" class="btn btn-primary" onclick="pckImportQueue('${tid}')">Import now</button></div>`; }
  // r96 (David 04-11): proper button + status note under it, in the action grid
  const qline=window.showDirectoryPicker?`<button type="button" class="btn" onclick="pckScanQueue('${tid}',true)">${u.qState==='need'||!u.qState?'⌕ Look for waiting PC checks':'↻ Look again'}</button>${u.qMsg?`<span class="pck-qmsg ${u.qMsg.k}" role="status">${e(u.qMsg.t)}</span>`:''}`:'';
  // table
  const groups=[['Needs you','open','yellow = open',r=>r.status==='Open'],['Deliberate','deliberate','your call, never flagged again',r=>r.status==='Deliberate'],["Won't fix",'wontfix','like Deliberate, grey',r=>r.status==="Won't fix"],
    ['Resolved by you','resolved',"includes check-by-eye items the checker can't confirm itself",r=>r.status==='Resolved'&&!isAutoClosed(r)&&!isMerged(r)],['Confirmed fixed by a re-run','resolved','closed automatically, kept as the record',r=>isAutoClosed(r)],
    ['Merged into a grouped row','resolved','old one-row-per-page findings, now counted in one grouped row above; kept as the record',r=>isMerged(r)]];
  const ord=r=>{ const g=grpInfo(r); if(g) return g.first; const n=parseInt(String(r.page).replace(/\D.*$/,''),10); return isNaN(n)?99999:n; };
  let body='';
  groups.forEach(([lab,key,sub,fn])=>{ if(u.filter!=='all'&&u.filter!==key) return; const rs=rows.filter(fn).filter(r=>u.cat==='all'||r.category===u.cat).sort((a,b)=>ord(a)-ord(b)); if(!rs.length) return;
    const mg=fn===isMerged||lab==='Merged into a grouped row';
    body+=`<tr class="grp"><td colspan="7">${e(lab)} <span>· ${e(sub)}</span>${mg?` <button type="button" class="pck-link pck-mtog" onclick="pckShowMerged('${tid}')">${u.showMerged?'Hide':'Show'} ${rs.length}</button>`:''}</td></tr>`;
    if(mg && !u.showMerged) return;
    rs.forEach(r=>{ const cls=r.status==='Open'?'s-open':r.status==='Deliberate'?'s-deliberate':r.status==="Won't fix"?'s-wontfix':isAutoClosed(r)?'s-auto':'s-resolved'; const fid=r.findingId, cid=cssId(fid);
      const g=grpInfo(r);
      const auto=/^merged into grouped row/.test(r.auto_note)?'<span class="k g">MERGED</span>':/^confirmed fixed|^gone/.test(r.auto_note)&&r.status!=='Open'?'<span class="k">FIXED</span>':/^still present|^new in/.test(r.auto_note)&&r.status==='Open'?'<span class="k r">'+(/^new/.test(r.auto_note)?'NEW':'STILL HERE')+'</span>':'';
      const gone=isAutoClosed(r)||(r.status==='Resolved'&&r.last_seen!==r.export_date);
      const gpg=grpPages(r), GS=gpg.length?grpState(gpg):null, tickable=u.cat!=='all' && r.status==='Open' && !GS;
      const stCell=GS?`<span class="pck-pill ${GS.done===0?'open':GS.done>=GS.M?'res':'part'}">${GS.done===0?'OPEN':GS.done>=GS.M?'CLOSED':'PARTIAL'}</span><div class="pck-sub">${GS.done>=GS.M?e(GS.mix):'<b>'+GS.done+' of '+GS.M+'</b> pages'}</div><select class="pck-sel pck-setall" aria-label="Mark all open pages" data-k="${e(fid)}" onchange="pckGroupSetAll('${tid}',this)"><option value="">Mark all…</option><option value="Resolved">All open: OK</option><option value="Deliberate">All open: Deliberate</option><option value="Won't fix">All open: Won't fix</option>${GS.done?'<option value="Open">Reopen all handled</option>':''}</select>`:null;
      body+=`<tr class="${cls}"><td>${stCell||''}${GS?'':`${tickable?`<label class="pck-cb"><input type="checkbox" aria-label="Tick this row" data-k="${e(fid)}" ${u.ticks.has(fid)?'checked':''} onchange="pckTick('${tid}',this.dataset.k,this.checked)"> tick</label>`:''}<select class="pck-sel" aria-label="Status" onchange="pckMark('${e(fid)}','status',this.value,'${tid}')">${PCK_STATUSES.map(s=>`<option${s===r.status?' selected':''}>${e(s)}</option>`).join('')}</select>`}</td>
        <td class="pg">${g?`<span class="pck-ppb" title="${e(g.n)} pages, grouped into one row">${e(g.n)} pp</span><span class="pdfp">grouped</span>`:`<b>${/^\d+$/.test(r.page)?'p'+e(r.page):e(r.page)}</b>`}${r.pdf_page?`<span class="pdfp">PDF p${e(r.pdf_page)}</span>`:''}</td>
        <td>${e(r.category)}<br><span class="src">${e(r.source)}${r.by_eye==='TRUE'?' · by eye':''}</span></td>
        <td>${g?`<div class="ent">${e(g.head)}</div>${g.worst?`<div class="pck-worst">Worst: <b>${e(g.worst)}</b>${g.worstList.length>1?` <span class="muted">· next: ${e(g.worstList.slice(1,4).join(', '))}${g.worstList.length>4?' …':''}</span>`:''}</div>`:''}<div class="pck-pplist">pp ${e(pckShort(g.list.replace(/-/g,'–')))}</div>${gpg.length?`<button type="button" class="pck-pgtog" aria-expanded="${u.open.has(fid)}" data-k="${e(fid)}" onclick="pckTogglePages('${tid}',this.dataset.k)">${u.open.has(fid)?'▾ Hide':'▸ Check'} ${gpg.length} pages</button>`:`<details class="pck-pgl"><summary>All ${e(g.n)} pages</summary><span>pp ${e(g.list.replace(/-/g,'–'))}</span></details>`}${g.rest.length?`<div class="muted">${e(pckShort(g.rest.join('; ')))}</div>`:''}`
          :`<div class="ent">${e(r.problem)}</div>${r.detail?`<div class="muted">${e(r.detail)}</div>`:''}`}</td>
        <td class="seen">first ${e(dm(r.first_seen))}<br>${gone?'gone after '+e(dm(r.last_seen)):'last '+e(dm(r.last_seen))}</td>
        <td><textarea class="pck-note" rows="1" placeholder="Type a note… saves by itself" oninput="pckMark('${e(fid)}','david_note',this.value,'${tid}')">${e(r.david_note||'')}</textarea><div class="pck-saved" id="pck-sv-${cid}">${r.note_date?'saved '+e(dm(r.note_date)):''}</div></td>
        <td class="auto">${auto}${e(r.auto_note||'')}</td></tr>`;
      if(gpg.length&&u.open.has(fid)) body+=`<tr class="pck-pgrow"><td colspan="7">${pckPagesHtml(tid,r)}</td></tr>`; }); });
  const fb=(k,l)=>`<button type="button" class="pck-fbtn${u.filter===k?' on':''}" onclick="pckFilter('${tid}','${k}')">${l} <b>${cnt[k]}</b></button>`;
  const catN={}; rows.filter(r=>u.filter==='all'||statusKey(r)===u.filter).forEach(r=>{ const k=r.category||'(none)'; catN[k]=(catN[k]||0)+1; });
  const cats=Object.keys(catN).sort((a,b)=>catN[b]-catN[a]||a.localeCompare(b)); if(u.cat!=='all'&&!(u.cat in catN)) cats.push(u.cat);
  const cb=(k,l,n)=>`<button type="button" class="pck-fbtn${u.cat===k?' on':''}" data-cat="${e(k)}" onclick="pckCat('${tid}',this.dataset.cat)">${e(l)} <b>${n}</b></button>`;
  const catRow=rows.length&&cats.length>1?`<div class="pck-filters" role="group" aria-label="Category"><span class="pck-flab">Category</span>${cb('all','All',Object.values(catN).reduce((a,b)=>a+b,0))}${cats.map(k=>cb(k,k,catN[k]||0)).join('')}</div>`:'';
  let bulk='';
  if(u.cat!=='all'){ const its=pckItems(t,{cat:u.cat}), M=its.length, op=its.filter(i=>pgSt(i.o)==='Open'), dn=M-op.length, tk=op.filter(i=>u.ticks.has(itId(i))).length, unit=its.every(i=>i.t==='page')?'page':its.some(i=>i.t==='page')?'item':'row', pu=unit+(M===1?'':'s');
    if(M){ const st=!dn?['OPEN','open']:dn>=M?['RESOLVED','res']:['PARTIAL','part'], dis=n=>n?'':' disabled';
      bulk=`<div class="pck-bulk"><b>${e(u.cat)} · ${M} ${pu}</b><span class="pck-pill ${st[1]}">${st[0]}</span><span><b>${dn} of ${M}</b> ${unit}s confirmed<span class="pck-prog"><i style="width:${Math.round(dn/M*100)}%"></i></span></span><span class="pck-sub">${op.length} still open</span><span class="pck-grow"></span>
        <span class="pck-sub">Mark all <u>open</u> in category:</span><button type="button" class="btn pck-go" onclick="pckBulkAsk('${tid}','group','Resolved')"${dis(op.length)}>OK (${op.length})</button><button type="button" class="btn" onclick="pckBulkAsk('${tid}','group','Deliberate')"${dis(op.length)}>Deliberate (${op.length})</button>
        <span class="pck-sub">or tick ${unit}s, then</span><button type="button" class="btn pck-go" onclick="pckBulkAsk('${tid}','ticked','Resolved')"${dis(tk)}>OK ticked (${tk})</button><button type="button" class="btn" onclick="pckBulkAsk('${tid}','ticked','Deliberate')"${dis(tk)}>Deliberate ticked (${tk})</button></div>`; } }
  let passes=[]; try{ passes=JSON.parse((sel&&sel.passes_json)||'[]'); }catch(_){}
  const passLine=sel?`<div class="pck-collapsed">✅ Passing in the ${e(dm(sel.export_date))} run, not listed${passes.length?': '+passes.length+' checks':''}. <button type="button" class="pck-link" onclick="pckShowAll('${tid}')">${u.showAll?'Problems only':'Show all checks'}</button></div>
    ${u.showAll?`<div class="pck-passes"><div class="pck-sub">Run ${e(dm(sel.run_at))} · ${e(sel.export_file)} · ${e(sel.verdict)} · ${e(sel.summary||'')}${sel.notes_file?' · notes: '+e(sel.notes_file):''}</div>${passes.length?'<ul>'+passes.map(p=>`<li><b>${e(p.category)}</b> · ${e(p.text)}</li>`).join('')+'</ul>':'<div class="pck-sub">This run has no pass list stored (migrated from an older check sheet).</div>'}</div>`:''}`:'';
  box.innerHTML=`<div class="pck-h"><span class="chip sage">Single point of truth · Sheet tab “Print Checks”</span>${lr?`<span class="chip blue">✓ Synced · last write ${e(dm(lr.run_at))} · ${lr.source==='BPH'?'browser check':'PC check'}</span>`:''}${devMode?'<span class="chip amber">Preview: nothing is written</span>':''}</div>
    ${qb}
    ${pckProofLine(lr)}
    ${pckProofPanel(t,lr,tid)}
    <div class="pck-sec-l">This title's print settings <span>· saved in BPH (Commercial) · flagged when the PDF differs</span></div>
    ${settings}
    <div class="pck-cpages">${cpages}</div>
    <div class="pck-sec-l">Runs <span>· one per check, newest right · click a run to see its full result</span></div>
    ${strip}
    ${verdict}
    ${rows.length?`<div class="pck-filters" role="group" aria-label="Filter"><span class="pck-flab">Status</span>${fb('all','All')}${fb('open','Open')}${fb('deliberate','Deliberate')}${fb('resolved','Resolved')}${fb('wontfix',"Won't fix")}</div>${catRow}${bulk}
    <div class="pck-tbl"><table class="pck-fx"><colgroup><col class="c-st"><col class="c-pg"><col class="c-cat"><col><col class="c-seen"><col class="c-note"><col class="c-auto"></colgroup>
      <thead><tr><th>Status</th><th>Page</th><th>Check</th><th>Finding</th><th>Seen</th><th>Your note</th><th>Auto (re-runs)</th></tr></thead><tbody>${body||'<tr><td colspan="7" class="pck-na">Nothing in this filter.</td></tr>'}</tbody></table></div>`:''}
    ${passLine}
    <div class="pck-foot pck-acts">
      <div class="pck-act"><label class="btn pck-run">▶ RUN CHECK<input type="file" accept="application/pdf" hidden onchange="pckBrowserCheck('${tid}',this)"></label>
        <span class="pck-adesc">Quick check in BPH: page count, trim, ISBN and LSI last page. No ink or colour test.</span></div>
      <div class="pck-act"><button type="button" class="btn" onclick="pckCopyCmd('${tid}',this)">⧉ Copy PC Check</button>
        <span class="pck-adesc">Copies the command for the full PC check (ink, colour, proof corrections), same as the Print PDF Check .bat.</span></div>
      <div class="pck-act"><button type="button" class="btn" onclick="pckXlsx('${tid}')"${rows.length||runs.length?'':' disabled'}>⬇ Download xlsx</button>
        <span class="pck-adesc">A copy to print or send. Mark items here in BPH, not in the sheet.</span></div>
      <div class="pck-act"><label class="btn">Import PC check file…<input type="file" accept=".json,application/json" multiple hidden onchange="pckImportFile('${tid}',this)"></label>
        <span class="pck-adesc">Brings in a PC check that couldn't reach BPH (Google sign-in expired): pick its file.</span></div>
      ${qline?`<div class="pck-act">${qline}
        <span class="pck-adesc">Same as Import, but BPH finds the waiting files in the book's Checks folder for you.</span></div>`:''}
    </div>
    <div class="pck-browser" id="pck-bc-${tid}">${u.bcMsg||''}</div>`;
  snapScroll.forEach(([g,sc])=>{ const b=[...box.querySelectorAll('.pck-pgbox')].find(x=>x.dataset.gid===g); if(b) b.scrollTop=sc; });
  if(snapFocus){ const el=[...box.querySelectorAll('[data-f]')].find(x=>x.dataset.k===snapFocus[0]&&x.dataset.f===snapFocus[1]); if(el) el.focus({preventScroll:true}); }
  if(!keep && window.showDirectoryPicker && !u.qState) pckScanQueue(tid,false);
  if(typeof updateSectionHeaders==='function') updateSectionHeaders(tid);
}
// r95 (David via Thomas 04-11): each run box identifies exactly which PDF it checked. Chrome blocks
// file:// links from an https page, so: full path (hover + expand) and a Copy path button for File Explorer.
function pdfPath(r){ const f=String(r.pdf_folder||'').replace(/[\\/]+$/,''); return f?(f+'\\'+(r.export_file||'')):String(r.export_file||''); }
function fmtBytes(v){ const n=Number(v); if(!isFinite(n)||n<=0) return ''; return n>=1048576?(Math.round(n/104857.6)/10)+' MB':n>=1024?Math.round(n/1024)+' KB':n+' bytes'; }
function pckFileLine(tid,r){
  const path=pdfPath(r), sz=fmtBytes(r.pdf_bytes), fp=String(r.pdf_sha256||'').slice(0,8);
  return `<div class="pck-file"><span class="k">PDF checked</span><b class="nm" title="${e(path)}">${e(r.export_file||'–')}</b>
    <span class="meta">modified ${e(dm(r.export_date)||'–')}${sz?' · '+e(sz):''}${fp?` · fingerprint <code title="sha256 ${e(r.pdf_sha256)}">${e(fp)}</code>`:''}</span>
    ${r.pdf_folder?`<button type="button" class="btn btn-sm" onclick="pckCopyPath('${tid}','${e(r.run_id)}',this)">⧉ Copy path</button>`:''}
    <details class="pck-pgl"><summary>Full path</summary><span>${e(path)}</span></details>
    ${!sz&&!fp?'<span class="pck-sub">Size + fingerprint show once the PC check records them.</span>':''}</div>`;
}
function pckCopyPath(tid,rid,btn){ const r=pck.runs.find(x=>x.run_id===rid); if(!r) return; ctCopyText(pdfPath(r),btn,'Path copied: paste it into the File Explorer address bar'); }
function pckFilter(tid,k){ U(tid).filter=k; pckRender(tid,true); }
function pckShowMerged(tid){ const u=U(tid); u.showMerged=!u.showMerged; pckRender(tid,true); }
function pckShowAll(tid){ const u=U(tid); u.showAll=!u.showAll; pckRender(tid,true); }
function pckSelRun(tid,rid){ const u=U(tid); u.runSel=rid; u.showAll=true; pckRender(tid,true); }
async function pckReload(tid){ pck.loaded=false; pck.err=''; await pckLoad(true); pckRender(tid); }
function pckCopyColour(tid,btn){ const t=getTitle(tid), lr=t&&latestRun(t); if(!lr) return; ctCopyText('Colour pages: '+(lr.colour_pages||0)+' — pp '+(lr.colour_page_list||''),btn,'Copied for the printer quote'); }
function pckCopyCmd(tid,btn){
  const t=getTitle(tid); if(!t) return; const lr=latestRun(t), c=t.commercial||{};
  const folder=(lr&&lr.pdf_folder)||((t.workingFolderLink||'D:\\PROJECTS - BOOKS\\<book folder>')+'\\<print PDFs folder>');
  const pdf=folder+'\\'+((lr&&lr.export_file)||'<print PDF>.pdf');
  const mode=c.interior==='Colour'?' --colour':c.interior==='Mixed'?' --mixed':' --mono';
  const cmd=`python "${PCK_SCRIPT}" "${pdf}"${mode} --ink${c.humanAuthored===true?' --human-authored':''} --title "${t.title}" --check-dir "${folder}\\Checks"`;
  ctCopyText(cmd,btn,'PC check command copied. Or drag the PDF onto Desktop\\Print PDF Check.bat');
}

// ── xlsx export (copy only; never read back) ──
function loadScript(src){ return new Promise((res,rej)=>{ if([...document.scripts].some(s=>s.src===src)) return res(); const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=()=>rej(new Error('could not load '+src)); document.head.appendChild(s); }); }
async function pckXlsx(tid){
  const t=getTitle(tid); if(!t) return;
  try{ await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'); }catch(err){ ctToast('xlsx library did not load'); return; }
  const cols=['status','page','pdf_page','category','problem','detail','by_eye','source','first_seen','last_seen','export_file','david_note','note_date','auto_note','findingId'];
  const rows=rowsFor(t).map(r=>cols.map(k=>r[k]||''));
  const runCols=['run_at','export_file','export_date','source','verdict','fail_count','warn_count','page_count','trim_mm','interior_mode','colour_pages','colour_page_list','illos_pdf','summary'];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols].concat(rows)), 'Print Checks');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([runCols].concat(runsFor(t).map(r=>runCols.map(k=>r[k]||'')))), 'Runs');
  const pgc=['group_id','check','kind','page','message','status','david_note','note_date','auto_note'], gp=[]; rowsFor(t).forEach(r=>grpPages(r).forEach(p=>gp.push(pgc.map(k=>p[k]||''))));
  if(gp.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([pgc].concat(gp)), 'Pages');
  const lgc=['source_file','item_no','proof_page','pdf_page','entry','quote','result','detail','david_addition'], lg=pck.log.filter(l=>(l.title_id===t.id||l.isbn===isbnKey(t))&&latestRun(t)&&l.run_id===latestRun(t).run_id).map(l=>lgc.map(k=>l[k]||''));
  if(lg.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([lgc].concat(lg)), 'Proof queries');
  const lr=latestRun(t); let passes=[]; try{ passes=JSON.parse((lr&&lr.passes_json)||'[]'); }catch(_){}
  if(passes.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['category','passing in the latest run']].concat(passes.map(p=>[p.category,p.text]))), 'Passing');
  const safe=String(t.title||'Book').replace(/[\\/:*?"<>|]+/g,'-');
  XLSX.writeFile(wb, safe+' - Print Checks (BPH copy) - '+nowStamp().slice(0,10)+'.xlsx');
}

// ── browser check (pdf.js): page count, trim, ISBN, LSI last page. Ink/colour stay on the PC. ──
async function pckBrowserCheck(tid,input){
  const t=getTitle(tid), file=input.files&&input.files[0]; input.value=''; if(!t||!file) return;
  const say=h=>{ U(tid).bcMsg=h; const o=document.getElementById('pck-bc-'+tid); if(o) o.innerHTML=h; };
  say('<div class="po-empty">Reading '+e(file.name)+'…</div>');
  try{
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const doc=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    const n=doc.numPages, p1=await doc.getPage(1), v=p1.view, w=(v[2]-v[0])/72*25.4, h=(v[3]-v[1])/72*25.4;
    const c=t.commercial||{}, isbn=isbnKey(t), F=[], passes=[], when=new Date(file.lastModified), pad=x=>String(x).padStart(2,'0');
    const exp=when.getFullYear()+'-'+pad(when.getMonth()+1)+'-'+pad(when.getDate())+' '+pad(when.getHours())+':'+pad(when.getMinutes());
    const cp=pnum(c.pages);
    if(cp==null) passes.push({category:'Page count',text:'PDF has '+n+' pages (Commercial has no number to compare)'});
    else if(cp===n) passes.push({category:'Page count',text:'Page count: '+n+' = Commercial '+cp});
    else F.push({findingId:isbn+'|pages|all|count',check:'pages',category:'Page count / spine',page:'all',problem:'Page count: PDF '+n+' ≠ Commercial '+cp,detail:'browser check',by_eye:false,severity:'FAIL'});
    if(n%2) F.push({findingId:isbn+'|pages|all|odd',check:'pages',category:'Page count / spine',page:'all',problem:'Odd page count ('+n+')',detail:'printers need an even count',by_eye:false,severity:'FAIL'});
    const ct=(typeof distTrim==='function')?distTrim(t):null;
    const okT=(a,b)=>(Math.abs(a[0]-b[0])<=0.5&&Math.abs(a[1]-b[1])<=0.5)||(Math.abs(a[0]-b[1])<=0.5&&Math.abs(a[1]-b[0])<=0.5);
    const tm=(Math.round(w*10)/10).toFixed(1)+' x '+(Math.round(h*10)/10).toFixed(1);
    if(ct){ if(okT([w,h],[ct.wMm,ct.hMm])) passes.push({category:'Trim / bleed',text:'Trim '+tm+'mm = Commercial'});
      else F.push({findingId:isbn+'|trim|all|size',check:'trim',category:'Trim / bleed',page:'all',problem:'Trim: PDF '+tm+' mm ≠ Commercial '+Math.round(ct.wMm)+' x '+Math.round(ct.hMm)+' mm',detail:'browser check reads the page box; a file exported with bleed shows ~6 mm larger',by_eye:false,severity:'FAIL'}); }
    // ISBN on the first pages
    let front=''; for(let i=1;i<=Math.min(10,n);i++){ const tc=await (await doc.getPage(i)).getTextContent(); front+=' '+tc.items.map(x=>x.str).join(' '); }
    const digits=front.replace(/[^0-9X]/gi,''); const want=String(c.isbnPbk||'').replace(/[^0-9X]/gi,'');
    if(want){ if(digits.includes(want)) passes.push({category:'Copyright page',text:'ISBN '+want+' = BPH pbk'});
      else F.push({findingId:isbn+'|isbn|all|pbk-missing',check:'isbn',category:'Copyright page',page:'all',problem:'Pbk ISBN '+c.isbnPbk+' not found on the first pages',detail:'browser check (text only)',by_eye:false,severity:'FAIL'}); }
    const last=await (await doc.getPage(n)).getTextContent();
    if(last.items.some(x=>String(x.str).trim())) F.push({findingId:isbn+'|lsi|p'+n+'|last-page-not-blank',check:'lsi',category:'Page count / spine',page:String(n),problem:'LSI: last page is not blank',detail:'LSI uses the last page for its barcode, so it adds 2 pages (count at LSI = '+(n+2)+').',by_eye:false,severity:'WARN'});
    else passes.push({category:'Page count / spine',text:'LSI: last page is blank'});
    const fails=F.filter(f=>f.severity==='FAIL').length, runAtS=nowStamp(true), runAt=runAtS.slice(0,16);
    const q={schema:'bph-print-checks/1',checks_run:['pages','trim','isbn','lsi'],findings:F,run:{run_id:isbn+'|'+runAtS,title_id:t.id,title:t.title,isbn,run_at:runAt,export_file:file.name,export_date:exp,source:'BPH',verdict:fails?'FAIL':'OK',
      fail_count:String(fails),warn_count:String(F.length-fails),pass_count:String(passes.length),corr_in:'',corr_total:'',page_count:String(n),trim_mm:tm,interior_mode:c.interior||'',colour_pages:'',colour_page_list:'',illos_pdf:'',ink_limit:'',ink_worst:'',
      summary:'browser check: pages, trim, ISBN, LSI last page'+(F.length?' · '+F.map(f=>f.problem).join(' · '):' · all clear'),passes,passes_json:JSON.stringify(passes),script_version:'BPH browser check r95',notes_file:'',pdf_folder:''}};
    const res=await pckMergeRun(q);
    say(`<div class="pck-sub">Browser check done: ${n} pages, ${tm} mm, ${fails} fail${fails===1?'':'s'}. ${res.skipped?' Already recorded.':devMode?' Preview: not written.':' <b>Saved to BPH</b> (Sheet tab “Print Checks”).'} Proof corrections, colour, ink and layout need the PC check.</div>`);
    pckRender(tid,true);
  }catch(err){ say('<div class="po-empty">Browser check failed: '+e(err.message||err)+'</div>'); if(isAuthFailure(err)) showReconnect('Browser check not saved: signed out.',true); }
}

function pckSectionStatus(t){ if(!pck.loaded) return 'partial'; const lr=latestRun(t); if(!lr) return 'partial'; if(lr.verdict!=='OK') return 'overdue'; if(rowsFor(t).some(r=>r.status==='Open')) return 'partial'; return 'complete'; }

Object.assign(window,{pckSectionHtml,pckOpen,pckRender,pckMark,pckFilter,pckShowMerged,pckCopyPath,pckShowAll,pckSelRun,pckReload,pckCopyColour,pckCopyCmd,pckXlsx,pckBrowserCheck,
  pckScanQueue,pckImportQueue,pckImportFile,pckSetField,pckCommercialHtml,pckCat,pckTick,pckBulkAsk,pckRowsWriteData,pckPageMark,pckTogglePages,pckHideHandled,pckVpToggle,pckGroupSetAll,pckProofPanel,pckProofLine,pckSectionStatus,pckLoad,pckMergeRun,_pck:pck});
})();
