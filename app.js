'use strict';

const APP_VERSION = '1.34.0';
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
let settings = Object.assign({ warnDays: 30, theme: 'system', autoLogos: true }, safeGet(SETTINGS_KEY, {}));

function persist() { safeSet(STORAGE_KEY, contracts); }

/* ---------- Konten ---------- */

const ACCOUNTS_KEY = 'vw.accounts.v1';
const BANKS = ['Sparkasse', 'Volksbank', 'Raiffeisenbank', 'Deutsche Bank', 'Commerzbank', 'Postbank', 'DKB', 'ING', 'N26', 'comdirect',
  'Consorsbank', 'Targobank', 'HypoVereinsbank', 'Santander', 'Sparda-Bank', 'PSD Bank', 'C24', 'Revolut', 'Trade Republic',
  'American Express', 'Barclays', 'Hanseatic Bank', 'Advanzia', 'PayPal'];
let accounts = safeGet(ACCOUNTS_KEY, []);
function persistAccounts() { safeSet(ACCOUNTS_KEY, accounts); }
const accountById = id => (id ? accounts.find(a => a.id === id) : null);

function guessAccountType(name) {
  const n = name.toLowerCase();
  if (/kredit|visa|master|amex|american express/.test(n)) return 'kredit';
  if (/paypal/.test(n)) return 'paypal';
  if (/tagesgeld|spar(konto|buch)/.test(n)) return 'tagesgeld';
  return 'giro';
}

/**
 * Verknüpft Verträge mit Konten. Verträge, die nur einen Kontonamen haben (ältere Daten,
 * Import, Beispieldaten), bekommen ein passendes Konto – bei Bedarf wird es angelegt.
 */
function syncAccountsFromContracts() {
  let changedContracts = false, changedAccounts = false;
  for (const c of contracts) {
    const linked = accountById(c.accountId);
    if (linked) {
      if (c.account !== linked.name) { c.account = linked.name; changedContracts = true; }
      continue;
    }
    if (c.accountId) { c.accountId = ''; changedContracts = true; }
    const name = String(c.account || '').trim();
    if (!name) continue;
    let acc = accounts.find(a => a.name.toLowerCase() === name.toLowerCase());
    if (!acc) {
      acc = { id: uid(), name, type: guessAccountType(name), bank: '', iban: '', cardLast4: '', email: '', notes: '', createdAt: new Date().toISOString() };
      accounts.push(acc);
      changedAccounts = true;
    }
    c.accountId = acc.id;
    c.account = acc.name;
    changedContracts = true;
  }
  if (changedAccounts) persistAccounts();
  if (changedContracts) persist();
}

/* IBAN: Format, Prüfziffer (ISO 13616, Modulo 97), gekürzte Anzeige */
const normIban = s => String(s || '').replace(/\s+/g, '').toUpperCase();
function ibanValid(s) {
  const i = normIban(s);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(i)) return false;
  if (i.startsWith('DE') && i.length !== 22) return false;
  const digits = (i.slice(4) + i.slice(0, 4)).replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}
const formatIban = s => normIban(s).replace(/(.{4})/g, '$1 ').trim();
// Geschützte Leerzeichen, damit die gekürzte IBAN nicht umbricht
const maskIban = s => { const i = normIban(s); return i ? `${i.slice(0, 4)}\u00a0••••\u00a0${i.slice(-4)}` : ''; };

function accountDetails(a) {
  if (a.type === 'kredit') return a.cardLast4 ? `Karte •••• ${a.cardLast4}` : '';
  if (a.type === 'paypal') return a.email || '';
  return a.iban ? `IBAN ${maskIban(a.iban)}` : '';
}
function accountAvatar(a, extraClass = '') {
  // Bank-Logo automatisch über den Kontonamen (z. B. „Girokonto Sparkasse“, „PayPal“)
  return avatar({ name: a.name, provider: `${a.name} ${a.bank || ''}`, website: '', logoMode: 'auto' }, extraClass);
}
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
const shortDateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
function fmtShort(d) { return d ? shortDateFmt.format(d) : ''; }
function fmtISO(s) { return fmtDate(parseISO(s)); }
function relDays(n) {
  if (n === 0) return 'heute';
  if (n === 1) return 'morgen';
  if (n < 0) return `vor ${-n} ${-n === 1 ? 'Tag' : 'Tagen'}`;
  return `in ${n} Tagen`;
}

/* ---------- Fachlogik ---------- */

/* Preise: Betrag ab Vertragsbeginn, weitere Preise ab bestimmten Daten und Preis nach automatischer Verlängerung */
const hasNum = v => v !== '' && v != null && Number.isFinite(Number(v));
function renewalStart(c) {
  const start = parseISO(c.startDate);
  const first = Number(c.minTermMonths) || Number(c.renewalMonths) || 0;
  return start && first ? addMonths(start, first) : null;
}
/**
 * Preise mit Zeitraum: [{ from, to, amount }] – „from“ leer = ab Vertragsbeginn, „to“ leer = läuft noch.
 * Ausdrücklich begrenzte Zeiträume haben Vorrang; der Preis nach Verlängerung ersetzt einen
 * noch laufenden Preis, der vor der Verlängerung begonnen hat.
 */
function pricePeriods(c) {
  if (Array.isArray(c.prices) && c.prices.length) return c.prices;
  return [{ from: '', to: '', amount: Number(c.amount) || 0 }];
}
function priceAt(c, d = today()) {
  const periods = pricePeriods(c).filter(p => hasNum(p.amount))
    .map(p => ({ from: parseISO(p.from), to: parseISO(p.to), amount: Number(p.amount) }));
  if (!periods.length) return { amount: Number(c.amount) || 0, kind: 'base' };
  const hit = periods.filter(p => (!p.from || p.from <= d) && (!p.to || p.to >= d))
    .sort((x, y) => (x.from || 0) - (y.from || 0)).pop();
  const r = renewalStart(c);
  const renewal = r && r <= d && hasNum(c.renewalAmount);
  if (renewal && (!hit || (!hit.to && (!hit.from || hit.from < r)))) return { amount: Number(c.renewalAmount), kind: 'renewal', from: r };
  if (hit) return { ...hit, kind: 'period' };
  // Kein Zeitraum passt: zuletzt gültiger Preis, sonst der früheste
  const past = periods.filter(p => p.to && p.to < d).sort((x, y) => x.to - y.to).pop();
  return { ...(past || periods.sort((x, y) => (x.from || 0) - (y.from || 0))[0]), kind: 'period' };
}
const currentAmount = c => priceAt(c).amount;
/**
 * Durchschnittlicher Preis (je Zahlungsintervall) von Vertragsbeginn bis heute bzw. bis zum Vertragsende,
 * gewichtet nach der Dauer jedes Preises. Nur sinnvoll, wenn es in diesem Zeitraum mehrere Preise gab.
 */
function averagePrice(c) {
  const periods = pricePeriods(c);
  const start = parseISO(c.startDate);
  const min = Number(c.minTermMonths) || 0;
  // Über die gesamte Mindestlaufzeit (Vertragsbeginn bis Ende der Mindestlaufzeit)
  if (!start || !min) return null;
  const end = addDays(addMonths(start, min), -1);
  const stop = addDays(end, 1);
  const pts = [start, stop];
  const add = d => { if (d && d > start && d < stop) pts.push(d); };
  for (const p of periods) { add(parseISO(p.from)); const t = parseISO(p.to); if (t) add(addDays(t, 1)); }
  add(renewalStart(c));
  const uniq = [...new Set(pts.map(d => d.getTime()))].sort((a, b) => a - b).map(t => new Date(t));
  let sum = 0, days = 0;
  const amounts = new Set();
  for (let i = 0; i < uniq.length - 1; i++) {
    const n = daysBetween(uniq[i], uniq[i + 1]);
    if (n <= 0) continue;
    const a = priceAt(c, uniq[i]).amount;
    amounts.add(a);
    sum += a * n; days += n;
  }
  if (!days || amounts.size < 2) return null;
  return { amount: sum / days, from: start, to: end, days, months: min };
}
function nextPriceChange(c, d = today()) {
  const cur = currentAmount(c);
  const dates = [];
  for (const p of pricePeriods(c)) {
    const f = parseISO(p.from), t = parseISO(p.to);
    if (f && f > d) dates.push(f);
    if (t && t >= d) dates.push(addDays(t, 1));
  }
  const r = renewalStart(c);
  if (r && r > d && hasNum(c.renewalAmount)) dates.push(r);
  for (const x of dates.sort((a, b) => a - b)) {
    const at = priceAt(c, x);
    if (at.amount !== cur) return { from: x, amount: at.amount, kind: at.kind };
  }
  return null;
}

