/* product-pages.js — Book Production Hub, "Product Pages" tab (Mia Chen, 2026-11-24; mockup approved by David 24-11, scanner by Marcus Webb).
 * Reads the product-page audit via the PC's local helper (http://127.0.0.1:8744/product_page_audit*.json). The data holds unreleased street dates,
 * ISBNs and prices, so it is NEVER copied into this (public) repo: on phone / helper off the tab says so and everything else in BPH works as before.
 * Notes are saved through the same helper (POST /product_page_note) into product_page_audit_notes.json, joined by product id; rescans never touch them.
 */
(function(){
'use strict';
const BASE=(window.BOOK_HUB_CONFIG&&window.BOOK_HUB_CONFIG.AUDIT_BASE_URL)||'http://127.0.0.1:8744';
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const E=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S={d:null,st:null,notes:{},err:'',flagged:false,mm:false,status:'all',sort:'new',q:''};
const timers={};

(function(){ if(document.getElementById('pp-css')) return; const st=document.createElement('style'); st.id='pp-css'; st.textContent=`
#main.main-prodpages{max-width:none;padding:0 20px 40px}
.pp-top{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:16px 0 12px;color:#F1EAD9}
.pp-top h1{font-size:1.3rem;margin:0 14px 0 0;color:#F1EAD9}
.pp-scan{color:#B9AF9B;font-size:.82rem}.pp-scan b{color:#F1EAD9}.pp-scan .bad{color:#ff8a7a;font-weight:700}
.pp-btn{background:rgba(241,234,217,.06);border:1px solid rgba(241,234,217,.25);color:#F1EAD9;padding:5px 12px;border-radius:4px;font:inherit;font-size:.8rem;cursor:pointer}
.pp-btn.on{background:#4B6E53;border-color:#4B6E53;color:#fff;font-weight:600}
.pp-sum{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.pp-pill{background:#fff;color:#14130F;border:1px solid #111;border-radius:8px;padding:6px 12px;font-size:.8rem}.pp-pill b{font-size:1.1rem;margin-right:5px}
.pp-pill.red b{color:#ff0000}.pp-pill.amb b{color:#C98A3E}.pp-pill.grn b{color:#4B6E53}
.pp-pill.click{cursor:pointer}.pp-pill.on{outline:3px solid #4B6E53}
.pp-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.pp-filters .lbl{color:#B9AF9B;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;margin-left:10px}
.pp-filters input[type=search]{background:#fff;border:1px solid #111;border-radius:4px;padding:5px 9px;font:inherit;font-size:.8rem;width:210px}
.pp-wrap{background:#fff;border:1px solid #111;border-radius:8px;overflow:auto;max-height:calc(100vh - 270px);color:#14130F}
.pp-wrap table{border-collapse:separate;border-spacing:0;width:100%;min-width:1560px}
.pp-wrap thead th{position:sticky;top:0;z-index:5;background:#F4F1E8;border-bottom:2px solid #111;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;padding:8px 6px;text-align:center;white-space:nowrap}
.pp-wrap thead th.fur{background:#ECEAE4;color:#6B6459}
.pp-wrap th.l,.pp-wrap td.l{text-align:left}
.pp-wrap td{padding:6px;border-bottom:1px solid #E4DFD1;text-align:center;vertical-align:middle;font-size:.8rem}
.pp-wrap td.fur{background:#FAF9F5;border-left:1px solid #E4DFD1}
.pp-wrap tr:hover td{background:#F6F1E2}
.pp-title{display:flex;align-items:center;gap:9px;min-width:240px;text-align:left}
.pp-thumb{width:28px;height:40px;object-fit:cover;border:1px solid #111;flex:none;background:#ddd;border-radius:2px;display:inline-block}
.pp-title b{display:block;font-size:.85rem}.pp-title small{color:#6B6459;font-size:.7rem}
.pp-title a{color:inherit;text-decoration:none}.pp-title a:hover{text-decoration:underline}
.pp-tag{display:inline-block;font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:3px;border:1px solid #111;margin-left:5px;vertical-align:1px;white-space:nowrap}
.pp-tag.draft{background:#FBF0DE;border-color:#C98A3E}.pp-tag.hb{background:#E8E4F2}.pp-tag.se{background:#E3EEF2}
.pp-ok{color:#4B6E53;font-weight:700;font-size:1rem}.pp-no{color:#ff0000;font-weight:700;font-size:1rem;cursor:help}.pp-na{color:#9AA5B1}
.pp-soft{color:#8f8b82}
.pp-st{font-size:.72rem;font-weight:600;padding:2px 7px;border-radius:10px;border:1px solid;white-space:nowrap}
.pp-st.in{background:#E9EEE4;border-color:#4B6E53}.pp-st.draft{background:#FBF0DE;border-color:#C98A3E}.pp-st.out{background:#EEF0F2;border-color:#9AA5B1}.pp-st.back{background:#F7E6E1;border-color:#ff0000;color:#8a3626}
.pp-flag{font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:10px;cursor:help;white-space:nowrap}
.pp-flag.ok2{background:#E9EEE4;color:#4B6E53}.pp-flag.warn{background:#F7E6E1;color:#8a0000;border:1px solid #ff0000}
.pp-mm{background:#F7E6E1!important;outline:2px solid #ff0000;outline-offset:-2px;border-radius:3px}
.pp-mm small{display:block;font-size:.65rem;color:#8a0000;margin-top:2px;white-space:nowrap}
.pp-price{font-size:.74rem;white-space:nowrap}
.pp-wrap td.notes{min-width:210px}
.pp-wrap td.notes input{width:100%;border:1px dashed #bbb;background:#fffdf6;border-radius:3px;padding:4px 6px;font:inherit;font-size:.78rem}
.pp-wrap td.notes small{display:block;font-size:.62rem;color:#6B6459;min-height:.8em;text-align:left}
.pp-wrap td.notes small.err{color:#ff0000;font-weight:700}
.pp-wrap tr.grp td{background:#2f2c22;color:#F1EAD9;font-weight:700;text-align:left;padding:7px 10px;font-size:.82rem}
.pp-wrap tr.grp td small{font-weight:400;color:#B9AF9B;margin-left:10px}
.pp-foot{color:#B9AF9B;font-size:.75rem;margin-top:10px}
.pp-empty{padding:30px;text-align:center;color:#4B453C}
.pp-msg{background:#fff;border:1px solid #111;border-radius:8px;padding:18px;color:#14130F;max-width:760px}
`; document.head.appendChild(st); })();

// ── data ──
async function getJson(path){ const r=await fetch(BASE+path,{cache:'no-store'}); if(!r.ok) throw new Error(path+' answered '+r.status); return r.json(); }
async function load(){
  S.err='';
  try{
    const [d,st,n]=await Promise.all([getJson('/product_page_audit.json'),getJson('/product_page_audit_status.json').catch(()=>null),getJson('/product_page_audit_notes.json').catch(()=>({}))]);
    S.d=d; S.st=st||d.scan_status||{}; S.notes=n||{};
  }catch(e){ S.d=null; S.err='The audit data is not reachable. It is read from the PC helper, so this tab only works on David\'s PC while the helper is running ('+e.message+').'; }
}
function lastScanned(){
  const s=S.st||{}, t=s.last_scanned_at||s.last_good_scan_at; if(!t) return 'never';
  const d=new Date(t); if(isNaN(d)) return t;
  const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+' '+MON[d.getMonth()]+' '+d.getDate()+', '+p(d.getHours())+':'+p(d.getMinutes());
}

// ── logic ──
const CORE=[['praise','Praise'],['slider','Slider'],['look_inside','Look Inside'],['pdf_download','PDF dl'],['author_bio','Author bio'],['cover','Cover']];
const FURN=[['promo_video','Promo video'],['related_reading','Related reading'],['related_titles','Related titles']];
const flagFor=(p,k)=>(p.flags||[]).find(f=>f.key===k&&f.severity!=='info');
const mainFlags=p=>(p.flags||[]).filter(f=>f.severity==='alarm'||f.severity==='warn');
function checkCell(p,k,fur){
  const c=(p.checks||{})[k]||{}, f=flagFor(p,k);
  if(fur){ // soft tier: tick or grey dash, never red
    if(c.ok===true) return '<td class="fur"><span class="pp-ok" title="'+E(c.detail)+'">✓</span></td>';
    if(c.ok===false) return '<td class="fur"><span class="pp-soft" title="'+E(c.detail)+'">–</span></td>';
    return '<td class="fur"><span class="pp-na" title="Not applicable">·</span></td>';
  }
  if(c.ok===true) return '<td><span class="pp-ok" title="'+E(c.detail)+'">✓</span></td>';
  if(f||c.ok===false) return '<td><span class="pp-no" title="'+E((f&&f.text)||c.detail)+'">✗</span></td>';
  return '<td><span class="pp-na" title="'+E(c.detail||'Not applicable')+'">–</span></td>';
}
function isbnCell(p){
  const c=(p.checks||{}).isbn||{}, f=flagFor(p,'isbn');
  if(c.hardback_no_isbn&&c.ok!==false&&!f) return '<td><span class="pp-na" title="No ISBN is correct for hardbacks and special editions" style="white-space:nowrap">NO-ISBN ✓</span></td>';
  if(c.status==='ok') return '<td><span class="pp-ok" title="'+E(c.detail)+'">✓</span></td>';
  if(f) return '<td class="'+(f.severity==='alarm'?'pp-mm':'')+'"><span class="pp-no" title="'+E(f.text)+'">✗</span></td>';
  if(c.status==='not_on_page') return '<td><span class="pp-soft" title="ISBN not shown on this older page layout">–</span></td>';
  return '<td><span class="pp-na" title="'+E(c.detail||'Not applicable')+'">–</span></td>';
}
function priceCell(p){
  const c=(p.checks||{}).price||{}, f=flagFor(p,'price');
  const t=c.uk!=null?('£'+Number(c.uk).toFixed(2)+(c.us!=null?' / $'+Number(c.us).toFixed(2):'')):'–';
  return '<td class="'+(f?'pp-mm':'')+'"><span class="pp-price" title="'+E(f?f.text:'')+'">'+E(t)+'</span></td>';
}
const STCLS={'In Stock':'in','Draft':'draft','Out of Stock':'out','Back Order':'back'};
function row(p){
  const sk=p.stock||{}, mm=!!sk.mismatch, pg=sk.page_status||'', fl=mainFlags(p);
  const th=(p.cover&&(p.cover.thumb||p.cover.url))?'<img class="pp-thumb" loading="lazy" src="'+E(p.cover.thumb||p.cover.url)+'" alt="">':'<span class="pp-thumb"></span>';
  const tags=(p.is_draft?'<span class="pp-tag draft">DRAFT</span>':'')+(p.tags||[]).map(t=>'<span class="pp-tag '+(t==='HARDBACK'?'hb':'se')+'">'+E(t)+'</span>').join('');
  const au=(p.authors||[]); const aus=au.length>3?au.slice(0,3).join(', ')+' +'+(au.length-3):au.join(', ');
  const title=p.url&&!p.is_draft?'<a href="'+E(p.url)+'" target="_blank" rel="noopener">“'+E(p.title)+'”</a>':'“'+E(p.title)+'”';
  const n=(S.notes[String(p.id)]||{}).note||'';
  return '<tr data-id="'+p.id+'"><td class="l"><div class="pp-title">'+th+'<div><b>'+title+tags+'</b><small>'+E(aus)+'</small></div></div></td>'+
    '<td class="'+(mm?'pp-mm':'')+'" title="'+E((sk.reasons||[]).join(' · '))+'"><span class="pp-st '+(STCLS[pg]||'out')+'">'+E(pg)+'</span>'+(mm?'<small>actually: '+E(sk.actual||'')+(sk.mismatch_kind==='edition'?' (one edition)':'')+'</small>':'')+'</td>'+
    CORE.map(c=>checkCell(p,c[0],false)).join('')+priceCell(p)+isbnCell(p)+FURN.map(c=>checkCell(p,c[0],true)).join('')+
    '<td>'+(fl.length?'<span class="pp-flag warn" title="'+E(fl.map(f=>f.text).join(' · '))+'">⚑ '+fl.length+'</span>':'<span class="pp-flag ok2">OK</span>')+'</td>'+
    '<td class="notes l"><input type="text" data-note="'+p.id+'" value="'+E(n)+'" placeholder="Add note…" maxlength="4000"><small id="ppn-'+p.id+'"></small></td></tr>';
}
function notAuditedRow(p){
  const th=p.url?'<a href="'+E(p.url)+'" target="_blank" rel="noopener">“'+E(p.title)+'”</a>':'“'+E(p.title)+'”';
  return '<tr><td class="l" colspan="3"><div class="pp-title"><div><b>'+th+(p.status==='draft'?'<span class="pp-tag draft">DRAFT</span>':'')+'</b></div></div></td><td colspan="4" class="l">'+E(p.kind)+'</td><td colspan="8" class="l">'+E(p.reason||'')+'</td><td>'+E(p.page_status||'')+'</td></tr>';
}
function cmp(a,b){ return S.sort==='az'?String(a.sort_key||a.title).localeCompare(String(b.sort_key||b.title),undefined,{numeric:true}):String(b.date||'').localeCompare(String(a.date||'')); }
function norm(s){ return String(s||'').toLowerCase().replace(/[“”‘’"']/g,'').replace(/\s+/g,' '); }
function draw(){
  const body=document.getElementById('pp-body'); if(!body||!S.d) return;
  const q=norm(S.q);
  let rows=(S.d.products||[]).filter(p=>(!S.flagged||p.flag_count>0)&&(!S.mm||(p.stock||{}).mismatch)&&(S.status==='all'||(p.stock||{}).page_status===S.status)&&(!q||norm(p.title).includes(q)||norm(p.sort_title).includes(q)||(p.authors||[]).some(a=>norm(a).includes(q))));
  rows.sort(cmp);
  const act=rows.filter(p=>p.group!=='out_of_stock'), out=rows.filter(p=>p.group==='out_of_stock');
  const na=(S.d.not_audited||[]).filter(p=>!q||norm(p.title).includes(q)).slice().sort((a,b)=>String(a.kind).localeCompare(String(b.kind))||String(a.sort_key).localeCompare(String(b.sort_key)));
  let h='';
  if(act.length) h+='<tr class="grp"><td colspan="16">In Stock, Back Order and Draft ('+act.length+')</td></tr>'+act.map(row).join('');
  if(out.length) h+='<tr class="grp"><td colspan="16">Out of Stock ('+out.length+')</td></tr>'+out.map(row).join('');
  if(na.length&&!S.flagged&&!S.mm&&S.status==='all') h+='<tr class="grp"><td colspan="16">Not audited ('+na.length+')<small>products on the site that the audit deliberately skips (merchandise, comix, other), so you can see what you have</small></td></tr>'+na.map(notAuditedRow).join('');
  body.innerHTML=h||'<tr><td colspan="16" class="pp-empty">No rows match.</td></tr>';
  const sm=S.d.summary||{};
  document.getElementById('pp-sum').innerHTML=
    '<div class="pp-pill"><b>'+(sm.scanned||0)+'</b>products scanned</div>'+
    '<div class="pp-pill red"><b>'+(sm.with_flags||0)+'</b>with flags</div>'+
    '<div class="pp-pill red click'+(S.mm?' on':'')+'" id="pp-mmpill" title="Show only rows where the page stock status is wrong"><b>'+(sm.status_mismatches||0)+'</b>stock mismatches</div>'+
    '<div class="pp-pill amb"><b>'+(sm.drafts||0)+'</b>drafts</div>'+
    '<div class="pp-pill grn"><b>'+(sm.all_clear||0)+'</b>all clear</div>'+
    '<div class="pp-pill"><b>'+(sm.not_audited||0)+'</b>not audited</div>';
  const mp=document.getElementById('pp-mmpill'); if(mp) mp.onclick=()=>{ S.mm=!S.mm; syncBtns(); draw(); };
  body.querySelectorAll('input[data-note]').forEach(i=>{ i.oninput=()=>queueSave(i); i.onblur=()=>flushSave(i); });
}
function syncBtns(){
  const set=(id,on)=>{ const b=document.getElementById(id); if(b) b.classList.toggle('on',on); };
  set('pp-f-all',!S.flagged); set('pp-f-flag',S.flagged); set('pp-s-new',S.sort==='new'); set('pp-s-az',S.sort==='az');
  ['all','In Stock','Back Order','Draft','Out of Stock'].forEach((s,i)=>set('pp-st-'+i,S.status===s));
}
// ── notes ──
function queueSave(i){ const id=i.dataset.note; clearTimeout(timers[id]); setMsg(id,'…',false); timers[id]=setTimeout(()=>save(i),800); }
function flushSave(i){ const id=i.dataset.note; if(timers[id]){ clearTimeout(timers[id]); timers[id]=null; save(i); } }
function setMsg(id,t,err){ const m=document.getElementById('ppn-'+id); if(m){ m.textContent=t; m.className=err?'err':''; } }
async function save(i){
  const id=i.dataset.note, note=i.value; timers[id]=null;
  try{
    const r=await fetch(BASE+'/product_page_note',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:Number(id),note})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok) throw new Error(j.error||('status '+r.status));
    S.notes[id]={note,updated:j.updated}; setMsg(id,'Saved',false);
  }catch(e){ setMsg(id,'NOT saved: '+e.message+' (is the PC helper running?)',true); }
}
// ── view ──
async function ppRender(){
  const main=document.getElementById('main'); if(!main) return;
  main.innerHTML='<div class="pp-top"><h1>Product Pages</h1><span class="pp-scan">Loading audit…</span></div>';
  await load();
  if(!S.d){ main.innerHTML='<div class="pp-top"><h1>Product Pages</h1></div><div class="pp-msg">'+E(S.err)+' <button class="pp-btn" style="color:#14130F;border-color:#111" onclick="ppRender()">Try again</button></div>'; return; }
  const st=S.st||{}, bad=st.state&&st.state!=='ok';
  main.innerHTML='<div class="pp-top"><h1>Product Pages</h1><span class="pp-scan">Last scanned: <b>'+E(lastScanned())+'</b>'+(bad?' <span class="bad">· last scan '+E(String(st.state).toUpperCase())+(st.error?' ('+E(st.error)+')':'')+', showing the previous good data</span>':'')+' · automatic read-only scan of the live pages, every morning</span></div>'+
  '<div class="pp-sum" id="pp-sum"></div>'+
  '<div class="pp-filters"><button class="pp-btn" id="pp-f-all">All</button><button class="pp-btn" id="pp-f-flag">Only rows with flags</button>'+
  '<span class="lbl">Status</span>'+['all','In Stock','Back Order','Draft','Out of Stock'].map((s,i)=>'<button class="pp-btn" id="pp-st-'+i+'" data-st="'+s+'">'+(s==='all'?'All':s)+'</button>').join('')+
  '<span class="lbl">Sort</span><button class="pp-btn" id="pp-s-new">Newest to Oldest</button><button class="pp-btn" id="pp-s-az">A–Z</button>'+
  '<input type="search" id="pp-q" placeholder="Search title or author…"></div>'+
  '<div class="pp-wrap"><table><thead><tr><th class="l">Title</th><th>Page status</th>'+CORE.map(c=>'<th>'+c[1]+'</th>').join('')+'<th>Price</th><th>ISBN</th>'+FURN.map(c=>'<th class="fur" title="Nice to have, never counted as a flag">'+c[1]+'</th>').join('')+'<th>Flags</th><th class="l">Notes</th></tr></thead><tbody id="pp-body"></tbody></table></div>'+
  '<div class="pp-foot">✓ present · <span style="color:#ff8a7a">✗</span> missing (counts as a flag) · – not applicable. Red cell = page disagrees with stock / BPH. Grey columns (promo video, related reading, related titles) are nice-to-have and never flagged. Hardbacks and Special Editions: no ISBN is correct. Hover a ✗ or flag for the detail. Notes are David\'s own and survive rescans.</div>';
  const $=id=>document.getElementById(id);
  $('pp-f-all').onclick=()=>{ S.flagged=false; syncBtns(); draw(); }; $('pp-f-flag').onclick=()=>{ S.flagged=true; syncBtns(); draw(); };
  document.querySelectorAll('[data-st]').forEach(b=>b.onclick=()=>{ S.status=b.dataset.st; syncBtns(); draw(); });
  $('pp-s-new').onclick=()=>{ S.sort='new'; syncBtns(); draw(); }; $('pp-s-az').onclick=()=>{ S.sort='az'; syncBtns(); draw(); };
  $('pp-q').value=S.q; $('pp-q').oninput=()=>{ S.q=$('pp-q').value; draw(); };
  syncBtns(); draw();
}
window.ppRender=ppRender;
window.renderProductPages=ppRender;
window.gotoProductPages=function(){ if(typeof flushPendingSave==='function') flushPendingSave(selectedId); view='prodpages'; render(); };
})();
