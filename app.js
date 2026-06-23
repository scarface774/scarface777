// ============================================================================
// GASP SCREENER — core logic
// ============================================================================

// ---- constants ----------------------------------------------------------
const EXCHANGES = [
  { id: 'binance', label: 'Binance', color: '#f3ba2f' },
  { id: 'bybit',   label: 'Bybit',   color: '#fcd535' },
  { id: 'okx',     label: 'OKX',     color: '#cfd3da' },
];

const TF_DEFS = [
  { key: 'm1',  label: '1м',  ms: 60 * 1000 },
  { key: 'm5',  label: '5м',  ms: 5 * 60 * 1000 },
  { key: 'm15', label: '15м', ms: 15 * 60 * 1000 },
  { key: 'h1',  label: '1ч',  ms: 60 * 60 * 1000 },
  { key: 'h4',  label: '4ч',  ms: 4 * 60 * 60 * 1000 },
  { key: 'h24', label: '24ч', ms: 24 * 60 * 60 * 1000 },
];

const REFRESH_MS = 2000;        // опрос каждые 2с — биржи обновляются независимо друг от друга
const HISTORY_MAX_MS = 24.5 * 60 * 60 * 1000;
const OI_HISTORY_MAX_POINTS = 60;

const LS_KEYS = {
  favorites: 'gasp_favorites_v1',
  settings: 'gasp_settings_v1',
};

// ---- state ----------------------------------------------------------------
const state = {
  selectedExchanges: new Set(['binance', 'bybit', 'okx']),
  sortKey: 'h24',
  sortDir: -1,
  minVolume: 5,
  minOI: 0,
  search: '',
  autoRefresh: true,
  soundOn: false,
  voiceOn: false,
  alertsOn: true,
  hotRowsOn: true,
  spike1Threshold: 5,
  spike5Threshold: 10,
  favorites: new Set(),
  activePreset: null,
  oiSelectedKey: null,
  coins: new Map(),
  history: new Map(),
  alerts: [],
  lastErrors: {},
  liveExchanges: new Set(),
};

loadSettings();
loadFavorites();

// ---- DOM refs ---------------------------------------------------------
const $ = (id) => document.getElementById(id);
const tbody = $('tbody');
const theadRow = $('theadRow');
const statusRow = $('statusRow');
const connRow = $('connRow');
const clockEl = $('clock');
const footerNote = $('footerNote');
const toastWrap = $('toastWrap');

// ============================================================================
// AUDIO
// ============================================================================
let audioCtx = null;
function playBeep(freq = 880, dur = 0.12) {
  if (!state.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch (e) {}
}

// ============================================================================
// VOICE — интонация: рост = выше/быстрее, падение = ниже/медленнее
// ============================================================================
let ruVoice = null;
function initVoices() {
  if (!('speechSynthesis' in window)) return;
  const pick = () => {
    const voices = window.speechSynthesis.getVoices();
    ruVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('ru')) || null;
  };
  pick();
  window.speechSynthesis.onvoiceschanged = pick;
}
initVoices();

function speakAlert(alert) {
  if (!state.voiceOn) return;
  if (!('speechSynthesis' in window)) return;
  try {
    const isUp = alert.pct > 0;
    const dir = isUp ? 'плюс' : 'минус';
    const pctText = Math.abs(alert.pct).toFixed(1).replace('.', ',');
    const text = `${alert.symbol}... ${dir} ${pctText} процента`;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ru-RU';
    if (ruVoice) utter.voice = ruVoice;
    utter.pitch  = isUp ? 1.4 : 0.7;
    utter.rate   = isUp ? 1.1 : 0.88;
    utter.volume = isUp ? 1.0 : 0.9;
    if (window.speechSynthesis.speaking && window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
    }
    window.speechSynthesis.speak(utter);
  } catch (e) {}
}

// ============================================================================
// EXCHANGE LOADERS
// ============================================================================

async function loadBinance() {
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data
      .filter(it => it.symbol.endsWith('USDT'))
      .map(it => ({
        exchange: 'Binance',
        symbol: it.symbol.replace(/USDT$/, ''),
        price: parseFloat(it.lastPrice),
        change24h: parseFloat(it.priceChangePercent),
        volume: parseFloat(it.quoteVolume),
        oi: null,
      }));
    return { ok: true, ex: 'Binance', items };
  } catch (e) {
    return { ok: false, ex: 'Binance', error: e.message || 'Failed to fetch' };
  }
}

