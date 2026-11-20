'use strict';

const APP_VERSION = '1.0.0';
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
  const sub = [c.category, c.account].filter(Boolean).map(esc).join(' · ') || esc(c.provider || '');
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

function showView(name) {
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
    ${c.notes ? `<div class="notes">${esc(c.notes)}</div>` : ''}`;
  $('#detail-ics').hidden = s.kind !== 'deadline';
  $('#dlg-detail').showModal();
}

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

function exportJSON() {
  const payload = { app: 'vertragswaechter', version: 1, exportedAt: new Date().toISOString(), contracts };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `vertragswaechter-backup-${toISO(today())}.json`);
}

function exportCSV() {
  const cols = [['Name', 'name'], ['Anbieter', 'provider'], ['Kategorie', 'category'], ['Status', c => STATUS[c.status]],
    ['Betrag', c => String(c.amount).replace('.', ',')], ['Intervall', c => (INTERVALS[c.interval] || {}).label],
    ['Monatlich', c => monthlyCost(c).toFixed(2).replace('.', ',')], ['Konto', 'account'], ['Zahlungsart', 'paymentMethod'],
    ['Abschluss', 'startDate'], ['Mindestlaufzeit (Monate)', 'minTermMonths'], ['Verlängerung (Monate)', 'renewalMonths'],
    ['Kündigungsfrist', noticeText], ['Kündigen bis', c => { const s = schedule(c); return s.kind === 'deadline' ? toISO(s.deadline) : ''; }],
    ['Gekündigt am', 'cancelledAt'], ['Vertragsende', 'endDate'], ['Vertragsnr.', 'contractNo'], ['Website', 'website'],
    ['Kündigung an', 'cancelContact'], ['Notizen', 'notes']];
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
    const replace = contracts.length === 0 || confirm(
      `${clean.length} Verträge gefunden.\n\nOK = Vorhandene Daten ersetzen\nAbbrechen = Zusammenführen (gleiche IDs werden aktualisiert)`);
    if (replace) {
      contracts = clean;
    } else {
      const map = new Map(contracts.map(c => [c.id, c]));
      for (const c of clean) map.set(c.id, c);
      contracts = [...map.values()];
    }
    persist();
    renderAll();
    toast(`${clean.length} Verträge importiert`);
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

/* ---------- Theme ---------- */

function applyTheme() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

/* ---------- Toast ---------- */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
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
$('#detail-delete').addEventListener('click', () => {
  const c = contracts.find(x => x.id === currentId);
  if (!c || !confirm(`„${c.name}“ wirklich löschen?`)) return;
  contracts = contracts.filter(x => x.id !== currentId);
  persist();
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
$('#btn-demo').addEventListener('click', () => {
  if (contracts.length && !confirm('Beispieldaten zu deinen vorhandenen Verträgen hinzufügen?')) return;
  contracts.push(...demoData());
  persist();
  renderAll();
  toast('Beispieldaten geladen');
});
$('#btn-clear').addEventListener('click', () => {
  if (!contracts.length) { toast('Keine Daten vorhanden.'); return; }
  if (!confirm('Wirklich ALLE Verträge löschen? Das kann nicht rückgängig gemacht werden.\n\nTipp: Vorher ein Backup exportieren.')) return;
  contracts = [];
  persist();
  renderAll();
  toast('Alle Daten gelöscht');
});

/* ---------- Start ---------- */

applyTheme();
$('#set-warn-days').value = settings.warnDays;
$('#set-theme').value = settings.theme;
$('#app-version').textContent = APP_VERSION;
updateNotifyState();
renderAll();

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
