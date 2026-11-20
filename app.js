'use strict';

const APP_VERSION = '1.3.0';
const STORAGE_KEY = 'vw.contracts.v1';
const SETTINGS_KEY = 'vw.settings.v1';
const NOTIFIED_KEY = 'vw.notified.v1';

const INTERVALS = {
  weekly:     { label: 'wöchentlich',     short: 'Woche',   perMonth: 52 / 12 },
  monthly:    { label: 'monatlich',       short: 'Monat',   perMonth: 1 },
  quarterly:  { label: 'vierteljährlich', short: 'Quartal', perMonth: 1 / 3 },
  halfyearly: { label: 'halbjährlich',    short: 'Halbjahr', perMonth: 1 / 6 },
  yearly:     { label: 'jährlich',        short: 'Jahr',    perMonth: 1 / 12 },
};
const STATUS = { active: 'Aktiv', cancelled: 'Gekündigt', ended: 'Beendet' };
const NOTICE_UNITS = { days: ['Tag', 'Tage'], weeks: ['Woche', 'Wochen'], months: ['Monat', 'Monate'] };
const DEFAULT_CATEGORIES = ['Streaming', 'Musik', 'Mobilfunk', 'Internet', 'Strom', 'Gas', 'Versicherung', 'Fitness', 'Software', 'Cloud', 'Zeitschriften', 'Mobilität', 'Bank', 'Wohnen', 'Spenden', 'Sonstiges'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/* ---------- Speicher ---------- */

function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { toast('Speichern fehlgeschlagen – ist der Speicher voll oder privat?'); return false; }
}

let contracts = safeGet(STORAGE_KEY, []);
let settings = Object.assign({ warnDays: 30, theme: 'system' }, safeGet(SETTINGS_KEY, {}));

function persist() { safeSet(STORAGE_KEY, contracts); }
function saveSettings() { safeSet(SETTINGS_KEY, settings); }

/* ---------- Dokumente (IndexedDB) ---------- */

