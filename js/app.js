/* PDFSathi – browser-only PDF editor. No server, no uploads. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const { PDFDocument, degrees } = window.PDFLib;
const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js';

/* ============================== state ============================== */
const SRC_COLORS = ['#6c5ce7', '#00b894', '#ff7675', '#0984e3', '#e17055', '#e84393'];
const A4 = [595.28, 841.89];
const S = { sources: new Map(), pages: [], selected: new Set(), view: 'home', cur: 0, tool: 'select', zoom: 1, selAnn: null };
const E = { scale: 1, token: 0 };
const hist = { undo: [], redo: [] };
const thumbCache = new Map();
let _id = 0;
const uid = () => 'p' + (++_id) + Math.random().toString(36).slice(2, 5);
const norm = (d) => ((((d % 360) + 540) % 360) - 180);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ============================== ui helpers ============================== */
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}
async function busy(msg, fn) {
  $('#busyMsg').textContent = msg; $('#busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30));
  try { return await fn(); }
  catch (e) { console.error(e); toast('Something went wrong: ' + (e.message || e), 'error'); }
  finally { $('#busy').hidden = true; }
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function loadImg(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
}
function readDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function dataURLBytes(url) {
  const b = atob(url.split(',')[1]); const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
function trimCanvas(c, pad = 10) {
  const x = c.getContext('2d'); const { width: w, height: h } = c;
  const d = x.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    if (d[(y * w + xx) * 4 + 3] > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const o = document.createElement('canvas');
  o.width = x1 - x0 + 1 + pad * 2; o.height = y1 - y0 + 1 + pad * 2;
  o.getContext('2d').drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return o;
}
const pageDisp = (p) => (p.rot % 180 ? [p.h, p.w] : [p.w, p.h]);
function toDisp(p, x, y) {
  switch (p.rot) { case 90: return [p.h - y, x]; case 180: return [p.w - x, p.h - y]; case 270: return [y, p.w - x]; default: return [x, y]; }
}
function toBase(p, u, v) {
  switch (p.rot) { case 90: return [v, p.h - u]; case 180: return [p.w - u, p.h - v]; case 270: return [p.w - v, u]; default: return [u, v]; }
}

/* ============================== history ============================== */
const cloneState = () => S.pages.map((p) => ({ ...p, annots: p.annots.map((a) => ({ ...a, cfg: a.cfg ? { ...a.cfg } : undefined })) }));
function snap() { hist.undo.push(cloneState()); if (hist.undo.length > 60) hist.undo.shift(); hist.redo = []; histBtns(); }
function histBtns() { $('#btnUndo').disabled = !hist.undo.length; $('#btnRedo').disabled = !hist.redo.length; }
function restore(st) {
  S.pages = st;
  const ids = new Set(S.pages.map((p) => p.id));
  S.selected = new Set([...S.selected].filter((i) => ids.has(i)));
  S.selAnn = null; histBtns();
  if (!S.pages.length) return goHome();
  if (S.view === 'editor') { S.cur = Math.min(S.cur, S.pages.length - 1); renderEditor(); } else renderGrid();
}
function undo() { if (!hist.undo.length) return; hist.redo.push(cloneState()); restore(hist.undo.pop()); }
function redo() { if (!hist.redo.length) return; hist.undo.push(cloneState()); restore(hist.redo.pop()); }

/* ============================== views ============================== */
function show(view) {
  S.view = view; document.body.dataset.view = view;
  ['home', 'workspace', 'editor'].forEach((v) => ($('#' + v).hidden = v !== view));
  const home = view === 'home';
  ['#btnUndo', '#btnRedo', '#btnAddTop', '#btnDownload'].forEach((s) => ($(s).hidden = home));
  updateSelbar();
  window.scrollTo(0, 0);
}
function goHome() { S.pages = []; S.sources.clear(); thumbCache.clear(); S.selected.clear(); hist.undo = []; hist.redo = []; histBtns(); show('home'); }

/* ============================== ingest files ============================== */
async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  await busy('Reading your files…', async () => {
    let added = 0;
    for (const f of files) {
      try {
        if (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name)) { await addImagePage(f); added++; continue; }
        if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { toast('Not a PDF or image: ' + f.name, 'error'); continue; }
        const bytes = await f.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
        const src = { id: uid(), name: f.name, bytes, doc, color: SRC_COLORS[S.sources.size % SRC_COLORS.length] };
        S.sources.set(src.id, src);
        for (let i = 0; i < doc.numPages; i++) {
          const pg = await doc.getPage(i + 1);
          const vp = pg.getViewport({ scale: 1 });
          S.pages.push({ id: uid(), kind: 'pdf', srcId: src.id, index: i, rot: 0, r0: pg.rotate || 0, w: vp.width, h: vp.height, annots: [] });
        }
        added++;
      } catch (e) {
        console.error(e);
        toast(e && e.name === 'PasswordException' ? 'Password-protected PDFs are not supported yet: ' + f.name : 'Could not open ' + f.name, 'error');
      }
    }
    if (!added) return;
    hist.undo = []; hist.redo = []; histBtns();
    const names = [...S.sources.values()];
    $('#outName').value = names.length === 1 && !S.pages.some((p) => p.kind !== 'pdf') ? names[0].name.replace(/\.pdf$/i, '') + '-edited.pdf' : 'merged.pdf';
    if (S.view === 'editor') renderEditor(); else { show('workspace'); renderGrid(); }
  });
}
async function addImagePage(f) {
  let url = await readDataURL(f);
  let img = await loadImg(url);
  const M = 3000, sc = Math.min(1, M / Math.max(img.width, img.height));
  let fmt = /jpe?g/i.test(f.type) ? 'jpg' : 'png';
  if (sc < 1 || !/png|jpe?g/i.test(f.type)) {
    const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    url = c.toDataURL(fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.92); img = await loadImg(url);
  }
  const L = A4[1], land = img.width > img.height;
  const w = land ? L : (L * img.width) / img.height, h = land ? (L * img.height) / img.width : L;
  S.pages.push({ id: uid(), kind: 'image', imgId: uid(), img, bytes: dataURLBytes(url), fmt, rot: 0, r0: 0, w, h, annots: [] });
}

/* ============================== thumbnails + grid ============================== */
async function getBase(p) {
  const key = p.kind === 'pdf' ? p.srcId + ':' + p.index : p.kind + ':' + (p.imgId || p.id);
  if (thumbCache.has(key)) return thumbCache.get(key);
  const pr = (async () => {
    const ts = 360 / p.w;
    const c = document.createElement('canvas');
    if (p.kind === 'pdf') {
      const pg = await S.sources.get(p.srcId).doc.getPage(p.index + 1);
      const vp = pg.getViewport({ scale: ts, rotation: p.r0 });
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: x, viewport: vp }).promise;
    } else {
      c.width = Math.round(p.w * ts); c.height = Math.round(p.h * ts);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      if (p.kind === 'image') x.drawImage(p.img, 0, 0, c.width, c.height);
    }
    return c;
  })();
  thumbCache.set(key, pr);
  return pr;
}
function compose(base, p) {
  const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
  const x = c.getContext('2d'); x.drawImage(base, 0, 0);
  const ts = base.width / p.w;
  for (const a of p.annots) {
    x.save(); x.translate(a.cx * ts, a.cy * ts); x.rotate((a.rot * Math.PI) / 180);
    x.drawImage(a.bmp, (-a.w * ts) / 2, (-a.h * ts) / 2, a.w * ts, a.h * ts); x.restore();
  }
  return c;
}
function layoutPaper(card, p) {
  const th = $('.thumb', card), paper = $('.paper', card);
  const bw = th.clientWidth - 18, bh = th.clientHeight - 18;
  const [dw, dh] = pageDisp(p);
  const s = Math.min(bw / dw, bh / dh);
  paper.style.width = dw * s + 'px'; paper.style.height = dh * s + 'px';
  const cv = $('canvas', paper);
  if (cv) {
    const cw = p.w * s, ch = p.h * s;
    Object.assign(cv.style, { width: cw + 'px', height: ch + 'px', left: (dw * s - cw) / 2 + 'px', top: (dh * s - ch) / 2 + 'px', transform: `rotate(${p.rot}deg)` });
  }
}
async function fillCard(card, p) {
  layoutPaper(card, p);
  try {
    const base = await getBase(p);
    const c = compose(base, p);
    const paper = $('.paper', card);
    $('canvas', paper)?.remove(); $('.ph', paper)?.remove();
    paper.appendChild(c); layoutPaper(card, p);
  } catch (e) { console.error(e); }
}
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
const IC = {
  ccw: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>', cw: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', dup: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  del: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
};
const ico = (k) => `<svg class="i" viewBox="0 0 24 24">${IC[k]}</svg>`;
let io;
function renderGrid() {
  const g = $('#grid'); g.innerHTML = '';
  io?.disconnect();
  io = new IntersectionObserver((ents) => {
    ents.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); const p = S.pages.find((q) => q.id === en.target.dataset.id); if (p) fillCard(en.target, p); } });
  }, { rootMargin: '300px' });
  S.pages.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'card' + (S.selected.has(p.id) ? ' sel' : ''); card.dataset.id = p.id;
    const src = p.kind === 'pdf' ? S.sources.get(p.srcId) : null;
    card.style.setProperty('--src', src ? src.color : '#94a3b8');
    card.innerHTML = `<div class="thumb"><div class="paper"><div class="ph"></div></div></div>
      <span class="num">${i + 1}</span><span class="chk" data-a="chk">${CHECK}</span>
      <div class="acts"><button data-a="ccw" title="Rotate left">${ico('ccw')}</button><button data-a="cw" title="Rotate right">${ico('cw')}</button><button data-a="edit" title="Edit page">${ico('edit')}</button><button data-a="dup" title="Duplicate">${ico('dup')}</button><button class="d" data-a="del" title="Delete">${ico('del')}</button></div>
      <div class="meta">${src ? esc(src.name) : p.kind === 'image' ? 'Image' : 'Blank page'}</div>`;
    g.appendChild(card);
    layoutPaper(card, p); io.observe(card);
  });
  $('#pageCount').textContent = S.pages.length;
  $('#srcCount').textContent = S.sources.size > 1 ? `from ${S.sources.size} files` : '';
  updateSelbar();
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renumber() { $$('#grid .card').forEach((c, i) => ($('.num', c).textContent = i + 1)); }