function monthlyCost(c) {
  const i = INTERVALS[c.interval] || INTERVALS.monthly;
  return currentAmount(c) * i.perMonth;
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
  if (c.status === 'cancelled') {
    const sentAt = parseISO(c.cancelledAt);
    return { kind: 'cancelled', endDate: parseISO(c.endDate), confirmed: !!c.cancelConfirmedAt, sentAt,
      waitingDays: sentAt ? daysBetween(sentAt, ref) : 0 };
  }

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

// Nach so vielen Tagen ohne Kündigungsbestätigung wird nachgehakt
const CONFIRM_WAIT_DAYS = 14;

/** Vertragsende, wenn am Tag `sent` gekündigt wird (nächstmögliches Laufzeitende) */
function endIfCancelledOn(c, sent) {
  const s = schedule({ ...c, status: 'active' }, sent);
  if (s.kind === 'deadline') return s.termEnd;
  if (s.kind === 'anytime') return s.earliestEnd;
  return null;
}

/**
 * Gekündigte Verträge, deren Vertragsende vorbei ist, gelten automatisch als beendet.
 * Ältere Daten ohne Bestätigungsfeld gelten als bestätigt (früher gab es den Schritt nicht).
 */
function normalizeCancellations() {
  let changed = false;
  const t = today();
  for (const c of contracts) {
    // Früher gab es nur ein Feld „Vertrags-/Kundennummer“ – das wird zur Kundennummer
    if (c.customerNo === undefined) { c.customerNo = c.contractNo || ''; c.contractNo = ''; changed = true; }
    // Preise in Zeiträume umwandeln (früher: ein Betrag plus „Preis ab Datum“)
    if (!Array.isArray(c.prices)) {
      const steps = (c.priceSteps || []).filter(p => p.from).sort((a, b) => a.from.localeCompare(b.from));
      const list = [{ from: '', amount: Number(c.amount) || 0 }, ...steps.map(p => ({ from: p.from, amount: Number(p.amount) || 0 }))];
      c.prices = list.map((p, i) => ({ from: p.from, to: list[i + 1] ? toISO(addDays(parseISO(list[i + 1].from), -1)) : '', amount: p.amount }));
      delete c.priceSteps;
      changed = true;
    }
    if ((c.status === 'cancelled' || c.status === 'ended') && c.cancelConfirmedAt === undefined) {
      c.cancelConfirmedAt = c.cancelledAt || ''; changed = true;
    }
    const end = parseISO(c.endDate);
    if (c.status === 'cancelled' && end && end < t) { c.status = 'ended'; changed = true; }
  }
  if (changed) persist();
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
    case 'cancelled': return s.confirmed
      ? `<span class="badge">Gekündigt${s.endDate ? ' · endet ' + fmtDate(s.endDate) : ''}</span>`
      : `<span class="badge ${s.waitingDays >= CONFIRM_WAIT_DAYS ? 'urgent' : 'soon'}">Bestätigung ausstehend</span>`;
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
/* ---------- Logos ---------- */

const LOGO_CACHE_KEY = 'vw.logos.v1';
const LOGO_RETRY_MS = 7 * 24 * 3600 * 1000;   // fehlgeschlagene Logos nach 7 Tagen erneut versuchen
const logoUrl = domain => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;

// Bekannte Anbieter → Webadresse. Reihenfolge zählt: Spezielles vor Allgemeinem.
const KNOWN_PROVIDERS = [
  [/netflix/, 'netflix.com'], [/spotify/, 'spotify.com'], [/disney/, 'disneyplus.com'], [/dazn/, 'dazn.com'],
  [/\bwow\b/, 'wowtv.de'], [/\bsky\b/, 'sky.de'], [/joyn/, 'joyn.de'], [/rtl\s*\+|rtl plus/, 'plus.rtl.de'],
  [/paramount/, 'paramountplus.com'], [/crunchyroll/, 'crunchyroll.com'], [/waipu/, 'waipu.tv'], [/zattoo/, 'zattoo.com'],
  [/youtube/, 'youtube.com'], [/twitch/, 'twitch.tv'], [/audible/, 'audible.de'], [/kindle|amazon|prime video|\bprime\b/, 'amazon.de'],
  [/deezer/, 'deezer.com'], [/tidal/, 'tidal.com'], [/apple|icloud|itunes/, 'apple.com'],
  [/xbox|game ?pass/, 'xbox.com'], [/microsoft|office|\bm365\b|onedrive|outlook/, 'microsoft.com'],
  [/playstation|\bps ?plus\b/, 'playstation.com'], [/nintendo/, 'nintendo.de'], [/steam/, 'steampowered.com'],
  [/google|gemini/, 'google.com'], [/chatgpt|openai/, 'openai.com'], [/claude|anthropic/, 'claude.ai'],
  [/adobe|photoshop|lightroom/, 'adobe.com'], [/dropbox/, 'dropbox.com'], [/github/, 'github.com'], [/canva/, 'canva.com'],
  [/1password/, '1password.com'], [/bitwarden/, 'bitwarden.com'], [/nordvpn/, 'nordvpn.com'], [/surfshark/, 'surfshark.com'],
  [/proton/, 'proton.me'], [/notion/, 'notion.so'], [/duolingo/, 'duolingo.com'], [/linkedin/, 'linkedin.com'],
  [/patreon/, 'patreon.com'], [/strava/, 'strava.com'], [/peloton/, 'onepeloton.de'], [/gymondo/, 'gymondo.com'],
  [/telekom|magenta|t-mobile/, 'telekom.de'], [/vodafone/, 'vodafone.de'], [/\bo2\b|telef[oó]nica/, 'o2online.de'],
  [/1\s*(&|und)\s*1/, '1und1.de'], [/congstar/, 'congstar.de'], [/freenet/, 'freenet.de'], [/aldi ?talk/, 'alditalk.de'],
  [/fraenk/, 'fraenk.de'], [/winsim/, 'winsim.de'], [/klarmobil/, 'klarmobil.de'], [/blau\.de|\bblau\b/, 'blau.de'],
  [/huk/, 'huk.de'], [/allianz/, 'allianz.de'], [/\baxa\b/, 'axa.de'], [/\bergo\b/, 'ergo.de'], [/devk/, 'devk.de'],
  [/generali/, 'generali.de'], [/signal iduna/, 'signal-iduna.de'], [/\bcosmos/, 'cosmosdirekt.de'], [/\btk\b|techniker/, 'tk.de'],
  [/\baok\b/, 'aok.de'], [/barmer/, 'barmer.de'], [/\bdak\b/, 'dak.de'], [/adac/, 'adac.de'], [/check24/, 'check24.de'],
  [/fitx/, 'fitx.de'], [/mcfit/, 'mcfit.com'], [/urban sports/, 'urbansportsclub.com'], [/clever fit/, 'clever-fit.com'],
  [/john reed/, 'johnreed.fitness'], [/\bevo fitness|\bevo\b/, 'evofitness.de'],
  [/e\.on|\beon\b/, 'eon.de'], [/vattenfall/, 'vattenfall.de'], [/enbw/, 'enbw.com'], [/\brwe\b/, 'rwe.com'],
  [/tibber/, 'tibber.com'], [/ostrom/, 'ostrom.de'], [/octopus/, 'octopusenergy.de'], [/lichtblick/, 'lichtblick.de'],
  [/paypal/, 'paypal.com'], [/\bdkb\b/, 'dkb.de'], [/\bing\b/, 'ing.de'], [/\bn26\b/, 'n26.com'], [/comdirect/, 'comdirect.de'],
  [/sparkasse/, 'sparkasse.de'], [/volksbank|raiffeisen/, 'vr.de'], [/commerzbank/, 'commerzbank.de'], [/deutsche bank/, 'deutsche-bank.de'],
  [/trade republic/, 'traderepublic.com'], [/scalable/, 'scalable.capital'], [/american express|amex/, 'americanexpress.com'],
  [/bahncard|deutsche bahn|\bdb\b|deutschlandticket|d-ticket/, 'bahn.de'], [/\bbvg\b/, 'bvg.de'], [/\bmvv\b/, 'mvv-muenchen.de'],
  [/\bhvv\b/, 'hvv.de'], [/share now/, 'share-now.com'], [/miles/, 'miles-mobility.com'],
  [/spiegel/, 'spiegel.de'], [/\bzeit\b/, 'zeit.de'], [/\bfaz\b|frankfurter allgemeine/, 'faz.net'], [/s(ü|ue)ddeutsche|\bsz\b/, 'sueddeutsche.de'],
  [/\bbild\b/, 'bild.de'], [/handelsblatt/, 'handelsblatt.com'], [/readly/, 'gb.readly.com'],
  [/hellofresh/, 'hellofresh.de'], [/rundfunk|\bgez\b/, 'rundfunkbeitrag.de'], [/lieferando/, 'lieferando.de'], [/wolt/, 'wolt.com'],
];

function domainFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '') || null;
  } catch { return null; }
}
function logoDomain(c) {
  const fromSite = domainFromUrl(c.website);
  if (fromSite) return fromSite;
  const text = `${c.provider || ''} ${c.name || ''}`.toLowerCase();
  for (const [re, domain] of KNOWN_PROVIDERS) if (re.test(text)) return domain;
  return null;
}

let logoCache = safeGet(LOGO_CACHE_KEY, {});
const logoFetching = new Map();
function saveLogoCache() { safeSet(LOGO_CACHE_KEY, logoCache); }

/** Lädt ein Logo einmalig und speichert es als Daten-URL auf dem Gerät. */
function fetchLogo(domain) {
  if (!logoFetching.has(domain)) {
    logoFetching.set(domain, fetchLogoNow(domain).finally(() => logoFetching.delete(domain)));
  }
  return logoFetching.get(domain);
}
async function fetchLogoNow(domain) {
  try {
    const res = await fetch(logoUrl(domain), { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) { logoCache[domain] = { src: null, ts: Date.now() }; saveLogoCache(); return; }
    const blob = await res.blob();
    if (!blob.size || !/^image\//.test(blob.type || 'image/')) { logoCache[domain] = { src: null, ts: Date.now() }; saveLogoCache(); return; }
    const src = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    logoCache[domain] = { src, ts: Date.now() };
    saveLogoCache();
  } catch {
    // Speichern nicht möglich (z. B. offline oder vom Dienst nicht erlaubt): Bild wird direkt geladen
    logoCache[domain] = { remote: true, ts: Date.now() };
    saveLogoCache();
  }
}

/** Liefert { src, custom } für das anzuzeigende Logo oder null (→ Anfangsbuchstabe). */
function resolveLogo(c) {
  const mode = c.logoMode || 'auto';
  if (mode === 'custom' && c.logo) return { src: c.logo, custom: true };
  if (mode === 'none' || mode === 'custom' || !settings.autoLogos) return null;
  const domain = logoDomain(c);
  if (!domain) return null;
  const entry = logoCache[domain];
  if (entry && entry.src) return { src: entry.src, domain };
  if (entry && entry.src === null && Date.now() - entry.ts < LOGO_RETRY_MS) return null;
  if (!entry || (!entry.remote && Date.now() - entry.ts >= LOGO_RETRY_MS)) fetchLogo(domain);
  return { src: logoUrl(domain), domain, remote: true };
}

function avatar(c, extraClass = '') {
  const initial = (c.name || '?').trim().charAt(0).toUpperCase() || '?';
  const bg = `hsl(${hue(c.name)} 55% 42%)`;
  const logo = resolveLogo(c);
  if (logo) {
    return `<span class="avatar has-logo${logo.custom ? ' custom' : ''} ${extraClass}" style="background:${bg}" data-initial="${esc(initial)}" aria-hidden="true">` +
      `<img class="logo-img" src="${esc(logo.src)}" alt="" loading="lazy" referrerpolicy="no-referrer"${logo.domain ? ` data-domain="${esc(logo.domain)}"` : ''}></span>`;
  }
  return `<span class="avatar ${extraClass}" style="background:${bg}" aria-hidden="true">${esc(initial)}</span>`;
}

// Logo lässt sich nicht laden → Anfangsbuchstabe zeigen und merken
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('logo-img')) return;
  const box = img.parentElement;
  box.classList.remove('has-logo', 'custom');
  box.textContent = box.dataset.initial || '?';
  const domain = img.dataset.domain;
  if (domain && navigator.onLine) {
    logoCache[domain] = { src: null, ts: Date.now() };
    saveLogoCache();
  }
}, true);
// Winzige Platzhalter-Symbole (1×1) wie fehlende Logos behandeln
document.addEventListener('load', e => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('logo-img') && img.naturalWidth > 0 && img.naturalWidth < 8) {
    img.dispatchEvent(new Event('error'));
  }
}, true);

/**
 * Bereitet ein eigenes Logo auf: leeren Rand entfernen, vollständig (ohne Abschneiden)
 * in ein Quadrat einpassen und als kleine, scharfe Datei speichern.
 */