const MAX_DOC_BYTES = 25 * 1024 * 1024;
const docStore = (() => {
  let dbPromise;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('vertragswaechter', 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore('documents', { keyPath: 'id' });
          store.createIndex('contractId', 'contractId');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('documents', mode);
      const store = tx.objectStore('documents');
      let result;
      const r = fn(store);
      if (r) r.onsuccess = () => { result = r.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  return {
    put: doc => run('readwrite', s => s.put(doc)),
    get: id => run('readonly', s => s.get(id)),
    remove: id => run('readwrite', s => s.delete(id)),
    all: () => run('readonly', s => s.getAll()),
    byContract: cid => run('readonly', s => s.index('contractId').getAll(cid)),
    clear: () => run('readwrite', s => s.clear()),
    async removeByContract(cid) {
      const docs = await this.byContract(cid);
      await run('readwrite', s => { for (const d of docs) s.delete(d.id); });
    },
  };
})();

// Anzahl der Dokumente je Vertrag, damit die Listen synchron rendern können
let docCounts = new Map();
async function loadDocCounts() {
  try {
    const docs = await docStore.all();
    docCounts = new Map();
    for (const d of docs) docCounts.set(d.contractId, (docCounts.get(d.contractId) || 0) + 1);
  } catch { docCounts = new Map(); }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* ---------- Datums-Helfer (lokal, ohne Zeitzonen-Probleme) ---------- */

function parseISO(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function addMonths(d, n) {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target;
}
function subNotice(d, value, unit) {
  if (!value) return d;
  if (unit === 'days') return addDays(d, -value);
  if (unit === 'weeks') return addDays(d, -7 * value);
  return addMonths(d, -value);
}
function addNotice(d, value, unit) {
  if (!value) return d;
  if (unit === 'days') return addDays(d, value);
  if (unit === 'weeks') return addDays(d, 7 * value);
  return addMonths(d, value);
}
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function fmtDate(d) { return d ? dateFmt.format(d) : '–'; }
function fmtISO(s) { return fmtDate(parseISO(s)); }
function relDays(n) {
  if (n === 0) return 'heute';
  if (n === 1) return 'morgen';
  if (n < 0) return `vor ${-n} ${-n === 1 ? 'Tag' : 'Tagen'}`;
  return `in ${n} Tagen`;
}

/* ---------- Fachlogik ---------- */

function monthlyCost(c) {
  const i = INTERVALS[c.interval] || INTERVALS.monthly;
  return (Number(c.amount) || 0) * i.perMonth;
}
function isCosting(c) { return c.status === 'active' || c.status === 'cancelled'; }

function noticeText(c) {
  const v = Number(c.noticeValue) || 0;
  if (!v) return 'keine / sofort';
  const [one, many] = NOTICE_UNITS[c.noticeUnit] || NOTICE_UNITS.months;
  return `${v} ${v === 1 ? one : many}`;
}

/**
 * Ermittelt das aktuelle Laufzeitende und den letzten Tag, an dem gekündigt werden muss.
 * Modell: Laufzeit beginnt am Abschlussdatum, dauert `minTermMonths` Monate und
 * verlängert sich danach jeweils um `renewalMonths` Monate. Ohne Verlängerung
 * (0) gilt der Vertrag nach der Mindestlaufzeit als unbefristet, also jederzeit
 * mit der Kündigungsfrist kündbar.
 */
function schedule(c, ref = today()) {
  if (c.status === 'ended') return { kind: 'ended', endDate: parseISO(c.endDate) };
  if (c.status === 'cancelled') return { kind: 'cancelled', endDate: parseISO(c.endDate) };

  const nv = Number(c.noticeValue) || 0;
  const nu = c.noticeUnit || 'months';
  const start = parseISO(c.startDate);
  const min = Math.max(0, Number(c.minTermMonths) || 0);
  const renew = Math.max(0, Number(c.renewalMonths) || 0);
  const anytime = () => ({ kind: 'anytime', earliestEnd: addNotice(ref, nv, nu) });

  if (!start) return (min || renew) ? { kind: 'unknown' } : anytime();
  const first = min || renew;
  if (!first) return anytime();

  const periodEnd = k => addDays(addMonths(start, first + k * renew), -1);
  let k = 0;
  let end = periodEnd(0);
  let deadline = subNotice(end, nv, nu);

  if (deadline < ref) {
    if (!renew) return anytime();
    while (deadline < ref && k < 5000) {
      k++;
      end = periodEnd(k);
      deadline = subNotice(end, nv, nu);
    }
  }
  return { kind: 'deadline', termEnd: end, deadline, daysLeft: daysBetween(ref, deadline), inMinTerm: k === 0 && !!min };
}

function urgency(s) {
  if (s.kind !== 'deadline') return '';
  if (s.daysLeft <= 7) return 'urgent';
  if (s.daysLeft <= settings.warnDays) return 'soon';
  return 'ok';
}

function scheduleBadge(s) {
  switch (s.kind) {
    case 'deadline': return `<span class="badge ${urgency(s)}">Kündigen bis ${fmtDate(s.deadline)}</span>`;
    case 'anytime': return `<span class="badge ok">Jederzeit kündbar</span>`;
    case 'cancelled': return `<span class="badge">Gekündigt${s.endDate ? ' · endet ' + fmtDate(s.endDate) : ''}</span>`;
    case 'ended': return `<span class="badge">Beendet</span>`;
    default: return `<span class="badge">Frist unbekannt</span>`;
  }
}

/* ---------- Darstellung ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function avatar(c) {
  const initial = (c.name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="avatar" style="background:hsl(${hue(c.name)} 55% 42%)" aria-hidden="true">${esc(initial)}</span>`;
}
function itemHTML(c) {
  const s = schedule(c);
  const iv = INTERVALS[c.interval] || INTERVALS.monthly;
  const n = docCounts.get(c.id) || 0;
  const clip = n ? `<span class="clip" title="${n} ${n === 1 ? 'Dokument' : 'Dokumente'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6L15 7.1"/></svg>${n}</span>` : '';
  const sub = [[c.category, c.account].filter(Boolean).map(esc).join(' · ') || esc(c.provider || ''), clip].filter(Boolean).join(' · ');
  const perMonth = c.interval !== 'monthly' ? `<small> ≈ ${eur.format(monthlyCost(c))}/Monat</small>` : '';
  return `
    <button type="button" class="item" data-id="${esc(c.id)}">
      ${avatar(c)}
      <span class="item-main">
        <span class="item-title">${esc(c.name)}</span>
        <span class="item-sub">${sub || '&nbsp;'}</span>
      </span>
      <span class="item-side">
        <span class="price">${eur.format(Number(c.amount) || 0)}<small>/${iv.short}</small>${perMonth}</span>
        ${scheduleBadge(s)}
      </span>
    </button>`;
}
function emptyHTML(text, withButton = true) {
  return `<div class="empty"><div>${text}</div>${withButton ? '<button type="button" class="btn btn-primary" data-action="add">＋ Ersten Vertrag anlegen</button>' : ''}</div>`;
}

function renderDashboard() {
  const costing = contracts.filter(isCosting);
  const active = contracts.filter(c => c.status === 'active');
  const month = costing.reduce((sum, c) => sum + monthlyCost(c), 0);
  const withDeadline = active
    .map(c => ({ c, s: schedule(c) }))
    .filter(x => x.s.kind === 'deadline')
    .sort((a, b) => a.s.deadline - b.s.deadline);
  const due = withDeadline.filter(x => x.s.daysLeft <= settings.warnDays);

  $('#stat-month').textContent = eur.format(month);
  $('#stat-year').textContent = eur.format(month * 12);
  $('#stat-count').textContent = active.length;
  $('#stat-due').textContent = due.length;
  $('#stat-warn-days').textContent = settings.warnDays;

  const upcoming = withDeadline.slice(0, 6);
  $('#upcoming').innerHTML = contracts.length === 0
    ? emptyHTML('Noch keine Verträge erfasst. Leg los – oder lade unter „Mehr“ Beispieldaten.')
    : upcoming.length
      ? upcoming.map(x => itemHTML(x.c)).join('')
      : emptyHTML('Keine anstehenden Fristen. Trage Abschlussdatum, Laufzeit und Kündigungsfrist ein, damit Fristen berechnet werden.', false);

  const byCat = {};
  for (const c of costing) {
    const k = c.category || 'Ohne Kategorie';
    byCat[k] = (byCat[k] || 0) + monthlyCost(c);
  }
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 0;
  $('#by-category').innerHTML = rows.length
    ? rows.map(([k, v]) => `
        <div class="bar-row">
          <span class="bar-label" title="${esc(k)}">${esc(k)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${max ? (v / max * 100).toFixed(1) : 0}%;display:block"></span></span>
          <span class="bar-value">${eur.format(v)}</span>
        </div>`).join('')
    : '<p class="hint">Noch keine Kosten erfasst.</p>';
  $('#by-category').hidden = false;
}

function renderContracts() {
  const q = $('#search').value.trim().toLowerCase();
  const status = $('#filter-status').value;
  const cat = $('#filter-category').value;
  const sort = $('#sort').value;

  let list = contracts.filter(c =>
    (status === 'all' || c.status === status) &&
    (!cat || c.category === cat) &&
    (!q || [c.name, c.provider, c.category, c.account, c.contractNo, c.notes].some(v => String(v || '').toLowerCase().includes(q)))
  );

  const key = c => {
    const s = schedule(c);
    if (s.kind === 'deadline') return s.deadline.getTime();
    if (s.kind === 'cancelled' && s.endDate) return s.endDate.getTime() + 1e13;
    return Infinity;
  };
  const sorters = {
    deadline: (a, b) => key(a) - key(b) || a.name.localeCompare(b.name, 'de'),
    'cost-desc': (a, b) => monthlyCost(b) - monthlyCost(a),
    'cost-asc': (a, b) => monthlyCost(a) - monthlyCost(b),
    name: (a, b) => a.name.localeCompare(b.name, 'de'),
  };
  list.sort(sorters[sort] || sorters.deadline);

  $('#contracts').innerHTML = list.length
    ? list.map(itemHTML).join('')
    : contracts.length ? emptyHTML('Keine Treffer für diese Filter.', false) : emptyHTML('Noch keine Verträge erfasst.');
}

function renderAccounts() {
  const groups = {};
  for (const c of contracts.filter(isCosting)) {
    const k = c.account || 'Ohne Konto';
    (groups[k] ||= []).push(c);
  }
  const entries = Object.entries(groups)
    .map(([k, list]) => [k, list, list.reduce((s, c) => s + monthlyCost(c), 0)])
    .sort((a, b) => b[2] - a[2]);

  $('#accounts').innerHTML = entries.length
    ? entries.map(([k, list, sum]) => `
        <div class="card">
          <div class="detail-hero" style="margin-bottom:10px">
            <div class="item-main" style="flex:1">
              <div class="item-title">${esc(k)}</div>
              <div class="item-sub">${list.length} ${list.length === 1 ? 'Vertrag' : 'Verträge'} · ${eur.format(sum * 12)} pro Jahr</div>
            </div>
            <div class="price">${eur.format(sum)}<small>/Monat</small></div>
          </div>
          <div class="list">${list.sort((a, b) => monthlyCost(b) - monthlyCost(a)).map(itemHTML).join('')}</div>
        </div>`).join('')
    : emptyHTML('Noch keine Verträge erfasst.');
}

function refreshFilterOptions() {
  const cats = [...new Set(contracts.map(c => c.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const sel = $('#filter-category');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Alle Kategorien</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
  sel.value = cats.includes(cur) ? cur : '';

  const allCats = [...new Set([...DEFAULT_CATEGORIES, ...cats])];
  $('#dl-categories').innerHTML = allCats.map(c => `<option value="${esc(c)}">`).join('');
  const accounts = [...new Set(contracts.map(c => c.account).filter(Boolean))];
  $('#dl-accounts').innerHTML = accounts.map(a => `<option value="${esc(a)}">`).join('');
}

function renderAll() {
  refreshFilterOptions();
  renderDashboard();
  renderContracts();
  renderAccounts();
}

/* ---------- Navigation ---------- */

let currentView = 'dashboard';
function showView(name) {
  currentView = name;
  for (const v of $$('.view')) v.hidden = v.dataset.view !== name;
  for (const b of $$('.tabbar button')) b.classList.toggle('active', b.dataset.tab === name);
  try { sessionStorage.setItem('vw.tab', name); } catch {}
  window.scrollTo({ top: 0 });
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.tab)));

/* ---------- Detailansicht ---------- */

let currentId = null;

function openDetail(id) {
  const c = contracts.find(x => x.id === id);
  if (!c) return;
  currentId = id;
  const s = schedule(c);
  const iv = INTERVALS[c.interval] || INTERVALS.monthly;

  let alert = '';
  if (s.kind === 'deadline') {
    const cls = urgency(s);
    alert = `<div class="alert ${cls}">
      Spätestens kündigen bis <strong>${fmtDate(s.deadline)}</strong> (${relDays(s.daysLeft)}).<br>
      <span style="font-weight:500">Sonst verlängert sich der Vertrag – aktuelles Laufzeitende: ${fmtDate(s.termEnd)}${s.inMinTerm ? ' (Ende Mindestlaufzeit)' : ''}.</span>
    </div>`;
  } else if (s.kind === 'anytime') {
    alert = `<div class="alert ok">Jederzeit kündbar. Bei Kündigung heute endet der Vertrag frühestens am <strong>${fmtDate(s.earliestEnd)}</strong>.</div>`;
  } else if (s.kind === 'cancelled') {
    alert = `<div class="alert info">Gekündigt${c.cancelledAt ? ' am ' + fmtISO(c.cancelledAt) : ''}${s.endDate ? ` – läuft aus am <strong>${fmtDate(s.endDate)}</strong>` : ''}.</div>`;
  } else if (s.kind === 'ended') {
    alert = `<div class="alert info">Vertrag beendet${s.endDate ? ' am ' + fmtDate(s.endDate) : ''}.</div>`;
  } else {
    alert = `<div class="alert info">Für die Fristberechnung fehlt das Abschlussdatum.</div>`;
  }

  const link = url => {
    const safe = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
  };
  const contact = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v);
  const rows = [
    ['Anbieter', esc(c.provider)],
    ['Kategorie', esc(c.category)],
    ['Status', STATUS[c.status]],
    ['Betrag', `${eur.format(Number(c.amount) || 0)} ${iv.label}`],
    ['Monatlich', eur.format(monthlyCost(c))],
    ['Jährlich', eur.format(monthlyCost(c) * 12)],
    ['Zahlungskonto', esc(c.account)],
    ['Zahlungsart', esc(c.paymentMethod)],
    ['Abschluss', c.startDate ? fmtISO(c.startDate) : ''],
    ['Mindestlaufzeit', c.minTermMonths ? `${c.minTermMonths} Monate` : 'keine'],
    ['Verlängerung', c.renewalMonths ? `um ${c.renewalMonths} ${Number(c.renewalMonths) === 1 ? 'Monat' : 'Monate'}` : 'unbefristet'],
    ['Kündigungsfrist', noticeText(c)],
    ['Gekündigt am', c.cancelledAt ? fmtISO(c.cancelledAt) : ''],
    ['Vertragsende', c.endDate ? fmtISO(c.endDate) : ''],
    ['Vertragsnr.', esc(c.contractNo)],
    ['Website', c.website ? link(c.website) : ''],
    ['Kündigung an', c.cancelContact ? contact(c.cancelContact) : ''],
  ].filter(([, v]) => v);

  $('#detail-title').textContent = c.name;
  $('#detail-body').innerHTML = `
    <div class="detail-hero">
      ${avatar(c)}
      <div>
        <div class="price">${eur.format(Number(c.amount) || 0)}<small>/${iv.short}</small></div>
        <div class="item-sub">${eur.format(monthlyCost(c) * 12)} pro Jahr</div>
      </div>
    </div>
    ${alert}
    <dl class="dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${c.notes ? `<div class="notes">${esc(c.notes)}</div>` : ''}
    <h3 class="sub-title">Dokumente <span class="count" id="doc-count"></span></h3>
    <div class="docs" id="doc-list"></div>
    <button type="button" class="btn doc-add" id="doc-add">＋ Dokument hinzufügen</button>`;
  $('#detail-ics').hidden = s.kind !== 'deadline';
  if (!$('#dlg-detail').open) $('#dlg-detail').showModal();
  renderDocs(id);
}

/* ---------- Dokumente: Verarbeitung ---------- */

const MAX_IMAGE_INPUT_BYTES = 40 * 1024 * 1024;
const IMAGE_MAX_SIDE = 2400;   // längste Kante gespeicherter Fotos (gut lesbar, aber platzsparend)
const THUMB_WIDTH = 160;

const isImageDoc = d => (d.kind || (String(d.type).startsWith('image/') ? 'image' : 'pdf')) === 'image';

let pdfjsPromise;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdfjs/pdf.min.mjs').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
      return lib;
    }).catch(err => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}
