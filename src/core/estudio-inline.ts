// ─── Barra de estudio AUTO-INYECTADA en los ```html del chat (20 jul 2026) ───
//
// Decisión de Daniel: en vez de que Levy recree la barra de audio en cada HTML
// que genera, el ESTÁNDAR de estudio de libro-os (estudio.html del Timonel:
// play/pausa, velocidad ciclable, tamaño A±, voz, salto por sección,
// tap-en-párrafo, swipe, teclado) vive AQUÍ como configuración default y
// HtmlPreview lo inyecta en todo documento renderizado. Levy solo escribe el
// CONTENIDO (con tamaños en rem para que A± escale).
//
// Gates en runtime (dentro del iframe):
// · sin bloques legibles o < 280 chars de texto → la barra se auto-elimina
//   (una tarjeta de métricas no necesita lector).
// · viewport < 340px de alto (la tarjeta chica del chat) → la barra espera
//   oculta; el fullscreen monta OTRO iframe alto y ahí sí aparece.
// · ya existe #estudio-bar en el doc (pergaminos completos) → HtmlPreview no
//   inyecta. Opt-out explícito: incluir "sin-estudio" en el HTML.
//
// Adaptaciones vs estudio.html original (documentadas en memoria
// reference/chat-render-html-mermaid-2026-07-20.md):
// · localStorage → shim try/catch (el sandbox del chat es origen opaco y LANZA).
// · SIN marco morado de bloque: solo la palabra dorada (orden de Daniel).
// · SIN toggle de tema (los explicables ya son oscuros).
// · padding-bottom del body y cursor:pointer se aplican por JS solo si la barra
//   pasa los gates (no ensuciar documentos que no la usan).