async function prepareLogo(blob, size = 160) {
  const img = await loadImage(blob);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error('image');

  // 1. Verkleinerte Kopie zur Analyse
  const a = Math.min(1, 600 / Math.max(w, h));
  const aw = Math.max(1, Math.round(w * a)), ah = Math.max(1, Math.round(h * a));
  const ac = document.createElement('canvas');
  ac.width = aw; ac.height = ah;
  const actx = ac.getContext('2d', { willReadFrequently: true });
  actx.drawImage(img, 0, 0, aw, ah);
  const px = actx.getImageData(0, 0, aw, ah).data;
  const at = (x, y) => { const i = (y * aw + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };

  // 2. Hintergrund an Ecken und Kanten bestimmen
  const samples = [];
  for (let k = 0; k <= 8; k++) {
    const fx = Math.round((aw - 1) * k / 8), fy = Math.round((ah - 1) * k / 8);
    samples.push(at(fx, 0), at(fx, ah - 1), at(0, fy), at(aw - 1, fy));
  }
  const transparentBg = samples.every(c => c[3] < 24);
  const avg = [0, 1, 2].map(i => samples.reduce((sum, c) => sum + c[i], 0) / samples.length);
  const dist = (c, b) => Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1]) + Math.abs(c[2] - b[2]);
  const solidBg = !transparentBg && samples.every(c => c[3] > 230 && dist(c, avg) < 45);
  const kind = transparentBg ? 'transparent' : solidBg ? 'solid' : 'photo';

  // 3. Inhalt finden (alles, was sich vom Hintergrund abhebt)
  let x0 = 0, y0 = 0, x1 = aw - 1, y1 = ah - 1;
  if (kind !== 'photo') {
    let minX = aw, minY = ah, maxX = -1, maxY = -1;
    for (let y = 0; y < ah; y++) {
      for (let x = 0; x < aw; x++) {
        const c = at(x, y);
        const isContent = kind === 'transparent' ? c[3] > 24 : (c[3] > 24 && dist(c, avg) > 60);
        if (isContent) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= 0) { x0 = minX; y0 = minY; x1 = maxX; y1 = maxY; }
  }
  // zurück auf Originalkoordinaten
  const sx = x0 / a, sy = y0 / a;
  const sw = Math.min(w - sx, (x1 - x0 + 1) / a), sh = Math.min(h - sy, (y1 - y0 + 1) / a);

  // 4. Vollständig ins Quadrat einpassen (mit Abstand), Hintergrund passend auffüllen
  const pad = kind === 'photo' ? 0 : Math.round(size * 0.1);
  const box = size - 2 * pad;
  const scale = Math.min(box / sw, box / sh);
  const dw = sw * scale, dh = sh * scale;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d');
  if (kind === 'solid') ctx.fillStyle = `rgb(${avg.map(Math.round).join(',')})`;
  else if (kind === 'photo') ctx.fillStyle = '#fff';
  if (kind !== 'transparent') ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return kind === 'photo' ? out.toDataURL('image/jpeg', 0.88) : out.toDataURL('image/png');
}
function dataUrlToBlob(url) {
  const [head, b64] = url.split(',');
  const type = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
  return new Blob([b64ToBuf(b64)], { type });
}
// Einmalig: früher zugeschnittene eigene Logos neu einpassen (entfernt u. a. weißen Rand)
async function migrateCustomLogos() {
  let changed = false;
  for (const c of contracts) {
    if (c.logoMode !== 'custom' || !c.logo || c.logoV === 2) continue;
    try { c.logo = await prepareLogo(dataUrlToBlob(c.logo)); } catch {}
    c.logoV = 2;
    changed = true;
  }
  if (changed) { persist(); renderAll(); }
}
function itemHTML(c) {
  const s = schedule(c);
  const iv = INTERVALS[c.interval] || INTERVALS.monthly;
  const n = docCounts.get(c.id) || 0;
  const clip = n ? `<span class="clip" title="${n} ${n === 1 ? 'Dokument' : 'Dokumente'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6L15 7.1"/></svg>${n}</span>` : '';
  const sub = [[c.category, c.account].filter(Boolean).map(esc).join(' · ') || esc(c.provider || ''), clip].filter(Boolean).join(' · ');
  // Bei nicht-monatlicher Zahlung zusätzlich den Monatswert zeigen
  const perMonth = c.interval !== 'monthly' ? `<span class="item-permonth">≈ ${eur.format(monthlyCost(c))}/Monat</span>` : '';
  // Nächste Preisänderung (nur bei laufenden Verträgen)
  const next = c.status === 'ended' ? null : nextPriceChange(c);
  return `
    <button type="button" class="item" data-id="${esc(c.id)}">
      ${avatar(c)}
      <span class="item-main">
        <span class="item-title">${esc(c.name)}</span>
        <span class="item-sub">${sub || '&nbsp;'}</span>
        <span class="item-badge">${scheduleBadge(s)}</span>
      </span>
      <span class="item-side">
        <span class="price">${eur.format(currentAmount(c))}</span>
        <span class="item-interval">${iv.label}</span>
        ${perMonth}
        ${next ? `<span class="item-next">ab ${fmtShort(next.from)}: ${eur.format(next.amount)}</span>` : ''}
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

  // Glocke in der Kopfzeile: Zahl anstehender Fristen, dringende (≤ 7 Tage) kräftiger
  const badge = $('#bell-badge');
  badge.hidden = due.length === 0;
  badge.textContent = due.length > 9 ? '9+' : String(due.length);
  badge.classList.toggle('urgent', due.some(x => x.s.daysLeft <= 7));
  $('#btn-bell').setAttribute('aria-label', due.length
    ? `${due.length} anstehende Kündigungsfristen` : 'Keine anstehenden Kündigungsfristen');

  renderDeadlines(withDeadline, due);

  const byCat = {};
  for (const c of costing) {
    const k = c.category || 'Ohne Kategorie';
    byCat[k] = (byCat[k] || 0) + monthlyCost(c);
  }
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 0;
  const total = rows.reduce((s, r) => s + r[1], 0);
  const pctFmt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('#by-category').innerHTML = rows.length
    ? rows.map(([k, v]) => `
        <${k === 'Ohne Kategorie' ? 'div' : 'button type="button"'} class="bar-row"${k === 'Ohne Kategorie' ? '' : ` data-category="${esc(k)}" aria-label="Verträge der Kategorie ${esc(k)} anzeigen"`}>
          <span class="bar-label" title="${esc(k)}">${esc(k)}</span>
          <span class="bar-track">${barHTML(max ? v / max * 100 : 0, total ? pctFmt.format(v / total * 100) + ' %' : '')}</span>
          <span class="bar-value">${eur.format(v)}</span>
        </${k === 'Ohne Kategorie' ? 'div' : 'button'}>`).join('')
    : '<p class="hint">Noch keine Kosten erfasst.</p>';
  $('#by-category').hidden = false;
}

/* Inhalt des Fristen-Fensters: ausstehende Bestätigungen, bald fällige und spätere Fristen */
function renderDeadlines(withDeadline, due) {
  const pending = contracts
    .filter(c => c.status === 'cancelled' && !c.cancelConfirmedAt)
    .sort((a, b) => String(a.cancelledAt).localeCompare(String(b.cancelledAt)));
  const later = withDeadline.filter(x => x.s.daysLeft > settings.warnDays);
  const group = (title, list, hint = '') => list.length ? `
    <h3 class="section-title">${title} <span class="count">(${list.length})</span></h3>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    <div class="list">${list.map(itemHTML).join('')}</div>` : '';
  const html = group('Bestätigung ausstehend', pending, 'Kündigung verschickt, aber noch nicht bestätigt.')
    + group(`In den nächsten ${settings.warnDays} Tagen`, due.map(x => x.c))
    + group('Später', later.map(x => x.c));
  $('#deadlines-body').innerHTML = html || (contracts.length === 0
    ? emptyHTML('Noch keine Verträge erfasst. Leg los – oder lade unter „Mehr“ Beispieldaten.')
    : emptyHTML('Keine anstehenden Fristen. Trage Abschlussdatum, Laufzeit und Kündigungsfrist ein, damit Fristen berechnet werden.', false));
}

// Balken mit Prozentangabe: im Balken, wenn genug Platz ist, sonst direkt dahinter
function barHTML(width, label) {
  return `<span class="bar-fill" style="width:${width.toFixed(1)}%"></span>${label ? `<span class="bar-pct">${label}</span>` : ''}`;
}

function sortContracts(list, sort = 'deadline') {
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
  return list.sort(sorters[sort] || sorters.deadline);
}

// Seite „Verträge“: Filter und Sortierung, nach Status gruppiert
const LIST_DEFAULTS = { status: 'all', category: '', account: '', sort: 'deadline' };
function listFilters() { return { ...LIST_DEFAULTS, ...(settings.list || {}) }; }
// Kategorie in der Übersicht antippen → Verträge, gefiltert nach dieser Kategorie
$('#by-category').addEventListener('click', e => {
  const row = e.target.closest('[data-category]');
  if (!row) return;
  settings.list = { ...listFilters(), status: 'all', account: '', category: row.dataset.category };
  saveSettings();
  renderContracts();
  showView('contracts');
  $('#view-contracts').scrollTo({ top: 0 });
});

function setListFilter(key, value) {
  settings.list = { ...listFilters(), [key]: value };
  saveSettings();
  renderContracts();
}

function renderContracts() {
  const f = listFilters();
  $('.list-filters').hidden = !contracts.length;
  for (const chip of $$('#list-status [data-status]')) chip.setAttribute('aria-pressed', String(chip.dataset.status === f.status));
  for (const [sel, val] of [['#list-category', f.category], ['#list-account', f.account], ['#list-sort', f.sort]]) {
    const el = $(sel);
    if ([...el.options].some(o => o.value === val)) el.value = val;
    el.classList.toggle('is-empty', !el.value);   // „Kategorie“/„Konto“ gedämpft, solange nichts gewählt
  }
  if (!contracts.length) { $('#contracts').innerHTML = emptyHTML('Noch keine Verträge erfasst.'); return; }

  const matches = contracts.filter(c =>
    (f.status === 'all' || c.status === f.status) &&
    (!f.category || c.category === f.category) &&
    (!f.account || (c.account || '') === f.account));
  const groups = [['active', 'Aktiv'], ['cancelled', 'Gekündigt'], ['ended', 'Beendet']]
    .map(([st, label]) => [label, sortContracts(matches.filter(c => c.status === st), f.sort)])
    .filter(([, list]) => list.length);

  const filtered = JSON.stringify(f) !== JSON.stringify(LIST_DEFAULTS);
  $('#list-reset').hidden = !filtered;
  $('#list-count').textContent = `${matches.length} ${matches.length === 1 ? 'Vertrag' : 'Verträge'}`;
  $('#contracts').innerHTML = groups.length
    ? groups.map(([label, list]) => `<h2 class="list-group-title">${label} · ${list.length}</h2>${list.map(itemHTML).join('')}`).join('')
    : '<div class="empty">Keine Verträge für diese Filter.</div>';
}

// Suchfenster: Treffer nach Suchbegriff und Filtern
function renderSearch(force = false) {
  if (!force && !$('#dlg-search').open) return;
  const raw = $('#search').value.trim();
  const q = raw.toLowerCase();
  const cat = $('#filter-category').value;
  const acc = $('#filter-account').value;
  const sort = $('#sort').value;
  for (const chip of $$('#filter-status [data-status]')) chip.setAttribute('aria-pressed', String(chip.dataset.status === searchStatus));

  const list = sortContracts(contracts.filter(c =>
    (searchStatus === 'all' || c.status === searchStatus) &&
    (!cat || c.category === cat) &&
    (!acc || (c.account || '') === acc) &&
    (!q || [c.name, c.provider, c.category, c.account, c.customerNo, c.contractNo, c.notes].some(v => String(v || '').toLowerCase().includes(q)))
  ), sort);

  const filtered = raw || searchStatus !== 'all' || cat || acc || sort !== 'deadline';
  $('#search-reset').hidden = !filtered;
  $('#search-count').textContent = `${list.length} ${list.length === 1 ? 'Vertrag' : 'Verträge'}${raw ? ` für „${raw}“` : ''}`;
  $('#search-results').innerHTML = list.length
    ? list.map(itemHTML).join('')
    : `<div class="empty">${contracts.length ? 'Kein Vertrag passt zu deiner Suche.' : 'Noch keine Verträge erfasst.'}</div>`;
}

function renderAccounts() {
  const costing = contracts.filter(isCosting);
  const sumOf = list => list.reduce((s, c) => s + monthlyCost(c), 0);
  const rows = accounts
    .map(a => { const list = costing.filter(c => c.accountId === a.id); return { a, list, sum: sumOf(list) }; })
    .sort((x, y) => y.sum - x.sum || x.a.name.localeCompare(y.a.name, 'de'));
  const unassigned = costing.filter(c => !accountById(c.accountId));

  // Konten sind aufklappbar; geöffnete Konten merkt sich die App
  const openSet = new Set(settings.accountsOpen || []);
  const card = (key, head, list, editId) => {
    const open = openSet.has(key);
    return `
    <div class="card account-card${open ? ' open' : ''}">
      <div class="account-head${editId ? '' : ' muted'}" data-account-toggle="${esc(key)}" role="button" tabindex="0" aria-expanded="${open}">
        ${head}
        <svg class="account-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </div>
      <div class="account-body"><div class="account-inner">
        ${list.length
          ? `<div class="list">${list.sort((a, b) => monthlyCost(b) - monthlyCost(a)).map(itemHTML).join('')}</div>`
          : '<p class="hint account-empty">Keine laufenden Verträge über dieses Konto.</p>'}
      </div></div>
    </div>`;
  };
  const countLine = (list, sum) => list.length
    ? `${list.length}\u00a0${list.length === 1 ? 'Vertrag' : 'Verträge'} · ${eur.format(sum * 12)}\u00a0pro\u00a0Jahr` : 'Noch keine Verträge';
  const side = sum => `<span class="item-side"><span class="price">${eur.format(sum)}</span><span class="item-interval">pro Monat</span></span>`;

  const html = rows.map(({ a, list, sum }) => card(a.id, `
        ${accountAvatar(a)}
        <span class="item-main">
          <span class="account-title-row"><span class="item-title">${esc(a.name)}</span><button type="button" class="account-pen" data-account="${esc(a.id)}" aria-label="Konto ${esc(a.name)} bearbeiten" title="Konto bearbeiten"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button></span>
          ${accountDetails(a) ? `<span class="item-sub">${esc(accountDetails(a))}</span>` : ''}
          <span class="item-sub">${countLine(list, sum)}</span>
        </span>
        ${side(sum)}`, list, a.id)).join('')
    + (unassigned.length ? card('__none__', `
        <span class="avatar" style="background:var(--surface-2);color:var(--muted)" aria-hidden="true">?</span>
        <span class="item-main">
          <span class="item-title">Ohne Konto</span>
          <span class="item-sub">${countLine(unassigned, sumOf(unassigned))}</span>
        </span>
        ${side(sumOf(unassigned))}`, unassigned, null) : '');

  $('#accounts').innerHTML = (html || '<div class="empty">Noch keine Konten angelegt.</div>')
    + '<button type="button" class="btn doc-add" id="account-add">＋ Konto hinzufügen</button>';
}

function refreshFilterOptions() {
  const cats = [...new Set(contracts.map(c => c.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const fillSelect = (sel, values, allLabel = 'Alle') => {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>` + values.map(v => `<option>${esc(v)}</option>`).join('');
    sel.value = values.includes(cur) ? cur : '';
  };
  fillSelect($('#filter-category'), cats);
  fillSelect($('#list-category'), cats);

  const allCats = [...new Set([...DEFAULT_CATEGORIES, ...cats])];
  $('#dl-categories').innerHTML = allCats.map(c => `<option value="${esc(c)}">`).join('');
  const accountNames = accounts.map(a => a.name).sort((a, b) => a.localeCompare(b, 'de'));
  fillSelect($('#filter-account'), accountNames);
  fillSelect($('#list-account'), accountNames);
}