// PDF.js übernimmt den Puffer in den Worker – deshalb immer eine Kopie übergeben
async function openPdf(data) {
  const lib = await loadPdfJs();
  return lib.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false }).promise;
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('blob')), 'image/jpeg', quality));
}
function drawScaled(source, srcW, srcH, maxW, maxH = Infinity) {
  const scale = Math.min(1, maxW / srcW, maxH / srcH);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

async function pdfThumb(pdf) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (THUMB_WIDTH * 2) / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.75);
}

/** Liest eine Datei ein, erzeugt Vorschaubild und verkleinert große Fotos. */
async function processFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name);
  if (!isPdf && !isImage) throw new UserError('Bitte eine PDF-Datei oder ein Foto auswählen.');

  if (isPdf) {
    if (file.size > MAX_DOC_BYTES) throw new UserError(`Die PDF ist zu groß (max. ${fmtBytes(MAX_DOC_BYTES)}).`);
    const data = await file.arrayBuffer();
    let pages = null, thumb = null, locked = false;
    try {
      const pdf = await openPdf(data);
      pages = pdf.numPages;
      thumb = await pdfThumb(pdf);
      pdf.destroy();
    } catch (err) {
      if (err && err.name === 'PasswordException') locked = true;
      else if (err && err.name === 'InvalidPDFException') throw new UserError('Die PDF-Datei ist beschädigt oder ungültig.');
    }
    return { kind: 'pdf', type: 'application/pdf', fileName: file.name, data, size: data.byteLength, pages, thumb, locked };
  }

  if (file.size > MAX_IMAGE_INPUT_BYTES) throw new UserError(`Das Foto ist zu groß (max. ${fmtBytes(MAX_IMAGE_INPUT_BYTES)}).`);
  let img;
  try { img = await loadImage(file); }
  catch { throw new UserError('Dieses Bildformat kann der Browser nicht öffnen. Bitte als JPG oder PNG speichern.'); }
  const w = img.naturalWidth, h = img.naturalHeight;
  const keepOriginal = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
    && Math.max(w, h) <= IMAGE_MAX_SIDE && file.size <= 1.5 * 1024 * 1024;
  let data, type, fileName = file.name;
  if (keepOriginal) {
    data = await file.arrayBuffer();
    type = file.type;
  } else {
    const canvas = drawScaled(img, w, h, IMAGE_MAX_SIDE, IMAGE_MAX_SIDE);
    data = await (await canvasToBlob(canvas, 0.85)).arrayBuffer();
    type = 'image/jpeg';
    fileName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  }
  const thumb = drawScaled(img, w, h, THUMB_WIDTH * 2).toDataURL('image/jpeg', 0.75);
  return { kind: 'image', type, fileName, data, size: data.byteLength, originalSize: file.size, thumb };
}

class UserError extends Error {}
const thumbTried = new Set();

// Vorschaubilder für ältere Dokumente nachträglich erzeugen
async function ensureThumb(doc) {
  if (doc.thumb || doc.locked) return doc;
  try {
    if (isImageDoc(doc)) {
      const img = await loadImage(new Blob([doc.data], { type: doc.type }));
      doc.thumb = drawScaled(img, img.naturalWidth, img.naturalHeight, THUMB_WIDTH * 2).toDataURL('image/jpeg', 0.75);
      doc.kind = 'image';
    } else {
      const pdf = await openPdf(doc.data);
      doc.pages = pdf.numPages;
      doc.thumb = await pdfThumb(pdf);
      doc.kind = 'pdf';
      pdf.destroy();
    }
    await docStore.put(doc);
  } catch (err) {
    if (err && err.name === 'PasswordException') { doc.locked = true; await docStore.put(doc).catch(() => {}); }
  }
  return doc;
}

function docMeta(d) {
  const parts = [isImageDoc(d) ? 'Foto' : 'PDF'];
  if (d.pages) parts.push(`${d.pages} ${d.pages === 1 ? 'Seite' : 'Seiten'}`);
  if (d.locked) parts.push('passwortgeschützt');
  parts.push(fmtBytes(d.size));
  return parts.join(' · ');
}
function thumbHTML(d) {
  return d.thumb
    ? `<img src="${esc(d.thumb)}" alt="">`
    : `<span>${isImageDoc(d) ? 'JPG' : 'PDF'}</span>`;
}

/* ---------- Dokumente: Liste in der Detailansicht ---------- */