async function loadBinanceOI(symbols) {
  const out = {};
  const batch = symbols.slice(0, 60);
  await Promise.all(batch.map(async (sym) => {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}USDT`);
      if (!res.ok) return;
      const j = await res.json();
      out[sym] = parseFloat(j.openInterest) || 0;
    } catch (e) {}
  }));
  return out;
}

async function loadBybit() {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(json.retMsg || `retCode ${json.retCode}`);
    const items = json.result.list
      .filter(it => it.symbol.endsWith('USDT'))
      .map(it => {
        const price = parseFloat(it.lastPrice);
        const oiRaw = parseFloat(it.openInterest || 0);
        return {
          exchange: 'Bybit',
          symbol: it.symbol.replace(/USDT$/, ''),
          price,
          change24h: parseFloat(it.price24hPcnt || 0) * 100,
          volume: parseFloat(it.turnover24h || 0),
          oi: oiRaw * price,
        };
      });
    return { ok: true, ex: 'Bybit', items };
  } catch (e) {
    return { ok: false, ex: 'Bybit', error: e.message || 'Failed to fetch' };
  }
}

async function loadOKX() {
  try {
    const [tickRes, oiRes] = await Promise.all([
      fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP'),
      fetch('https://www.okx.com/api/v5/public/open-interest?instType=SWAP'),
    ]);
    if (!tickRes.ok) throw new Error(`HTTP ${tickRes.status}`);
    const json = await tickRes.json();
    if (json.code !== '0') throw new Error(json.msg || `code ${json.code}`);
    let oiMap = {};
    if (oiRes.ok) {
      const oiJson = await oiRes.json();
      if (oiJson.code === '0') {
        oiJson.data.forEach(d => { oiMap[d.instId] = parseFloat(d.oiCcy || d.oi || 0); });
      }
    }
    const items = json.data
      .filter(it => it.instId.endsWith('-USDT-SWAP'))
      .map(it => {
        const last = parseFloat(it.last);
        const open24h = parseFloat(it.open24h);
        const change = open24h ? ((last - open24h) / open24h) * 100 : 0;
        const oiContracts = oiMap[it.instId] || 0;
        return {
          exchange: 'OKX',
          symbol: it.instId.replace('-USDT-SWAP', ''),
          price: last,
          change24h: change,
          volume: parseFloat(it.volCcy24h || 0) * last,
          oi: oiContracts * last,
        };
      });
    return { ok: true, ex: 'OKX', items };
  } catch (e) {
    return { ok: false, ex: 'OKX', error: e.message || 'Failed to fetch' };
  }
}

// ============================================================================
// DATA PIPELINE — каждая биржа обновляется независимо, не блокируя друг друга
// ============================================================================

function keyFor(exchange, symbol) { return `${exchange}:${symbol}`; }

function processExchangeResult(r) {
  const now = Date.now();
  if (!r.ok) {
    state.lastErrors[r.ex] = r.error;
    updateConnRowFromState();
    return;
  }
  delete state.lastErrors[r.ex];
  state.liveExchanges.add(r.ex);

  for (const it of r.items) {
    const key = keyFor(it.exchange, it.symbol);
    const prev = state.coins.get(key);
    const record = {
      key,
      exchange: it.exchange,
      symbol: it.symbol,
      price: it.price,
      volume: it.volume,
      oi: (it.oi === null || it.oi === undefined) ? (prev ? prev.oi : 0) : it.oi,
      change24h: it.change24h,
      lastUpdate: now,
      prevPrice: prev ? prev.price : it.price,
    };
    state.coins.set(key, record);
    pushHistory(key, now, it.price, record.oi);
  }
  detectSpikes(now);
  render();
  renderOiChart();
  updateConnRowFromState();
}

function updateConnRowFromState() {
  const errors = Object.entries(state.lastErrors).map(([ex, err]) => `${ex}: ${err}`);
  updateConnRow(state.liveExchanges, errors);
}

async function refreshBinance() {
  const r = await loadBinance();
  processExchangeResult(r);
  if (r.ok) {
    const binSymbols = [...state.coins.values()]
      .filter(c => c.exchange === 'Binance')
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 60)
      .map(c => c.symbol);
    loadBinanceOI(binSymbols).then(oiMap => {
      const t = Date.now();
      Object.entries(oiMap).forEach(([sym, oiCoins]) => {
        const key = keyFor('Binance', sym);
        const rec = state.coins.get(key);
        if (rec) { rec.oi = oiCoins * rec.price; pushHistory(key, t, rec.price, rec.oi); }
      });
      render();
      renderOiChart();
    });
  }
}

async function refreshBybit() { processExchangeResult(await loadBybit()); }
async function refreshOKX()   { processExchangeResult(await loadOKX()); }

async function refreshAll() {
  setBtnSpinning(true);
  const tasks = [];
  if (state.selectedExchanges.has('binance')) tasks.push(refreshBinance());
  if (state.selectedExchanges.has('bybit'))   tasks.push(refreshBybit());
  if (state.selectedExchanges.has('okx'))     tasks.push(refreshOKX());
  await Promise.allSettled(tasks);
  setBtnSpinning(false);
}

function pushHistory(key, t, price, oi) {
  let arr = state.history.get(key);
  if (!arr) { arr = []; state.history.set(key, arr); }
  arr.push({ t, price, oi });
  const cutoff = t - HISTORY_MAX_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}

function priceAt(key, now, windowMs) {
  const arr = state.history.get(key);
  if (!arr || arr.length === 0) return null;
  const target = now - windowMs;
  let best = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].t <= target) best = arr[i];
    else break;
  }
  if (!best) {
    if (arr[0].t - target < windowMs * 0.15) return arr[0];
    return null;
  }
  return best;
}

function pctChange(key, now, windowMs, fallback24h) {
  if (windowMs >= TF_DEFS.find(t => t.key === 'h24').ms - 1) return fallback24h;
  const past = priceAt(key, now, windowMs);
  const cur = state.coins.get(key);
  if (!past || !cur || past.price === 0) return null;
  return ((cur.price - past.price) / past.price) * 100;
}

// ============================================================================
// ALERTS
// ============================================================================

function detectSpikes(now) {
  if (!state.alertsOn) return;
  state.coins.forEach((coin, key) => {
    const p1 = pctChange(key, now, TF_DEFS[0].ms, coin.change24h);
    const p5 = pctChange(key, now, TF_DEFS[1].ms, coin.change24h);
    if (p1 !== null && Math.abs(p1) >= state.spike1Threshold) fireAlert(coin, '1м', p1, 60 * 1000);
    if (p5 !== null && Math.abs(p5) >= state.spike5Threshold) fireAlert(coin, '5м', p5, 5 * 60 * 1000);
  });
}

const alertCooldown = new Map();
function fireAlert(coin, windowLabel, pct, windowMs) {
  const cdKey = `${coin.key}:${windowLabel}`;
  const now = Date.now();
  const last = alertCooldown.get(cdKey) || 0;
  if (now - last < windowMs) return;
  alertCooldown.set(cdKey, now);

  const alert = { id: `${cdKey}:${now}`, key: coin.key, symbol: coin.symbol, exchange: coin.exchange, windowLabel, pct, time: now };
  state.alerts.unshift(alert);
  if (state.alerts.length > 80) state.alerts.length = 80;

  renderAlertFeed();
  showToast(alert);
  playBeep(pct > 0 ? 1040 : 620, 0.16);
  speakAlert(alert);
}

function showToast(alert) {
  const el = document.createElement('div');
  el.className = 'toast';
  const dirArrow = alert.pct > 0 ? '▲' : '▼';
  const color = alert.pct > 0 ? 'var(--up)' : 'var(--down)';
  el.innerHTML = `
    <div class="t-top">
      <span class="t-sym mono">${alert.symbol} <span style="color:var(--text-2);font-weight:500;">${alert.exchange}</span></span>
      <span class="t-close">✕</span>
    </div>
    <div class="t-msg" style="color:${color};">${dirArrow} ${alert.pct.toFixed(2)}% за ${alert.windowLabel}</div>
  `;
  el.querySelector('.t-close').onclick = () => el.remove();
  toastWrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 6000);
}

function renderAlertFeed() {
  const feed = $('alertFeed');
  $('alertCount').textContent = state.alerts.length;
  if (state.alerts.length === 0) { feed.innerHTML = `<div class="fav-empty">Алертов пока нет</div>`; return; }
  feed.innerHTML = state.alerts.slice(0, 30).map(a => {
    const color = a.pct > 0 ? 'var(--up)' : 'var(--down)';
    const arrow = a.pct > 0 ? '▲' : '▼';
    const t = new Date(a.time).toLocaleTimeString('ru-RU');
    return `<div class="alert-item">
      <div class="a-top"><span class="a-sym">${a.symbol}<span style="color:var(--text-2);"> · ${a.exchange}</span></span><span class="a-time">${t}</span></div>
      <div class="a-detail" style="color:${color};">${arrow} ${a.pct.toFixed(2)}% за ${a.windowLabel}</div>
    </div>`;
  }).join('');
}

// ============================================================================
// FAVORITES
// ============================================================================

function loadFavorites() {
  try { const raw = localStorage.getItem(LS_KEYS.favorites); if (raw) state.favorites = new Set(JSON.parse(raw)); } catch (e) {}
}
function saveFavorites() {
  try { localStorage.setItem(LS_KEYS.favorites, JSON.stringify([...state.favorites])); } catch (e) {}
}
function toggleFavorite(key) {
  if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
  saveFavorites(); render(); renderFavList();
}

function renderFavList() {
  const el = $('favList');
  if (state.favorites.size === 0) { el.innerHTML = `<div class="fav-empty">Нажмите ★ у монеты</div>`; return; }
  const rows = [...state.favorites].map(key => {
    const coin = state.coins.get(key);
    if (!coin) return '';
    const color = coin.change24h >= 0 ? 'var(--up)' : 'var(--down)';
    return `<div class="fav-item"><span class="fname">${coin.symbol}<span style="color:var(--text-2);"> ${coin.exchange}</span></span><span style="color:${color};font-weight:700;">${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(2)}%</span></div>`;
  }).join('');
  el.innerHTML = rows || `<div class="fav-empty">Нажмите ★ у монеты</div>`;
}

// ============================================================================
// SETTINGS
// ============================================================================
function saveSettings() {
  try {
    localStorage.setItem(LS_KEYS.settings, JSON.stringify({
      selectedExchanges: [...state.selectedExchanges], minVolume: state.minVolume, minOI: state.minOI,
      soundOn: state.soundOn, voiceOn: state.voiceOn, alertsOn: state.alertsOn,
      hotRowsOn: state.hotRowsOn, autoRefresh: state.autoRefresh,
      spike1Threshold: state.spike1Threshold, spike5Threshold: state.spike5Threshold,
      sortKey: state.sortKey, sortDir: state.sortDir,
    }));
  } catch (e) {}
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEYS.settings);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.selectedExchanges) state.selectedExchanges = new Set(s.selectedExchanges);
    if (typeof s.minVolume === 'number') state.minVolume = s.minVolume;
    if (typeof s.minOI === 'number') state.minOI = s.minOI;
    if (typeof s.soundOn === 'boolean') state.soundOn = s.soundOn;
    if (typeof s.voiceOn === 'boolean') state.voiceOn = s.voiceOn;
    if (typeof s.alertsOn === 'boolean') state.alertsOn = s.alertsOn;
    if (typeof s.hotRowsOn === 'boolean') state.hotRowsOn = s.hotRowsOn;
    if (typeof s.autoRefresh === 'boolean') state.autoRefresh = s.autoRefresh;
    if (typeof s.spike1Threshold === 'number') state.spike1Threshold = s.spike1Threshold;
    if (typeof s.spike5Threshold === 'number') state.spike5Threshold = s.spike5Threshold;
    if (s.sortKey) state.sortKey = s.sortKey;
    if (typeof s.sortDir === 'number') state.sortDir = s.sortDir;
  } catch (e) {}
}

// ============================================================================
// RENDER — conn row
// ============================================================================
function updateConnRow(liveExchanges, errors) {
  connRow.innerHTML = EXCHANGES.map(ex => {
    const selected = state.selectedExchanges.has(ex.id);
    if (!selected) return `<div class="exch-pill"><span class="dot"></span>${ex.label}</div>`;
    const isLive = liveExchanges.has(ex.label);
    return `<div class="exch-pill live"><span class="dot ${isLive ? 'live' : 'bad'}"></span>${ex.label}</div>`;
  }).join('');
  if (errors.length > 0) {
    statusRow.innerHTML = `<span class="err">⚠ ${errors.join(' &nbsp;|&nbsp; ')}</span>`;
  } else {
    statusRow.innerHTML = `<span class="ok">●</span> Подключено · тикеров в буфере: <span class="badge-count">${state.coins.size}</span>`;
  }
}

// ============================================================================
// RENDER — exchange toggle, presets, table head
// ============================================================================
function renderExchangeToggle() {
  $('exchToggle').innerHTML = EXCHANGES.map(ex => {
    const on = state.selectedExchanges.has(ex.id);
    return `<button class="btn ${on ? 'toggle-on' : ''}" data-ex="${ex.id}">${ex.label}</button>`;
  }).join('');
  $('exchToggle').querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const ex = btn.getAttribute('data-ex');
      if (state.selectedExchanges.has(ex)) state.selectedExchanges.delete(ex); else state.selectedExchanges.add(ex);
      saveSettings(); renderExchangeToggle(); render(); refreshAll();
    };
  });
}

const PRESETS = [
  { id: 'all', label: 'Все', filter: () => true },
  { id: 'gainers', label: 'Топ рост 24ч', filter: c => c.change24h > 0, sortKey: 'h24', sortDir: -1 },
  { id: 'losers', label: 'Топ падение 24ч', filter: c => c.change24h < 0, sortKey: 'h24', sortDir: 1 },
  { id: 'hot1m', label: `Взлёт ≥${'{s1}'}% за 1м`, dynamic: true, windowKey: 'm1' },
  { id: 'hot5m', label: `Взлёт ≥${'{s5}'}% за 5м`, dynamic: true, windowKey: 'm5' },
  { id: 'favs', label: '★ Избранное', filter: (c) => state.favorites.has(c.key) },
];

function renderPresets() {
  $('presets').innerHTML = PRESETS.map(p => {
    let label = p.label.replace('{s1}', state.spike1Threshold).replace('{s5}', state.spike5Threshold);
    const active = state.activePreset === p.id;
    return `<button class="preset-btn ${active ? 'active' : ''}" data-preset="${p.id}">${label}</button>`;
  }).join('');
  $('presets').querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-preset');
      state.activePreset = state.activePreset === id ? null : id;
      render(); renderPresets();
    };
  });
}

function renderTableHead() {
  const cols = [
    { key: 'symbol', label: 'Тикер' }, { key: 'price', label: 'Цена' },
    { key: 'm1', label: '1м' }, { key: 'm5', label: '5м' }, { key: 'm15', label: '15м' },
    { key: 'h1', label: '1ч' }, { key: 'h4', label: '4ч' }, { key: 'h24', label: '24ч' },
    { key: 'volume', label: 'Объём 24ч' }, { key: 'oi', label: 'Open Interest' },
  ];
  theadRow.innerHTML = cols.map(c => {
    const sorted = state.sortKey === c.key;
    const arrow = sorted ? (state.sortDir === -1 ? '↓' : '↑') : '';
    return `<th data-key="${c.key}" class="${sorted ? 'sorted' : ''}">${c.label}<span class="arrow">${arrow}</span></th>`;
  }).join('');
  theadRow.querySelectorAll('th').forEach(th => {
    th.onclick = () => {
      const key = th.getAttribute('data-key');
      if (state.sortKey === key) state.sortDir *= -1; else { state.sortKey = key; state.sortDir = -1; }
      saveSettings(); render(); renderTableHead();
    };
  });
}

// ============================================================================
// RENDER — main table
// ============================================================================
const prevRenderPrices = new Map();

function getFilteredSortedCoins() {
  const now = Date.now();
  const minVol = state.minVolume * 1_000_000;
  const minOI = state.minOI * 1_000_000;
  const search = state.search.toUpperCase();

  let list = [...state.coins.values()].filter(c => {
    if (!state.selectedExchanges.has(c.exchange.toLowerCase())) return false;
    if (search && !c.symbol.includes(search)) return false;
    if (c.volume < minVol) return false;
    if (c.oi < minOI) return false;
    return true;
  });

  list = list.map(c => {
    const m1  = pctChange(c.key, now, TF_DEFS[0].ms, c.change24h);
    const m5  = pctChange(c.key, now, TF_DEFS[1].ms, c.change24h);
    const m15 = pctChange(c.key, now, TF_DEFS[2].ms, c.change24h);
    const h1  = pctChange(c.key, now, TF_DEFS[3].ms, c.change24h);
    const h4  = pctChange(c.key, now, TF_DEFS[4].ms, c.change24h);
    return { ...c, m1, m5, m15, h1, h4 };
  });

  const preset = PRESETS.find(p => p.id === state.activePreset);
  if (preset) {
    if (preset.dynamic) {
      const wk = preset.windowKey;
      const thresh = wk === 'm1' ? state.spike1Threshold : state.spike5Threshold;
      list = list.filter(c => c[wk] !== null && Math.abs(c[wk]) >= thresh);
      list.sort((a, b) => Math.abs(b[wk]) - Math.abs(a[wk]));
      return list;
    }
    list = list.filter(preset.filter);
    if (preset.sortKey) { list.sort((a, b) => (b[preset.sortKey] - a[preset.sortKey]) * (preset.sortDir || -1)); return list; }
  }

  list.sort((a, b) => {
    let va = a[state.sortKey], vb = b[state.sortKey];
    if (state.sortKey === 'symbol') return state.sortDir === -1 ? b.symbol.localeCompare(a.symbol) : a.symbol.localeCompare(b.symbol);
    if (va === null || va === undefined) va = -Infinity;
    if (vb === null || vb === undefined) vb = -Infinity;
    return state.sortDir === -1 ? vb - va : va - vb;
  });
  return list;
}

function fmtPrice(p) {
  if (p >= 1000) return p.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toLocaleString('ru-RU', { maximumFractionDigits: 4 });
  return p.toLocaleString('ru-RU', { maximumFractionDigits: 8 });
}

function pctCellHtml(val) {
  if (val === null || val === undefined) return `<span class="pct pending">···</span>`;
  const cls = val > 0.001 ? 'up' : val < -0.001 ? 'down' : 'flat';
  return `<span class="pct ${cls}">${val > 0 ? '+' : ''}${val.toFixed(2)}%</span>`;
}

function render() {
  const list = getFilteredSortedCoins();
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><div class="big">∅</div>Нет монет под текущие фильтры.</div></td></tr>`;
    footerNote.textContent = '';
    renderFavList(); populateOiSelect(list); return;
  }

  tbody.innerHTML = list.map(c => {
    const prevPrice = prevRenderPrices.get(c.key);
    let flashClass = '';
    if (prevPrice !== undefined && prevPrice !== c.price) flashClass = c.price > prevPrice ? 'flash-up' : 'flash-down';
    prevRenderPrices.set(c.key, c.price);
    const isFav = state.favorites.has(c.key);
    const isHot = state.hotRowsOn && (
      (c.m1 !== null && Math.abs(c.m1) >= state.spike1Threshold) ||
      (c.m5 !== null && Math.abs(c.m5) >= state.spike5Threshold)
    );
    return `<tr class="${flashClass} ${isHot ? 'hot-row' : ''}" data-key="${c.key}">
      <td><div class="sym-cell">
        <button class="star-btn ${isFav ? 'fav' : ''}" data-fav="${c.key}">★</button>
        <span class="ex-tag ${c.exchange}">${c.exchange.slice(0,3).toUpperCase()}</span>
        <span class="sym-name">${c.symbol}</span>
      </div></td>
      <td class="mono">$${fmtPrice(c.price)}</td>
      <td>${pctCellHtml(c.m1)}</td>
      <td>${pctCellHtml(c.m5)}</td>
      <td>${pctCellHtml(c.m15)}</td>
      <td>${pctCellHtml(c.h1)}</td>
      <td>${pctCellHtml(c.h4)}</td>
      <td>${pctCellHtml(c.h24)}</td>
      <td class="mono">$${(c.volume/1e6).toFixed(1)}M</td>
      <td class="mono">${c.oi > 0 ? '$'+(c.oi/1e6).toFixed(1)+'M' : '—'}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-fav]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); toggleFavorite(btn.getAttribute('data-fav')); };
  });

  footerNote.textContent = `Показано ${list.length} тикеров · обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
  renderFavList(); populateOiSelect(list);
}

// ============================================================================
// OI CHART
// ============================================================================
function populateOiSelect(list) {
  const sel = $('oiSymbolSelect');
  const withOi = list.filter(c => c.oi > 0).slice(0, 200);
  const currentVal = state.oiSelectedKey;
  sel.innerHTML = withOi.map(c => `<option value="${c.key}">${c.symbol} · ${c.exchange}</option>`).join('') || `<option value="">Нет данных OI</option>`;
  if (currentVal && withOi.some(c => c.key === currentVal)) sel.value = currentVal;
  else if (withOi.length) { state.oiSelectedKey = withOi[0].key; sel.value = withOi[0].key; }
}

function renderOiChart() {
  const key = state.oiSelectedKey;
  const svg = $('oiSvg');
  const title = $('oiChartTitle');
  if (!key || !state.history.has(key)) { svg.innerHTML = ''; title.textContent = '—'; return; }
  const coin = state.coins.get(key);
  const hist = state.history.get(key).filter(h => h.oi > 0);
  if (!coin || hist.length < 2) {
    svg.innerHTML = `<text x="124" y="48" text-anchor="middle" fill="#646d80" font-size="10">Копим историю...</text>`;
    title.textContent = coin ? `${coin.symbol} · ${coin.exchange}` : '—'; return;
  }
  const points = hist.slice(-OI_HISTORY_MAX_POINTS);
  const oiVals = points.map(p => p.oi);
  const min = Math.min(...oiVals), max = Math.max(...oiVals);
  const range = (max - min) || 1;
  const w = 248, h = 90, pad = 6;
  const coords = points.map((p, i) => [pad + (i/(points.length-1))*(w-pad*2), h-pad-((p.oi-min)/range)*(h-pad*2)]);
  const pathD = coords.map((c,i) => (i===0?`M${c[0]},${c[1]}`:`L${c[0]},${c[1]}`)).join(' ');
  const areaD = `${pathD} L${coords[coords.length-1][0]},${h-pad} L${coords[0][0]},${h-pad} Z`;
  const first = oiVals[0], last = oiVals[oiVals.length-1];
  const oiChangePct = first ? ((last-first)/first)*100 : 0;
  const up = oiChangePct >= 0;
  const color = up ? '#3ddc84' : '#ff5d5d';
  svg.innerHTML = `<defs><linearGradient id="oiGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.35"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${areaD}" fill="url(#oiGrad)" stroke="none"/>
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
  title.innerHTML = `<span>${coin.symbol} <span style="color:var(--text-2);">${coin.exchange}</span></span><span style="color:${color};">${up?'+':''}${oiChangePct.toFixed(2)}%</span>`;
}

// ============================================================================
// UI WIRING
// ============================================================================
function setBtnSpinning(on) { $('refreshBtn').classList.toggle('icon-spin', on); }

function wireControls() {
  renderExchangeToggle(); renderPresets(); renderTableHead();

  $('search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('minVolume').value = state.minVolume;
  $('minVolume').addEventListener('input', (e) => { state.minVolume = parseFloat(e.target.value)||0; saveSettings(); render(); });
  $('minOI').value = state.minOI;
  $('minOI').addEventListener('input', (e) => { state.minOI = parseFloat(e.target.value)||0; saveSettings(); render(); });
  $('sortTf').addEventListener('change', (e) => { state.sortKey = e.target.value; state.sortDir = -1; saveSettings(); render(); renderTableHead(); });
  $('refreshBtn').addEventListener('click', refreshAll);

  const soundBtn = $('soundBtn');
  soundBtn.classList.toggle('active', state.soundOn);
  soundBtn.addEventListener('click', () => { state.soundOn = !state.soundOn; soundBtn.classList.toggle('active', state.soundOn); saveSettings(); if (state.soundOn) playBeep(880, 0.1); });

  wireSwitch('toggleAlerts', state.alertsOn, (v) => { state.alertsOn = v; saveSettings(); });
  wireSwitch('toggleVoice', state.voiceOn, (v) => { state.voiceOn = v; saveSettings(); if (v) speakAlert({ symbol: 'GASP', pct: 1, windowLabel: 'тест' }); });
  wireSwitch('toggleHotRows', state.hotRowsOn, (v) => { state.hotRowsOn = v; saveSettings(); render(); });
  wireSwitch('toggleAuto', state.autoRefresh, (v) => { state.autoRefresh = v; saveSettings(); });

  $('spike1').value = state.spike1Threshold;
  $('lblSpike1').textContent = state.spike1Threshold.toFixed(1) + '%';
  $('spike1').addEventListener('input', (e) => { state.spike1Threshold = parseFloat(e.target.value); $('lblSpike1').textContent = state.spike1Threshold.toFixed(1)+'%'; saveSettings(); renderPresets(); });

  $('spike5').value = state.spike5Threshold;
  $('lblSpike5').textContent = state.spike5Threshold.toFixed(1) + '%';
  $('spike5').addEventListener('input', (e) => { state.spike5Threshold = parseFloat(e.target.value); $('lblSpike5').textContent = state.spike5Threshold.toFixed(1)+'%'; saveSettings(); renderPresets(); });

  $('oiSymbolSelect').addEventListener('change', (e) => { state.oiSelectedKey = e.target.value; renderOiChart(); });

  document.querySelectorAll('.mini-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.mini-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.getAttribute('data-tab');
      $('panelAlerts').style.display = target === 'alerts' ? 'block' : 'none';
      $('panelFavs').style.display   = target === 'favs'   ? 'block' : 'none';
      $('panelOi').style.display     = target === 'oi'     ? 'block' : 'none';
      if (target === 'oi') renderOiChart();
    };
  });
}

function wireSwitch(id, initial, onChange) {
  const el = $(id);
  el.classList.toggle('on', initial);
  el.onclick = () => { const next = !el.classList.contains('on'); el.classList.toggle('on', next); onChange(next); };
}

// ============================================================================
// CLOCK + loops
// ============================================================================
function tickClock() { clockEl.textContent = new Date().toLocaleTimeString('ru-RU'); }
setInterval(tickClock, 1000);
tickClock();

function scheduleRefresh() {
  // Независимые интервалы для каждой биржи — Binance быстрее, OKX медленнее
  setInterval(() => { if (!state.autoRefresh) return; if (state.selectedExchanges.has('binance')) refreshBinance(); }, 2000);
  setInterval(() => { if (!state.autoRefresh) return; if (state.selectedExchanges.has('bybit'))   refreshBybit();   }, 3000);
  setInterval(() => { if (!state.autoRefresh) return; if (state.selectedExchanges.has('okx'))     refreshOKX();     }, 4000);
}

setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('tbody tr[data-key]').forEach(tr => {
    const key = tr.getAttribute('data-key');
    const coin = state.coins.get(key);
    if (!coin) return;
    const cells = tr.querySelectorAll('td');
    if (cells[2]) cells[2].innerHTML = pctCellHtml(pctChange(key, now, TF_DEFS[0].ms, coin.change24h));
    if (cells[3]) cells[3].innerHTML = pctCellHtml(pctChange(key, now, TF_DEFS[1].ms, coin.change24h));
    if (cells[4]) cells[4].innerHTML = pctCellHtml(pctChange(key, now, TF_DEFS[2].ms, coin.change24h));
    if (cells[5]) cells[5].innerHTML = pctCellHtml(pctChange(key, now, TF_DEFS[3].ms, coin.change24h));
    if (cells[6]) cells[6].innerHTML = pctCellHtml(pctChange(key, now, TF_DEFS[4].ms, coin.change24h));
  });
}, 1000);

// ============================================================================
// INIT
// ============================================================================
wireControls();
render();
refreshAll();
scheduleRefresh();