$('#list-status').addEventListener('click', e => {
  const chip = e.target.closest('[data-status]');
  if (chip) setListFilter('status', chip.dataset.status);
});
$('#list-category').addEventListener('change', e => setListFilter('category', e.target.value));
$('#list-account').addEventListener('change', e => setListFilter('account', e.target.value));
$('#list-sort').addEventListener('change', e => setListFilter('sort', e.target.value));
$('#list-reset').addEventListener('click', () => { settings.list = { ...LIST_DEFAULTS }; saveSettings(); renderContracts(); });

function renderAll() {
  normalizeCancellations();
  refreshFilterOptions();
  renderDashboard();
  renderContracts();
  renderAccounts();
  renderSearch();
}

/* ---------- Navigation ---------- */

/* Seiten-Navigation: waagerecht wischen oder Tab antippen */
const VIEWS = ['dashboard', 'contracts', 'accounts', 'settings'];
const pager = $('#main');
let currentView = 'dashboard';
let navTarget = null;      // Ziel eines angetippten Tabs, solange dorthin geglitten wird
let navTimer;

const PAGE_TITLES = { dashboard: 'Übersicht', contracts: 'Verträge', accounts: 'Konten', settings: 'Mehr' };

function setActiveTab(name) {
  if (name === currentView && $('.tabbar [data-tab].active')?.dataset.tab === name) return;
  currentView = name;
  for (const b of $$('.tabbar [data-tab]')) b.classList.toggle('active', b.dataset.tab === name);
  $('#page-title').textContent = PAGE_TITLES[name];
  try { sessionStorage.setItem('vw.tab', name); } catch {}
}

/* Suchfenster: fährt von unten hoch, auf jeder Seite über die Lupe */
let searchStatus = 'all';
function openSearch() {
  const dlg = $('#dlg-search');
  if (dlg.open) return;
  renderSearch(true);
  dlg.showModal();
  noAutoFocus(dlg);
}
// Beim Öffnen kein Eingabefeld vorauswählen – sonst springt die Tastatur auf
function noAutoFocus(dlg) {
  const el = document.activeElement;
  if (el && dlg.contains(el) && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.blur();
}
// Bottom-Sheets nach unten hinausgleiten lassen statt hart zu schließen
// force: ohne Rückfrage (z. B. nach dem Speichern)
async function closeSheet(dlg, force = false) {
  if (!dlg.open || dlg.classList.contains('closing')) return;
  if (!force && dlg.guardClose && !(await dlg.guardClose())) { dlg.style.transform = ''; return; }
  dlg.classList.add('closing');
  dlg.style.transform = `translateY(${dlg.offsetHeight + 20}px)`;
  setTimeout(() => { dlg.close(); dlg.style.transform = ''; dlg.classList.remove('closing'); }, 300);
}
// Esc bei Fenstern von unten: ebenfalls über closeSheet (Animation und ggf. Rückfrage)
for (const sheet of document.querySelectorAll('dialog.bottom-sheet')) {
  sheet.addEventListener('cancel', e => { e.preventDefault(); closeSheet(sheet); });
}
$('#btn-search').addEventListener('click', openSearch);
$('#filter-status').addEventListener('click', e => {
  const chip = e.target.closest('[data-status]');
  if (!chip) return;
  searchStatus = chip.dataset.status;
  renderSearch();
});
$('#search-reset').addEventListener('click', () => {
  $('#search').value = '';
  searchStatus = 'all';
  $('#filter-category').value = '';
  $('#filter-account').value = '';
  $('#sort').value = 'deadline';
  renderSearch();
});
['#search', '#filter-category', '#filter-account', '#sort'].forEach(sel => $(sel).addEventListener('input', () => renderSearch()));

/* Glocke: zu den anstehenden Fristen auf der Übersicht */
// Glocke: Fenster mit allen Kündigungsfristen fährt von unten hoch
$('#btn-bell').addEventListener('click', () => {
  const dlg = $('#dlg-deadlines');
  if (dlg.open) return;
  $('#deadlines-body').scrollTop = 0;
  dlg.showModal();
  noAutoFocus(dlg);
});
function viewIndexFromScroll() {
  const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
  return Math.max(0, Math.min(VIEWS.length - 1, i));
}
function showView(name, smooth = true) {
  const i = VIEWS.indexOf(name);
  if (i < 0) return;
  const left = i * pager.clientWidth;
  // Erneuter Tipp auf den aktiven Tab: nach oben scrollen
  if (name === currentView && Math.abs(pager.scrollLeft - left) < 2) {
    $(`#view-${name}`).scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    return;
  }
  setActiveTab(name);
  if (!smooth) { pager.scrollLeft = left; return; }
  navTarget = name;
  clearTimeout(navTimer);
  navTimer = setTimeout(() => { navTarget = null; }, 800);
  pager.scrollTo({ left, behavior: 'smooth' });
}
$$('.tabbar [data-tab]').forEach(b => b.addEventListener('click', () => showView(b.dataset.tab)));

// Aktiven Tab beim Wischen mitführen (max. einmal pro Bild, damit nichts ruckelt)
let pagerFrame = 0;
pager.addEventListener('scroll', () => {
  if (pagerFrame) return;
  pagerFrame = requestAnimationFrame(() => {
    pagerFrame = 0;
    if (navTarget) return;
    setActiveTab(VIEWS[viewIndexFromScroll()]);
  });
}, { passive: true });
pager.addEventListener('scrollend', () => {
  navTarget = null;
  setActiveTab(VIEWS[viewIndexFromScroll()]);
});
// Bei Größenänderung (z. B. Drehen) auf der aktuellen Seite bleiben
let pagerResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(pagerResizeTimer);
  pagerResizeTimer = setTimeout(() => { pager.scrollLeft = VIEWS.indexOf(currentView) * pager.clientWidth; }, 100);
});

/* ---------- Detailansicht ---------- */

let currentId = null;