async function renderDocs(contractId) {
  const list = $('#doc-list');
  if (!list) return;
  let docs = [];
  try { docs = await docStore.byContract(contractId); }
  catch { list.innerHTML = '<p class="hint">Dokumente können in diesem Browser nicht gespeichert werden.</p>'; return; }
  if (currentId !== contractId) return;
  docs.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  $('#doc-count').textContent = docs.length ? `(${docs.length})` : '';
  list.innerHTML = docs.length
    ? docs.map(d => `
      <div class="doc" data-doc="${esc(d.id)}">
        <button type="button" class="doc-thumb" data-doc-action="open" aria-label="${esc(d.name)} öffnen">${thumbHTML(d)}</button>
        <button type="button" class="doc-main" data-doc-action="open">
          <span class="doc-name">${esc(d.name)}</span>
          <span class="doc-meta">${docMeta(d)} · ${fmtDate(new Date(d.createdAt))}</span>
        </button>
        <button type="button" class="icon-btn" data-doc-action="rename" aria-label="Umbenennen" title="Umbenennen">✎</button>
        <button type="button" class="icon-btn" data-doc-action="delete" aria-label="Löschen" title="Löschen">🗑</button>
      </div>`).join('')
    : '<p class="hint">Noch keine Dokumente. Hänge z. B. den Vertrag als PDF an oder fotografiere die Kündigungsbestätigung.</p>';

  const missing = docs.filter(d => !d.thumb && !d.locked && !thumbTried.has(d.id));
  if (missing.length) {
    for (const d of missing) { thumbTried.add(d.id); await ensureThumb(d); }
    if (currentId === contractId) renderDocs(contractId);
  }
}

/* ---------- Dokumente: Hochladen und Benennen ---------- */

let pendingFile = null;
let renamingDocId = null;

function openDocDialog({ title, fileName, meta, name, thumb, kind }) {
  $('#doc-form-title').textContent = title;
  $('#doc-file-name').textContent = fileName;
  $('#doc-file-meta').textContent = meta;
  $('#doc-file-thumb').innerHTML = thumbHTML({ thumb, kind });
  const input = $('#doc-form').elements.docName;
  input.value = name;
  $('#dlg-doc').showModal();
  input.focus();
  input.select();
}

$('#doc-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const addBtn = $('#doc-add');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Wird verarbeitet …'; }
  try {
    const processed = await processFile(file);
    pendingFile = processed;
    renamingDocId = null;
    let meta = docMeta(processed);
    if (processed.originalSize && processed.originalSize > processed.size * 1.2) meta += ` (verkleinert von ${fmtBytes(processed.originalSize)})`;
    openDocDialog({
      title: 'Dokument hinzufügen', fileName: file.name, meta, thumb: processed.thumb, kind: processed.kind,
      name: file.name.replace(/\.[^.]+$/, '').replace(/^(IMG|DSC|PXL|PHOTO|Screenshot|image)[_ -]?\d*.*$/i, '') || `Foto vom ${fmtDate(today())}`,
    });
  } catch (err) {
    toast(err instanceof UserError ? err.message : 'Die Datei konnte nicht gelesen werden.');
  } finally {
    if (addBtn && addBtn.isConnected) { addBtn.disabled = false; addBtn.textContent = '＋ Dokument hinzufügen'; }
  }
});

$('#doc-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#doc-form').elements.docName.value.trim();
  if (!name) { toast('Bitte einen Namen eingeben.'); return; }
  try {
    if (renamingDocId) {
      const doc = await docStore.get(renamingDocId);
      if (doc) await docStore.put({ ...doc, name });
      if (viewer.doc && viewer.doc.id === renamingDocId) $('#viewer-title').textContent = name;
      toast('Dokument umbenannt');
    } else if (pendingFile) {
      const { originalSize, ...p } = pendingFile;
      await docStore.put({ id: uid(), contractId: currentId, name, ...p, createdAt: new Date().toISOString() });
      toast('Dokument gespeichert');
    }
  } catch {
    toast('Speichern fehlgeschlagen – ist der Gerätespeicher voll?');
  }
  pendingFile = null;
  renamingDocId = null;
  $('#dlg-doc').close();
  await loadDocCounts();
  renderAll();
  renderDocs(currentId);
  updateStorageInfo();
});
$('#dlg-doc').addEventListener('close', () => { pendingFile = null; renamingDocId = null; });

async function startRename(id) {
  const doc = await docStore.get(id);
  if (!doc) return;
  renamingDocId = id;
  pendingFile = null;
  openDocDialog({ title: 'Dokument umbenennen', fileName: doc.fileName, meta: docMeta(doc), name: doc.name, thumb: doc.thumb, kind: doc.kind });
}
async function deleteDoc(id) {
  const doc = await docStore.get(id);
  if (!doc || !(await confirmDelete('Dokument löschen?', `„${doc.name}“ wird dauerhaft gelöscht.`))) return false;
  await docStore.remove(id);
  await loadDocCounts();
  renderAll();
  renderDocs(currentId);
  updateStorageInfo();
  toast('Dokument gelöscht');
  return true;
}

$('#dlg-detail').addEventListener('click', e => {
  if (e.target.closest('#doc-add')) { $('#doc-file').click(); return; }
  const btn = e.target.closest('[data-doc-action]');
  if (!btn) return;
  const id = btn.closest('[data-doc]').dataset.doc;
  const action = btn.dataset.docAction;
  if (action === 'open') openViewer(id);
  else if (action === 'rename') startRename(id);
  else if (action === 'delete') deleteDoc(id);
});

/* ---------- Dokumente: Betrachter ---------- */

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const viewer = { doc: null, pdf: null, zoom: 1, observer: null, url: null, pages: [], token: 0 };
const vBody = $('#viewer-body');

function viewerBaseWidth() {
  return Math.min(vBody.clientWidth - 24, 960);
}

async function openViewer(id) {
  const doc = await docStore.get(id);
  if (!doc) return;
  resetViewer();
  const token = ++viewer.token;
  viewer.doc = doc;
  viewer.zoom = 1;
  $('#viewer-title').textContent = doc.name;
  $('#viewer-page').textContent = '';
  $('#viewer-share').textContent = canShareFiles() ? 'Teilen' : 'Herunterladen';
  vBody.innerHTML = '<p class="viewer-msg">Wird geladen …</p>';
  $('#dlg-viewer').showModal();
  updateZoomLabel();

  if (isImageDoc(doc)) {
    viewer.url = URL.createObjectURL(new Blob([doc.data], { type: doc.type }));
    vBody.innerHTML = `<img class="viewer-img" src="${viewer.url}" alt="${esc(doc.name)}">`;
    applyZoom();
    return;
  }

  try {
    const pdf = await openPdf(doc.data);
    if (token !== viewer.token) { pdf.destroy(); return; }
    viewer.pdf = pdf;
    vBody.innerHTML = '';
    viewer.observer = new IntersectionObserver(onPageVisibility, { root: vBody, rootMargin: '150% 0px' });
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      if (token !== viewer.token) return;
      const vp = page.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'viewer-page';
      el.dataset.page = i;
      el.style.aspectRatio = `${vp.width} / ${vp.height}`;
      vBody.appendChild(el);
      viewer.pages.push({ el, page, width: vp.width, renderedAt: 0, task: null, visible: false });
      viewer.observer.observe(el);
    }
    applyZoom();
    updatePageIndicator();
  } catch (err) {
    if (token !== viewer.token) return;
    vBody.innerHTML = `<p class="viewer-msg">${err && err.name === 'PasswordException'
      ? 'Diese PDF ist passwortgeschützt und kann hier nicht angezeigt werden. Über „' + esc($('#viewer-share').textContent) + '“ kannst du sie in einer anderen App öffnen.'
      : 'Die PDF konnte nicht angezeigt werden.'}</p>`;
  }
}

function onPageVisibility(entries) {
  for (const entry of entries) {
    const p = viewer.pages.find(x => x.el === entry.target);
    if (!p) continue;
    p.visible = entry.isIntersecting;
    if (p.visible) renderPage(p);
    else releasePage(p);
  }
}

async function renderPage(p) {
  const cssWidth = viewerBaseWidth() * viewer.zoom;
  if (p.renderedAt === cssWidth || !viewer.pdf) return;
  if (p.task) { p.task.cancel(); p.task = null; }
  // Auflösung begrenzen, damit Mobilgeräte nicht am Speicher scheitern
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  let scale = (cssWidth * ratio) / p.width;
  const base = p.page.getViewport({ scale: 1 });
  const maxArea = 12e6;
  if (base.width * base.height * scale * scale > maxArea) scale = Math.sqrt(maxArea / (base.width * base.height));
  const viewport = p.page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = p.page.render({ canvasContext: ctx, viewport });
  p.task = task;
  p.renderedAt = cssWidth;
  try {
    await task.promise;
    if (p.task !== task) return;
    p.task = null;
    p.el.replaceChildren(canvas);
  } catch {
    if (p.task === task) { p.task = null; p.renderedAt = 0; }
  }
}

