/* final-files.js — Book Production Hub, r105 (2026-11-17, Marcus Webb; spec = Mia Chen's mockup "BPH - Final Files and Checks Panel Mockup", David YES x2).
 * "Final Files + Checks" panel, top of the Proofing & Production (Print Checks) section of every title.
 *
 * Data in:
 *   - Scanner output (read-only, from the PC): final_files.json via the local helper (http://127.0.0.1:8744/final_files.json), or the staging preview server
 *     (same origin, http://127.0.0.1:8745). If neither answers (phone, helper off) the panel says so and everything else in BPH works as before.
 *   - Sheet tab "Final Files Log" (APPEND-ONLY): approvals, per-title printers, sent date + PO per printer, proof-list ticks. Never edits or deletes a row;
 *     latest row per key wins. Tab is created on first save (an addition, no other tab touched).
 * Nothing here writes in dev preview (devMode): saves stay in memory so the screen can be tried.
 */
(function(){
'use strict';
const LOG_TAB='Final Files Log', LOG_HEAD=['saved_at','title_id','kind','key','value','note'];
const DEFAULT_PRINTERS=['Biddles','LSI','IBI'], KNOWN_PRINTERS=['Biddles','LSI','IBI'];
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ff={data:null, err:'', loading:null, log:null, logErr:'', mem:[]};
const fu={}; // per-title UI state
const U=id=>fu[id]||(fu[id]={sendOpen:'',edit:false,showList:false,showMatched:false,msg:''});
const E=s=>(typeof esc==='function'?esc(s):String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
function fdt(s){ const m=/^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d:\d\d))?/.exec(String(s||'')); return m?(m[1]+' '+MON[+m[2]-1]+' '+(+m[3])+(m[4]?', '+m[4]:'')):String(s||''); }
function fd(s){ return fdt(String(s||'').slice(0,10)); }
function stamp(){ const d=new Date(), p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
function today(){ return stamp().slice(0,10); }
function cid(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'_'); }

// ── styles (scoped, injected once) ──
(function(){ if(document.getElementById('ff-css')) return; const st=document.createElement('style'); st.id='ff-css'; st.textContent=`
.ff{margin:0 0 14px}
.ff-panel{border:2px solid #111;border-radius:12px;overflow:hidden;background:#fff;color:var(--text,#14130F)}
.ff-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;background:#1B1914;color:#F1EAD9;flex-wrap:wrap}
.ff-head h3{font-size:1rem;margin:0}.ff-fresh{font-size:.78rem;color:#B9AF9B}
.ff-fresh button{margin-left:8px;font:600 .72rem inherit;background:none;color:#F1EAD9;border:1px solid #B9AF9B;border-radius:4px;padding:1px 8px;cursor:pointer}
.ff-bar{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #D2CBB8}
.ff-q{padding:12px 14px;border-right:1px solid #D2CBB8;display:flex;flex-direction:column;gap:3px}.ff-q:last-child{border-right:0}
.ff-q .l{font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6B6459}
.ff-q .v{font-size:1.05rem;font-weight:800}.ff-q .d{font-size:.78rem;color:#4B453C}
.ff-q.ok{background:#E9EEE4}.ff-q.ok .v{color:#2f4f35}.ff-q.warn{background:#FBF0DE}.ff-q.warn .v{color:#7a4a12}
.ff-q.bad{background:#F7E6E1}.ff-q.bad .v{color:#8a3626}.ff-q.none{background:#F4F1E8}.ff-q.none .v{color:#4B453C}
.ff-sec{padding:6px 14px;background:#F4F1E8;font-size:.7rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6B6459;border-bottom:1px solid #E4DFD1}
.ff-row{display:grid;grid-template-columns:170px 1fr auto;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid #E4DFD1}
.ff-row:last-child{border-bottom:0}.ff-row .k{font-weight:700;font-size:.88rem}
.ff-row .m{font-size:.85rem;color:#4B453C;line-height:1.5;min-width:0;overflow-wrap:anywhere}
.ff-row .m code{font-size:.78rem;background:#F4F1E8;padding:1px 5px;border-radius:3px;word-break:break-all}
.ff-sub{color:#6B6459;font-size:.78rem}
.ff-pill{display:inline-block;font-size:.72rem;font-weight:800;letter-spacing:.03em;border-radius:999px;padding:2px 10px;white-space:nowrap}
.ff-ok{background:#E9EEE4;color:#2f4f35;border:1px solid #3F5D42}.ff-warn{background:#FBF0DE;color:#7a4a12;border:1px solid #C98A3E}
.ff-bad{background:#F7E6E1;color:#8a3626;border:1px solid #8a3626}.ff-none{background:#F4F1E8;color:#6B6459;border:1px solid #D2CBB8}
.ff-hand{background:#E6EEF8;color:#2B5AA8;border:1px solid #9DB0D6}
.ff-btn{font:600 .8rem inherit;padding:6px 12px;border-radius:4px;border:1px solid #D2CBB8;background:#fff;color:#4B453C;cursor:pointer;white-space:nowrap}
.ff-btn.go{background:#4B6E53;color:#fff;border-color:#3F5D42}.ff-btn.warn{background:#FBF0DE;color:#7a4a12;border-color:#C98A3E}.ff-btn[disabled]{opacity:.5;cursor:not-allowed}
.ff-hl{background:#FFF200;color:#111;padding:1px 4px;border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.ff-banner{padding:10px 14px;background:#FFF200;color:#111;font-weight:700;font-size:.88rem;border-bottom:2px solid #111}
.ff-proof{max-height:640px;overflow:auto;padding:8px 14px 12px 14px;font-size:.84rem;line-height:1.55;background:#FBFAF4;border-bottom:1px solid #E4DFD1}
.ff-proof label{display:grid;grid-template-columns:22px 1fr;gap:6px;padding:3px 0;border-bottom:1px dotted #E4DFD1;cursor:pointer}
.ff-proof .why{display:block;font-size:.74rem;color:#6B6459}
.ff-proof h4{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:#6B6459;margin:8px 0 2px}
.ff-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 14px;background:#FBFAF4;border-bottom:1px solid #E4DFD1;font-size:.84rem}
.ff-form input[type=text],.ff-form input[type=date]{font:inherit;padding:4px 6px;border:1px solid #D2CBB8;border-radius:4px}
.ff-msg{padding:8px 14px;background:#E6EEF8;color:#2B5AA8;font-size:.82rem;border-bottom:1px solid #9DB0D6}
.ff-empty{padding:14px;font-size:.88rem;color:#4B453C}
@media(max-width:760px){.ff-bar{grid-template-columns:1fr 1fr}.ff-row{grid-template-columns:1fr}}
`; document.head.appendChild(st); })();

// ── data ──
function feedUrls(){ const c=(window.BOOK_HUB_CONFIG||{}); const l=[]; if(location.port==='8745') l.push('/final_files.json'); l.push(c.FINAL_FILES_URL||'http://127.0.0.1:8744/final_files.json'); return l; }
async function ffFetch(force){
  if(ff.data && !force) return ff;
  if(ff.loading && !force) return ff.loading;
  ff.loading=(async()=>{
    ff.err='';
    for(const u of feedUrls()){ try{ const r=await fetch(u,{cache:'no-store'}); if(r.ok){ ff.data=await r.json(); ff.err=''; return ff; } ff.err='scanner data answered '+r.status; }catch(e){ ff.err='scanner data not reachable (the PC helper must be running, and this only works on David\'s PC)'; } }
    return ff; })().finally(()=>{ ff.loading=null; });
  return ff.loading;
}
function fmtRows(vals){ const h=(vals[0]||[]).map(x=>String(x||'').trim()), out=[]; for(let i=1;i<vals.length;i++){ const r=vals[i]; if(!r||!r[1]) continue; const o={}; h.forEach((k,j)=>{ if(k) o[k]=r[j]==null?'':String(r[j]); }); out.push(o); } return out; }
async function ffLoadLog(force){
  if(ff.log && !force) return;
  if(devMode){ ff.log=ff.mem; return; }
  try{ const v=await sheetsGet(CFG.TITLES_SHEET_ID,"'"+LOG_TAB+"'!A1:F20000"); ff.log=fmtRows(v); ff.logErr=''; }
  catch(e){ if(typeof isAuthFailure==='function'&&isAuthFailure(e)){ ff.log=[]; ff.logErr='Sheet not signed in'; } else { ff.log=[]; ff.logErr=''; } } // tab missing = nothing saved yet
}
async function ffAppend(rows){
  const full=rows.map(r=>[stamp(),r.title_id,r.kind,r.key||'',r.value||'',r.note||'']);
  rows.forEach((r,i)=>{ const o={saved_at:full[i][0],title_id:r.title_id,kind:r.kind,key:r.key||'',value:r.value||'',note:r.note||''}; (ff.log=ff.log||[]).push(o); if(devMode) ff.mem=ff.log; });
  if(devMode) return;
  const post=async(url,body)=>withAuthRetry(async()=>{ const resp=await fetch(url,{method:'POST',headers:Object.assign({'Content-Type':'application/json'},await authHeaders()),body:JSON.stringify(body)}); if(resp.status===401) throw new AuthExpiredError('Sheets 401 on Final Files Log'); const j=await resp.json().catch(()=>({})); return {ok:resp.ok,status:resp.status,j}; });
  const appendUrl=SHEETS_API+CFG.TITLES_SHEET_ID+'/values/'+encodeURIComponent("'"+LOG_TAB+"'!A1")+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
  let r=await post(appendUrl,{values:full});
  if(!r.ok && r.status===400){ // tab not there yet: add it (an addition), write the header, retry once
    const c=await post(SHEETS_API+CFG.TITLES_SHEET_ID+':batchUpdate',{requests:[{addSheet:{properties:{title:LOG_TAB}}}]});
    if(!c.ok) throw new Error('could not add the "'+LOG_TAB+'" tab ('+c.status+')');
    await post(appendUrl,{values:[LOG_HEAD]});
    r=await post(appendUrl,{values:full});
  }
  if(!r.ok) throw new Error('Sheets append '+r.status);
}
const rowsFor=tid=>(ff.log||[]).filter(r=>r.title_id===tid);
function latest(tid,kind){ const m=new Map(); rowsFor(tid).filter(r=>r.kind===kind).forEach(r=>m.set(r.key,r)); return m; }
function printersOf(tid){
  const rs=rowsFor(tid).filter(r=>r.kind==='printer_add'||r.kind==='printer_remove');
  let list; if(!rs.length) list=DEFAULT_PRINTERS.slice(); else { list=[]; rs.forEach(r=>{ const i=list.indexOf(r.key); if(r.kind==='printer_add'&&i<0) list.push(r.key); if(r.kind==='printer_remove'&&i>=0) list.splice(i,1); }); }
  const sent=latest(tid,'printer_sent');
  return list.map(n=>{ const s=sent.get(n); return {name:n, sent:s&&s.value?s.value:'', po:s&&s.value?s.note:''}; });
}
function folderFor(tid){
  const fs=((ff.data||{}).folders||[]).filter(f=>f.title_id===tid);
  fs.sort((a,b)=>String(b.candidate.mtime).localeCompare(String(a.candidate.mtime)));
  return fs[0]||null;
}

// ── render ──
function ffSectionHtml(t){ return '<div class="ff" id="ff-'+t.id+'"><div class="ff-empty">Loading Final Files + Checks…</div></div>'; }
async function ffOpen(tid){ await Promise.all([ffFetch(),ffLoadLog()]); ffRender(tid); }
const pillOf=r=>r==='PASS'?['ff-ok','PASS']:r==='FAIL'?['ff-bad','FAIL']:r==='WARN'?['ff-warn','WARN']:r==='CHECK'?['ff-warn','CHECK']:['ff-none',r||'NOTE'];
function ffRender(tid){
  const box=document.getElementById('ff-'+tid), t=(typeof getTitle==='function')?getTitle(tid):null; if(!box||!t) return;
  const u=U(tid);
  if(!ff.data){ box.innerHTML='<div class="ff-panel"><div class="ff-head"><h3>Final Files + Checks</h3></div><div class="ff-empty">'+E(ff.err||'Loading…')+' <button class="ff-btn" onclick="ffRefresh(\''+tid+'\')">Try again</button></div></div>'; return; }
  const f=folderFor(tid);
  const head=(extra)=>'<div class="ff-head"><h3>Final Files + Checks</h3><span class="ff-fresh">'+(extra||'')+'<button type="button" onclick="ffRefresh(\''+tid+'\')">Refresh</button></span></div>';
  if(!f){ box.innerHTML='<div class="ff-panel">'+head('Last scanned '+E(fdt(ff.data.generated_at)))+'<div class="ff-empty">No print PDF found for this title in the project library (looked for a Book_ folder with a print / printer / "PDFs for Print" folder). The scanner tries again every 30 minutes.</div></div>'; return; }
  const c=f.candidate, ck=f.checks||{}, src=f.sources||null, pl=f.proof_list||null, interior=(t.commercial||{}).interior||'';
  const appr=latest(tid,'approve').get(c.sha256||'~none~');
  const printers=printersOf(tid), sentN=printers.filter(p=>p.sent).length;
  const newerPdf=(f.newer_pdfs||[])[0]||null;
  const stale=Object.entries(ck).filter(([k,v])=>!v.on_candidate);
  // 1. top strip
  const rev=c.revision_code?('Rev '+c.revision_code):'';
  const q1=newerPdf?['warn','Newer PDF exists','not the file below']:appr?['ok','Yes'+(rev?' · '+rev:''),'Approved '+fd(appr.saved_at)+', newest PDF']:['none','Not approved yet',(rev?rev+', ':'')+'newest PDF found'];
  const pc=ck.print_pdf, ty=ck.typo;
  const qc=(x,none)=>!x?['none',none,'not run on any file']:!x.on_candidate?['warn','Older file','last run on '+x.file_name.slice(0,34)]:x.result==='PASS'?['ok','PASS',fd(x.run_at)]:x.result==='FAIL'?['bad','FAIL',String(x.detail||'').slice(0,60)||fd(x.run_at)]:['warn',x.result,fd(x.run_at)];
  const q2=qc(pc,'Not run'), q3=qc(ty,'Not run');
  if(ty&&ty.on_candidate&&ty.result==='PASS'){ q3[1]='Yes'; q3[2]='on this file · '+fd(ty.run_at); }
  const q4=!printers.length?['none','No printers set','add one below']:sentN===printers.length?['ok','Sent to '+sentN+' of '+printers.length,printers.map(p=>p.name).join(', ')]:['none','Sent to '+sentN+' of '+printers.length,printers.map(p=>p.name).join(', ')];
  const qh=(l,q)=>'<div class="ff-q '+q[0]+'"><span class="l">'+l+'</span><span class="v">'+E(q[1])+'</span><span class="d">'+E(q[2])+'</span></div>';
  let h='<div class="ff-panel">'+head('Last scanned '+E(fdt(ff.data.generated_at)));
  if(u.msg) h+='<div class="ff-msg">'+E(u.msg)+'</div>';
  if(newerPdf) h+='<div class="ff-banner">A newer PDF exists: <span class="ff-hl">'+E(newerPdf.name)+', modified '+E(fdt(newerPdf.mtime_iso))+'.</span> The checks below ran on an older file.</div>';
  else if(stale.length) h+='<div class="ff-banner">'+E(stale.map(([k])=>k==='print_pdf'?'Print PDF check':k==='typo'?'Typo check':k).join(' and '))+' <span class="ff-hl">ran on an older file</span>, not the final PDF below.</div>';
  h+='<div class="ff-bar">'+qh('Final file?',q1)+qh('Checked?',q2)+qh('Typo-checked?',q3)+qh('Sent?',q4)+'</div>';
  // 2. print final
  h+='<div class="ff-sec">Print final</div>';
  const fileSub=[c.pages?c.pages+' pp':'',c.size?Number(c.size).toLocaleString('en-GB')+' bytes':'','modified '+fdt(c.mtime)].filter(Boolean).join(' · ');
  const apBtn=(!appr&&c.sha256)?'<button class="ff-btn '+(newerPdf?'warn':'go')+'" onclick="ffApprove(\''+tid+'\')">Approve as final</button>':'';
  h+='<div class="ff-row"><span class="k">File</span><span class="m"><b>'+E(c.name)+'</b><br>'+E(fileSub)+'<br><code>'+(c.sha256?'sha256 '+E(c.sha256.slice(0,8))+'…'+E(c.sha256.slice(-7)):'fingerprint pending ('+E(c.hash_status)+')')+'</code> · folder <code>'+E(f.folder.split('\\').slice(-2).join('\\'))+'</code>'+(c.revision_code?' · Revision code on the title page: '+E(c.revision_code):'')+'</span>'+(appr?'<span class="ff-pill ff-ok">APPROVED '+E(fd(appr.saved_at)).toUpperCase()+'</span>':apBtn||'<span class="ff-pill ff-none">NOT APPROVED</span>')+'</div>';
  h+='<div class="ff-row"><span class="k">Newer file?</span><span class="m">'+(newerPdf?'A newer PDF was saved in the same folder: <span class="ff-hl">'+E(newerPdf.name)+', '+E(fdt(newerPdf.mtime_iso))+'</span>.':'This is the newest PDF in the print folder. '+((f.superseded||[]).length?(f.superseded.length+' older export'+(f.superseded.length>1?'s':'')+' sit in OLD.'):''))+'</span><span class="ff-pill '+(newerPdf?'ff-warn':'ff-ok')+'">'+(newerPdf?'NEWER EXISTS':'NEWEST')+'</span></div>';
  if(src){
    const b=src.built_from, newerS=(src.newer_than_pdf||[])[0];
    const bl=b?('<b>'+E(b.name)+'</b> · modified '+E(fdt(b.mtime_iso))+' · '+E(b.app)+(b.in_old?' (in an OLD folder)':'')+'<br><span class="ff-sub">'+E(src.confidence==='likely'?'Likely: ':'Unsure: ')+E(src.reason)+'. PDF made by '+E(src.pdf_creator||'unknown app')+', exported '+E(fdt(src.pdf_created))+'.</span>'):('Could not tell: <span class="ff-sub">'+E(src.reason)+'</span>');
    h+='<div class="ff-row"><span class="k">Built from (source)</span><span class="m">'+bl+(newerS?'<br><span class="ff-hl">A newer source exists: '+E(newerS.name)+', modified '+E(fdt(newerS.mtime_iso))+'</span>':'')+'</span><span class="ff-pill '+(newerS?'ff-warn':b&&src.confidence==='likely'?'ff-ok':b?'ff-warn':'ff-none')+'">'+(newerS?'SOURCE NOT NEWEST':b&&src.confidence==='likely'?'SOURCE MATCHES':b?'UNSURE':'NOT FOUND')+'</span></div>';
    const ns=(src.newest||[]).slice(0,5);
    h+='<div class="ff-row"><span class="k">Newest source files</span><span class="m">'+(ns.length?ns.map((s,i)=>(i+1)+'. '+(i===0?'<b>'+E(s.name)+'</b>':E(s.name))+' · '+E(fdt(s.mtime_iso))+' · '+E(s.app)+(s.in_old?', OLD folder':'')+(i===0?' · <b>newest</b>':'')).join('<br>'):'None found.')+(src.has_indd?'':'<br><span class="ff-sub">No InDesign (.indd) file for this title yet: Affinity files only.</span>')+(src.total>ns.length?'<br><span class="ff-sub">+ '+(src.total-ns.length)+' more, older.</span>':'')+'</span><span class="ff-pill ff-none">'+src.total+' FOUND</span></div>';
  }
  // 3. checks
  h+='<div class="ff-sec">Checks on THIS file</div>';
  const chkRow=(k,x,label,none)=>{ if(!x) return '<div class="ff-row"><span class="k">'+label+'</span><span class="m">'+none+'</span><span class="ff-pill ff-none">NOT RUN</span></div>';
    const p=x.on_candidate?pillOf(x.result):['ff-warn','CHECKED AN OLDER FILE'];
    return '<div class="ff-row"><span class="k">'+label+'</span><span class="m">'+(x.on_candidate?'':'<b>Ran on '+E(x.file_name)+', not this file.</b> ')+E(x.detail||'')+' · '+E(x.by||'')+' · '+E(fdt(x.run_at))+(x.report_link?' · <span class="ff-sub">'+E(x.report_link)+'</span>':'')+'</span><span class="ff-pill '+p[0]+'">'+E(p[1])+'</span></div>'; };
  h+=chkRow('print_pdf',ck.print_pdf,'Print PDF check','Run the PC check on this PDF (drag it onto Print PDF Check.bat).');
  if(interior==='Mixed') h+=chkRow('ink',ck.ink,'Ink / black','No separate ink check logged yet; the Print PDF check above reports ink.');
  h+=chkRow('typo',ck.typo,'Typo check','Not run on any file in this folder.');
  h+=ffProofRow(tid,f,u);
  // 4. printers
  h+='<div class="ff-sec">Printer</div>';
  printers.forEach(p=>{
    const open=u.sendOpen===p.name;
    h+='<div class="ff-row"><span class="k">Printer: '+E(p.name)+'</span><span class="m">'+(p.sent?'<b>Sent '+E(fd(p.sent))+'</b> · PO: '+(p.po?E(p.po):'none linked'):'Not sent. PO: none linked.')+'</span>'+(p.sent?'<button class="ff-btn" onclick="ffSendOpen(\''+tid+'\',\''+E(p.name)+'\')">Edit</button>':'<button class="ff-btn go" onclick="ffSendOpen(\''+tid+'\',\''+E(p.name)+'\')">Mark as sent…</button>')+'</div>';
    if(open) h+='<div class="ff-form"><label>Sent on <input type="date" id="ff-sd-'+cid(tid+p.name)+'" value="'+E(p.sent||today())+'"></label><label>PO <input type="text" id="ff-po-'+cid(tid+p.name)+'" value="'+E(p.po)+'" placeholder="PO number, e.g. PO-0018"></label><button class="ff-btn go" onclick="ffSendSave(\''+tid+'\',\''+E(p.name)+'\')">Save</button>'+(p.sent?'<button class="ff-btn" onclick="ffSendClear(\''+tid+'\',\''+E(p.name)+'\')">Clear sent</button>':'')+'<button class="ff-btn" onclick="ffSendOpen(\''+tid+'\',\'\')">Cancel</button></div>';
  });
  h+='<div class="ff-row"><span class="k">Printers for this title</span><span class="m">Each title keeps its own list, with a sent date and PO for each printer. The “Sent?” box reads “Sent to 1 of '+(printers.length||3)+'” and so on.</span><button class="ff-btn" onclick="ffEditToggle(\''+tid+'\')">Add / change printers</button></div>';
  if(u.edit){ const names=Array.from(new Set(KNOWN_PRINTERS.concat(printers.map(p=>p.name))));
    h+='<div class="ff-form">'+names.map((n,i)=>'<label><input type="checkbox" id="ff-pe-'+cid(tid)+'-'+i+'" data-n="'+E(n)+'" '+(printers.some(p=>p.name===n)?'checked':'')+'> '+E(n)+'</label>').join('')+'<label>Add another <input type="text" id="ff-pn-'+cid(tid)+'" placeholder="printer name"></label><button class="ff-btn go" onclick="ffEditSave(\''+tid+'\','+names.length+')">Save printers</button><button class="ff-btn" onclick="ffEditToggle(\''+tid+'\')">Cancel</button></div>'; }
  h+='<div class="ff-row"><span class="k">eBook final</span><span class="m">'+(ck.epub?E(ck.epub.detail||ck.epub.result)+' · '+E(fdt(ck.epub.run_at)):'Not set up for this title.')+'</span><span class="ff-pill ff-none">'+(ck.epub?E(ck.epub.result):'N/A')+'</span></div>';
  h+='</div>';
  if(ff.logErr) h='<div class="ff-msg">'+E(ff.logErr)+'. Approvals, printers and ticks need the Sheet.</div>'+h;
  box.innerHTML=h;
}
function ffProofRow(tid,f,u){
  const pl=f.proof_list, k='Proof corrections';
  if(!pl) return '<div class="ff-row"><span class="k">'+k+'</span><span class="m">No corrections file (.docx) found for this title. Tick them by hand in the list below.</span><span class="ff-pill ff-none">NO LIST</span></div>';
  const head='<b>'+E(pl.file)+'</b> · '+E(fdt(pl.file_mtime))+(pl.total?' · '+pl.total+' items':'');
  if(!pl.total) return '<div class="ff-row"><span class="k">'+k+'</span><span class="m">'+head+'<br><span class="ff-sub">'+E(pl.status)+'</span></span><span class="ff-pill ff-none">'+(pl.readable===false?'CANNOT READ':'WAITING')+'</span></div>';
  const ticks=latest(tid,'proof_tick');
  const st=it=>{ const t=ticks.get(it.id); if(t) return t.value==='1'?['you','ticked by you']:['open','left open by you']; return it.status==='matched'?['auto','matched and fixed']:['open','you check']; };
  const items=pl.items.map(it=>Object.assign({s:st(it)},it)), done=items.filter(i=>i.s[0]!=='open').length, auto=items.filter(i=>i.s[0]==='auto').length, left=items.length-done;
  const li=i=>'<label><input type="checkbox" '+(i.s[0]!=='open'?'checked':'')+' onchange="ffTick(\''+tid+'\',\''+i.id+'\',this.checked)"><span>'+(i.page?'<b>p'+i.page+'</b> (old layout) ':'')+E(i.text.length>230?i.text.slice(0,230)+' …':i.text)+'<span class="why">'+E(i.s[0]==='open'?i.why:i.s[0]==='auto'?'Matched: '+i.why:i.s[1])+'</span></span></label>';
  let body='';
  if(u.showList){ const open=items.filter(i=>i.s[0]==='open'), okk=items.filter(i=>i.s[0]!=='open');
    body='<div class="ff-proof"><h4>You check ('+open.length+')</h4>'+(open.map(li).join('')||'<div class="ff-sub">Nothing left.</div>')+'<h4>Matched and fixed, or ticked by you ('+okk.length+')</h4>'+(u.showMatched?okk.map(li).join(''):'<button class="ff-btn" onclick="ffToggleMatched(\''+tid+'\')">Show the '+okk.length+'</button>')+'<div class="ff-sub" style="margin-top:6px">Page numbers are from the proofing round, not this layout. “Matched” = the corrected wording is in this PDF and the old wording is gone; anything unsure stays in “you check”. Ticks save to BPH.</div></div>'; }
  return '<div class="ff-row"><span class="k">'+k+'</span><span class="m">'+head+'<br>'+items.length+' items: <b>'+done+'</b> matched / ticked ('+auto+' by the scanner), <b>'+left+'</b> for you.<br><a href="#" onclick="ffToggleList(\''+tid+'\');return false">'+(u.showList?'Hide':'Show')+' the pulled-in list</a></span><span class="ff-pill '+(left?'ff-hand':'ff-ok')+'">'+(left?left+' FOR YOU':'ALL IN')+'</span></div>'+body;
}

// ── actions ──
async function save(tid,rows,msg){
  const u=U(tid); try{ await ffAppend(rows); u.msg=msg+(devMode?' (preview, not written)':''); }catch(e){ u.msg=''; if(typeof showReconnect==='function') showReconnect('Final Files not saved: '+(e.message||e), typeof isAuthFailure==='function'&&isAuthFailure(e)); }
  ffRender(tid); setTimeout(()=>{ if(u.msg===msg+(devMode?' (preview, not written)':'')){ u.msg=''; ffRender(tid); } },4000);
}
window.ffRefresh=async tid=>{ ff.data=null; ff.log=null; ff.mem=devMode?ff.mem:[]; ffRender(tid); await Promise.all([ffFetch(true),ffLoadLog(true)]); ffRender(tid); };
window.ffToggleList=tid=>{ const u=U(tid); u.showList=!u.showList; ffRender(tid); };
window.ffToggleMatched=tid=>{ const u=U(tid); u.showMatched=true; ffRender(tid); };
window.ffSendOpen=(tid,n)=>{ U(tid).sendOpen=n; ffRender(tid); };
window.ffEditToggle=tid=>{ const u=U(tid); u.edit=!u.edit; ffRender(tid); };
window.ffApprove=tid=>{ const f=folderFor(tid); if(!f||!f.candidate.sha256) return; save(tid,[{title_id:tid,kind:'approve',key:f.candidate.sha256,value:f.candidate.name,note:f.candidate.revision_code?'Rev '+f.candidate.revision_code:''}],'Approved as the final print file.'); };
window.ffSendSave=(tid,n)=>{ const d=document.getElementById('ff-sd-'+cid(tid+n)).value, po=document.getElementById('ff-po-'+cid(tid+n)).value.trim(); if(!d) return; U(tid).sendOpen=''; save(tid,[{title_id:tid,kind:'printer_sent',key:n,value:d,note:po}],n+': sent '+d+(po?', '+po:'')+' saved.'); };
window.ffSendClear=(tid,n)=>{ U(tid).sendOpen=''; save(tid,[{title_id:tid,kind:'printer_sent',key:n,value:'',note:'cleared'}],n+': sent date cleared (history kept in the log).'); };
window.ffTick=(tid,id,on)=>{ save(tid,[{title_id:tid,kind:'proof_tick',key:id,value:on?'1':'0'}],on?'Ticked.':'Left open.'); };
window.ffEditSave=(tid,n)=>{ const cur=printersOf(tid).map(p=>p.name), want=[]; for(let i=0;i<n;i++){ const el=document.getElementById('ff-pe-'+cid(tid)+'-'+i); if(el&&el.checked) want.push(el.dataset.n); }
  const extra=(document.getElementById('ff-pn-'+cid(tid))||{value:''}).value.replace(/['"\<>&]/g,'').trim(); if(extra&&!want.includes(extra)) want.push(extra);
  const rows=[]; const first=!rowsFor(tid).some(r=>r.kind==='printer_add'||r.kind==='printer_remove');
  want.forEach(w=>{ if(first||!cur.includes(w)) rows.push({title_id:tid,kind:'printer_add',key:w}); });
  cur.forEach(c=>{ if(!want.includes(c)) rows.push({title_id:tid,kind:'printer_remove',key:c}); });
  U(tid).edit=false; if(!rows.length){ ffRender(tid); return; } save(tid,rows,'Printers for this title updated.'); };
Object.assign(window,{ffSectionHtml,ffOpen,ffRender,ffFetch});
})();
