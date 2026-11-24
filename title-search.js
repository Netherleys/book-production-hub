/* title-search.js — Book Production Hub global "Jump to a title" box in the header (Mia Chen, 2026-11-24, David's ask).
 * Typeahead over data.titles (the same data All Titles uses). Case-insensitive, curly/straight quotes ignored, leading The/A/An ignored.
 * Enter or click opens the title (gotoDetail). The All Titles search is separate and unchanged. */
(function(){
'use strict';
const E=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s||'').toLowerCase().replace(/[“”„‟‘’‚‛"'`]/g,'').replace(/[^a-z0-9\u00c0-\uffff]+/g,' ').trim();
const noArt=s=>s.replace(/^(the|a|an)\s+/,'');
let hits=[], sel=0;
function search(q){
  const n=noArt(norm(q)); if(!n) return [];
  const out=[];
  (typeof data!=='undefined'?data.titles:[]).forEach(t=>{
    const full=norm(t.title), core=noArt(full);
    let r=-1;
    if(core.startsWith(n)||full.startsWith(n)) r=0; else if(core.split(' ').some(w=>w.startsWith(n.split(' ')[0]))&&(core.includes(n)||full.includes(n))) r=1; else if(core.includes(n)||full.includes(n)) r=2;
    if(r>=0) out.push({t,r,k:core});
  });
  out.sort((a,b)=>a.r-b.r||a.k.localeCompare(b.k));
  return out.slice(0,12).map(o=>o.t);
}
function draw(){
  const l=document.getElementById('gs-list'); if(!l) return;
  const q=document.getElementById('gs-input').value;
  if(!q.trim()){ l.hidden=true; return; }
  l.hidden=false;
  l.innerHTML=hits.length?hits.map((t,i)=>'<div class="gs-item'+(i===sel?' on':'')+'" role="option" data-id="'+E(t.id)+'"><span>“'+E(t.title)+'”</span><small>'+E(t.status||'')+'</small></div>').join(''):'<div class="gs-item" style="cursor:default;color:#6B6459">No title matches</div>';
  l.querySelectorAll('[data-id]').forEach(el=>el.onmousedown=e=>{ e.preventDefault(); open(el.dataset.id); });
}
function open(id){
  const i=document.getElementById('gs-input'); i.value=''; i.blur();
  document.getElementById('gs-list').hidden=true;
  if(typeof gotoDetail==='function') gotoDetail(id);
}
function init(){
  const i=document.getElementById('gs-input'); if(!i) return;
  i.addEventListener('input',()=>{ hits=search(i.value); sel=0; draw(); });
  i.addEventListener('focus',()=>{ if(i.value.trim()){ hits=search(i.value); draw(); } });
  i.addEventListener('blur',()=>setTimeout(()=>{ const l=document.getElementById('gs-list'); if(l) l.hidden=true; },120));
  i.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){ e.preventDefault(); sel=Math.min(sel+1,hits.length-1); draw(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); sel=Math.max(sel-1,0); draw(); }
    else if(e.key==='Enter'){ e.preventDefault(); if(hits[sel]) open(hits[sel].id); }
    else if(e.key==='Escape'){ i.value=''; i.blur(); document.getElementById('gs-list').hidden=true; }
  });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
