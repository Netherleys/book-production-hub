/*
 * author-link-row.js — "Author form link" row on every title page (live Hub).
 * Marcus Webb, 2026-11-23. David approved 23-11 ("Yes.").
 * Link-only: builds the Form A address from the title's permanent key (title_id). It reads no Sheet, writes nothing,
 * calls no service and changes no BPH field. Rollback: delete this file's <script> tag from index.html.
 */
(function () {
  'use strict';
  var FORM_A = 'https://eu.jotform.com/form/263225142320039';
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function mount(id) {
    var t = typeof getTitle === 'function' ? getTitle(id) : null; if (!t) return;
    var main = document.getElementById('main'); if (!main) return;
    var old = document.getElementById('alr-row'); if (old) old.remove();
    var link = FORM_A + '?bphId=' + encodeURIComponent(t.id) + (t.title ? '&bookTitle=' + encodeURIComponent(t.title) : '') + (t.authors ? '&authorName=' + encodeURIComponent(t.authors) : '');
    var r = document.createElement('section'); r.id = 'alr-row';
    r.style.cssText = 'display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin:1rem 0;padding:.6rem .9rem;border:2.5px solid #111;border-radius:16px;background:#fff;box-shadow:4px 4px 0 rgba(17,17,17,.9);font-size:.82rem;color:#14130F';
    r.innerHTML = '<b style="font-size:.74rem;letter-spacing:.2em;text-transform:uppercase;color:#4B6E53">Author form link</b>'
      + '<input id="alr-link" readonly value="' + esc(link) + '" style="flex:1;min-width:260px;font:inherit;border:1.5px solid rgba(17,17,17,.3);border-radius:8px;padding:.3rem .5rem;background:#faf6ea">'
      + '<button id="alr-copy" type="button" style="background:#BE1F24;color:#fff;border:2px solid #111;border-radius:99px;padding:.3rem .9rem;font:800 .8rem inherit;cursor:pointer">Copy link</button>'
      + '<a href="' + esc(link) + '" target="_blank" rel="noopener" style="font-weight:800;color:#111">Open</a><span id="alr-msg" style="color:#3F7A52;font-weight:700"></span>'
      + '<div style="flex-basis:100%;color:#6B6459;font-size:.72rem">Send this one link to the author. It carries this title&rsquo;s permanent key, so it keeps working if the title is renamed.</div>';
    main.insertBefore(r, main.firstChild);
    r.querySelector('#alr-copy').onclick = function () {
      var i = r.querySelector('#alr-link'), done = function () { r.querySelector('#alr-msg').textContent = 'Copied'; };
      try { navigator.clipboard.writeText(i.value).then(done, function () { i.select(); document.execCommand('copy'); done(); }); } catch (e) { i.select(); document.execCommand('copy'); done(); }
    };
  }
  if (typeof renderDetail !== 'function') return;
  var orig = renderDetail;
  renderDetail = function () {
    var res = orig.apply(this, arguments);
    try { if (typeof selectedId !== 'undefined' && selectedId) mount(selectedId); } catch (e) { console.warn('author-link-row', e); }
    return res;
  };
})();