export const ESTUDIO_INLINE = `
<style id="estudio-inline-css">
::highlight(est-word){background:rgba(255,145,1,.65);color:#1a1208}
.est-current{scroll-margin:30vh}
html{font-size:calc(100% * var(--est-font-scale,1))}
body.est-on h1,body.est-on h2,body.est-on h3,body.est-on h4,body.est-on p,body.est-on li,body.est-on figcaption{cursor:pointer}
#estudio-bar{position:fixed;left:50%;bottom:16px;bottom:max(16px,env(safe-area-inset-bottom));
  transform:translateX(-50%);display:flex;align-items:center;gap:6px;
  width:min(460px,calc(100vw - 24px));max-width:calc(100vw - 24px);box-sizing:border-box;padding:8px 9px;
  background:linear-gradient(180deg,rgba(32,26,44,.88),rgba(18,15,26,.92));
  border:1px solid rgba(255,255,255,.08);border-radius:999px;
  box-shadow:0 14px 38px rgba(0,0,0,.4),0 2px 10px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);
  font-family:"Optima",Georgia,serif;color:#f2eef7;z-index:9999;isolation:isolate}
#estudio-bar *{box-sizing:border-box}
#estudio-bar::before{content:'';position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(135deg,rgba(157,60,245,.5),rgba(255,145,1,.24) 55%,transparent 80%);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;opacity:.65;z-index:-1}
#estudio-bar button{border:0;background:transparent;color:inherit;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent;
  flex:0 0 auto;transition:background .15s ease,transform .1s ease,opacity .15s ease,color .15s ease}
#estudio-bar button:active{transform:scale(.92)}
#est-play{position:relative;width:44px;height:44px;border-radius:50%;
  background:radial-gradient(120% 120% at 30% 20%,#b158ff,#7a1fe0 60%,#5c14ad);
  box-shadow:0 6px 18px rgba(140,39,241,.5),inset 0 1px 1px rgba(255,255,255,.25)}
#est-play svg{display:block}
#est-play .ico-play svg{margin-left:2px}
@keyframes est-pulse{0%,100%{box-shadow:0 6px 18px rgba(140,39,241,.5),inset 0 1px 1px rgba(255,255,255,.25)}
  50%{box-shadow:0 6px 28px rgba(140,39,241,.85),inset 0 1px 1px rgba(255,255,255,.4)}}
#est-play.is-playing{animation:est-pulse 2.2s ease-in-out infinite}
#est-rate-btn{min-width:46px;height:32px;padding:0 10px;border-radius:16px;background:rgba(255,255,255,.09);
  font-size:13px;font-weight:700;letter-spacing:.01em;color:#ffb64d;border:1px solid rgba(255,255,255,.08);
  font-variant-numeric:tabular-nums}
#est-rate-btn:hover{background:rgba(255,145,1,.14)}
#est-info{flex:1 1 auto;min-width:0;text-align:center;font-size:12px;color:rgba(242,238,247,.6);
  letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
#est-settings,#est-hide{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.06)}
#est-settings svg,#est-hide svg{opacity:.85}
#est-settings.is-open{background:rgba(157,60,245,.28)}
#est-settings.is-open svg{opacity:1;color:#c79bff}
#est-popover{position:absolute;left:50%;bottom:calc(100% + 12px);
  transform:translateX(-50%) translateY(8px) scale(.95);transform-origin:bottom center;
  width:min(300px,calc(100vw - 40px));max-height:min(420px,calc(100vh - 140px));overflow-y:auto;
  background:linear-gradient(180deg,rgba(38,31,52,.96),rgba(20,16,28,.98));
  border:1px solid rgba(255,255,255,.1);border-radius:22px;
  box-shadow:0 24px 60px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter:blur(28px) saturate(1.6);-webkit-backdrop-filter:blur(28px) saturate(1.6);
  padding:6px;font-family:"Optima",Georgia,serif;color:#f2eef7;
  opacity:0;visibility:hidden;pointer-events:none;
  transition:opacity .16s ease,transform .18s cubic-bezier(.2,.9,.32,1.2);z-index:10000;cursor:default}
#est-popover.is-open{opacity:1;visibility:visible;pointer-events:auto;transform:translateX(-50%) translateY(0) scale(1)}
#est-popover::after{content:'';position:absolute;left:50%;bottom:-6px;transform:translateX(-50%) rotate(45deg);
  width:12px;height:12px;background:rgba(20,16,28,.98);border-right:1px solid rgba(255,255,255,.1);
  border-bottom:1px solid rgba(255,255,255,.1);border-radius:0 0 3px 0}
.est-pop-section{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.07)}
.est-pop-section:last-child{border-bottom:0}
.est-pop-label{display:flex;align-items:center;gap:6px;font-size:11px;text-transform:uppercase;
  letter-spacing:.06em;color:rgba(242,238,247,.5);margin-bottom:8px;
  font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.est-pop-label svg{flex-shrink:0;opacity:.7}
.est-select{width:100%;appearance:none;-webkit-appearance:none;background:rgba(255,255,255,.07);
  color:#f2eef7;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:10px 12px;
  font-size:14px;font-family:inherit}
.est-size-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.est-size-btn{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.08);
  border:1px solid rgba(255,255,255,.08);font-weight:700;color:#f2eef7;font-family:Georgia,serif;cursor:pointer}
.est-size-btn:active{background:rgba(255,145,1,.16)}
.est-size-btn-sm{font-size:12px}
.est-size-btn-lg{font-size:19px}
#est-size-pct{font-size:12px;color:rgba(242,238,247,.55);min-width:38px;text-align:center;font-variant-numeric:tabular-nums}
#est-show{position:fixed;right:16px;bottom:16px;bottom:max(16px,env(safe-area-inset-bottom));
  z-index:9999;display:none;align-items:center;justify-content:center;width:50px;height:50px;
  border-radius:50%;border:0;background:radial-gradient(120% 120% at 30% 20%,#b158ff,#7a1fe0 60%,#5c14ad);
  color:#fff;box-shadow:0 10px 30px rgba(140,39,241,.5),inset 0 1px 0 rgba(255,255,255,.25);
  cursor:pointer;-webkit-tap-highlight-color:transparent}
#est-show:active{transform:scale(.92)}
@media (pointer:coarse){
  #estudio-bar{padding:9px 11px}
  #estudio-bar button{min-height:44px}
  #est-play{width:48px;height:48px}
  #est-settings,#est-hide{width:40px;height:40px}
  .est-select,.est-size-btn{min-height:44px}
}
@media (max-width:380px){
  #estudio-bar{gap:4px;padding:8px}
  #est-info{font-size:11px}
}
</style>
<div id="estudio-bar" style="display:none">
  <button id="est-play" aria-label="Reproducir" title="Play/Pausa (espacio)">
    <span class="ico-play"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
    <span class="ico-pause" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg></span>
  </button>
  <button id="est-rate-btn" aria-label="Velocidad de lectura, toca para cambiar" title="Velocidad">1x</button>
  <span id="est-info">&mdash;</span>
  <button id="est-settings" aria-haspopup="true" aria-expanded="false" aria-label="Ajustes" title="Ajustes">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>
  </button>
  <button id="est-hide" aria-label="Ocultar barra" title="Ocultar barra (H)">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
  </button>
  <div id="est-popover" role="dialog" aria-label="Ajustes de lectura">
    <div class="est-pop-section">
      <div class="est-pop-label">Voz</div>
      <select id="est-voice" class="est-select" title="Voz"></select>
    </div>
    <div class="est-pop-section">
      <div class="est-pop-label">Secci&oacute;n</div>
      <select id="est-chapter" class="est-select" title="Saltar a secci&oacute;n"></select>
    </div>
    <div class="est-pop-section">
      <div class="est-pop-label">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>
        Tama&ntilde;o de texto
      </div>
      <div class="est-size-row">
        <button id="est-size-dec" class="est-size-btn est-size-btn-sm" aria-label="Reducir tama&ntilde;o de texto">A</button>
        <span id="est-size-pct">100%</span>
        <button id="est-size-inc" class="est-size-btn est-size-btn-lg" aria-label="Aumentar tama&ntilde;o de texto">A</button>
      </div>
    </div>
  </div>
</div>
<button id="est-show" title="Mostrar controles" aria-label="Mostrar controles">
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
</button>
<script id="estudio-inline-js">
(function () {
  'use strict';
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  };
  var LS_KEY = 'estudio-inline:' + (document.title || 'html');
  var $ = function (id) { return document.getElementById(id); };
  var synth = window.speechSynthesis;
  if (!synth) { removeAll(); return; }
  var isChrome = /Chrome/.test(navigator.userAgent);
  var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var warmed = false;

  var candidates = Array.prototype.filter.call(
    document.querySelectorAll('h1,h2,h3,h4,p,li,figcaption'),
    function (el) { return !el.closest('#estudio-bar'); }
  );
  var candSet = new Set(candidates);
  var blocks = candidates.filter(function (el) {
    if (!el.innerText.trim()) return false;
    var inner = el.querySelectorAll('h1,h2,h3,h4,p,li,figcaption');
    for (var i = 0; i < inner.length; i++) if (candSet.has(inner[i])) return false;
    return true;
  });

  function removeAll() {
    var b = $('estudio-bar'), s = $('est-show'), c = $('estudio-inline-css');
    if (b) b.remove(); if (s) s.remove(); if (c) c.remove();
  }
  // Gate 1: sin texto legible suficiente (tarjeta de métricas, widget) → fuera.
  var totalText = blocks.reduce(function (n, el) { return n + el.innerText.length; }, 0);
  if (blocks.length === 0 || totalText < 280) { removeAll(); return; }

  var initialized = false;

  var idx = 0, playing = false, paused = false, sentTimer = null, wakeLock = null;
  var cursorOffset = 0; // offset (dentro de block.textContent) de la última palabra sonada
  var startOffset = null; // one-shot: arranque a mitad de bloque para la próxima speakBlock()
  var saved = {};
  try { saved = JSON.parse(store.get(LS_KEY) || '{}'); } catch (_) {}
  if (Number.isInteger(saved.idx) && saved.idx >= 0 && saved.idx < blocks.length) idx = saved.idx;

  var RATES = [1, 1.25, 1.5, 1.75, 2];
  var rateIdx = 0;
  function getRate() { return RATES[rateIdx]; }
  function setRateIdx(i, opts) {
    rateIdx = ((i % RATES.length) + RATES.length) % RATES.length;
    $('est-rate-btn').textContent = RATES[rateIdx] + 'x';
    save();
    if (opts && opts.restart && playing) jump(idx, true);
  }

  var SIZE_MIN = 0.8, SIZE_MAX = 1.6, SIZE_STEP = 0.1;
  var fontScale = 1;
  function applyFontScale(scale) {
    fontScale = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(scale * 100) / 100));
    document.documentElement.style.setProperty('--est-font-scale', fontScale.toFixed(2));
    $('est-size-pct').textContent = Math.round(fontScale * 100) + '%';
    save();
  }

  function save() {
    store.set(LS_KEY, JSON.stringify({ idx: idx, rateIdx: rateIdx, voice: $('est-voice').value, fontScale: fontScale }));
  }

  function loadVoices() {
    var es = synth.getVoices().filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf('es') === 0; });
    var local = es.filter(function (v) { return v.localService; });
    var vs = local.length ? local : es;
    var sel = $('est-voice');
    if (!sel) return;
    var prevValue = sel.value;
    sel.innerHTML = '';
    var sysOpt = document.createElement('option');
    sysOpt.value = '__system__';
    sysOpt.textContent = 'Voz del sistema' + (isIOS ? ' (recomendada)' : '');
    sel.appendChild(sysOpt);
    vs.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.name; o.textContent = v.name + ' (' + v.lang + ')';
      sel.appendChild(o);
    });
    var enh = function (v) { return /(enhanced|mejorad|premium|siri|neural)/i.test(v.name); };
    var mx = function (v) { return v.lang.toLowerCase().indexOf('mx') >= 0 || v.lang.toLowerCase().indexOf('419') >= 0; };
    var isValid = function (val) { return val === '__system__' || vs.some(function (v) { return v.name === val; }); };
    if (isValid(prevValue)) { sel.value = prevValue; }
    else if (isValid(saved.voice)) { sel.value = saved.voice; }
    else if (isIOS) { sel.value = '__system__'; }
    else {
      var pick =
        vs.find(function (v) { return /Juan/i.test(v.name) && enh(v); }) ||
        vs.find(function (v) { return /Juan/i.test(v.name); }) ||
        vs.find(function (v) { return mx(v) && enh(v); }) ||
        vs.find(function (v) { return /Paulina/i.test(v.name); }) ||
        vs.find(enh) ||
        vs.find(function (v) { return /M[oó]nica/i.test(v.name); }) ||
        vs[0];
      sel.value = pick ? pick.name : '__system__';
    }
  }
  loadVoices();
  synth.onvoiceschanged = loadVoices;

  function currentVoice() {
    var val = $('est-voice').value;
    if (!val || val === '__system__') return null;
    return synth.getVoices().find(function (v) { return v.name === val; }) || null;
  }

  var ABBR_END = /(?:\\b(?:pp?|p[aá]gs?|caps?|figs?|n[uú]m|nro|vols?|eds?|op|cit|arts?|Dr|Dra|Sr|Sra|Srta|Prof|Ing|Lic|Gral|Av|etc|vs|Ej|ej|ss)|\\b[\\p{Lu}])\\.[\\s"»”’)\\]]*$/u;
  var NUM_END = /\\d\\.[\\s"»”’)\\]]*$/;
  var NUM_START = /^[\\s"«“(]*\\d/;
  function sentencesOf(el) {
    var text = el.textContent;
    var raw = text.match(/[^.!?…]+[.!?…]+[\\s"»”’)\\]]*|[^.!?…]+$/g) || [text];
    var parts = [];
    for (var i = 0; i < raw.length; i++) {
      var seg = raw[i];
      var prev = parts[parts.length - 1];
      if (prev != null && (ABBR_END.test(prev) || (NUM_END.test(prev) && NUM_START.test(seg)))) {
        parts[parts.length - 1] = prev + seg;
      } else {
        parts.push(seg);
      }
    }
    var out = []; var pos = 0;
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      var rawStart = text.indexOf(p, pos);
      pos = rawStart + p.length;
      var lead = p.length - p.replace(/^\\s+/, '').length;
      var t = p.trim();
      out.push({ text: t, start: rawStart + lead, end: rawStart + lead + t.length });
    }
    return out.filter(function (s) { return s.text.length; });
  }
  function highlightRange(el, start, end, name) {
    if (!window.Highlight || !CSS.highlights) return;
    try {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      var node, off = 0; var range = document.createRange();
      var s = null, e = null;
      while ((node = walker.nextNode())) {
        var len = node.textContent.length;
        if (s === null && off + len > start) { range.setStart(node, start - off); s = true; }
        if (s && off + len >= end) { range.setEnd(node, Math.min(end - off, len)); e = true; break; }
        off += len;
      }
      if (s && e) CSS.highlights.set(name || 'est-word', new Highlight(range));
    } catch (_) {}
  }
  function clearHighlight() {
    if (window.CSS && CSS.highlights) { CSS.highlights.delete('est-word'); }
  }

  function snapWordStart(text, offset) {
    var k = offset;
    while (k > 0 && !/\\s/.test(text[k - 1])) k--;
    return k;
  }
  function highlightAtOffset(el, offset) {
    var text = el.textContent || '';
    var start = offset;
    while (start > 0 && !/\\s/.test(text[start - 1])) start--;
    var end = offset;
    while (end < text.length && !/\\s/.test(text[end])) end++;
    if (end <= start) return;
    highlightRange(el, start, end, 'est-word');
  }
  function offsetWithinBlock(block, node, nodeOffset) {
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var off = 0, n;
    while ((n = walker.nextNode())) {
      if (n === node) return off + nodeOffset;
      off += n.textContent.length;
    }
    return 0;
  }
  function caretOffsetInBlock(block, x, y) {
    var node = null, nodeOffset = 0;
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer; nodeOffset = r.startOffset;
    } else if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode; nodeOffset = p.offset;
    } else {
      return null;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !block.contains(node)) return null;
    return offsetWithinBlock(block, node, nodeOffset);
  }

  function markBlock() {
    document.querySelectorAll('.est-current').forEach(function (el) { el.classList.remove('est-current'); });
    var el = blocks[idx];
    if (!el) return;
    el.classList.add('est-current');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateInfo();
  }
  function speakBlock() {
    var el = blocks[idx];
    if (!el) return stop();
    markBlock(); save();
    var sents = sentencesOf(el);
    var startAt = startOffset;
    startOffset = null;
    var si = 0, localStart = 0;
    if (startAt != null && sents.length) {
      si = -1;
      for (var fi = 0; fi < sents.length; fi++) {
        if (sents[fi].end > startAt) { si = fi; break; }
      }
      if (si === -1) si = sents.length - 1;
      var fs = sents[si];
      localStart = Math.max(0, Math.min(fs.text.length, startAt - fs.start));
      localStart = snapWordStart(fs.text, localStart);
      cursorOffset = fs.start + localStart;
      highlightAtOffset(el, cursorOffset);
    } else {
      cursorOffset = sents.length ? sents[0].start : 0;
    }
    var cursor = si;
    var next = function () {
      if (!playing) return;
      if (cursor >= sents.length) {
        clearHighlight();
        if (idx < blocks.length - 1) { idx++; speakBlock(); } else stop();
        return;
      }
      var isFirst = cursor === si;
      var s = sents[cursor++];
      var sliceStart = isFirst ? localStart : 0;
      var sentText = sliceStart > 0 ? s.text.slice(sliceStart) : s.text;
      cursorOffset = s.start + sliceStart;
      var spoken = sentText.replace(/[«»“”„‟‹›"']/g, ' ');
      var u = new SpeechSynthesisUtterance(spoken);
      var v = currentVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-MX';
      u.rate = getRate();
      u.onboundary = function (ev) {
        if (ev.name && ev.name !== 'word') return;
        var m = /\\S+/.exec(sentText.slice(ev.charIndex));
        if (m) {
          var from = s.start + sliceStart + ev.charIndex + m.index;
          var to = from + m[0].length;
          cursorOffset = from;
          highlightRange(el, from, to, 'est-word');
        }
      };
      u.onend = function () { clearHighlight(); next(); };
      u.onerror = next;
      synth.speak(u);
    };
    next();
  }

  function setPlayIcon(isPlaying) {
    $('est-play').querySelector('.ico-play').hidden = isPlaying;
    $('est-play').querySelector('.ico-pause').hidden = !isPlaying;
    $('est-play').classList.toggle('is-playing', isPlaying);
    $('est-play').setAttribute('aria-label', isPlaying ? 'Pausar' : 'Reproducir');
  }
  function speakFrom(i, charOffset) {
    idx = Math.max(0, Math.min(blocks.length - 1, i));
    paused = false;
    startOffset = Math.max(0, charOffset || 0);
    if (isIOS && !warmed) {
      try { var w = new SpeechSynthesisUtterance(' '); w.volume = 0; synth.speak(w); } catch (_) {}
      warmed = true;
    }
    playing = true;
    setPlayIcon(true);
    if (!wakeLock && navigator.wakeLock) {
      try { navigator.wakeLock.request('screen').then(function (wl) { wakeLock = wl; }).catch(function () {}); } catch (_) {}
    }
    if (isChrome && !sentTimer) {
      sentTimer = setInterval(function () {
        if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
      }, 10000);
    }
    synth.cancel();
    speakBlock();
  }
  function play() {
    if (playing) return;
    // Resume conserva posición SIEMPRE vía speakFrom (nunca synth.resume()). Si no hay
    // posición previa (primer play, o tras stop()), cursorOffset es 0 → arranca desde el
    // inicio del bloque actual, igual que antes.
    speakFrom(idx, cursorOffset);
  }
  function pause() {
    // Pausa: conserva idx Y cursorOffset. Play() reanuda EXACTO donde iba (feature 1).
    playing = false;
    paused = true;
    synth.cancel();
    if (sentTimer) { clearInterval(sentTimer); sentTimer = null; }
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    setPlayIcon(false);
    save();
  }
  function stop() {
    // Stop DURO: fin natural del documento. A diferencia de pause(), descarta la posición.
    playing = false;
    paused = false;
    cursorOffset = 0;
    synth.cancel();
    clearHighlight();
    if (sentTimer) { clearInterval(sentTimer); sentTimer = null; }
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    setPlayIcon(false);
    save();
  }
  function jump(i, autoplay, charOffset) {
    var offset = typeof charOffset === 'number' ? charOffset : 0;
    var wasPlaying = playing;
    synth.cancel();
    if (sentTimer) { clearInterval(sentTimer); sentTimer = null; }
    playing = false;
    idx = Math.max(0, Math.min(blocks.length - 1, i));
    cursorOffset = offset;
    if (autoplay || wasPlaying) {
      speakFrom(idx, offset);
    } else {
      markBlock();
      save();
    }
  }
  function updateInfo() {
    var pct = blocks.length > 1 ? Math.round((idx / (blocks.length - 1)) * 100) : 100;
    $('est-info').textContent = (idx + 1) + '/' + blocks.length + ' · ' + pct + '%';
  }

  function initBar() {
    if (initialized) return;
    initialized = true;
    var bar = $('estudio-bar');
    bar.style.display = '';
    document.body.classList.add('est-on');
    document.body.style.paddingBottom = '128px';

    var chSel = $('est-chapter');
    blocks.forEach(function (el, i) {
      if (el.tagName === 'H1' || el.tagName === 'H2') {
        var o = document.createElement('option');
        o.value = i;
        o.textContent = (el.tagName === 'H1' ? '' : '· ') + el.textContent.trim().slice(0, 60);
        chSel.appendChild(o);
      }
    });
    chSel.onchange = function () { jump(parseInt(chSel.value, 10), true); closePopover(); };

    var settingsBtn = $('est-settings'), popover = $('est-popover');
    function openPopover() {
      popover.classList.add('is-open');
      settingsBtn.classList.add('is-open');
      settingsBtn.setAttribute('aria-expanded', 'true');
    }
    function closePopover() {
      popover.classList.remove('is-open');
      settingsBtn.classList.remove('is-open');
      settingsBtn.setAttribute('aria-expanded', 'false');
    }
    settingsBtn.onclick = function (e) {
      e.stopPropagation();
      if (popover.classList.contains('is-open')) closePopover(); else openPopover();
    };
    popover.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function (e) {
      if (popover.classList.contains('is-open') && !popover.contains(e.target) && !settingsBtn.contains(e.target)) closePopover();
    });

    $('est-play').onclick = function () { if (playing) pause(); else play(); };
    $('est-rate-btn').onclick = function () { setRateIdx(rateIdx + 1, { restart: true }); };
    $('est-voice').onchange = function () { save(); if (playing) jump(idx, true); };
    $('est-size-dec').onclick = function () { applyFontScale(fontScale - SIZE_STEP); };
    $('est-size-inc').onclick = function () { applyFontScale(fontScale + SIZE_STEP); };

    blocks.forEach(function (el, i) {
      el.addEventListener('click', function (e) {
        // Si el usuario está SELECCIONANDO texto (arrastrar para copiar), no leer:
        // el tap-en-punto no debe secuestrar la interacción de copiar una cita.
        var sel = window.getSelection();
        if (sel && sel.type === 'Range' && sel.toString().trim()) return;
        var offset = caretOffsetInBlock(el, e.clientX, e.clientY);
        jump(i, true, offset == null ? 0 : offset);
      });
    });

    function toggleBar() {
      var b = $('estudio-bar'), s = $('est-show');
      var hidden = b.style.display === 'none';
      b.style.display = hidden ? '' : 'none';
      s.style.display = hidden ? 'none' : 'flex';
      if (!hidden) closePopover();
    }
    $('est-hide').onclick = toggleBar;
    $('est-show').onclick = toggleBar;

    var gStart = null;
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { gStart = null; return; }
      var t = e.touches[0]; gStart = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (!gStart) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - gStart.x, dy = t.clientY - gStart.y;
      if (dx < -80 && Math.abs(dx) > Math.abs(dy) * 2) { if (playing) pause(); else play(); }
      gStart = null;
    }, { passive: true });

    document.addEventListener('keydown', function (e) {
      if (document.activeElement && /SELECT|INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'h') { e.preventDefault(); toggleBar(); return; }
      if (e.key === 'Escape') { closePopover(); return; }
      if (e.code === 'Space') { e.preventDefault(); if (playing) pause(); else play(); }
      if (e.key === 'ArrowRight') jump(idx + 1, false);
      if (e.key === 'ArrowLeft') jump(idx - 1, false);
      if (e.key === 'ArrowUp') { e.preventDefault(); setRateIdx(rateIdx + 1, { restart: true }); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setRateIdx(rateIdx - 1, { restart: true }); }
    });

    setRateIdx(Number.isInteger(saved.rateIdx) ? saved.rateIdx : 0);
    applyFontScale(saved.fontScale || 1);
    window.addEventListener('beforeunload', save);
    setPlayIcon(false);
    updateInfo();
  }

  // Gate 2: en la tarjeta chica del chat (~300px) la barra estorba — se queda
  // dormida. El fullscreen monta OTRO iframe (viewport alto) y ahí despierta.
  if (window.innerHeight >= 340) initBar();
  else window.addEventListener('resize', function () { if (window.innerHeight >= 340) initBar(); });
})();
</script>
`