function releasePage(p) {
  if (p.task) { p.task.cancel(); p.task = null; }
  const c = p.el.querySelector('canvas');
  if (c) { c.width = 0; c.height = 0; c.remove(); }
  p.renderedAt = 0;
}

function applyZoom() {
  const w = Math.round(viewerBaseWidth() * viewer.zoom);
  const img = vBody.querySelector('.viewer-img');
  if (img) img.style.width = `${w}px`;
  for (const p of viewer.pages) {
    p.el.style.width = `${w}px`;
    if (p.visible) renderPage(p);
  }
  updateZoomLabel();
}
function setZoom(z, anchor = 0.5) {
  const old = viewer.zoom;
  viewer.zoom = Math.min(4, Math.max(0.5, z));
  if (old === viewer.zoom) return;
  // Bildausschnitt beim Zoomen ungefähr beibehalten
  const fy = (vBody.scrollTop + vBody.clientHeight * anchor) / Math.max(1, vBody.scrollHeight);
  const fx = (vBody.scrollLeft + vBody.clientWidth / 2) / Math.max(1, vBody.scrollWidth);
  applyZoom();
  vBody.scrollTop = fy * vBody.scrollHeight - vBody.clientHeight * anchor;
  vBody.scrollLeft = fx * vBody.scrollWidth - vBody.clientWidth / 2;
}
function stepZoom(dir) {
  const z = viewer.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find(s => s > z + 0.01) : [...ZOOM_STEPS].reverse().find(s => s < z - 0.01);
  if (next) setZoom(next);
}
function updateZoomLabel() {
  $('#viewer-zoom').textContent = `${Math.round(viewer.zoom * 100)} %`;
  $('#viewer-zoom-out').disabled = viewer.zoom <= 0.5;
  $('#viewer-zoom-in').disabled = viewer.zoom >= 4;
}
function updatePageIndicator() {
  const n = viewer.pages.length;
  if (n < 2) { $('#viewer-page').textContent = n === 1 ? '1 Seite' : ''; return; }
  const mid = vBody.scrollTop + vBody.clientHeight / 3;
  let cur = 1;
  for (const p of viewer.pages) { if (p.el.offsetTop <= mid) cur = Number(p.el.dataset.page); }
  $('#viewer-page').textContent = `Seite ${cur} / ${n}`;
}

function resetViewer() {
  viewer.token++;
  if (viewer.observer) viewer.observer.disconnect();
  for (const p of viewer.pages) releasePage(p);
  if (viewer.pdf) viewer.pdf.destroy();
  if (viewer.url) URL.revokeObjectURL(viewer.url);
  Object.assign(viewer, { doc: null, pdf: null, observer: null, url: null, pages: [] });
  vBody.innerHTML = '';
}

function docFileName(d) {
  const ext = isImageDoc(d) ? (d.type === 'image/png' ? '.png' : d.type === 'image/webp' ? '.webp' : '.jpg') : '.pdf';
  return (d.name || 'Dokument').replace(/[\\/:*?"<>|]+/g, '_').trim() + ext;
}
function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));
  } catch { return false; }
}
async function shareDoc() {
  const d = viewer.doc;
  if (!d) return;
  const file = new File([d.data], docFileName(d), { type: d.type });
  if (canShareFiles() && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: d.name }); return; }
    catch (err) { if (err && err.name === 'AbortError') return; }
  }
  download(file, file.name);
}

$('#viewer-zoom-in').addEventListener('click', () => stepZoom(1));
$('#viewer-zoom-out').addEventListener('click', () => stepZoom(-1));
$('#viewer-zoom').addEventListener('click', () => setZoom(1));
$('#viewer-share').addEventListener('click', shareDoc);
$('#viewer-rename').addEventListener('click', () => viewer.doc && startRename(viewer.doc.id));
$('#viewer-delete').addEventListener('click', async () => {
  if (viewer.doc && await deleteDoc(viewer.doc.id)) $('#dlg-viewer').close();
});
$('#dlg-viewer').addEventListener('close', resetViewer);
vBody.addEventListener('scroll', () => requestAnimationFrame(updatePageIndicator), { passive: true });
// Doppeltipp/-klick wechselt zwischen 100 % und 200 %
vBody.addEventListener('dblclick', e => {
  const r = vBody.getBoundingClientRect();
  setZoom(viewer.zoom >= 1.5 ? 1 : 2, (e.clientY - r.top) / r.height);
});
// Strg/⌘ + Mausrad bzw. Trackpad-Pinch zoomt
vBody.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(viewer.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
}, { passive: false });
// Zwei-Finger-Pinch auf dem Touchscreen
let pinch = null;
vBody.addEventListener('touchstart', e => {
  if (e.touches.length === 2) pinch = { d: touchDist(e), z: viewer.zoom };
}, { passive: true });
vBody.addEventListener('touchmove', e => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const z = pinch.z * touchDist(e) / pinch.d;
  vBody.style.setProperty('--pinch', String(Math.min(4, Math.max(0.5, z)) / viewer.zoom));
  vBody.classList.add('pinching');
}, { passive: false });
vBody.addEventListener('touchend', () => {
  if (!pinch) return;
  const factor = parseFloat(vBody.style.getPropertyValue('--pinch')) || 1;
  vBody.classList.remove('pinching');
  vBody.style.removeProperty('--pinch');
  setZoom(viewer.zoom * factor);
  pinch = null;
});
function touchDist(e) {
  const [a, b] = e.touches;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if ($('#dlg-viewer').open) applyZoom(); }, 150);
});

/* ---------- Formular ---------- */

const form = $('#contract-form');
const FIELDS = ['name', 'provider', 'category', 'status', 'contractNo', 'amount', 'interval', 'account', 'paymentMethod',
  'startDate', 'minTermMonths', 'renewalMonths', 'noticeValue', 'noticeUnit', 'cancelledAt', 'endDate', 'website', 'cancelContact', 'notes'];
let editingId = null;

function openForm(id = null) {
  editingId = id;
  const c = id ? contracts.find(x => x.id === id) : {
    status: 'active', interval: 'monthly', noticeUnit: 'months', startDate: toISO(today()),
  };
  form.reset();
  for (const f of FIELDS) form.elements[f].value = c[f] ?? '';
  if (!form.elements.noticeUnit.value) form.elements.noticeUnit.value = 'months';
  if (!form.elements.interval.value) form.elements.interval.value = 'monthly';
  $('#form-title').textContent = id ? 'Vertrag bearbeiten' : 'Neuer Vertrag';
  updateFormState();
  $('#dlg-form').showModal();
  if (!id) form.elements.name.focus();
}

function readForm() {
  const data = {};
  for (const f of FIELDS) data[f] = form.elements[f].value.trim();
  data.amount = data.amount === '' ? 0 : Math.round(parseFloat(data.amount.replace(',', '.')) * 100) / 100;
  for (const n of ['minTermMonths', 'renewalMonths', 'noticeValue']) data[n] = data[n] === '' ? '' : Math.max(0, parseInt(data[n], 10) || 0);
  if (data.status === 'active') { data.cancelledAt = ''; data.endDate = ''; }
  return data;
}

function updateFormState() {
  const status = form.elements.status.value;
  for (const el of $$('[data-show-when]', form)) el.hidden = !el.dataset.showWhen.split(' ').includes(status);

  const data = readForm();
  const s = schedule(data);
  const p = $('#form-preview');
  if (status !== 'active') {
    p.textContent = '';
  } else if (s.kind === 'deadline') {
    p.innerHTML = `→ Nächste Kündigungsfrist: <strong>${fmtDate(s.deadline)}</strong> (Laufzeitende ${fmtDate(s.termEnd)})`;
  } else if (s.kind === 'anytime') {
    p.innerHTML = `→ Jederzeit kündbar, frühestes Ende bei Kündigung heute: <strong>${fmtDate(s.earliestEnd)}</strong>`;
  } else {
    p.textContent = '→ Trage das Abschlussdatum ein, um die Frist zu berechnen.';
  }
}
form.addEventListener('input', updateFormState);
form.addEventListener('change', updateFormState);