function updateSelbar() {
  const n = S.selected.size;
  $('#selbar').hidden = !(n && S.view === 'workspace');
  $('#selN').textContent = n;
}
function toggleSel(id, card) {
  if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
  card.classList.toggle('sel', S.selected.has(id)); updateSelbar();
}
function rotatePages(ids, d) {
  snap();
  ids.forEach((id) => { const p = S.pages.find((q) => q.id === id); if (p) { p.rot = (p.rot + d + 360) % 360; const c = $(`.card[data-id="${id}"]`); if (c) fillCard(c, p); } });
}
function duplicatePages(ids) {
  snap();
  const idset = new Set(ids); const out = [];
  for (const p of S.pages) {
    out.push(p);
    if (idset.has(p.id)) out.push({ ...p, id: uid(), annots: p.annots.map((a) => ({ ...a, id: uid(), cfg: a.cfg ? { ...a.cfg } : undefined })) });
  }
  S.pages = out; renderGrid();
}
function deletePages(ids) {
  snap(); const idset = new Set(ids);
  S.pages = S.pages.filter((p) => !idset.has(p.id));
  ids.forEach((i) => S.selected.delete(i));
  if (!S.pages.length) return goHome();
  renderGrid();
}
function pageAction(a, id, card) {
  const p = S.pages.find((q) => q.id === id);
  if (a === 'chk') toggleSel(id, card);
  else if (a === 'ccw') rotatePages([id], -90);
  else if (a === 'cw') rotatePages([id], 90);
  else if (a === 'dup') duplicatePages([id]);
  else if (a === 'del') deletePages([id]);
  else if (a === 'edit' && p) openEditor(S.pages.indexOf(p));
}