// Hinweis zur Frist oben im Bearbeiten-Fenster (ersetzt die frühere Detailansicht)
function statusAlertHTML(c) {
  const s = schedule(c);
  if (s.kind === 'deadline') {
    return `<div class="alert ${urgency(s)}">
      Spätestens kündigen bis <strong>${fmtDate(s.deadline)}</strong> (${relDays(s.daysLeft)}).<br>
      <span style="font-weight:500">Sonst verlängert sich der Vertrag – aktuelles Laufzeitende: ${fmtDate(s.termEnd)}${s.inMinTerm ? ' (Ende Mindestlaufzeit)' : ''}.</span>
    </div>`;
  }
  if (s.kind === 'anytime') return `<div class="alert ok">Jederzeit kündbar. Bei Kündigung heute endet der Vertrag frühestens am <strong>${fmtDate(s.earliestEnd)}</strong>.</div>`;
  if (s.kind === 'cancelled' && !s.confirmed) {
    const late = s.waitingDays >= CONFIRM_WAIT_DAYS;
    return `<div class="alert ${late ? 'urgent' : 'soon'}">
      Gekündigt${c.cancelledAt ? ' am ' + fmtISO(c.cancelledAt) : ''}${c.cancelMethod ? ' per ' + esc(c.cancelMethod) : ''} – <strong>Bestätigung steht noch aus</strong>${s.waitingDays > 0 ? ` (seit ${s.waitingDays} ${s.waitingDays === 1 ? 'Tag' : 'Tagen'})` : ''}.<br>
      <span style="font-weight:500">${late ? 'Bitte beim Anbieter nachhaken – ohne Bestätigung ist nicht sicher, dass die Kündigung angekommen ist.' : 'Bewahre den Nachweis (z.\u00a0B. Sendebestätigung) auf – am besten unten als Dokument.'}</span>
    </div>`;
  }
  if (s.kind === 'cancelled') return `<div class="alert ok">Kündigung bestätigt${c.cancelConfirmedAt ? ' am ' + fmtISO(c.cancelConfirmedAt) : ''}${s.endDate ? ` – läuft aus am <strong>${fmtDate(s.endDate)}</strong> (${relDays(daysBetween(today(), s.endDate))})` : ''}.</div>`;
  if (s.kind === 'ended') return `<div class="alert info">Vertrag beendet${s.endDate ? ' am ' + fmtDate(s.endDate) : ''}.</div>`;
  return `<div class="alert info">Für die Fristberechnung fehlt das Abschlussdatum.</div>`;
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
  $('#doc-count').textContent = docs.length ? String(docs.length) : '';
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
      if (formIsNew) formDirty = true;   // neuer Vertrag noch nicht gespeichert → Rückfrage vor dem Verwerfen
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

$('#dlg-form').addEventListener('click', e => {
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
  // Kann das Gerät nicht teilen, wird heruntergeladen
  const share = canShareFiles();
  $('#viewer-share').setAttribute('aria-label', share ? 'Teilen' : 'Herunterladen');
  $('#viewer-share').title = share ? 'Teilen' : 'Herunterladen';
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
      ? 'Diese PDF ist passwortgeschützt und kann hier nicht angezeigt werden. Über das Teilen-Symbol unten kannst du sie in einer anderen App öffnen.'
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
$('#viewer-reset').addEventListener('click', () => setZoom(1));
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
const FIELDS = ['name', 'provider', 'category', 'status', 'customerNo', 'contractNo', 'renewalAmount', 'interval', 'accountId', 'paymentMethod',
  'startDate', 'minTermMonths', 'renewalMonths', 'noticeValue', 'noticeUnit', 'cancelledAt', 'cancelMethod', 'cancelConfirmedAt', 'endDate', 'website', 'cancelContact', 'notes',
  'logoMode', 'logo'];
let editingId = null;

function openForm(id = null) {
  editingId = id;
  const c = id ? contracts.find(x => x.id === id) : {
    status: 'active', interval: 'monthly', noticeUnit: 'months', startDate: toISO(today()),
  };
  form.reset();
  fillAccountSelect();
  for (const f of FIELDS) form.elements[f].value = c[f] ?? '';
  if (!form.elements.status.value) form.elements.status.value = 'active';
  setLogoMenu(false);
  $('#price-rows').innerHTML = '';
  for (const p of id ? pricePeriods(c) : [{}]) addPriceRow(p);
  endDateAuto = false;
  if (!form.elements.noticeUnit.value) form.elements.noticeUnit.value = 'months';
  if (!form.elements.interval.value) form.elements.interval.value = 'monthly';
  if (!form.elements.logoMode.value) form.elements.logoMode.value = 'auto';
  logoRun++;
  setLogoProgress(null);
  lastLogoDomain = logoDomain(c);
  updateLogoPreview();
  if (!id) $('#form-title').textContent = 'Neuer Vertrag';
  // Neuer Vertrag bekommt sofort eine ID, damit Dokumente schon vorher angehängt werden können
  currentId = id || uid();
  formIsNew = !id;
  formSaved = false;
  $('#form-delete').hidden = !id;
  $('#doc-list').innerHTML = '';
  $('#doc-count').textContent = '';
  updateFormState();
  formDirty = false;
  // Über einem anderen Fenster (Fristen, Suche) etwas niedriger, damit beide gestaffelt sichtbar sind
  $('#dlg-form').classList.toggle('stacked', $$('dialog.bottom-sheet[open]').length > 0);
  $('#dlg-form').showModal();
  noAutoFocus($('#dlg-form'));
  for (const pane of $$('.form-pane')) pane.scrollTop = 0;
  setFormTab(0, false);
  $('#form-tabs').scrollLeft = 0;
  requestAnimationFrame(updateTabArrows);
  renderDocs(currentId);
}
let formIsNew = false;
let formSaved = false;

/* Reiter im Vertragsfenster: antippen oder seitlich wischen */
const formPager = $('#form-pager');
const formTabs = $$('#form-tabs [role=tab]');
let formTab = 0;
function markFormTab(i) {
  formTab = i;
  formTabs.forEach((t, k) => t.setAttribute('aria-selected', String(k === i)));
  // Aktiven Reiter in der Leiste sichtbar halten
  const bar = $('#form-tabs'), tab = formTabs[i];
  const left = tab.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2;
  bar.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
}
function setFormTab(i, smooth = true) {
  formPager.scrollTo({ left: i * formPager.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  markFormTab(i);
}
formTabs.forEach((t, i) => t.addEventListener('click', () => setFormTab(i)));
// Pfeile links/rechts, wenn Reiter außerhalb des sichtbaren Bereichs liegen
function updateTabArrows() {
  const bar = $('#form-tabs');
  const max = bar.scrollWidth - bar.clientWidth;
  $('#tabs-left').hidden = bar.scrollLeft <= 2;
  $('#tabs-right').hidden = bar.scrollLeft >= max - 2;
}
$('#form-tabs').addEventListener('scroll', () => requestAnimationFrame(updateTabArrows), { passive: true });
window.addEventListener('resize', updateTabArrows);
$('#tabs-left').addEventListener('click', () => setFormTab(Math.max(0, formTab - 1)));
$('#tabs-right').addEventListener('click', () => setFormTab(Math.min(formTabs.length - 1, formTab + 1)));
formPager.addEventListener('scroll', () => {
  const i = Math.round(formPager.scrollLeft / Math.max(1, formPager.clientWidth));
  if (i !== formTab && formTabs[i]) markFormTab(i);
}, { passive: true });
// Fenstergröße ändert sich (z. B. Drehen): beim aktuellen Reiter bleiben
window.addEventListener('resize', () => { if ($('#dlg-form').open) formPager.scrollLeft = formTab * formPager.clientWidth; });
function focusFormField(el) {
  const pane = el.closest('.form-pane');
  if (pane) setFormTab(Number(pane.dataset.pane), false);
  el.focus();
}
// Neuer Vertrag verworfen → bereits angehängte Dokumente wieder entfernen
$('#dlg-form').addEventListener('close', async () => {
  if (!formIsNew || formSaved) return;
  const docs = await docStore.byContract(currentId).catch(() => []);
  if (!docs.length) return;
  await docStore.removeByContract(currentId).catch(() => {});
  await loadDocCounts();
  updateStorageInfo();
});

/* Ungespeicherte Eingaben schützen: Rückfrage vor dem Schließen */
let formDirty = false;
form.addEventListener('input', () => { formDirty = true; });
form.addEventListener('change', e => { if (e.isTrusted) formDirty = true; });
$('#dlg-form').guardClose = async () => {
  if (!formDirty) return true;
  return (await ask({
    title: 'Änderungen verwerfen?',
    message: editingId ? 'Deine Änderungen an diesem Vertrag werden nicht gespeichert.' : 'Der neue Vertrag wird nicht gespeichert.',
    buttons: [{ label: 'Verwerfen', value: true, kind: 'danger' }, { label: 'Weiter bearbeiten', value: false }],
  })) === true;
};

function readForm() {
  const data = {};
  for (const f of FIELDS) data[f] = form.elements[f].value.trim();
  const money = v => Math.round(parseFloat(String(v).replace(',', '.')) * 100) / 100;
  data.renewalAmount = data.renewalAmount === '' ? '' : money(data.renewalAmount);
  data.prices = $$('#price-rows .price-row')
    .map(row => ({ from: row.querySelector('.pr-from').value, to: row.querySelector('.pr-to').value, amount: row.querySelector('.pr-amount').value.trim() }))
    .filter(p => p.amount !== '')
    .map(p => ({ from: p.from, to: p.to, amount: money(p.amount) }))
    .filter(p => Number.isFinite(p.amount))
    .sort((a, b) => (a.from || '').localeCompare(b.from || ''));
  // „amount“ bleibt der aktuell gültige Preis (für Export und ältere Versionen)
  data.amount = data.prices.length ? currentAmount(data) : NaN;
  for (const n of ['minTermMonths', 'renewalMonths', 'noticeValue']) data[n] = data[n] === '' ? '' : Math.max(0, parseInt(data[n], 10) || 0);
  if (data.status === 'active') { data.cancelledAt = ''; data.cancelMethod = ''; data.cancelConfirmedAt = ''; data.endDate = ''; }
  else {
    // Ist das Vertragsende vorbei, ist der Vertrag beendet – sonst (noch) gekündigt
    const end = parseISO(data.endDate);
    data.status = end ? (end < today() ? 'ended' : 'cancelled') : data.status;
  }
  if (data.logoMode !== 'custom') data.logo = '';
  else data.logoV = 2;
  if (!accountById(data.accountId)) data.accountId = '';
  data.account = accountById(data.accountId)?.name || '';
  return data;
}

/* Logo-Auswahl im Formular */
let logoPreviewTimer;
// Beim Bearbeiten steht oben Logo und Name des Vertrags statt „Vertrag bearbeiten“
function updateFormTitle(data, loading = false) {
  if (!editingId) return;
  $('#form-title').innerHTML = `${avatar(loading ? { ...data, logoMode: 'none' } : data, 'title-avatar')}<span class="form-title-name">${esc(form.elements.name.value.trim() || 'Ohne Namen')}</span>`;
}
function updateLogoPreview() {
  const data = { name: form.elements.name.value.trim() || '?', provider: form.elements.provider.value, website: form.elements.website.value,
    logoMode: form.elements.logoMode.value || 'auto', logo: form.elements.logo.value };
  for (const b of $$('[data-logo-mode]', form)) b.setAttribute('aria-checked', String(b.dataset.logoMode === data.logoMode));
  $('#logo-mode-label').textContent = { auto: 'Automatisch', custom: 'Eigenes Bild', none: 'Nur Buchstabe' }[data.logoMode] || 'Automatisch';
  if (logoLoading) {
    // Während der Suche: pulsierender Anfangsbuchstabe, Suchtext bleibt stehen
    $('#form-logo-preview').innerHTML = avatar({ ...data, logoMode: 'none' }, 'pulse');
    updateFormTitle(data, true);
    return;
  }
  $('#form-logo-preview').innerHTML = avatar(data);
  updateFormTitle(data);
  const domain = logoDomain(data);
  let hint;
  if (data.logoMode === 'custom') hint = 'Eigenes Bild. Tippe auf das Logo und „Eigenes Bild …“, um es zu ersetzen.';
  else if (data.logoMode === 'none') hint = 'Es wird nur der Anfangsbuchstabe angezeigt.';
  else if (!settings.autoLogos) hint = 'Automatische Logos sind unter „Mehr“ ausgeschaltet – es wird der Anfangsbuchstabe angezeigt.';
  else if (domain && logoCache[domain] && logoCache[domain].src === null) hint = `Für ${domain} wurde kein Logo gefunden. Trage unten die richtige Website ein oder wähle ein eigenes Bild.`;
  else if (domain) hint = `Logo von ${domain}. Passt es nicht, trage unten die richtige Website ein oder wähle ein eigenes Bild.`;
  else hint = 'Kein bekannter Anbieter – trage unten die Website ein (z. B. anbieter.de), dann wird das Logo geladen.';
  $('#logo-hint').textContent = hint;
}

/* Fortschrittsbalken beim automatischen Laden */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let logoRun = 0;
let logoLoading = false;
let lastLogoDomain = null;

// Prüft, ob sich das Logo wirklich anzeigen lässt
function probeImage(src, timeout = 8000) {
  return new Promise(resolve => {
    const img = new Image();
    const t = setTimeout(() => resolve(false), timeout);
    img.onload = () => { clearTimeout(t); resolve(img.naturalWidth >= 8); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.referrerPolicy = 'no-referrer';
    img.src = src;
  });
}
async function ensureLogo(domain, force) {
  let entry = logoCache[domain];
  if (force && entry && !entry.src) { delete logoCache[domain]; entry = null; }
  if (!entry || (!entry.src && !entry.remote && Date.now() - entry.ts >= LOGO_RETRY_MS)) {
    await fetchLogo(domain);
    entry = logoCache[domain];
  }
  const src = entry && (entry.src || (entry.remote ? logoUrl(domain) : null));
  if (!src) return false;
  const ok = await probeImage(src);
  if (!ok && navigator.onLine) { logoCache[domain] = { src: null, ts: Date.now() }; saveLogoCache(); }
  return ok;
}

function setLogoProgress(pct, label) {
  const wrap = $('#logo-progress');
  wrap.hidden = pct === null;
  logoLoading = pct !== null && pct < 100;
  if (pct === null) return;
  wrap.querySelector('.logo-progress-fill').style.width = `${pct}%`;
  wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
  if (label) $('#logo-hint').textContent = label;
}

async function runAutoLogo(force = false) {
  const run = ++logoRun;
  const data = { name: form.elements.name.value.trim(), provider: form.elements.provider.value, website: form.elements.website.value };
  const domain = logoDomain(data);
  lastLogoDomain = domain;
  if (form.elements.logoMode.value !== 'auto' || !settings.autoLogos || !domain) {
    setLogoProgress(null);
    updateLogoPreview();
    return;
  }
  const fill = $('#logo-progress .logo-progress-fill');
  fill.style.transition = 'none';
  setLogoProgress(0, `Suche Logo für ${domain} …`);
  updateLogoPreview();
  void fill.offsetWidth;
  fill.style.transition = '';
  setLogoProgress(35);
  // Langsam weiterlaufen lassen, solange geladen wird
  const creep = setTimeout(() => { if (run === logoRun) setLogoProgress(85); }, 400);
  const [ok] = await Promise.all([
    Promise.race([ensureLogo(domain, force), sleep(10000).then(() => false)]),
    sleep(700),   // kurz sichtbar lassen, damit man sieht, dass etwas passiert
  ]);
  clearTimeout(creep);
  if (run !== logoRun) return;
  setLogoProgress(100, ok ? `Logo von ${domain} geladen.` : `Für ${domain} wurde kein Logo gefunden.`);
  $('#form-logo-preview').innerHTML = avatar({ ...data, name: data.name || '?', logoMode: 'auto' });
  await sleep(450);
  if (run !== logoRun) return;
  setLogoProgress(null);
  updateLogoPreview();
}

form.addEventListener('input', e => {
  if (['name', 'provider', 'website'].includes(e.target.name)) {
    clearTimeout(logoPreviewTimer);
    logoPreviewTimer = setTimeout(() => {
      const d = logoDomain({ name: form.elements.name.value, provider: form.elements.provider.value, website: form.elements.website.value });
      if (form.elements.logoMode.value === 'auto' && d && d !== lastLogoDomain) runAutoLogo();
      else { lastLogoDomain = d; updateLogoPreview(); }
    }, 500);
  }
});
/* Logo-Menü öffnen/schließen */
function setLogoMenu(open) {
  $('#logo-menu').hidden = !open;
  $('#logo-btn').setAttribute('aria-expanded', String(open));
  if (open) ($('#logo-menu [aria-checked=true]') || $('#logo-menu button')).focus({ preventScroll: true });
}
for (const id of ['#logo-btn', '#logo-text']) $(id).addEventListener('click', () => setLogoMenu($('#logo-menu').hidden));
// Tipp außerhalb oder Escape schließt das Menü
$('#dlg-form').addEventListener('pointerdown', e => {
  if (!$('#logo-menu').hidden && !e.target.closest('#logo-menu, #logo-btn, #logo-text')) setLogoMenu(false);
});
$('#logo-menu').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setLogoMenu(false); $('#logo-btn').focus(); }
});
form.addEventListener('click', e => {
  const btn = e.target.closest('[data-logo-mode]');
  if (!btn) return;
  setLogoMenu(false);
  const mode = btn.dataset.logoMode;
  if (mode === 'custom') { $('#logo-file').click(); return; }
  formDirty = true;
  logoRun++;
  setLogoProgress(null);
  form.elements.logoMode.value = mode;
  updateLogoPreview();
  if (mode === 'auto') runAutoLogo(true);
});
$('#logo-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    logoRun++;
    setLogoProgress(null);
    form.elements.logo.value = await prepareLogo(file);
    form.elements.logoMode.value = 'custom';
    formDirty = true;
    updateLogoPreview();
  } catch {
    toast('Dieses Bild kann nicht gelesen werden. Bitte JPG oder PNG verwenden.');
  }
});

/* Preise mit Zeitraum */
function addPriceRow(p = {}) {
  const row = document.createElement('div');
  row.className = 'price-row';
  row.innerHTML = `<span class="pr-badge" hidden>aktuell</span>
    <label>von<input type="date" class="pr-from" value="${esc(p.from || '')}"></label>
    <label>bis<input type="date" class="pr-to" value="${esc(p.to || '')}"></label>
    <label class="pr-amount-wrap">Betrag €<input type="number" class="pr-amount" step="0.01" min="0" inputmode="decimal" placeholder="0,00" value="${hasNum(p.amount) ? esc(String(p.amount)) : ''}"></label>
    <button type="button" class="icon-btn pr-del" aria-label="Zeitraum entfernen">✕</button>`;
  $('#price-rows').appendChild(row);
  return row;
}
$('#price-add').addEventListener('click', () => {
  // Neuer Zeitraum beginnt am Tag nach dem Ende des letzten
  const rows = $$('#price-rows .price-row');
  const lastTo = parseISO(rows.at(-1)?.querySelector('.pr-to').value);
  const row = addPriceRow({ from: lastTo ? toISO(addDays(lastTo, 1)) : '' });
  formDirty = true;
  updateFormState();
  row.querySelector(lastTo ? '.pr-amount' : '.pr-from').focus();
});
$('#price-rows').addEventListener('click', e => {
  const del = e.target.closest('.pr-del');
  if (!del) return;
  del.closest('.price-row').remove();
  if (!$('#price-rows .price-row')) addPriceRow();
  formDirty = true;
  updateFormState();
});
function updatePriceInfo(d) {
  const r = renewalStart(d);
  $('#renewal-hint').textContent = r
    ? `Gilt ab ${fmtDate(r)}, wenn sich der Vertrag nach ${Number(d.minTermMonths) ? 'der Mindestlaufzeit' : 'der ersten Laufzeit'} automatisch verlängert – außer für Zeiträume, die du oben mit „bis“ festgelegt hast.`
    : 'Trag unter „Laufzeit & Kündigung“ Vertragsbeginn und Laufzeit ein, dann wird das Datum berechnet.';
  // Zeitraum markieren, der heute gilt
  const cur = d.prices?.length ? priceAt(d) : null;
  const t = today();
  for (const row of $$('#price-rows .price-row')) {
    const f = parseISO(row.querySelector('.pr-from').value), to = parseISO(row.querySelector('.pr-to').value);
    const amount = row.querySelector('.pr-amount').value;
    const isCur = !!cur && cur.kind === 'period' && amount !== '' && (!f || f <= t) && (!to || to >= t);
    row.classList.toggle('current', isCur);
    row.querySelector('.pr-badge').hidden = !isCur;
  }
  if (!cur) { $('#price-now').innerHTML = ''; return; }
  const next = nextPriceChange(d);
  const avg = averagePrice(d);
  const iv = (INTERVALS[d.interval] || INTERVALS.monthly).label;
  $('#price-now').innerHTML = `Aktuell gültig: <strong>${eur.format(cur.amount)}</strong>${cur.kind === 'renewal' ? ' (nach Verlängerung)' : ''}`
    + (next ? ` · ab ${fmtDate(next.from)}: <strong>${eur.format(next.amount)}</strong>${next.kind === 'renewal' ? ' (nach Verlängerung)' : ''}` : '')
    + (avg ? `<span class="price-avg">Ø über die Mindestlaufzeit (${avg.months} Monate, ${fmtDate(avg.from)} – ${fmtDate(avg.to)}): <strong>${eur.format(avg.amount)}</strong> ${iv}</span>` : '');
}

/* Kündigungs-Ablauf: abgeschickt → bestätigt → ausgelaufen */
let endDateAuto = false;
function cancelState(d) {
  if (d.status === 'active') return 'none';
  if (d.status === 'ended') return 'ended';
  return d.cancelConfirmedAt ? 'confirmed' : 'sent';
}
function updateCancelBox(d) {
  const st = cancelState(d);
  // Bestätigungs-Felder auch bei beendeten Verträgen zeigen, wenn eine Bestätigung vorliegt
  const keys = [st];
  if (st === 'ended' && d.cancelConfirmedAt) keys.push('confirmed-ended');
  for (const el of $$('[data-cstate]', form)) el.hidden = !el.dataset.cstate.split(' ').some(k => keys.includes(k));
  $('#step-cancel').setAttribute('aria-pressed', String(st !== 'none'));
  $('#step-confirm').setAttribute('aria-pressed', String(st !== 'none' && !!d.cancelConfirmedAt));
  $('#step-confirm').disabled = st === 'none';
  const done = { sent: st !== 'none', confirmed: st !== 'none' && !!d.cancelConfirmedAt, ended: st === 'ended' };
  const current = st === 'none' ? 'sent' : st === 'sent' ? 'confirmed' : st === 'confirmed' ? 'ended' : '';
  const dates = { sent: d.cancelledAt, confirmed: d.cancelConfirmedAt, ended: d.endDate };
  for (const li of $$('#cancel-steps li')) {
    const k = li.dataset.step;
    li.classList.toggle('done', done[k]);
    li.classList.toggle('current', k === current);
    const date = st !== 'none' && dates[k] ? fmtISO(dates[k]) : '';
    li.querySelector('.step-date').textContent = k === 'ended' && date && st !== 'ended' ? 'am ' + date : date;
  }
  if (st === 'sent') {
    const days = d.cancelledAt ? daysBetween(parseISO(d.cancelledAt), today()) : 0;
    const late = days >= CONFIRM_WAIT_DAYS;
    $('#cancel-wait').innerHTML = late
      ? `Seit ${days} Tagen keine Bestätigung – bitte beim Anbieter nachhaken. Danach oben auf <strong>Bestätigt</strong> tippen.`
      : 'Sobald der Anbieter die Kündigung bestätigt hat, oben auf <strong>Bestätigt</strong> tippen.';
    $('#cancel-wait').className = late ? 'hint cancel-hint danger-text' : 'hint cancel-hint';
  }
  const calc = d.cancelledAt ? endIfCancelledOn(d, parseISO(d.cancelledAt)) : null;
  $('#cancel-end-hint').textContent = st === 'none' ? ''
    : calc ? `Berechnet: Bei Kündigung am ${fmtISO(d.cancelledAt)} endet der Vertrag am ${fmtDate(calc)}. Nennt die Bestätigung ein anderes Datum, trag es ein.`
      : 'Trag das Vertragsende ein (steht meist in der Kündigungsbestätigung).';
}
function fillAutoEndDate() {
  if (!endDateAuto && form.elements.endDate.value) return;
  const d = readForm();
  const calc = d.cancelledAt ? endIfCancelledOn(d, parseISO(d.cancelledAt)) : null;
  if (calc) { form.elements.endDate.value = toISO(calc); endDateAuto = true; }
}
// Schritte sind Schalter: antippen setzt sie, erneutes Antippen nimmt sie nach Rückfrage zurück
$('#step-cancel').addEventListener('click', async () => {
  if (form.elements.status.value !== 'active') {
    const ok = await ask({
      title: 'Kündigung zurücknehmen?',
      message: form.elements.cancelConfirmedAt.value
        ? 'Der Vertrag gilt dann wieder als aktiv. Die Angaben zur Kündigung und die Bestätigung werden beim Speichern entfernt.'
        : 'Der Vertrag gilt dann wieder als aktiv. Die Angaben zur Kündigung werden beim Speichern entfernt.',
      buttons: [{ label: 'Zurücknehmen', value: true, kind: 'danger' }, { label: 'Abbrechen', value: false }],
    });
    if (!ok) return;
    for (const f of ['cancelledAt', 'cancelMethod', 'cancelConfirmedAt', 'endDate']) form.elements[f].value = '';
    form.elements.status.value = 'active';
  } else {
    form.elements.status.value = 'cancelled';
    form.elements.cancelledAt.value = toISO(today());
    form.elements.cancelConfirmedAt.value = '';
    endDateAuto = true;
    fillAutoEndDate();
  }
  formDirty = true;
  updateFormState();
});
$('#step-confirm').addEventListener('click', async () => {
  if (form.elements.status.value === 'active') return;
  if (form.elements.cancelConfirmedAt.value) {
    const ok = await ask({
      title: 'Bestätigung zurücknehmen?', message: 'Die Kündigung bleibt bestehen, gilt aber wieder als „Bestätigung ausstehend“.',
      buttons: [{ label: 'Zurücknehmen', value: true, kind: 'danger' }, { label: 'Abbrechen', value: false }],
    });
    if (!ok) return;
    form.elements.cancelConfirmedAt.value = '';
  } else {
    form.elements.cancelConfirmedAt.value = toISO(today());
  }
  formDirty = true;
  updateFormState();
});
form.elements.cancelledAt.addEventListener('change', () => { fillAutoEndDate(); updateFormState(); });
form.elements.endDate.addEventListener('input', () => { endDateAuto = false; });

function updateFormState() {
  const data = readForm();
  const status = data.status;
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
  updateCancelBox(data);
  updatePriceInfo(data);
  // Beim Bearbeiten oben den Fristhinweis zeigen (wie früher in der Detailansicht), live aktualisiert
  $('#form-alert').innerHTML = editingId ? statusAlertHTML(data) : '';
  $('#form-ics').hidden = !(editingId && s.kind === 'deadline');
}
form.addEventListener('input', updateFormState);
form.addEventListener('change', updateFormState);

form.addEventListener('submit', e => {
  e.preventDefault();
  const data = readForm();
  if (!data.name) { toast('Bitte einen Namen eingeben.'); focusFormField(form.elements.name); return; }
  if (!Number.isFinite(data.amount)) { toast('Bitte einen Betrag eingeben.'); focusFormField($('#price-rows .pr-amount') || $('#price-add')); return; }
  const bad = data.prices.find(p => p.from && p.to && p.to < p.from);
  if (bad) { toast('Bei einem Zeitraum liegt „bis“ vor „von“.'); focusFormField($('#price-rows .pr-to')); return; }
  const now = new Date().toISOString();
  if (editingId) {
    const idx = contracts.findIndex(x => x.id === editingId);
    contracts[idx] = { ...contracts[idx], ...data, updatedAt: now };
  } else {
    // Die ID wurde beim Öffnen vergeben, damit Dokumente schon vor dem Speichern angehängt werden können
    contracts.push({ id: currentId || uid(), ...data, createdAt: now, updatedAt: now });
  }
  persist();
  renderAll();
  formSaved = true;
  closeSheet($('#dlg-form'), true);
  toast(editingId ? 'Änderungen gespeichert' : 'Vertrag angelegt');
});

/* ---------- Konto anlegen / bearbeiten ---------- */

const accForm = $('#account-form');
let editingAccountId = null;
let accountForContract = false;   // aus dem Vertragsformular heraus angelegt → dort auswählen

function fillAccountSelect(selected) {
  const sel = form.elements.accountId;
  const cur = selected ?? sel.value;
  const sorted = [...accounts].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  sel.innerHTML = '<option value="">– kein Konto –</option>'
    + sorted.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')
    + '<option value="__new__">＋ Neues Konto anlegen …</option>';
  sel.value = accountById(cur) ? cur : '';
  sel.dataset.prev = sel.value;
}
form.elements.accountId.addEventListener('change', e => {
  const sel = e.target;
  if (sel.value === '__new__') {
    sel.value = sel.dataset.prev || '';
    openAccountForm(null, true);
    return;
  }
  sel.dataset.prev = sel.value;
  // Zahlungsart passend zur Kontoart vorschlagen, wenn noch leer
  const acc = accountById(sel.value);
  if (acc && !form.elements.paymentMethod.value) {
    form.elements.paymentMethod.value = { kredit: 'Kreditkarte', paypal: 'PayPal', giro: 'Lastschrift' }[acc.type] || '';
  }
});

function openAccountForm(id = null, forContract = false) {
  editingAccountId = id;
  accountForContract = forContract;
  const a = accountById(id) || { type: 'giro' };
  accForm.reset();
  accountFormBaseType = id ? a.type : '';
  $('#dl-banks').innerHTML = BANKS.map(b => `<option value="${esc(b)}">`).join('');
  for (const f of ['name', 'iban', 'cardLast4', 'email', 'notes']) accForm.elements[f].value = a[f] ?? '';
  accForm.elements.iban.value = a.iban ? formatIban(a.iban) : '';
  $('#account-form-title').textContent = id ? 'Konto bearbeiten' : 'Neues Konto';
  $('#account-delete').hidden = !id;
  updateAccountForm();
  $('#dlg-account').showModal();
  noAutoFocus($('#dlg-account'));
}

// Kontoart ergibt sich aus dem Namen; bei bestehenden Konten bleibt eine
// ausdrücklich gesetzte Art (Kreditkarte/PayPal) erhalten, wenn der Name nichts verrät.
let accountFormBaseType = '';
function accountFormType() {
  const guess = guessAccountType(accForm.elements.name.value);
  return guess === 'giro' && ['kredit', 'paypal', 'tagesgeld'].includes(accountFormBaseType) ? accountFormBaseType : guess;
}
function updateAccountForm() {
  const type = accountFormType();
  for (const el of $$('[data-show-type]', accForm)) el.hidden = !el.dataset.showType.split(' ').includes(type);
  const raw = accForm.elements.iban.value;
  const hint = $('#iban-hint');
  if (!normIban(raw)) { hint.textContent = ''; hint.className = 'hint'; }
  else if (ibanValid(raw)) { hint.textContent = '✓ Gültige IBAN'; hint.className = 'hint ok-text'; }
  else { hint.textContent = normIban(raw).length < 15 ? 'IBAN unvollständig' : 'Die Prüfziffer stimmt nicht – bitte die IBAN prüfen.'; hint.className = 'hint danger-text'; }
  $('#iban-copy').hidden = !ibanValid(raw);
  $('#account-preview').innerHTML = accountAvatar({
    name: accForm.elements.name.value.trim() || '?', type,
  });
}
accForm.addEventListener('input', updateAccountForm);
accForm.addEventListener('change', updateAccountForm);
accForm.elements.iban.addEventListener('blur', e => { if (normIban(e.target.value)) e.target.value = formatIban(e.target.value); });
accForm.elements.cardLast4.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
$('#iban-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(formatIban(accForm.elements.iban.value)); toast('IBAN kopiert'); }
  catch { toast('Kopieren nicht möglich'); }
});