form.addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm();
  if (!data.name) { toast('Bitte einen Namen eingeben.'); form.elements.name.focus(); return; }
  if (!Number.isFinite(data.amount)) { toast('Bitte einen gültigen Betrag eingeben.'); form.elements.amount.focus(); return; }
  const now = new Date().toISOString();
  if (editingId) {
    const idx = contracts.findIndex(x => x.id === editingId);
    contracts[idx] = { ...contracts[idx], ...data, updatedAt: now };
  } else {
    contracts.push({ id: uid(), ...data, createdAt: now, updatedAt: now });
  }
  persist();
  renderAll();
  $('#dlg-form').close();
  if (editingId && $('#dlg-detail').open) openDetail(editingId);
  toast(editingId ? 'Änderungen gespeichert' : 'Vertrag angelegt');
});

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

/* ---------- Kalender-Export (.ics) ---------- */

function icsEscape(s) { return String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n'); }
function icsDate(d) { return toISO(d).replace(/-/g, ''); }
function icsEvent(c, s) {
  const desc = `Letzter Tag zur Kündigung von "${c.name}". Laufzeitende: ${fmtDate(s.termEnd)}. ` +
    `Kosten: ${eur.format(Number(c.amount) || 0)} ${(INTERVALS[c.interval] || INTERVALS.monthly).label}.` +
    (c.cancelContact ? ` Kündigung an: ${c.cancelContact}.` : '');
  return [
    'BEGIN:VEVENT',
    `UID:${c.id}-${icsDate(s.deadline)}@vertragswaechter`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    `DTSTART;VALUE=DATE:${icsDate(s.deadline)}`,
    `DTEND;VALUE=DATE:${icsDate(addDays(s.deadline, 1))}`,
    `SUMMARY:${icsEscape('Kündigungsfrist: ' + c.name)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('Kündigungsfrist: ' + c.name)}`, 'TRIGGER:-P14D', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('Kündigungsfrist: ' + c.name)}`, 'TRIGGER:-P3D', 'END:VALARM',
    'END:VEVENT',
  ].join('\r\n');
}
function downloadICS(items, filename) {
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vertragswaechter//DE', 'CALSCALE:GREGORIAN',
    ...items.map(({ c, s }) => icsEvent(c, s)), 'END:VCALENDAR'].join('\r\n');
  download(new Blob([body], { type: 'text/calendar;charset=utf-8' }), filename);
}

/* ---------- Import / Export ---------- */

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportJSON() {
  let documents = [];
  try {
    documents = (await docStore.all()).map(({ data, ...meta }) => ({ ...meta, data: bufToB64(data) }));
  } catch {}
  const payload = { app: 'vertragswaechter', version: 2, exportedAt: new Date().toISOString(), contracts, documents };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `vertragswaechter-backup-${toISO(today())}.json`);
}

function exportCSV() {
  const cols = [['Name', 'name'], ['Anbieter', 'provider'], ['Kategorie', 'category'], ['Status', c => STATUS[c.status]],
    ['Betrag', c => String(c.amount).replace('.', ',')], ['Intervall', c => (INTERVALS[c.interval] || {}).label],
    ['Monatlich', c => monthlyCost(c).toFixed(2).replace('.', ',')], ['Konto', 'account'], ['Zahlungsart', 'paymentMethod'],
    ['Abschluss', 'startDate'], ['Mindestlaufzeit (Monate)', 'minTermMonths'], ['Verlängerung (Monate)', 'renewalMonths'],
    ['Kündigungsfrist', noticeText], ['Kündigen bis', c => { const s = schedule(c); return s.kind === 'deadline' ? toISO(s.deadline) : ''; }],
    ['Gekündigt am', 'cancelledAt'], ['Vertragsende', 'endDate'], ['Vertragsnr.', 'contractNo'], ['Website', 'website'],
    ['Kündigung an', 'cancelContact'], ['Notizen', 'notes'], ['Dokumente', c => docCounts.get(c.id) || 0]];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(c => cell(c[0])).join(';'),
    ...contracts.map(c => cols.map(([, f]) => cell(typeof f === 'function' ? f(c) : c[f])).join(';'))];
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `vertragswaechter-${toISO(today())}.csv`);
}

async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.contracts;
    if (!Array.isArray(list)) throw new Error('format');
    const clean = list.filter(c => c && typeof c === 'object' && c.name).map(c => ({
      ...c, id: c.id || uid(), status: STATUS[c.status] ? c.status : 'active',
    }));
    let mode = 'replace';
    if (contracts.length) {
      mode = await ask({
        title: 'Backup importieren',
        message: `Im Backup sind ${clean.length} Verträge. Sollen sie zu deinen vorhandenen Daten hinzugefügt werden oder diese ersetzen?`,
        icon: ICONS.upload, tone: 'neutral',
        buttons: [
          { label: 'Hinzufügen', value: 'merge', kind: 'primary' },
          { label: 'Vorhandene Daten ersetzen', value: 'replace', kind: 'danger' },
          { label: 'Abbrechen', value: null },
        ],
      });
      if (!mode) return;
    }
    const replace = mode === 'replace';
    if (replace) {
      contracts = clean;
      await docStore.clear().catch(() => {});
    } else {
      const map = new Map(contracts.map(c => [c.id, c]));
      for (const c of clean) map.set(c.id, c);
      contracts = [...map.values()];
    }
    persist();
    const ids = new Set(contracts.map(c => c.id));
    const docs = Array.isArray(data.documents) ? data.documents.filter(d => d && d.id && d.data && ids.has(d.contractId)) : [];
    let docErrors = 0;
    for (const d of docs) {
      try { await docStore.put({ ...d, data: b64ToBuf(d.data) }); } catch { docErrors++; }
    }
    await loadDocCounts();
    renderAll();
    updateStorageInfo();
    toast(`${clean.length} Verträge${docs.length ? ` und ${docs.length - docErrors} Dokumente` : ''} importiert`);
  } catch {
    toast('Import fehlgeschlagen – ist das eine gültige Backup-Datei?');
  }
}

function demoData() {
  const t = today();
  const iso = d => toISO(d);
  const mk = o => ({ id: uid(), status: 'active', noticeUnit: 'months', createdAt: new Date().toISOString(), ...o });
  return [
    mk({ name: 'Netflix', provider: 'Netflix', category: 'Streaming', amount: 13.99, interval: 'monthly', account: 'Kreditkarte Visa', paymentMethod: 'Kreditkarte', startDate: iso(addMonths(t, -26)), minTermMonths: '', renewalMonths: 1, noticeValue: '', website: 'netflix.com' }),
    mk({ name: 'Spotify Family', provider: 'Spotify', category: 'Musik', amount: 17.99, interval: 'monthly', account: 'PayPal', paymentMethod: 'PayPal', startDate: iso(addMonths(t, -40)), renewalMonths: 1, noticeValue: '' }),
    mk({ name: 'Handyvertrag', provider: 'Telekom', category: 'Mobilfunk', amount: 39.95, interval: 'monthly', account: 'Girokonto Sparkasse', paymentMethod: 'Lastschrift', startDate: iso(addDays(addMonths(t, -21), 20)), minTermMonths: 24, renewalMonths: 1, noticeValue: 1, noticeUnit: 'months', contractNo: 'MF-4711', cancelContact: 'kuendigung@example.com' }),
    mk({ name: 'Fitnessstudio', provider: 'FitX', category: 'Fitness', amount: 24.99, interval: 'monthly', account: 'Girokonto Sparkasse', paymentMethod: 'Lastschrift', startDate: iso(addDays(addMonths(t, -11), 12)), minTermMonths: 12, renewalMonths: 1, noticeValue: 1 }),
    mk({ name: 'Kfz-Versicherung', provider: 'HUK', category: 'Versicherung', amount: 412.6, interval: 'yearly', account: 'Girokonto Sparkasse', paymentMethod: 'Lastschrift', startDate: iso(new Date(t.getFullYear() - 3, 0, 1)), minTermMonths: 12, renewalMonths: 12, noticeValue: 1, notes: 'Stichtag 30.11. – Sonderkündigung bei Beitragserhöhung möglich.' }),
    mk({ name: 'Strom', provider: 'Stadtwerke', category: 'Strom', amount: 78, interval: 'monthly', account: 'Gemeinschaftskonto', paymentMethod: 'Lastschrift', startDate: iso(addMonths(t, -8)), minTermMonths: 12, renewalMonths: 1, noticeValue: 1 }),
    mk({ name: 'Internet 250', provider: 'Vodafone', category: 'Internet', amount: 44.99, interval: 'monthly', account: 'Gemeinschaftskonto', paymentMethod: 'Lastschrift', startDate: iso(addMonths(t, -30)), minTermMonths: 24, renewalMonths: 1, noticeValue: 1 }),
    mk({ name: 'Microsoft 365', provider: 'Microsoft', category: 'Software', amount: 99, interval: 'yearly', account: 'Kreditkarte Visa', paymentMethod: 'Kreditkarte', startDate: iso(addDays(addMonths(t, -12), 40)), minTermMonths: 12, renewalMonths: 12, noticeValue: '' }),
    mk({ name: 'Zeitschrift', provider: 'Verlag', category: 'Zeitschriften', amount: 29.7, interval: 'quarterly', account: 'Girokonto Sparkasse', paymentMethod: 'Rechnung', startDate: iso(addMonths(t, -14)), status: 'cancelled', cancelledAt: iso(addDays(t, -10)), endDate: iso(addDays(t, 45)), minTermMonths: 12, renewalMonths: 3, noticeValue: 6, noticeUnit: 'weeks' }),
  ];
}

/* ---------- Benachrichtigungen ---------- */

function updateNotifyState() {
  const el = $('#notify-state');
  const btn = $('#btn-notify');
  if (!('Notification' in window)) { el.textContent = 'Dieser Browser unterstützt keine Benachrichtigungen.'; btn.hidden = true; return; }
  const p = Notification.permission;
  el.textContent = p === 'granted' ? 'Benachrichtigungen sind aktiviert.' : p === 'denied' ? 'Benachrichtigungen wurden blockiert – bitte in den Browser-Einstellungen erlauben.' : '';
  btn.hidden = p !== 'default';
}

async function checkDeadlines() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const notified = safeGet(NOTIFIED_KEY, {});
  const due = contracts.filter(c => c.status === 'active')
    .map(c => ({ c, s: schedule(c) }))
    .filter(x => x.s.kind === 'deadline' && x.s.daysLeft <= settings.warnDays);
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  for (const { c, s } of due) {
    // Erinnern beim ersten Mal sowie nochmals in der letzten Woche
    const stage = s.daysLeft <= 7 ? 'week' : 'warn';
    const key = `${c.id}|${toISO(s.deadline)}|${stage}`;
    if (notified[key]) continue;
    const title = `Kündigungsfrist: ${c.name}`;
    const opts = { body: `Kündigen bis ${fmtDate(s.deadline)} (${relDays(s.daysLeft)}), sonst Verlängerung.`, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: key, data: { id: c.id } };
    try {
      if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
      notified[key] = Date.now();
    } catch {}
  }
  safeSet(NOTIFIED_KEY, notified);
}

/* ---------- Speicheranzeige ---------- */

async function updateStorageInfo() {
  const el = $('#storage-info');
  try {
    const docs = await docStore.all();
    const size = docs.reduce((s, d) => s + (d.size || 0), 0);
    let text = `${docs.length} ${docs.length === 1 ? 'Dokument' : 'Dokumente'} gespeichert (${fmtBytes(size)}).`;
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (quota) text += ` Belegt: ${fmtBytes(usage || 0)} von ca. ${fmtBytes(quota)}.`;
    }
    el.textContent = text;
  } catch {
    el.textContent = '';
  }
}

/* ---------- Theme ---------- */

function applyTheme() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

/* ---------- Sicherheitsabfrage ---------- */

const ICONS = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

/**
 * Zeigt eine eigene Abfrage statt des Browserfensters.
 * buttons: [{ label, value, kind: 'danger' | 'primary' | undefined }] – in Anzeigereihenfolge.
 * Liefert den value des gewählten Buttons, bei Abbruch (Esc, Hintergrund) null.
 */
function ask({ title, message = '', icon = ICONS.trash, tone = 'danger', buttons }) {
  const dlg = $('#dlg-confirm');
  const actions = $('#confirm-actions');
  $('#confirm-title').textContent = title;
  $('#confirm-msg').textContent = message;
  $('#confirm-msg').hidden = !message;
  const ic = $('#confirm-icon');
  ic.innerHTML = icon;
  ic.className = `confirm-icon ${tone}`;
  actions.innerHTML = buttons.map((b, i) => `<button type="button" class="btn ${
    b.kind === 'danger' ? 'btn-danger-solid' : b.kind === 'primary' ? 'btn-primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('');
  return new Promise(resolve => {
    let result = null;
    const onClick = e => {
      const btn = e.target.closest('[data-i]');
      if (!btn) return;
      result = buttons[Number(btn.dataset.i)].value;
      dlg.close();
    };
    actions.addEventListener('click', onClick);
    dlg.addEventListener('close', () => { actions.removeEventListener('click', onClick); resolve(result); }, { once: true });
    dlg.showModal();
    // Sicherer Standard: Fokus auf „Abbrechen“
    const safe = buttons.findIndex(b => b.value === false || b.value === null);
    actions.querySelector(`[data-i="${safe >= 0 ? safe : 0}"]`).focus();
  });
}
const confirmDelete = (title, message, label = 'Löschen') =>
  ask({ title, message, buttons: [{ label, value: true, kind: 'danger' }, { label: 'Abbrechen', value: false }] }).then(v => v === true);

/* ---------- Ziehen zum Aktualisieren (nur Übersicht, nur oberes Drittel) ---------- */

const PTR_THRESHOLD = 70;
const ptrEl = $('#ptr');
const ptrRing = ptrEl.querySelector('.ptr-ring');
let ptr = null;
const anyDialogOpen = () => $$('dialog').some(d => d.open);

function setPtr(d) {
  const p = Math.min(1, d / PTR_THRESHOLD);
  ptrEl.style.transform = `translateY(${d}px)`;
  ptrEl.style.opacity = String(Math.min(1, d / 30));
  ptrRing.style.strokeDasharray = `${p * 80} 100`;
  ptrEl.classList.toggle('ready', p >= 1);
}
function resetPtr() {
  ptrEl.classList.remove('pulling', 'ready');
  ptrEl.style.transform = '';
  ptrEl.style.opacity = '';
}
async function refreshApp() {
  ptrEl.classList.remove('pulling');
  ptrEl.classList.add('loading');
  setPtr(PTR_THRESHOLD);
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await Promise.race([reg.update(), new Promise(r => setTimeout(r, 1500))]);
  } catch {}
  location.reload();
}