/* ============================== export / split ============================== */
async function exportPages(pages, onProgress) {
  const out = await PDFDocument.create();
  const bySrc = new Map();
  pages.forEach((p) => { if (p.kind === 'pdf') { if (!bySrc.has(p.srcId)) bySrc.set(p.srcId, []); bySrc.get(p.srcId).push(p); } });
  const copied = new Map();
  for (const [sid, list] of bySrc) {
    const lib = await PDFDocument.load(S.sources.get(sid).bytes, { ignoreEncryption: true, updateMetadata: false });
    const cp = await out.copyPages(lib, list.map((p) => p.index));
    list.forEach((p, i) => copied.set(p.id, cp[i]));
  }
  const imgCache = new Map();
  let n = 0;
  for (const pg of pages) {
    let page;
    if (pg.kind === 'pdf') { page = copied.get(pg.id); out.addPage(page); }
    else {
      page = out.addPage([pg.w, pg.h]);
      if (pg.kind === 'image') {
        const im = pg.fmt === 'jpg' ? await out.embedJpg(pg.bytes) : await out.embedPng(pg.bytes);
        page.drawImage(im, { x: 0, y: 0, width: pg.w, height: pg.h });
      }
    }
    if (pg.annots.length) {
      let vp = null;
      if (pg.kind === 'pdf') vp = (await S.sources.get(pg.srcId).doc.getPage(pg.index + 1)).getViewport({ scale: 1 });
      for (const a of pg.annots) {
        let emb = imgCache.get(a.url);
        if (!emb) { const b = dataURLBytes(a.url); emb = /^data:image\/jpe?g/i.test(a.url) ? await out.embedJpg(b) : await out.embedPng(b); imgCache.set(a.url, emb); }
        const [cx, cy] = vp ? vp.convertToPdfPoint(a.cx, a.cy) : [a.cx, pg.h - a.cy];
        const th = pg.r0 - a.rot, rad = (th * Math.PI) / 180;
        const hx = a.w / 2, hy = a.h / 2;
        page.drawImage(emb, {
          x: cx - (hx * Math.cos(rad) - hy * Math.sin(rad)), y: cy - (hx * Math.sin(rad) + hy * Math.cos(rad)),
          width: a.w, height: a.h, rotate: degrees(th),
        });
      }
    }
    page.setRotation(degrees((pg.r0 + pg.rot) % 360));
    if (onProgress) onProgress(++n, pages.length);
  }
  out.setProducer('PDFSathi'); out.setCreator('PDFSathi');
  return out.save();
}
const pdfBlob = (bytes) => new Blob([bytes], { type: 'application/pdf' });
const outFile = () => { let n = ($('#outName').value || 'merged.pdf').trim().replace(/[\\/:*?"<>|]+/g, '-'); return /\.pdf$/i.test(n) ? n : n + '.pdf'; };

function downloadAll() {
  busy('Building your PDF…', async () => {
    const bytes = await exportPages(S.pages);
    download(pdfBlob(bytes), outFile());
    toast('Done! Your PDF is downloaded.', 'ok');
  });
}
function parseRanges(str, max) {
  const res = [];
  for (const part of str.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error('Invalid range: ' + part);
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > max) throw new Error(`Pages must be between 1 and ${max}`);
    res.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  if (!res.length) throw new Error('Enter at least one range');
  return res;
}
function doSplit() {
  const mode = $('input[name=splitMode]:checked').value;
  const N = S.pages.length;
  let groups;
  try {
    if (mode === 'ranges') groups = parseRanges($('#splitRanges').value, N);
    else if (mode === 'every') { const k = Math.max(1, +$('#splitEvery').value || 1); groups = []; for (let i = 0; i < N; i += k) groups.push(Array.from({ length: Math.min(k, N - i) }, (_, j) => i + j)); }
    else groups = S.pages.map((_, i) => [i]);
  } catch (e) { return toast(e.message, 'error'); }
  closeModal('splitModal');
  const base = outFile().replace(/\.pdf$/i, '');
  busy('Splitting…', async () => {
    if (mode === 'ranges' && $('#splitOne').checked) {
      const bytes = await exportPages(groups.flat().map((i) => S.pages[i]));
      download(pdfBlob(bytes), base + '-extract.pdf');
    } else if (groups.length === 1) {
      download(pdfBlob(await exportPages(groups[0].map((i) => S.pages[i]))), base + '-part1.pdf');
    } else {
      const zip = new JSZip();
      for (let g = 0; g < groups.length; g++) {
        const label = groups[g].length === 1 ? 'page-' + (groups[g][0] + 1) : `pages-${groups[g][0] + 1}-${groups[g][groups[g].length - 1] + 1}`;
        zip.file(`${base}-${label}.pdf`, await exportPages(groups[g].map((i) => S.pages[i])));
      }
      download(await zip.generateAsync({ type: 'blob' }), base + '-split.zip');
    }
    toast('Split complete!', 'ok');
  });
}

/* ============================== annotations ============================== */
const TEXT_FONTS = [['Inter', 'Sans'], ['Lora', 'Serif'], ['Roboto Mono', 'Mono'], ['Hind', 'Hindi · हिन्दी'], ['Caveat', 'Handwriting'], ['Kalam', 'Kalam · हस्तलेख']];
const K = 4; // bitmap pixels per point for text
async function ensureFont(font, text, weight = 400) {
  try { await document.fonts.load(`${weight} 40px "${font}"`, text || 'Aa'); } catch {}
}
function renderText(cfg) {
  const lines = cfg.text.split('\n');
  const x0 = document.createElement('canvas').getContext('2d');
  const fam = `"${cfg.font}","Hind",sans-serif`;
  const font = `${cfg.bold ? 700 : 400} ${cfg.fs * K}px ${fam}`;
  x0.font = font;
  const wmax = Math.max(1, ...lines.map((l) => x0.measureText(l || ' ').width)) / K;
  const lh = cfg.fs * 1.4, pad = cfg.fs * 0.15;
  const w = wmax + pad * 2, h = lines.length * lh + pad * 2;
  const c = document.createElement('canvas');
  c.width = Math.min(4096, Math.ceil(w * K)); c.height = Math.min(4096, Math.ceil(h * K));
  const x = c.getContext('2d'); x.font = font; x.fillStyle = cfg.color; x.textBaseline = 'alphabetic';
  lines.forEach((l, i) => x.fillText(l, pad * K, (pad + i * lh + cfg.fs * 1.05) * K));
  return { c, w, h };
}
const curPage = () => S.pages[S.cur];
const annById = (id) => curPage()?.annots.find((a) => a.id === id);

function placeAnn({ type, bmp, url, w, h, cfg, tilt = 0, at, free = false }) {
  const p = curPage();
  const n = p.annots.length % 4, [vx, vy] = viewCenter();
  const [dx, dy] = at || [vx + n * 16, vy + n * 16];
  const [cx, cy] = toBase(p, dx, dy);
  const a = { id: uid(), type, cx, cy, w, h, rot: norm(-p.rot + tilt), bmp, url: url || bmp.toDataURL('image/png'), cfg, free };
  snap(); p.annots.push(a);
  mountAnn(a); selectAnn(a.id);
  return a;
}
function viewCenter() {
  const st = $('#stage').getBoundingClientRect(), pw = $('#pageWrap').getBoundingClientRect();
  const cx = (Math.max(st.left, pw.left) + Math.min(st.right, pw.right)) / 2;
  const cy = (Math.max(st.top, pw.top) + Math.min(st.bottom, pw.bottom)) / 2;
  return [(cx - pw.left) / E.scale, (cy - pw.top) / E.scale];
}
function mountAnn(a) {
  const el = document.createElement('div');
  el.className = 'ann'; el.dataset.id = a.id;
  el.innerHTML = `<img alt="" draggable="false"><i class="h"></i>`;
  $('img', el).src = a.url;
  $('#annLayer').appendChild(el); layoutAnn(el, a);
  return el;
}
function layoutAnn(el, a) {
  const p = curPage(), s = E.scale, [dx, dy] = toDisp(p, a.cx, a.cy);
  Object.assign(el.style, { width: a.w * s + 'px', height: a.h * s + 'px', left: dx * s - (a.w * s) / 2 + 'px', top: dy * s - (a.h * s) / 2 + 'px', transform: `rotate(${a.rot + p.rot}deg)` });
}
const annEl = (id) => $(`.ann[data-id="${id}"]`);
function selectAnn(id) {
  S.selAnn = id;
  $$('.ann').forEach((e) => e.classList.toggle('sel', e.dataset.id === id));
  renderProps();
}
function removeAnn(id) {
  const p = curPage(); snap(); p.annots = p.annots.filter((a) => a.id !== id);
  annEl(id)?.remove(); selectAnn(null);
}
function dupAnn(id) {
  const a = annById(id); if (!a) return;
  const p = curPage(); snap();
  const b = { ...a, id: uid(), cfg: a.cfg ? { ...a.cfg } : undefined, cx: a.cx + 14, cy: a.cy + 14 };
  p.annots.push(b); mountAnn(b); selectAnn(b.id);
}

/* ---- text annotations ---- */
async function newText(at) {
  const cfg = { text: 'Type here', font: 'Inter', fs: 16, color: '#111827', bold: false };
  await ensureFont(cfg.font, cfg.text);
  const { c, w, h } = renderText(cfg);
  placeAnn({ type: 'text', bmp: c, w, h, cfg, at });
  setTool('select');
  const ta = $('#pText'); if (ta) { ta.focus(); ta.select(); }
}
async function refreshText(a) {
  await ensureFont(a.cfg.font, a.cfg.text, a.cfg.bold ? 700 : 400);
  const { c, w, h } = renderText(a.cfg);
  a.bmp = c; a.url = c.toDataURL('image/png'); a.w = w; a.h = h;
  const el = annEl(a.id); if (el) { $('img', el).src = a.url; layoutAnn(el, a); }
}

/* ---- properties bar ---- */
function renderProps() {
  const box = $('#props'); const a = S.selAnn && annById(S.selAnn);
  if (!a) { box.hidden = true; box.innerHTML = ''; return; }
  const p = curPage();
  let h = '';
  if (a.type === 'text') {
    h += `<textarea id="pText" rows="1" placeholder="Your text (Hindi works too)">${esc(a.cfg.text)}</textarea>
      <select id="pFont">${TEXT_FONTS.map(([f, l]) => `<option value="${f}" ${a.cfg.font === f ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>Size <input type="number" id="pSize" min="6" max="120" value="${Math.round(a.cfg.fs)}"></label>
      <button class="tg ${a.cfg.bold ? 'on' : ''}" id="pBold" title="Bold">B</button>
      <input type="color" id="pColor" value="${a.cfg.color}" title="Colour">`;
  } else if (a.type === 'cover') {
    h += `<label>Cover colour <input type="color" id="pColor" value="${a.cfg.color}"></label><span class="muted small">Hides what’s underneath — add Text on top to replace it.</span>`;
  }
  h += `<label>Tilt <input type="range" id="pTilt" min="-180" max="180" value="${Math.round(norm(a.rot + p.rot))}"></label>
    <span class="sp"></span>
    <button class="btn soft sm" id="pDup">Duplicate</button><button class="btn danger sm" id="pDel">Delete</button>`;
  box.innerHTML = h; box.hidden = false;
  const on = (sel, ev, fn) => { const e = $(sel, box); if (e) e.addEventListener(ev, fn); };
  if (a.type === 'text') {
    let first = true; const touch = () => { if (first) { snap(); first = false; } };
    on('#pText', 'input', (e) => { touch(); a.cfg.text = e.target.value || ' '; refreshText(a); });
    on('#pFont', 'change', (e) => { snap(); a.cfg.font = e.target.value; refreshText(a); });
    on('#pSize', 'input', (e) => { touch(); a.cfg.fs = Math.max(6, Math.min(120, +e.target.value || 16)); refreshText(a); });
    on('#pBold', 'click', (e) => { snap(); a.cfg.bold = !a.cfg.bold; e.currentTarget.classList.toggle('on', a.cfg.bold); refreshText(a); });
    on('#pColor', 'input', (e) => { touch(); a.cfg.color = e.target.value; refreshText(a); });
  } else if (a.type === 'cover') {
    on('#pColor', 'input', (e) => { a.cfg.color = e.target.value; makeCoverBmp(a); const el = annEl(a.id); $('img', el).src = a.url; });
  }
  let tf = true;
  on('#pTilt', 'input', (e) => { if (tf) { snap(); tf = false; } a.rot = norm(+e.target.value - p.rot); layoutAnn(annEl(a.id), a); });
  on('#pDup', 'click', () => dupAnn(a.id));
  on('#pDel', 'click', () => removeAnn(a.id));
}
function makeCoverBmp(a) {
  const c = document.createElement('canvas'); c.width = c.height = 4;
  const x = c.getContext('2d'); x.fillStyle = a.cfg.color; x.fillRect(0, 0, 4, 4);
  a.bmp = c; a.url = c.toDataURL('image/png');
}

/* ---- dragging / resizing ---- */
function startDrag(ev, a, el) {
  const p = curPage(), s = E.scale, [dx0, dy0] = toDisp(p, a.cx, a.cy), sx = ev.clientX, sy = ev.clientY;
  let moved = false;
  const mv = (e) => {
    const ddx = (e.clientX - sx) / s, ddy = (e.clientY - sy) / s;
    if (!moved) { if (Math.hypot(ddx, ddy) * s < 3) return; snap(); moved = true; }
    [a.cx, a.cy] = toBase(p, dx0 + ddx, dy0 + ddy); layoutAnn(el, a);
  };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
function startResize(ev, a, el) {
  ev.preventDefault();
  const p = curPage(), s = E.scale;
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const d0 = Math.max(10, Math.hypot(ev.clientX - cx, ev.clientY - cy));
  const w0 = a.w, h0 = a.h, fs0 = a.cfg?.fs, ang = ((a.rot + p.rot) * Math.PI) / 180;
  let did = false;
  const mv = (e) => {
    if (!did) { snap(); did = true; }
    if (a.free) {
      const vx = e.clientX - cx, vy = e.clientY - cy;
      const lx = vx * Math.cos(-ang) - vy * Math.sin(-ang), ly = vx * Math.sin(-ang) + vy * Math.cos(-ang);
      a.w = Math.max(8, (2 * Math.abs(lx)) / s); a.h = Math.max(6, (2 * Math.abs(ly)) / s);
    } else {
      let k = Math.hypot(e.clientX - cx, e.clientY - cy) / d0;
      if (a.type === 'text') { a.cfg.fs = Math.max(6, Math.min(160, fs0 * k)); const t = renderText(a.cfg); a.bmp = t.c; a.url = t.c.toDataURL('image/png'); a.w = t.w; a.h = t.h; $('img', el).src = a.url; }
      else { k = Math.max(12 / w0, k); a.w = w0 * k; a.h = h0 * k; }
    }
    layoutAnn(el, a);
  };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); if (a.type === 'text') { const sz = $('#pSize'); if (sz) sz.value = Math.round(a.cfg.fs); } };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
function startCover(ev) {
  const lay = $('#annLayer'), r = lay.getBoundingClientRect(), s = E.scale;
  const x0 = ev.clientX - r.left, y0 = ev.clientY - r.top;
  const d = document.createElement('div'); d.className = 'draftbox'; lay.appendChild(d);
  const rect = (e) => { const x1 = e.clientX - r.left, y1 = e.clientY - r.top; return { l: Math.min(x0, x1), t: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }; };
  const mv = (e) => { const q = rect(e); Object.assign(d.style, { left: q.l + 'px', top: q.t + 'px', width: q.w + 'px', height: q.h + 'px' }); };
  const up = (e) => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    d.remove(); let q = rect(e);
    if (q.w < 6 && q.h < 6) q = { l: x0 - 70, t: y0 - 14, w: 140, h: 28 };
    const a = placeAnn({ type: 'cover', bmp: document.createElement('canvas'), url: 'x', w: q.w / s, h: q.h / s, cfg: { color: '#ffffff' }, at: [(q.l + q.w / 2) / s, (q.t + q.h / 2) / s], free: true });
    makeCoverBmp(a); $('img', annEl(a.id)).src = a.url; setTool('select');
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

/* ============================== editor ============================== */
async function openEditor(i) { S.cur = i; S.selAnn = null; show('editor'); await renderEditor(); }
async function renderEditor() {
  const p = curPage(); if (!p) return;
  const my = ++E.token;
  $('#edNum').textContent = S.cur + 1; $('#edTotal').textContent = S.pages.length;
  $('#edPrev').disabled = S.cur === 0; $('#edNext').disabled = S.cur === S.pages.length - 1;
  const [dw, dh] = pageDisp(p);
  const stage = $('#stage');
  const cs = getComputedStyle(stage), availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const fit = Math.min(availW / dw, 1.45);
  E.scale = Math.max(0.1, fit * S.zoom);
  $('#zoomLbl').textContent = Math.round(S.zoom * 100) + '%';
  const wrap = $('#pageWrap');
  wrap.style.width = dw * E.scale + 'px'; wrap.style.height = dh * E.scale + 'px';
  // annotations
  const lay = $('#annLayer'); lay.innerHTML = '';
  p.annots.forEach((a) => mountAnn(a));
  $$('.ann').forEach((e) => e.classList.toggle('sel', e.dataset.id === S.selAnn));
  if (!(S.selAnn && annById(S.selAnn))) { S.selAnn = null; }
  renderProps();
  // page bitmap
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5, 4096 / (dw * E.scale), 4096 / (dh * E.scale));
  const sc = E.scale * dpr;
  const off = document.createElement('canvas');
  off.width = Math.ceil(dw * sc); off.height = Math.ceil(dh * sc);
  const x = off.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, off.width, off.height);
  if (p.kind === 'pdf') {
    const pg = await S.sources.get(p.srcId).doc.getPage(p.index + 1);
    const vp = pg.getViewport({ scale: sc, rotation: (p.r0 + p.rot) % 360 });
    off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
    const x2 = off.getContext('2d'); x2.fillStyle = '#fff'; x2.fillRect(0, 0, off.width, off.height);
    await pg.render({ canvasContext: x2, viewport: vp }).promise;
  } else if (p.kind === 'image') {
    x.translate(off.width / 2, off.height / 2); x.rotate((p.rot * Math.PI) / 180);
    x.drawImage(p.img, (-p.w * sc) / 2, (-p.h * sc) / 2, p.w * sc, p.h * sc);
  }
  if (my !== E.token) return;
  const cv = $('#pageCanvas'); cv.width = off.width; cv.height = off.height;
  cv.getContext('2d').drawImage(off, 0, 0);
}
function setTool(t) {
  S.tool = t;
  $$('#rail button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $('#stage').className = 'stage tool-' + t;
}
function railClick(t) {
  if (t === 'select') return setTool('select');
  if (t === 'text') { setTool('text'); return toast('Tap anywhere on the page to add text'); }
  if (t === 'cover') { setTool('cover'); return toast('Drag over the area you want to hide'); }
  if (t === 'sign') return openSig();
  if (t === 'stamp') return openStamp();
  if (t === 'image') return $('#imgInput').click();
  if (t === 'rotL') { snap(); const p = curPage(); p.rot = (p.rot + 90) % 360; selectAnn(null); renderEditor(); }
}
async function addPlacedImage(file) {
  let url = await readDataURL(file); let img = await loadImg(url);
  const M = 1800, sc = Math.min(1, M / Math.max(img.width, img.height));
  if (sc < 1) { const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); url = c.toDataURL(/jpe?g/i.test(file.type) ? 'image/jpeg' : 'image/png', 0.9); img = await loadImg(url); }
  if (!/^data:image\/(png|jpe?g)/i.test(url)) { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); url = c.toDataURL('image/png'); img = await loadImg(url); }
  const p = curPage(), [dw] = pageDisp(p);
  const w = Math.min(260, dw * 0.5), h = (w * img.height) / img.width;
  placeAnn({ type: 'image', bmp: img, url, w, h });
}

/* ============================== modals ============================== */
function openModal(id) { $('#' + id).hidden = false; }
function closeModal(id) { $('#' + id).hidden = true; }

/* ============================== signature studio ============================== */
const SIG_FONTS = [['Dancing Script', 600], ['Great Vibes', 400], ['Allura', 400], ['Sacramento', 400], ['Satisfy', 400], ['Yellowtail', 400], ['Mrs Saint Delafield', 400], ['Homemade Apple', 400], ['Kaushan Script', 400], ['Caveat', 700], ['Kalam', 400]];
const INKS = ['#111827', '#1d3fd8', '#0b2a6f', '#b91c1c'];
const SG = { tab: 'type', font: 'Dancing Script', weight: 600, ink: INKS[0], name: '', strokes: [], up: null };
function sigInit() {
  const g = $('#sigFonts'); g.innerHTML = '';
  SIG_FONTS.forEach(([f, w]) => {
    const b = document.createElement('button'); b.className = 'fontopt'; b.dataset.f = f; b.dataset.w = w;
    b.style.fontFamily = `"${f}","Kalam",cursive`; b.style.fontWeight = w; b.onclick = () => { SG.font = f; SG.weight = w; sigPaintFonts(); };
    g.appendChild(b);
  });
  const ink = $('#sigInk'); ink.innerHTML = '';
  INKS.forEach((c) => { const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.dataset.c = c; b.onclick = () => { SG.ink = c; sigPaintInk(); padRedraw(); upRedraw(); }; ink.appendChild(b); });
  const ci = document.createElement('input'); ci.type = 'color'; ci.value = '#111827'; ci.title = 'Custom colour'; ci.oninput = (e) => { SG.ink = e.target.value; sigPaintInk(); padRedraw(); upRedraw(); }; ink.appendChild(ci);
  $('#sigName').addEventListener('input', (e) => { SG.name = e.target.value; sigPaintFonts(); });
  $$('#sigTabs button').forEach((b) => (b.onclick = () => sigTab(b.dataset.tab)));
  $('#sigUse').onclick = sigUse;
  $('#padClear').onclick = () => { SG.strokes = []; padRedraw(); };
  $('#padUndo').onclick = () => { SG.strokes.pop(); padRedraw(); };
  $('#sigFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; SG.up = await loadImg(await readDataURL(f)); upRedraw(); e.target.value = ''; };
  $('#sigBg').onchange = upRedraw;
  padInit();
}
function sigPaintFonts() {
  const name = SG.name.trim() || 'Your Name';
  $$('#sigFonts .fontopt').forEach((b) => {
    b.textContent = name; b.style.color = SG.ink; b.classList.toggle('on', b.dataset.f === SG.font);
    b.style.fontSize = '2rem';
    const k = (b.clientWidth - 20) / Math.max(1, b.scrollWidth);
    if (b.clientWidth && k < 1) b.style.fontSize = Math.max(0.9, 2 * k) + 'rem';
  });
}
function sigPaintInk() { $$('#sigInk .sw').forEach((b) => b.classList.toggle('on', b.dataset.c === SG.ink)); sigPaintFonts(); }
function sigTab(t) {
  SG.tab = t;
  $$('#sigTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('#sigModal .pane').forEach((p) => (p.hidden = p.dataset.pane !== t));
}
function openSig() {
  if (!$('#sigFonts').children.length) sigInit();
  sigPaintInk(); sigPaintFonts(); sigSavedPaint(); openModal('sigModal');
  Promise.all([...SIG_FONTS.map(([f, w]) => ensureFont(f, 'Aa', w)), ensureFont('Kalam', 'अ')]).then(sigPaintFonts);
  setTimeout(() => $('#sigName').focus(), 60);
}
function padInit() {
  const cv = $('#sigPad'); let cur = null;
  const pt = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * cv.width, ((e.clientY - r.top) / r.height) * cv.height]; };
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); cur = [pt(e)]; SG.strokes.push(cur); padRedraw(); });
  cv.addEventListener('pointermove', (e) => { if (!cur) return; cur.push(pt(e)); padRedraw(); });
  const end = () => { cur = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}
function padRedraw() {
  const cv = $('#sigPad'), x = cv.getContext('2d');
  x.clearRect(0, 0, cv.width, cv.height); x.strokeStyle = x.fillStyle = SG.ink; x.lineWidth = 6; x.lineCap = x.lineJoin = 'round';
  SG.strokes.forEach((s) => {
    if (s.length === 1) { x.beginPath(); x.arc(s[0][0], s[0][1], 3, 0, 7); x.fill(); return; }
    x.beginPath(); x.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length - 1; i++) { const mx = (s[i][0] + s[i + 1][0]) / 2, my = (s[i][1] + s[i + 1][1]) / 2; x.quadraticCurveTo(s[i][0], s[i][1], mx, my); }
    const l = s[s.length - 1]; x.lineTo(l[0], l[1]); x.stroke();
  });
}
function upCanvas() {
  if (!SG.up) return null;
  const img = SG.up, sc = Math.min(1, 1100 / img.width);
  const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
  if ($('#sigBg').checked) {
    const d = x.getImageData(0, 0, c.width, c.height), px = d.data;
    const hex = SG.ink, R = parseInt(hex.slice(1, 3), 16), G = parseInt(hex.slice(3, 5), 16), B = parseInt(hex.slice(5, 7), 16);
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
      const a = lum >= 225 ? 0 : lum <= 120 ? 255 : ((225 - lum) / 105) * 255;
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = Math.min(px[i + 3], a);
    }
    x.putImageData(d, 0, 0);
  }
  return c;
}
function upRedraw() {
  const c = upCanvas(), pv = $('#sigUpPrev'), x = pv.getContext('2d'); x.clearRect(0, 0, pv.width, pv.height);
  if (!c) return;
  const s = Math.min(pv.width / c.width, pv.height / c.height); x.drawImage(c, 0, 0, c.width * s, c.height * s);
  pv.style.width = c.width * s + 'px'; pv.style.height = c.height * s + 'px';
}
async function sigFromType() {
  const txt = SG.name.trim() || 'Your Name';
  await ensureFont(SG.font, txt, SG.weight); await ensureFont('Kalam', txt);
  const c = document.createElement('canvas'); c.width = 2400; c.height = 600;
  const x = c.getContext('2d'); let fs = 240;
  const fam = `"${SG.font}","Kalam",cursive`;
  x.font = `${SG.weight} ${fs}px ${fam}`;
  const w = x.measureText(txt).width; if (w > 2200) { fs = (fs * 2200) / w; x.font = `${SG.weight} ${fs}px ${fam}`; }
  x.fillStyle = SG.ink; x.textAlign = 'center'; x.textBaseline = 'alphabetic'; x.fillText(txt, 1200, 380);
  return trimCanvas(c, 20);
}
async function sigUse() {
  let c = null;
  if (SG.tab === 'type') { if (!SG.name.trim()) { toast('Type your name first'); return $('#sigName').focus(); } c = await sigFromType(); }
  else if (SG.tab === 'draw') { if (!SG.strokes.length) return toast('Draw your signature first'); c = trimCanvas($('#sigPad'), 16); }
  else { const u = upCanvas(); if (!u) return toast('Choose an image first'); c = trimCanvas(u, 10) || u; }
  if (!c) return toast('Nothing to place yet');
  if ($('#sigSave').checked) { const l = store.get('ps.sigs', []); l.unshift(c.toDataURL('image/png')); store.set('ps.sigs', l.slice(0, 6)); }
  closeModal('sigModal'); placeSig(c);
}
function placeSig(c) {
  let w = 160, h = (w * c.height) / c.width;
  if (h > 80) { h = 80; w = (h * c.width) / c.height; }
  placeAnn({ type: 'sign', bmp: c, w, h }); setTool('select');
}
function sigSavedPaint() {
  const l = store.get('ps.sigs', []), box = $('#sigSaved'); box.innerHTML = '';
  $('#sigSavedWrap').hidden = !l.length;
  l.forEach((u, i) => {
    const d = document.createElement('div'); d.className = 'it'; d.innerHTML = `<img alt="saved signature" src="${u}"><button class="rm" title="Remove">×</button>`;
    d.onclick = async (e) => { if (e.target.closest('.rm')) { const n = store.get('ps.sigs', []); n.splice(i, 1); store.set('ps.sigs', n); return sigSavedPaint(); } const im = await loadImg(u); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0); closeModal('sigModal'); placeSig(c); };
    box.appendChild(d);
  });
}

/* ============================== stamp maker ============================== */
const ST_COLORS = ['#dc2626', '#1d4ed8', '#15803d', '#7c3aed', '#b45309', '#0f766e', '#111827'];
const ST = { shape: 'rect', text1: 'APPROVED', text2: '', text3: '', color: '#15803d', font: 'sans', border: 'medium', date: true, rubber: 1, tilt: -8, seed: 7 };
let stInited = false;
function stInit() {
  stInited = true;
  const pr = $('#stampPresets');
  PS.STAMP_PRESETS.forEach((p) => { const b = document.createElement('button'); b.textContent = p.name; b.onclick = () => { Object.assign(ST, p, { seed: (Math.random() * 1e6) | 0 }); stSync(); }; pr.appendChild(b); });
  const sw = $('#stColors');
  ST_COLORS.forEach((c) => { const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.dataset.c = c; b.onclick = () => { ST.color = c; stSync(); }; sw.appendChild(b); });
  const ci = document.createElement('input'); ci.type = 'color'; ci.value = '#dc2626'; ci.oninput = (e) => { ST.color = e.target.value; stSync(); }; sw.appendChild(ci);
  const seg = (id, key, conv = (v) => v) => $$('#' + id + ' button').forEach((b) => (b.onclick = () => { ST[key] = conv(b.dataset.v); if (key === 'rubber') ST.seed = (Math.random() * 1e6) | 0; stSync(); }));
  seg('stShape', 'shape'); seg('stBorder', 'border'); seg('stRubber', 'rubber', Number);
  $('#stText1').oninput = (e) => { ST.text1 = e.target.value; stDraw(); };
  $('#stText2').oninput = (e) => { ST.text2 = e.target.value; stDraw(); };
  $('#stText3').oninput = (e) => { ST.text3 = e.target.value; stDraw(); };
  $('#stDate').onchange = (e) => { ST.date = e.target.checked; stDraw(); };
  $('#stFont').onchange = (e) => { ST.font = e.target.value; stDraw(); };
  $('#stTilt').oninput = (e) => { ST.tilt = +e.target.value; $('#tiltOut').textContent = ST.tilt + '°'; };
  $('#stUse').onclick = stUse; $('#stSave').onclick = stSave;
}
function stSync() {
  $$('#stShape button').forEach((b) => b.classList.toggle('on', b.dataset.v === ST.shape));
  $$('#stBorder button').forEach((b) => b.classList.toggle('on', b.dataset.v === ST.border));
  $$('#stRubber button').forEach((b) => b.classList.toggle('on', +b.dataset.v === ST.rubber));
  $$('#stColors .sw').forEach((b) => b.classList.toggle('on', b.dataset.c === ST.color));
  $('#stText1').value = ST.text1; $('#stText2').value = ST.text2; $('#stText3').value = ST.text3;
  $('#stDate').checked = ST.date; $('#stFont').value = ST.font; $('#stTilt').value = ST.tilt; $('#tiltOut').textContent = ST.tilt + '°';
  const seal = ST.shape === 'seal';
  $('#lblT2').textContent = seal ? 'Top curved text' : 'Small line below'; $('#fldT3').hidden = !seal;
  stDraw();
}
let stToken = 0;
async function stDraw() {
  const my = ++stToken;
  await PS.loadStampFonts(ST.text1 + ST.text2 + ST.text3);
  if (my !== stToken) return;
  const c = PS.renderStamp(ST), pv = $('#stampPrev');
  pv.width = c.width; pv.height = c.height; pv.getContext('2d').drawImage(c, 0, 0);
  pv.style.maxWidth = Math.min(c.width, 420) + 'px';
}
async function stUse() {
  if (!ST.text1.trim() && !ST.text2.trim()) return toast('Write some text for the stamp');
  await PS.loadStampFonts(ST.text1 + ST.text2 + ST.text3);
  const c = PS.renderStamp(ST), [W, H] = [c.width, c.height];
  const w = ST.shape === 'circle' || ST.shape === 'seal' ? 130 : ST.shape === 'oval' ? 170 : 190;
  closeModal('stampModal');
  placeAnn({ type: 'stamp', bmp: c, w, h: (w * H) / W, tilt: ST.tilt }); setTool('select');
}
function stSave() {
  const l = store.get('ps.stamps', []); l.unshift({ ...ST }); store.set('ps.stamps', l.slice(0, 8)); stSavedPaint(); toast('Saved to My stamps', 'ok');
}
function stSavedPaint() {
  const l = store.get('ps.stamps', []), box = $('#stSaved'); box.innerHTML = '';
  $('#stSavedWrap').hidden = !l.length;
  l.forEach((cfg, i) => {
    const c = PS.renderStamp(cfg), d = document.createElement('div'); d.className = 'it';
    d.innerHTML = `<img alt="saved stamp" src="${c.toDataURL('image/png')}"><button class="rm" title="Remove">×</button>`;
    d.onclick = (e) => { if (e.target.closest('.rm')) { const n = store.get('ps.stamps', []); n.splice(i, 1); store.set('ps.stamps', n); return stSavedPaint(); } Object.assign(ST, cfg); stSync(); };
    box.appendChild(d);
  });
}
async function openStamp() {
  if (!stInited) stInit();
  openModal('stampModal'); await PS.loadStampFonts('Aa अ'); stSync(); stSavedPaint();
}

/* ============================== wiring ============================== */
function wire() {
  const fi = $('#fileInput');
  fi.onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  const pick = () => fi.click();
  $('#btnAddTop').onclick = pick; $('#addTile').onclick = pick;
  $('#btnDownload').onclick = downloadAll;
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#btnSelAll').onclick = () => { const all = S.selected.size === S.pages.length; S.selected = new Set(all ? [] : S.pages.map((p) => p.id)); renderGrid(); };
  $('#btnBlank').onclick = () => {
    snap(); const last = S.pages[S.pages.length - 1];
    const [w, h] = last ? [last.w, last.h] : A4;
    S.pages.push({ id: uid(), kind: 'blank', rot: 0, r0: 0, w, h, annots: [] }); renderGrid();
  };
  $('#btnSplit').onclick = () => { $('#splitTotal').textContent = S.pages.length; openModal('splitModal'); };
  $('#splitGo').onclick = doSplit;
  $$('input[name=splitMode]').forEach((r) => (r.onchange = () => ($('#splitMergeRow').hidden = $('input[name=splitMode]:checked').value !== 'ranges')));

  // grid
  const grid = $('#grid');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card'); if (!card) return;
    const b = e.target.closest('[data-a]');
    if (b) return pageAction(b.dataset.a, card.dataset.id, card);
    if (e.target.closest('.thumb')) pageAction('edit', card.dataset.id, card);
  });
  new Sortable(grid, {
    animation: 180, ghostClass: 'sortable-ghost', filter: '.acts,.chk', preventOnFilter: false, delay: 140, delayOnTouchOnly: true,
    onEnd: (e) => { if (e.oldIndex === e.newIndex) return; snap(); const [m] = S.pages.splice(e.oldIndex, 1); S.pages.splice(e.newIndex, 0, m); renumber(); },
  });
  // selection bar
  $('#selbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sel]'); if (!b) return;
    const ids = S.pages.filter((p) => S.selected.has(p.id)).map((p) => p.id), a = b.dataset.sel;
    if (a === 'ccw') rotatePages(ids, -90); else if (a === 'cw') rotatePages(ids, 90);
    else if (a === 'dup') duplicatePages(ids); else if (a === 'del') deletePages(ids);
    else if (a === 'clear') { S.selected.clear(); renderGrid(); }
    else if (a === 'extract') busy('Extracting…', async () => { const bytes = await exportPages(S.pages.filter((p) => S.selected.has(p.id))); download(pdfBlob(bytes), outFile().replace(/\.pdf$/i, '') + '-extract.pdf'); toast('Extracted!', 'ok'); });
  });

  // editor
  $('#edBack').onclick = () => { selectAnn(null); show('workspace'); renderGrid(); };
  $('#edPrev').onclick = () => { if (S.cur > 0) { S.cur--; S.selAnn = null; renderEditor(); } };
  $('#edNext').onclick = () => { if (S.cur < S.pages.length - 1) { S.cur++; S.selAnn = null; renderEditor(); } };
  $('#zoomIn').onclick = () => { S.zoom = Math.min(3, +(S.zoom + 0.25).toFixed(2)); renderEditor(); };
  $('#zoomOut').onclick = () => { S.zoom = Math.max(0.5, +(S.zoom - 0.25).toFixed(2)); renderEditor(); };
  $$('#rail button').forEach((b) => (b.onclick = () => railClick(b.dataset.tool)));
  $('#imgInput').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await busy('Adding image…', () => addPlacedImage(f)); };
  const lay = $('#annLayer');
  lay.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.ann');
    if (el) {
      const a = annById(el.dataset.id); if (!a) return;
      if (e.target.classList.contains('h')) return startResize(e, a, el);
      if (S.selAnn !== a.id) selectAnn(a.id);
      return startDrag(e, a, el);
    }
    const r = lay.getBoundingClientRect(), at = [(e.clientX - r.left) / E.scale, (e.clientY - r.top) / E.scale];
    if (S.tool === 'text') { e.preventDefault(); return newText(at); }
    if (S.tool === 'cover') { e.preventDefault(); return startCover(e); }
    selectAnn(null);
  });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.view === 'editor') renderEditor(); else if (S.view === 'workspace') $$('#grid .card').forEach((c) => { const p = S.pages.find((q) => q.id === c.dataset.id); if (p) layoutPaper(c, p); }); }, 200); });

  // modals
  $$('.modal').forEach((m) => {
    m.addEventListener('pointerdown', (e) => { if (e.target === m) m.hidden = true; });
    $$('[data-close]', m).forEach((b) => (b.onclick = () => (m.hidden = true)));
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') { $$('.modal').forEach((m) => (m.hidden = true)); if (S.view === 'editor') { selectAnn(null); setTool('select'); } return; }
    if ((e.ctrlKey || e.metaKey) && !typing) {
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (e.key.toLowerCase() === 'd' && S.selAnn) { e.preventDefault(); dupAnn(S.selAnn); return; }
    }
    if (typing || S.view !== 'editor' || !S.selAnn) return;
    const a = annById(S.selAnn); if (!a) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeAnn(a.id); return; }
    const st = e.shiftKey ? 10 : 1, mv = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
    if (mv) { e.preventDefault(); const p = curPage(); snap(); const [dx, dy] = toDisp(p, a.cx, a.cy); [a.cx, a.cy] = toBase(p, dx + mv[0], dy + mv[1]); layoutAnn(annEl(a.id), a); }
  });

  // global drag & drop of files
  let dc = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dc++; $('#veil').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dc <= 0) { dc = 0; $('#veil').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dc = 0; $('#veil').hidden = true; addFiles(e.dataTransfer.files); });
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.add('over')));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('over')));

  histBtns(); setTool('select');
}
wire();
window.__PS = { S, addFiles };
})();