accForm.addEventListener('submit', e => {
  e.preventDefault();
  const v = f => accForm.elements[f].value.trim();
  const name = v('name');
  if (!name) { toast('Bitte einen Namen eingeben.'); accForm.elements.name.focus(); return; }
  if (accounts.some(a => a.id !== editingAccountId && a.name.toLowerCase() === name.toLowerCase())) {
    toast('Ein Konto mit diesem Namen gibt es schon.'); accForm.elements.name.focus(); return;
  }
  const type = accountFormType();
  const iban = ['giro', 'tagesgeld', 'sonstiges'].includes(type) ? normIban(v('iban')) : '';
  if (iban && !ibanValid(iban)) { toast('Die IBAN ist nicht gültig.'); accForm.elements.iban.focus(); return; }
  const card = type === 'kredit' ? v('cardLast4') : '';
  if (card && !/^\d{4}$/.test(card)) { toast('Bitte genau 4 Ziffern der Karte eingeben.'); accForm.elements.cardLast4.focus(); return; }
  const data = { name, type, bank: accountById(editingAccountId)?.bank || '', iban, cardLast4: card, email: type === 'paypal' ? v('email') : '', notes: v('notes') };

  let acc;
  if (editingAccountId) {
    acc = accountById(editingAccountId);
    Object.assign(acc, data, { updatedAt: new Date().toISOString() });
    // Umbenennen: Namen bei allen zugehörigen Verträgen nachziehen
    for (const c of contracts) if (c.accountId === acc.id) c.account = acc.name;
    persist();
  } else {
    acc = { id: uid(), ...data, createdAt: new Date().toISOString() };
    accounts.push(acc);
  }
  persistAccounts();
  closeSheet($('#dlg-account'), true);
  renderAll();
  if (accountForContract && $('#dlg-form').open) {
    formDirty = true;
    fillAccountSelect(acc.id);
    form.elements.accountId.dispatchEvent(new Event('change'));
  }
  toast(editingAccountId ? 'Konto gespeichert' : 'Konto angelegt');
});