document.addEventListener('touchstart', e => {
  ptr = null;
  if (currentView !== 'dashboard' || e.touches.length !== 1 || window.scrollY > 0 || anyDialogOpen()) return;
  const t = e.touches[0];
  if (t.clientY > window.innerHeight / 3) return;
  ptr = { x0: t.clientX, y0: t.clientY, dist: 0, active: false };
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!ptr) return;
  const t = e.touches[0];
  const dy = t.clientY - ptr.y0;
  const dx = t.clientX - ptr.x0;
  if (!ptr.active) {
    if (dy < -4 || Math.abs(dx) > Math.abs(dy) + 4) { ptr = null; return; }
    if (dy < 8) return;
    ptr.active = true;
    ptrEl.classList.add('pulling');
  }
  if (e.cancelable) e.preventDefault();
  ptr.dist = Math.min(130, Math.max(0, dy) * 0.55);
  setPtr(ptr.dist);
}, { passive: false });
document.addEventListener('touchend', () => {
  if (!ptr) return;
  const ready = ptr.active && ptr.dist >= PTR_THRESHOLD;
  const active = ptr.active;
  ptr = null;
  if (ready) refreshApp();
  else if (active) resetPtr();
});
document.addEventListener('touchcancel', () => { if (ptr) { ptr = null; resetPtr(); } });