$('#account-delete').addEventListener('click', async () => {
  const acc = accountById(editingAccountId);
  if (!acc) return;
  const n = contracts.filter(c => c.accountId === acc.id).length;
  const ok = await confirmDelete('Konto löschen?',
    `„${acc.name}“ wird gelöscht.${n ? ` ${n === 1 ? 'Der zugeordnete Vertrag bleibt' : `Die ${n} zugeordneten Verträge bleiben`} erhalten, aber ohne Konto.` : ''}`);
  if (!ok) return;
  for (const c of contracts) if (c.accountId === acc.id) { c.accountId = ''; c.account = ''; }
  accounts = accounts.filter(a => a.id !== acc.id);
  persist();
  persistAccounts();
  closeSheet($('#dlg-account'), true);
  renderAll();
  toast('Konto gelöscht');
});

// Konten-Seite: Konto antippen bzw. neues Konto
$('#accounts').addEventListener('click', e => {
  // Stift zuerst prüfen – er liegt im aufklappbaren Kopf
  const edit = e.target.closest('[data-account]');
  if (edit) { openAccountForm(edit.dataset.account); return; }
  const toggle = e.target.closest('[data-account-toggle]');
  if (toggle) {
    const key = toggle.dataset.accountToggle;
    const open = new Set(settings.accountsOpen || []);
    const isOpen = !open.has(key);
    isOpen ? open.add(key) : open.delete(key);
    settings.accountsOpen = [...open];
    saveSettings();
    toggle.closest('.account-card').classList.toggle('open', isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
    return;
  }
  if (e.target.closest('#account-add')) openAccountForm();
});
// Tastatur: Enter/Leertaste klappt ein Konto auf oder zu
$('#accounts').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-account-toggle]')) { e.preventDefault(); e.target.click(); }
});

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

/* ---------- Kalender-Export (.ics) ---------- */

function icsEscape(s) { return String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n'); }
function icsDate(d) { return toISO(d).replace(/-/g, ''); }
function icsEvent(c, s) {
  const desc = `Letzter Tag zur Kündigung von "${c.name}". Laufzeitende: ${fmtDate(s.termEnd)}. ` +
    `Kosten: ${eur.format(currentAmount(c))} ${(INTERVALS[c.interval] || INTERVALS.monthly).label}.` +
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
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fristfuchs//DE', 'CALSCALE:GREGORIAN',
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
  const payload = { app: 'fristfuchs', version: 3, exportedAt: new Date().toISOString(), contracts, accounts, documents };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `fristfuchs-backup-${toISO(today())}.json`);
}