/* ---------- Vertragsansicht nach unten wegwischen ---------- */

function enableSwipeToClose(dlg) {
  let s = null;
  dlg.addEventListener('touchstart', e => {
    s = null;
    if (e.touches.length !== 1 || e.target.closest('.sheet-foot')) return;
    const body = dlg.querySelector('.sheet-body');
    // Nur wenn der Inhalt ganz oben ist – sonst wird normal gescrollt
    if (body && body.contains(e.target) && body.scrollTop > 0) return;
    const t = e.touches[0];
    s = { x0: t.clientX, y0: t.clientY, t0: performance.now(), dy: 0, active: false };
  }, { passive: true });
  dlg.addEventListener('touchmove', e => {
    if (!s) return;
    const t = e.touches[0];
    const dy = t.clientY - s.y0;
    const dx = t.clientX - s.x0;
    if (!s.active) {
      if (dy < -4 || Math.abs(dx) > Math.abs(dy) + 4) { s = null; return; }
      if (dy < 8) return;
      s.active = true;
      s.t0 = performance.now();
      s.y0 = t.clientY;
      dlg.classList.add('dragging');
    }
    if (e.cancelable) e.preventDefault();
    s.dy = Math.max(0, t.clientY - s.y0);
    dlg.style.transform = `translateY(${s.dy}px)`;
  }, { passive: false });
  const end = () => {
    if (!s) return;
    const { dy, t0, active } = s;
    s = null;
    dlg.classList.remove('dragging');
    if (!active) return;
    const velocity = dy / Math.max(1, performance.now() - t0);
    if (dy > 120 || (dy > 40 && velocity > 0.5)) {
      dlg.style.transform = `translateY(${window.innerHeight}px)`;
      setTimeout(() => { dlg.close(); dlg.style.transform = ''; }, 200);
    } else {
      dlg.style.transform = '';
    }
  };
  dlg.addEventListener('touchend', end);
  dlg.addEventListener('touchcancel', end);
}
enableSwipeToClose($('#dlg-detail'));

/* ---------- Toast ---------- */

let toastTimer;
const toastEl = $('#toast');
const hasPopover = typeof toastEl.showPopover === 'function';
if (!hasPopover) toastEl.hidden = true;
function toast(msg) {
  toastEl.textContent = msg;
  clearTimeout(toastTimer);
  if (hasPopover) {
    // Neu öffnen, damit der Hinweis über einem gerade geöffneten Dialog liegt
    try { toastEl.hidePopover(); } catch {}
    toastEl.showPopover();
  } else {
    toastEl.hidden = false;
  }
  toastTimer = setTimeout(() => {
    if (hasPopover) { try { toastEl.hidePopover(); } catch {} } else toastEl.hidden = true;
  }, 2800);
}

/* ---------- Events ---------- */

$('#btn-add').addEventListener('click', () => openForm());
document.addEventListener('click', e => {
  const item = e.target.closest('.item[data-id]');
  if (item) { openDetail(item.dataset.id); return; }
  if (e.target.closest('[data-action="add"]')) openForm();
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
});
// Klick auf den Hintergrund schließt Dialoge
for (const dlg of $$('dialog')) {
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
}

$('#detail-edit').addEventListener('click', () => openForm(currentId));
$('#detail-delete').addEventListener('click', async () => {
  const c = contracts.find(x => x.id === currentId);
  const n = docCounts.get(currentId) || 0;
  if (!c) return;
  const ok = await confirmDelete('Vertrag löschen?',
    `„${c.name}“ wird dauerhaft gelöscht.${n ? ` ${n === 1 ? 'Das angehängte Dokument wird' : `Die ${n} angehängten Dokumente werden`} ebenfalls gelöscht.` : ''}`);
  if (!ok) return;
  contracts = contracts.filter(x => x.id !== currentId);
  persist();
  await docStore.removeByContract(c.id).catch(() => {});
  await loadDocCounts();
  updateStorageInfo();
  renderAll();
  $('#dlg-detail').close();
  toast('Vertrag gelöscht');
});
$('#detail-ics').addEventListener('click', () => {
  const c = contracts.find(x => x.id === currentId);
  const s = c && schedule(c);
  if (s && s.kind === 'deadline') downloadICS([{ c, s }], `kuendigungsfrist-${c.name.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.ics`);
});

['#search', '#filter-status', '#filter-category', '#sort'].forEach(sel => $(sel).addEventListener('input', renderContracts));

$('#set-warn-days').addEventListener('change', e => {
  settings.warnDays = Math.min(365, Math.max(1, parseInt(e.target.value, 10) || 30));
  e.target.value = settings.warnDays;
  saveSettings();
  renderAll();
});
$('#set-theme').addEventListener('change', e => { settings.theme = e.target.value; saveSettings(); applyTheme(); });
$('#btn-notify').addEventListener('click', async () => {
  const p = await Notification.requestPermission();
  updateNotifyState();
  if (p === 'granted') { toast('Benachrichtigungen aktiviert'); checkDeadlines(); }
});
$('#btn-ics-all').addEventListener('click', () => {
  const items = contracts.filter(c => c.status === 'active').map(c => ({ c, s: schedule(c) })).filter(x => x.s.kind === 'deadline');
  if (!items.length) { toast('Keine berechenbaren Fristen vorhanden.'); return; }
  downloadICS(items, `kuendigungsfristen-${toISO(today())}.ics`);
});
$('#btn-export').addEventListener('click', exportJSON);
$('#btn-export-csv').addEventListener('click', exportCSV);
$('#import-file').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) importJSON(f);
  e.target.value = '';
});
$('#btn-demo').addEventListener('click', async () => {
  if (contracts.length && !(await ask({
    title: 'Beispieldaten hinzufügen?', message: 'Die Beispielverträge werden zu deinen vorhandenen Verträgen hinzugefügt.',
    icon: ICONS.plus, tone: 'neutral',
    buttons: [{ label: 'Hinzufügen', value: true, kind: 'primary' }, { label: 'Abbrechen', value: false }],
  }))) return;
  contracts.push(...demoData());
  persist();
  renderAll();
  toast('Beispieldaten geladen');
});
$('#btn-clear').addEventListener('click', async () => {
  if (!contracts.length) { toast('Keine Daten vorhanden.'); return; }
  const ok = await confirmDelete('Alle Daten löschen?',
    `Alle ${contracts.length} Verträge und ihre Dokumente werden gelöscht. Das kann nicht rückgängig gemacht werden.\n\nTipp: Vorher ein Backup exportieren.`, 'Alles löschen');
  if (!ok) return;
  contracts = [];
  persist();
  await docStore.clear().catch(() => {});
  await loadDocCounts();
  renderAll();
  updateStorageInfo();
  toast('Alle Daten gelöscht');
});

/* ---------- Start ---------- */

applyTheme();
$('#set-warn-days').value = settings.warnDays;
$('#set-theme').value = settings.theme;
$('#app-version').textContent = APP_VERSION;
updateNotifyState();
renderAll();
loadDocCounts().then(renderAll);
updateStorageInfo();

const params = new URLSearchParams(location.search);
let startTab = 'dashboard';
try { startTab = sessionStorage.getItem('vw.tab') || startTab; } catch {}
showView(params.get('view') || startTab);
if (params.get('action') === 'add') openForm();
if (params.get('id')) openDetail(params.get('id'));

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(() => checkDeadlines()).catch(() => {});
  });
} else {
  checkDeadlines();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { renderAll(); checkDeadlines(); }
});