function exportCSV() {
  const cols = [['Name', 'name'], ['Anbieter', 'provider'], ['Kategorie', 'category'], ['Status', c => STATUS[c.status]],
    ['Betrag aktuell', c => String(currentAmount(c)).replace('.', ',')],
    ['Preise', c => pricePeriods(c).map(p => `${p.from ? fmtISO(p.from) : 'Beginn'}–${p.to ? fmtISO(p.to) : 'laufend'}: ${String(p.amount).replace('.', ',')}`).join('; ')],
    ['Preis nach Verlängerung', c => hasNum(c.renewalAmount) ? String(c.renewalAmount).replace('.', ',') : ''],
    ['Intervall', c => (INTERVALS[c.interval] || {}).label],
    ['Monatlich', c => monthlyCost(c).toFixed(2).replace('.', ',')], ['Konto', 'account'], ['IBAN', c => formatIban(accountById(c.accountId)?.iban || '')], ['Zahlungsart', 'paymentMethod'],
    ['Abschluss', 'startDate'], ['Mindestlaufzeit (Monate)', 'minTermMonths'], ['Verlängerung (Monate)', 'renewalMonths'],
    ['Kündigungsfrist', noticeText], ['Kündigen bis', c => { const s = schedule(c); return s.kind === 'deadline' ? toISO(s.deadline) : ''; }],
    ['Gekündigt am', 'cancelledAt'], ['Gekündigt per', 'cancelMethod'], ['Bestätigt am', 'cancelConfirmedAt'], ['Vertragsende', 'endDate'], ['Kundennr.', 'customerNo'], ['Vertragsnr.', 'contractNo'], ['Website', 'website'],
    ['Kündigung an', 'cancelContact'], ['Notizen', 'notes'], ['Dokumente', c => docCounts.get(c.id) || 0]];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(c => cell(c[0])).join(';'),
    ...contracts.map(c => cols.map(([, f]) => cell(typeof f === 'function' ? f(c) : c[f])).join(';'))];
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `fristfuchs-${toISO(today())}.csv`);
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
    const importedAccounts = Array.isArray(data.accounts) ? data.accounts.filter(a => a && a.id && a.name) : [];
    if (replace) {
      contracts = clean;
      accounts = importedAccounts;
      await docStore.clear().catch(() => {});
    } else {
      const map = new Map(contracts.map(c => [c.id, c]));
      for (const c of clean) map.set(c.id, c);
      contracts = [...map.values()];
      const accMap = new Map(accounts.map(a => [a.id, a]));
      for (const a of importedAccounts) accMap.set(a.id, a);
      accounts = [...accMap.values()];
    }
    persistAccounts();
    syncAccountsFromContracts();
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
    mk({ name: 'Handyvertrag', provider: 'Telekom', category: 'Mobilfunk', amount: 39.95, interval: 'monthly', account: 'Girokonto Sparkasse', paymentMethod: 'Lastschrift', startDate: iso(addDays(addMonths(t, -21), 20)), minTermMonths: 24, renewalMonths: 1, noticeValue: 1, noticeUnit: 'months', customerNo: 'K-208815', contractNo: 'MF-4711', renewalAmount: 49.95, cancelContact: 'kuendigung@example.com' }),
    mk({ name: 'Fitnessstudio', provider: 'FitX', category: 'Fitness', amount: 24.99, interval: 'monthly', account: 'Girokonto Sparkasse', paymentMethod: 'Lastschrift', startDate: iso(addDays(addMonths(t, -11), 12)), minTermMonths: 12, renewalMonths: 1, noticeValue: 1 }),
    mk({ name: 'Kfz-Versicherung', provider: 'HUK', category: 'Versicherung', amount: 412.6, interval: 'yearly', account: 'Girokonto Sparkasse', paymentMethod: 'Lastschrift', startDate: iso(new Date(t.getFullYear() - 3, 0, 1)), minTermMonths: 12, renewalMonths: 12, noticeValue: 1, notes: 'Stichtag 30.11. – Sonderkündigung bei Beitragserhöhung möglich.' }),
    mk({ name: 'Strom', provider: 'Stadtwerke', category: 'Strom', amount: 78, interval: 'monthly', account: 'Gemeinschaftskonto', paymentMethod: 'Lastschrift', startDate: iso(addMonths(t, -8)), minTermMonths: 12, renewalMonths: 1, noticeValue: 1 }),
    mk({ name: 'Internet 250', provider: 'Vodafone', category: 'Internet', amount: 19.99, renewalAmount: 44.99, interval: 'monthly', account: 'Gemeinschaftskonto', paymentMethod: 'Lastschrift', startDate: iso(addMonths(t, -30)), minTermMonths: 24, renewalMonths: 1, noticeValue: 1 }),
    mk({ name: 'Microsoft 365', provider: 'Microsoft', category: 'Software', amount: 99, interval: 'yearly', account: 'Kreditkarte Visa', paymentMethod: 'Kreditkarte', startDate: iso(addDays(addMonths(t, -12), 40)), minTermMonths: 12, renewalMonths: 12, noticeValue: '' }),
    mk({ name: 'Zeitschrift', provider: 'Verlag', category: 'Zeitschriften', amount: 29.7, interval: 'quarterly', account: 'Girokonto Sparkasse', paymentMethod: 'Rechnung', startDate: iso(addMonths(t, -14)), status: 'cancelled', cancelledAt: iso(addDays(t, -10)), cancelMethod: 'E-Mail', cancelConfirmedAt: '', endDate: iso(addDays(t, 45)), minTermMonths: 12, renewalMonths: 3, noticeValue: 6, noticeUnit: 'weeks' }),
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

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => settings.theme === 'dark' || (settings.theme !== 'light' && darkQuery.matches);
function applyTheme() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  const sw = $('#btn-theme');
  if (sw) {
    sw.setAttribute('aria-checked', String(isDark()));
    sw.setAttribute('aria-label', isDark() ? 'Dunkelmodus ausschalten' : 'Dunkelmodus einschalten');
  }
}
// Schalter in der Kopfzeile: wechselt zwischen Hell und Dunkel
let themeTimer;
$('#btn-theme').addEventListener('click', () => {
  const sw = $('#btn-theme');
  const toDark = sw.getAttribute('aria-checked') !== 'true';
  // Zuerst gleitet der Knopf (flüssig, ohne dass gleichzeitig die ganze Seite umgefärbt wird) …
  sw.setAttribute('aria-checked', String(toDark));
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => {
    // … danach wechselt das Farbschema mit sanfter Überblendung
    const root = document.documentElement;
    root.classList.add('theme-fade');
    settings.theme = toDark ? 'dark' : 'light';
    saveSettings();
    applyTheme();
    setTimeout(() => root.classList.remove('theme-fade'), 350);
  }, 380);
});
// Solange nichts gewählt ist, folgt die App dem Handy
darkQuery.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });

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

// iOS Safari ignoriert user-scalable=no: Zoom-Gesten hier abfangen (nicht im Dokument-Betrachter)
for (const type of ['gesturestart', 'gesturechange']) {
  document.addEventListener(type, e => { if (!e.target.closest?.('#dlg-viewer')) e.preventDefault(); }, { passive: false });
}
document.addEventListener('touchstart', e => {
  ptr = null;
  if (currentView !== 'dashboard' || e.touches.length !== 1 || $('#view-dashboard').scrollTop > 0 || anyDialogOpen()) return;
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
    const body = e.target.closest('.form-pane') || dlg.querySelector('.sheet-body');
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
      if (dlg.guardClose) { closeSheet(dlg); return; }   // fragt ggf. nach, sonst gleitet es hinaus
      dlg.style.transform = `translateY(${window.innerHeight}px)`;
      setTimeout(() => { dlg.close(); dlg.style.transform = ''; }, 200);
    } else {
      dlg.style.transform = '';
    }
  };
  dlg.addEventListener('touchend', end);
  dlg.addEventListener('touchcancel', end);
}
enableSwipeToClose($('#dlg-form'));
enableSwipeToClose($('#dlg-search'));
enableSwipeToClose($('#dlg-deadlines'));
enableSwipeToClose($('#dlg-account'));
// Logo oben links → Übersicht
$('#brand-home').addEventListener('click', () => showView('dashboard'));

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
  if (item) { openForm(item.dataset.id); return; }
  if (e.target.closest('[data-action="add"]')) openForm();
  const close = e.target.closest('[data-close]');
  if (close) {
    const dlg = close.closest('dialog');
    if (dlg.classList.contains('bottom-sheet')) closeSheet(dlg); else dlg.close();
  }
});
// Klick auf den Hintergrund schließt Dialoge
for (const dlg of $$('dialog')) {
  dlg.addEventListener('click', e => {
    if (e.target !== dlg) return;
    if (dlg.classList.contains('bottom-sheet')) closeSheet(dlg); else dlg.close();
  });
}

$('#form-delete').addEventListener('click', async () => {
  const c = contracts.find(x => x.id === editingId);
  const n = docCounts.get(editingId) || 0;
  if (!c) return;
  const ok = await confirmDelete('Vertrag löschen?',
    `„${c.name}“ wird dauerhaft gelöscht.${n ? ` ${n === 1 ? 'Das angehängte Dokument wird' : `Die ${n} angehängten Dokumente werden`} ebenfalls gelöscht.` : ''}`);
  if (!ok) return;
  contracts = contracts.filter(x => x.id !== c.id);
  persist();
  await docStore.removeByContract(c.id).catch(() => {});
  await loadDocCounts();
  updateStorageInfo();
  renderAll();
  formSaved = true;
  closeSheet($('#dlg-form'), true);
  toast('Vertrag gelöscht');
});
// Frist in den Kalender – mit dem aktuellen Stand des Formulars
$('#form-ics').addEventListener('click', () => {
  const c = { ...readForm(), id: currentId };
  const s = schedule(c);
  if (s.kind === 'deadline') downloadICS([{ c, s }], `kuendigungsfrist-${(c.name || 'vertrag').replace(/[^\wäöüÄÖÜß-]+/g, '_')}.ics`);
});


$('#set-warn-days').addEventListener('change', e => {
  settings.warnDays = Math.min(365, Math.max(1, parseInt(e.target.value, 10) || 30));
  e.target.value = settings.warnDays;
  saveSettings();
  renderAll();
});
$('#set-auto-logos').addEventListener('change', e => {
  settings.autoLogos = e.target.checked;
  saveSettings();
  if (!settings.autoLogos) { logoCache = {}; saveLogoCache(); }
  renderAll();
  toast(settings.autoLogos ? 'Logos werden automatisch geladen' : 'Automatische Logos ausgeschaltet');
});
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
  syncAccountsFromContracts();
  // Beispielkonten mit Bank, IBAN bzw. Karte ausstatten (gültige Muster-IBANs)
  const demoDetails = {
    'Girokonto Sparkasse': { type: 'giro', bank: 'Sparkasse', iban: 'DE89370400440532013000' },
    'Gemeinschaftskonto': { type: 'giro', bank: 'DKB', iban: 'DE45120300001234567890' },
    'Kreditkarte Visa': { type: 'kredit', bank: 'Visa', cardLast4: '4821' },
    'PayPal': { type: 'paypal', bank: 'PayPal', email: 'name@example.com' },
  };
  for (const a of accounts) if (demoDetails[a.name] && !a.bank) Object.assign(a, demoDetails[a.name]);
  persistAccounts();
  renderAll();
  toast('Beispieldaten geladen');
});
$('#btn-clear').addEventListener('click', async () => {
  if (!contracts.length && !accounts.length) { toast('Keine Daten vorhanden.'); return; }
  const ok = await confirmDelete('Alle Daten löschen?',
    `Alle ${contracts.length} Verträge, ${accounts.length} Konten und alle Dokumente werden gelöscht. Das kann nicht rückgängig gemacht werden.\n\nTipp: Vorher ein Backup exportieren.`, 'Alles löschen');
  if (!ok) return;
  contracts = [];
  accounts = [];
  persist();
  persistAccounts();
  await docStore.clear().catch(() => {});
  await loadDocCounts();
  renderAll();
  updateStorageInfo();
  toast('Alle Daten gelöscht');
});

/* ---------- Start ---------- */

applyTheme();
$('#set-warn-days').value = settings.warnDays;
$('#set-auto-logos').checked = settings.autoLogos;
$('#app-version').textContent = APP_VERSION;
updateNotifyState();
// Bisherige Kontonamen einmalig als Konten übernehmen
syncAccountsFromContracts();
renderAll();
window.__fristfuchsStarted = true;
loadDocCounts().then(renderAll);
migrateCustomLogos();
updateStorageInfo();

const params = new URLSearchParams(location.search);
let startTab = 'dashboard';
try { startTab = sessionStorage.getItem('vw.tab') || startTab; } catch {}
showView(params.get('view') || startTab, false);
if (params.get('action') === 'add') openForm();
if (params.get('id') && contracts.some(c => c.id === params.get('id'))) openForm(params.get('id'));

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // Neue Version übernommen → einmal neu laden, damit sie sofort sichtbar ist
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    try { sessionStorage.setItem('vw.updated', '1'); } catch {}
    location.reload();
  });
  try {
    if (sessionStorage.getItem('vw.updated')) {
      sessionStorage.removeItem('vw.updated');
      setTimeout(() => toast(`Neue Version ${APP_VERSION} geladen`), 300);
    }
  } catch {}

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      checkDeadlines();
      // Beim Zurückkehren in die App und stündlich nach Updates schauen
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  });
} else {
  checkDeadlines();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { renderAll(); checkDeadlines(); }
});
