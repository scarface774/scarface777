// ============================================================================
// GASP SCREENER v3 — with per-column TFs, sparklines, modal chart
// ============================================================================

const EXCHANGES = [
  { id: 'binance', label: 'Binance', color: '#f3ba2f' },
  { id: 'bybit',   label: 'Bybit',   color: '#fcd535' },
  { id: 'okx',     label: 'OKX',     color: '#cfd3da' },
];

const TF_OPTIONS = [
  { key: 'm1',  label: '1м',  ms: 60*1000 },
  { key: 'm5',  label: '5м',  ms: 5*60*1000 },
  { key: 'm15', label: '15м', ms: 15*60*1000 },
  { key: 'h1',  label: '1ч',  ms: 60*60*1000 },
  { key: 'h4',  label: '4ч',  ms: 4*60*60*1000 },
  { key: 'h24', label: '24ч', ms: 24*60*60*1000 },
];

const HISTORY_MAX_MS = 25 * 60 * 60 * 1000;
const OI_HISTORY_MAX_POINTS = 120;

const LS = {
  favorites: 'gasp_fav_v2',
  settings:  'gasp_set_v2',
  history:   'gasp_hist_v1',  // буфер истории цен — переживает перезагрузку
};

// Как часто сохраняем буфер в localStorage (не каждый тик — это дорого)
const HISTORY_SAVE_INTERVAL_MS = 30 * 1000;

// ---- state ---------------------------------------------------------------
const state = {
  selectedExchanges: new Set(['binance','bybit','okx']),
  sortColIdx: 3,  // 0=symbol,1=price,2=col0..5=col3,6=volume,7=oi
  sortDir: -1,
  minVolume: 5,
  minOI: 0,
  search: '',
  autoRefresh: true,
  soundOn: false,
  voiceOn: false,
  alertsOn: true,
  hotRowsOn: true,
  spike1: 5,
  spike5: 10,
  favorites: new Set(),
  activePreset: null,
  oiSelectedKey: null,
  // 4 настраиваемые колонки % изменения
  colTFs: ['m1','m5','h1','h24'],
  coins: new Map(),
  history: new Map(),
  funding: new Map(),  // key -> {rate, nextTime}
  lsRatio: new Map(),  // key -> {longPct, shortPct}
  alerts: [],
  lastErrors: {},
  liveExchanges: new Set(),
};

loadSettings(); loadFavorites(); loadHistory();

// ---- DOM -----------------------------------------------------------------
const $ = id => document.getElementById(id);
const tbody    = $('tbody');
const theadRow = $('theadRow');
const statusRow= $('statusRow');
const connRow  = $('connRow');
const clockEl  = $('clock');
const footerNote=$('footerNote');
const toastWrap=$('toastWrap');

// ============================================================================
// AUDIO
// ============================================================================
let audioCtx = null;
function playBeep(freq=880, dur=0.12) {
  if (!state.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sine'; o.frequency.value=freq;
    g.gain.setValueAtTime(0.18, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime+dur);
  } catch(e){}
}

// ============================================================================
// VOICE
// ============================================================================
let ruVoice = null;
function initVoices() {
  if (!('speechSynthesis' in window)) return;
  const pick = () => { const v=window.speechSynthesis.getVoices(); ruVoice=v.find(x=>x.lang&&x.lang.toLowerCase().startsWith('ru'))||null; };
  pick(); window.speechSynthesis.onvoiceschanged=pick;
}
initVoices();

function speakAlert(a) {
  if (!state.voiceOn || !('speechSynthesis' in window)) return;
  try {
    const isUp=a.pct>0, dir=isUp?'плюс':'минус';
    const pct=Math.abs(a.pct).toFixed(1).replace('.',',');
    const utter=new SpeechSynthesisUtterance(`${a.symbol}... ${dir} ${pct} процента`);
    utter.lang='ru-RU'; if(ruVoice)utter.voice=ruVoice;
    utter.pitch=isUp?1.4:0.7; utter.rate=isUp?1.1:0.88; utter.volume=1;
    if(window.speechSynthesis.speaking&&window.speechSynthesis.pending) window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  } catch(e){}
}

// ============================================================================
// EXCHANGE LOADERS
// ============================================================================
async function loadBinance() {
  try {
    const r=await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d=await r.json();
    return {ok:true,ex:'Binance',items:d.filter(x=>x.symbol.endsWith('USDT')).map(x=>({
      exchange:'Binance',symbol:x.symbol.replace(/USDT$/,''),
      price:+x.lastPrice,change24h:+x.priceChangePercent,volume:+x.quoteVolume,oi:null
    }))};
  } catch(e){return{ok:false,ex:'Binance',error:e.message};}
}
async function loadBinanceOI(syms) {
  const out={};
  await Promise.all(syms.slice(0,60).map(async s=>{
    try{const r=await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${s}USDT`);
      if(r.ok){const j=await r.json();out[s]=+j.openInterest||0;}}catch(e){}
  }));
  return out;
}
async function loadBybit() {
  try {
    const r=await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const j=await r.json();
    if(j.retCode!==0) throw new Error(j.retMsg);
    return {ok:true,ex:'Bybit',items:j.result.list.filter(x=>x.symbol.endsWith('USDT')).map(x=>{
      const p=+x.lastPrice;
      return{exchange:'Bybit',symbol:x.symbol.replace(/USDT$/,''),price:p,
        change24h:(+x.price24hPcnt||0)*100,volume:+x.turnover24h||0,oi:(+x.openInterest||0)*p};
    })};
  } catch(e){return{ok:false,ex:'Bybit',error:e.message};}
}
async function loadOKX() {
  try {
    const [tr,or]=await Promise.all([
      fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP'),
      fetch('https://www.okx.com/api/v5/public/open-interest?instType=SWAP'),
    ]);
    if(!tr.ok) throw new Error(`HTTP ${tr.status}`);
    const tj=await tr.json(); if(tj.code!=='0') throw new Error(tj.msg);
    let oiMap={};
    if(or.ok){const oj=await or.json();if(oj.code==='0')oj.data.forEach(d=>{oiMap[d.instId]=+(d.oiCcy||d.oi||0);});}
    return {ok:true,ex:'OKX',items:tj.data.filter(x=>x.instId.endsWith('-USDT-SWAP')).map(x=>{
      const last=+x.last,open=+x.open24h,chg=open?((last-open)/open)*100:0;
      return{exchange:'OKX',symbol:x.instId.replace('-USDT-SWAP',''),price:last,
        change24h:chg,volume:(+x.volCcy24h||0)*last,oi:(oiMap[x.instId]||0)*last};
    })};
  } catch(e){return{ok:false,ex:'OKX',error:e.message};}
}

// ============================================================================
// FUNDING RATE + LONG/SHORT RATIO
// ============================================================================

// Binance Funding Rate — батч топ-60 по объёму
async function loadBinanceFunding(symbols) {
  const out = {};
  await Promise.all(symbols.slice(0,60).map(async sym => {
    try {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}USDT`);
      if (!r.ok) return;
      const j = await r.json();
      out[sym] = { rate: +j.lastFundingRate * 100, nextTime: +j.nextFundingTime };
    } catch(e) {}
  }));
  return out;
}

// Binance Long/Short ratio
async function loadBinanceLSR(symbols) {
  const out = {};
  await Promise.all(symbols.slice(0,40).map(async sym => {
    try {
      const r = await fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}USDT&period=5m&limit=1`);
      if (!r.ok) return;
      const j = await r.json();
      if (j && j[0]) {
        const longPct = +j[0].longAccount * 100;
        out[sym] = { longPct, shortPct: 100 - longPct };
      }
    } catch(e) {}
  }));
  return out;
}

// Bybit Funding Rate
async function loadBybitFunding(symbols) {
  const out = {};
  await Promise.all(symbols.slice(0,60).map(async sym => {
    try {
      const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}USDT`);
      if (!r.ok) return;
      const j = await r.json();
      if (j.retCode === 0 && j.result.list[0]) {
        out[sym] = { rate: +j.result.list[0].fundingRate * 100, nextTime: +j.result.list[0].nextFundingTime };
      }
    } catch(e) {}
  }));
  return out;
}

// OKX Funding Rate — один запрос на все SWAP
async function loadOKXFunding() {
  const out = {};
  try {
    const r = await fetch('https://www.okx.com/api/v5/public/funding-rate?instType=SWAP');
    if (!r.ok) return out;
    const j = await r.json();
    if (j.code === '0') {
      j.data.filter(d => d.instId.endsWith('-USDT-SWAP')).forEach(d => {
        const sym = d.instId.replace('-USDT-SWAP','');
        out[sym] = { rate: +d.fundingRate * 100, nextTime: +d.nextFundingTime };
      });
    }
  } catch(e) {}
  return out;
}

// Запускаем фоновую загрузку funding + L/S каждые 30 секунд (данные обновляются редко)
async function refreshFundingAndLSR() {
  const binSyms = [...state.coins.values()].filter(c=>c.exchange==='Binance').sort((a,b)=>b.volume-a.volume).slice(0,60).map(c=>c.symbol);
  const bybSyms = [...state.coins.values()].filter(c=>c.exchange==='Bybit').sort((a,b)=>b.volume-a.volume).slice(0,60).map(c=>c.symbol);

  const [binF, binLS, bybF, okxF] = await Promise.allSettled([
    loadBinanceFunding(binSyms),
    loadBinanceLSR(binSyms),
    loadBybitFunding(bybSyms),
    loadOKXFunding(),
  ]);

  if (binF.status==='fulfilled')  Object.entries(binF.value).forEach(([s,v])  => state.funding.set(keyFor('Binance',s),v));
  if (binLS.status==='fulfilled') Object.entries(binLS.value).forEach(([s,v]) => state.lsRatio.set(keyFor('Binance',s),v));
  if (bybF.status==='fulfilled')  Object.entries(bybF.value).forEach(([s,v])  => state.funding.set(keyFor('Bybit',s),v));
  if (okxF.status==='fulfilled')  Object.entries(okxF.value).forEach(([s,v])  => state.funding.set(keyFor('OKX',s),v));

  render();
}
async function fetchKlines(exchange, symbol, interval='15m', limit=100) {
  try {
    if (exchange==='Binance') {
      const r=await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`);
      if(!r.ok) return null;
      const d=await r.json();
      return d.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]*+k[4],oi:0}));
    }
    if (exchange==='Bybit') {
      const ivMap={'1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D'};
      const iv=ivMap[interval]||'15';
      const r=await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}USDT&interval=${iv}&limit=${limit}`);
      if(!r.ok) return null;
      const j=await r.json(); if(j.retCode!==0) return null;
      return j.result.list.reverse().map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]*+k[4],oi:0}));
    }
    if (exchange==='OKX') {
      const ivMap={'1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H','1d':'1D'};
      const iv=ivMap[interval]||'15m';
      const r=await fetch(`https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT-SWAP&bar=${iv}&limit=${limit}`);
      if(!r.ok) return null;
      const j=await r.json(); if(j.code!=='0') return null;
      return j.data.reverse().map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]*+k[4],oi:0}));
    }
  } catch(e){ return null; }
  return null;
}

// ============================================================================
// DATA PIPELINE
// ============================================================================
const keyFor = (ex,sym) => `${ex}:${sym}`;

function processResult(r) {
  const now=Date.now();
  if(!r.ok){state.lastErrors[r.ex]=r.error;updateConnRowFromState();return;}
  delete state.lastErrors[r.ex]; state.liveExchanges.add(r.ex);
  for(const it of r.items){
    const key=keyFor(it.exchange,it.symbol);
    const prev=state.coins.get(key);
    const rec={key,exchange:it.exchange,symbol:it.symbol,price:it.price,volume:it.volume,
      oi:(it.oi==null)?(prev?prev.oi:0):it.oi,change24h:it.change24h,
      lastUpdate:now,prevPrice:prev?prev.price:it.price};
    state.coins.set(key,rec);
    pushHistory(key,now,it.price,rec.oi);
  }
  detectSpikes(now); render(); renderOiChart(); updateConnRowFromState();
}

function updateConnRowFromState(){
  const errs=Object.entries(state.lastErrors).map(([ex,e])=>`${ex}: ${e}`);
  updateConnRow(state.liveExchanges,errs);
}

async function refreshBinance(){
  const r=await loadBinance(); processResult(r);
  if(r.ok){
    const syms=[...state.coins.values()].filter(c=>c.exchange==='Binance').sort((a,b)=>b.volume-a.volume).slice(0,60).map(c=>c.symbol);
    loadBinanceOI(syms).then(oiMap=>{
      const t=Date.now();
      Object.entries(oiMap).forEach(([s,oi])=>{const k=keyFor('Binance',s);const rc=state.coins.get(k);if(rc){rc.oi=oi*rc.price;pushHistory(k,t,rc.price,rc.oi);}});
      render(); renderOiChart();
    });
  }
}
async function refreshBybit(){ processResult(await loadBybit()); }
async function refreshOKX()  { processResult(await loadOKX()); }
async function refreshAll(){
  setBtnSpinning(true);
  await Promise.allSettled([
    state.selectedExchanges.has('binance')?refreshBinance():null,
    state.selectedExchanges.has('bybit')  ?refreshBybit():null,
    state.selectedExchanges.has('okx')    ?refreshOKX():null,
  ].filter(Boolean));
  setBtnSpinning(false);
}

function pushHistory(key,t,price,oi){
  let arr=state.history.get(key);
  if(!arr){arr=[];state.history.set(key,arr);}
  arr.push({t,price,oi});
  const cut=t-HISTORY_MAX_MS;
  while(arr.length&&arr[0].t<cut)arr.shift();
}

// Сохраняем буфер в localStorage — только топ-200 монет по объёму (экономим место)
function saveHistory() {
  try {
    const topKeys = [...state.coins.values()]
      .sort((a,b) => b.volume - a.volume)
      .slice(0, 200)
      .map(c => c.key);
    const obj = {};
    topKeys.forEach(key => {
      const arr = state.history.get(key);
      if (arr && arr.length) obj[key] = arr.slice(-120); // последние 120 точек (~10 мин при 2с)
    });
    localStorage.setItem(LS.history, JSON.stringify(obj));
  } catch(e) { /* quota exceeded — ignore */ }
}

// Загружаем буфер при старте
function loadHistory() {
  try {
    const raw = localStorage.getItem(LS.history);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const now = Date.now();
    Object.entries(obj).forEach(([key, arr]) => {
      // отбрасываем точки старше HISTORY_MAX_MS
      const fresh = arr.filter(p => now - p.t < HISTORY_MAX_MS);
      if (fresh.length) state.history.set(key, fresh);
    });
    console.log(`[GASP] Восстановлен буфер для ${state.history.size} монет`);
  } catch(e) {}
}

function priceAt(key,now,ms){
  const arr=state.history.get(key); if(!arr||!arr.length)return null;
  const target=now-ms; let best=null;
  for(const p of arr){ if(p.t<=target)best=p; else break; }
  if(!best){ if(arr[0].t-target<ms*0.15)return arr[0]; return null; }
  return best;
}

function pctChange(key,now,ms,fb24){
  if(ms>=TF_OPTIONS.find(t=>t.key==='h24').ms-1)return fb24;
  const past=priceAt(key,now,ms),cur=state.coins.get(key);
  if(!past||!cur||past.price===0)return null;
  return((cur.price-past.price)/past.price)*100;
}

// ============================================================================
// SPARKLINE — мини SVG из буфера истории
// ============================================================================
function sparklineSVG(key, w=80, h=28) {
  const arr=state.history.get(key);
  if(!arr||arr.length<2)return `<svg width="${w}" height="${h}"></svg>`;
  const pts=arr.slice(-30);
  const vals=pts.map(p=>p.price);
  const mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||1;
  const xs=pts.map((_,i)=>Math.round((i/(pts.length-1))*(w-2)+1));
  const ys=pts.map(p=>Math.round(h-1-((p.price-mn)/rng)*(h-4)-1));
  const d=xs.map((x,i)=>(i===0?`M${x},${ys[i]}`:`L${x},${ys[i]}`)).join(' ');
  const last=vals[vals.length-1],first=vals[0];
  const color=last>=first?'#3ddc84':'#ff5d5d';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ============================================================================
// ALERTS
// ============================================================================
function detectSpikes(now){
  if(!state.alertsOn)return;
  state.coins.forEach((coin,key)=>{
    const p1=pctChange(key,now,TF_OPTIONS[0].ms,coin.change24h);
    const p5=pctChange(key,now,TF_OPTIONS[1].ms,coin.change24h);
    if(p1!==null&&Math.abs(p1)>=state.spike1)fireAlert(coin,'1м',p1,60000);
    if(p5!==null&&Math.abs(p5)>=state.spike5)fireAlert(coin,'5м',p5,300000);
  });
}
const alertCD=new Map();
function fireAlert(coin,wl,pct,wms){
  const ck=`${coin.key}:${wl}`,now=Date.now(),last=alertCD.get(ck)||0;
  if(now-last<wms)return; alertCD.set(ck,now);
  const a={id:`${ck}:${now}`,key:coin.key,symbol:coin.symbol,exchange:coin.exchange,windowLabel:wl,pct,time:now};
  state.alerts.unshift(a); if(state.alerts.length>80)state.alerts.length=80;
  renderAlertFeed(); showToast(a); playBeep(pct>0?1040:620,0.16); speakAlert(a);
}
function showToast(a){
  const el=document.createElement('div'); el.className='toast';
  const arrow=a.pct>0?'▲':'▼',color=a.pct>0?'var(--up)':'var(--down)';
  el.innerHTML=`<div class="t-top"><span class="t-sym mono">${a.symbol} <span style="color:var(--text-2)">${a.exchange}</span></span><span class="t-close">✕</span></div><div class="t-msg" style="color:${color}">${arrow} ${a.pct.toFixed(2)}% за ${a.windowLabel}</div>`;
  el.querySelector('.t-close').onclick=()=>el.remove();
  toastWrap.appendChild(el);
  setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300);},6000);
}
function renderAlertFeed(){
  const feed=$('alertFeed'); $('alertCount').textContent=state.alerts.length;
  if(!state.alerts.length){feed.innerHTML=`<div class="fav-empty">Алертов пока нет</div>`;return;}
  feed.innerHTML=state.alerts.slice(0,30).map(a=>{
    const color=a.pct>0?'var(--up)':'var(--down)',arrow=a.pct>0?'▲':'▼';
    return `<div class="alert-item"><div class="a-top"><span class="a-sym">${a.symbol}<span style="color:var(--text-2)"> · ${a.exchange}</span></span><span class="a-time">${new Date(a.time).toLocaleTimeString('ru-RU')}</span></div><div class="a-detail" style="color:${color}">${arrow} ${a.pct.toFixed(2)}% за ${a.windowLabel}</div></div>`;
  }).join('');
}

// ============================================================================
// FAVORITES
// ============================================================================
function loadFavorites(){ try{const r=localStorage.getItem(LS.favorites);if(r)state.favorites=new Set(JSON.parse(r));}catch(e){} }
function saveFavorites(){ try{localStorage.setItem(LS.favorites,JSON.stringify([...state.favorites]));}catch(e){} }
function toggleFavorite(key){ if(state.favorites.has(key))state.favorites.delete(key);else state.favorites.add(key); saveFavorites();render();renderFavList(); }
function renderFavList(){
  const el=$('favList');
  if(!state.favorites.size){el.innerHTML=`<div class="fav-empty">Нажмите ★ у монеты</div>`;return;}
  el.innerHTML=[...state.favorites].map(key=>{
    const c=state.coins.get(key); if(!c)return'';
    const color=c.change24h>=0?'var(--up)':'var(--down)';
    return `<div class="fav-item"><span class="fname">${c.symbol}<span style="color:var(--text-2)"> ${c.exchange}</span></span><span style="color:${color};font-weight:700">${c.change24h>=0?'+':''}${c.change24h.toFixed(2)}%</span></div>`;
  }).join('')||`<div class="fav-empty">Нажмите ★ у монеты</div>`;
}

// ============================================================================
// SETTINGS
// ============================================================================
function saveSettings(){
  try{localStorage.setItem(LS.settings,JSON.stringify({
    selectedExchanges:[...state.selectedExchanges],minVolume:state.minVolume,minOI:state.minOI,
    soundOn:state.soundOn,voiceOn:state.voiceOn,alertsOn:state.alertsOn,hotRowsOn:state.hotRowsOn,
    autoRefresh:state.autoRefresh,spike1:state.spike1,spike5:state.spike5,
    sortColIdx:state.sortColIdx,sortDir:state.sortDir,colTFs:state.colTFs,
  }));}catch(e){}
}
function loadSettings(){
  try{
    const raw=localStorage.getItem(LS.settings); if(!raw)return;
    const s=JSON.parse(raw);
    if(s.selectedExchanges)state.selectedExchanges=new Set(s.selectedExchanges);
    ['minVolume','minOI','spike1','spike5','sortColIdx','sortDir'].forEach(k=>{if(typeof s[k]==='number')state[k]=s[k];});
    ['soundOn','voiceOn','alertsOn','hotRowsOn','autoRefresh'].forEach(k=>{if(typeof s[k]==='boolean')state[k]=s[k];});
    if(Array.isArray(s.colTFs)&&s.colTFs.length===4)state.colTFs=s.colTFs;
  }catch(e){}
}

// ============================================================================
// CONN ROW
// ============================================================================
function updateConnRow(live,errors){
  connRow.innerHTML=EXCHANGES.map(ex=>{
    const sel=state.selectedExchanges.has(ex.id);
    if(!sel)return`<div class="exch-pill"><span class="dot"></span>${ex.label}</div>`;
    return`<div class="exch-pill live"><span class="dot ${live.has(ex.label)?'live':'bad'}"></span>${ex.label}</div>`;
  }).join('');
  if(errors.length) statusRow.innerHTML=`<span class="err">⚠ ${errors.join(' | ')}</span>`;
  else statusRow.innerHTML=`<span class="ok">●</span> Подключено · <span class="badge-count">${state.coins.size}</span> тикеров`;
}

// ============================================================================
// TABLE HEAD — колонки с выпадающим ТФ
// ============================================================================
function renderExchangeToggle(){
  $('exchToggle').innerHTML=EXCHANGES.map(ex=>{
    const on=state.selectedExchanges.has(ex.id);
    return`<button class="btn ${on?'toggle-on':''}" data-ex="${ex.id}">${ex.label}</button>`;
  }).join('');
  $('exchToggle').querySelectorAll('button').forEach(btn=>{
    btn.onclick=()=>{
      const ex=btn.getAttribute('data-ex');
      if(state.selectedExchanges.has(ex))state.selectedExchanges.delete(ex);else state.selectedExchanges.add(ex);
      saveSettings();renderExchangeToggle();render();refreshAll();
    };
  });
}

const PRESETS=[
  {id:'all',label:'Все',filter:()=>true},
  {id:'gainers',label:'Топ рост 24ч',filter:c=>c.change24h>0,sIdx:6,sDir:-1},
  {id:'losers',label:'Топ падение 24ч',filter:c=>c.change24h<0,sIdx:6,sDir:1},
  {id:'hot1m',label:`Взлёт ≥{s1}% 1м`,dynamic:true,wk:'m1'},
  {id:'hot5m',label:`Взлёт ≥{s5}% 5м`,dynamic:true,wk:'m5'},
  {id:'favs',label:'★ Избранное',filter:c=>state.favorites.has(c.key)},
];
function renderPresets(){
  $('presets').innerHTML=PRESETS.map(p=>{
    const lbl=p.label.replace('{s1}',state.spike1).replace('{s5}',state.spike5);
    return`<button class="preset-btn ${state.activePreset===p.id?'active':''}" data-preset="${p.id}">${lbl}</button>`;
  }).join('');
  $('presets').querySelectorAll('.preset-btn').forEach(btn=>{
    btn.onclick=()=>{const id=btn.getAttribute('data-preset');state.activePreset=state.activePreset===id?null:id;render();renderPresets();};
  });
}

// TF picker dropdown для шапки
let openTFPicker = null;
function closeTFPicker(){ if(openTFPicker){openTFPicker.remove();openTFPicker=null;} }

function renderTableHead(){
  // Статические колонки + 4 настраиваемые + объём + OI + spark
  const staticLeft=[
    {key:'symbol',label:'Тикер',idx:0},
    {key:'price', label:'Цена', idx:1},
  ];
  const staticRight=[
    {key:'volume',label:'Объём 24ч',idx:6},
    {key:'oi',   label:'OI',        idx:7},
    {key:'fund', label:'Funding',   idx:8, nosort:true},
    {key:'ls',   label:'L/S',       idx:9, nosort:true},
    {key:'spark', label:'График',   idx:10,nosort:true},
  ];

  const tfTh = state.colTFs.map((tf,i)=>{
    const tfDef=TF_OPTIONS.find(t=>t.key===tf);
    const idx=2+i;
    const sorted=state.sortColIdx===idx;
    const arrow=sorted?(state.sortDir===-1?'↓':'↑'):'';
    return `<th class="tf-col ${sorted?'sorted':''}" data-colidx="${idx}" data-coltf="${i}">
      <div class="th-inner">
        <span class="th-sort-part" data-sortidx="${idx}">${arrow} %</span>
        <button class="tf-pick-btn" data-coltf="${i}">${tfDef.label} ▾</button>
      </div>
    </th>`;
  }).join('');

  theadRow.innerHTML=
    staticLeft.map(c=>{const s=state.sortColIdx===c.idx;return`<th data-sortidx="${c.idx}" class="${s?'sorted':''}">${c.label}<span class="arrow">${s?(state.sortDir===-1?'↓':'↑'):''}</span></th>`;}).join('')+
    tfTh+
    staticRight.map(c=>{const s=state.sortColIdx===c.idx;return`<th ${c.nosort?'':'data-sortidx="'+c.idx+'"'} class="${s?'sorted':''}${c.nosort?' nosort':''}">${c.label}${!c.nosort?`<span class="arrow">${s?(state.sortDir===-1?'↓':'↑'):''}</span>`:''}</th>`;}).join('');

  // Сортировка по клику на th
  theadRow.querySelectorAll('[data-sortidx]').forEach(el=>{
    el.addEventListener('click',e=>{
      if(e.target.closest('.tf-pick-btn'))return;
      const idx=+el.getAttribute('data-sortidx');
      if(state.sortColIdx===idx)state.sortDir*=-1;else{state.sortColIdx=idx;state.sortDir=-1;}
      saveSettings();render();renderTableHead();
    });
  });

  // TF picker
  theadRow.querySelectorAll('.tf-pick-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const colIdx=+btn.getAttribute('data-coltf');
      closeTFPicker();
      const picker=document.createElement('div');
      picker.className='tf-picker';
      picker.innerHTML=TF_OPTIONS.map(t=>`<div class="tf-opt ${state.colTFs[colIdx]===t.key?'active':''}" data-tf="${t.key}">${t.label}</div>`).join('');
      const rect=btn.getBoundingClientRect();
      picker.style.cssText=`position:fixed;top:${rect.bottom+4}px;left:${rect.left}px;z-index:200;`;
      document.body.appendChild(picker);
      openTFPicker=picker;
      picker.querySelectorAll('.tf-opt').forEach(opt=>{
        opt.onclick=()=>{
          state.colTFs[colIdx]=opt.getAttribute('data-tf');
          saveSettings();closeTFPicker();renderTableHead();render();
        };
      });
    });
  });
}
document.addEventListener('click',()=>closeTFPicker());

// ============================================================================
// TABLE RENDER
// ============================================================================
const prevPrices=new Map();

function getCoins(){
  const now=Date.now();
  const minVol=state.minVolume*1e6,minOI=state.minOI*1e6,srch=state.search.toUpperCase();

  let list=[...state.coins.values()].filter(c=>{
    if(!state.selectedExchanges.has(c.exchange.toLowerCase()))return false;
    if(srch&&!c.symbol.includes(srch))return false;
    if(c.volume<minVol)return false;
    if(c.oi<minOI)return false;
    return true;
  }).map(c=>{
    const cols=state.colTFs.map(tf=>{
      const tfDef=TF_OPTIONS.find(t=>t.key===tf);
      return pctChange(c.key,now,tfDef.ms,c.change24h);
    });
    return{...c,cols};
  });

  const preset=PRESETS.find(p=>p.id===state.activePreset);
  if(preset){
    if(preset.dynamic){
      const tf=preset.wk,thresh=tf==='m1'?state.spike1:state.spike5;
      const tfDef=TF_OPTIONS.find(t=>t.key===tf);
      list=list.filter(c=>{const v=pctChange(c.key,now,tfDef.ms,c.change24h);return v!==null&&Math.abs(v)>=thresh;});
      list.sort((a,b)=>Math.abs(b.cols[0]||0)-Math.abs(a.cols[0]||0));
      return list;
    }
    list=list.filter(preset.filter);
    if(preset.sIdx!==undefined){list.sort((a,b)=>sortVal(b,preset.sIdx)-sortVal(a,preset.sIdx));if(preset.sDir===1)list.reverse();return list;}
  }

  list.sort((a,b)=>{
    let va=sortVal(a,state.sortColIdx),vb=sortVal(b,state.sortColIdx);
    if(state.sortColIdx===0)return state.sortDir===-1?b.symbol.localeCompare(a.symbol):a.symbol.localeCompare(b.symbol);
    if(va==null)va=-Infinity; if(vb==null)vb=-Infinity;
    return state.sortDir===-1?vb-va:va-vb;
  });
  return list;
}

function sortVal(c,idx){
  if(idx===0)return c.symbol;
  if(idx===1)return c.price;
  if(idx>=2&&idx<=5)return c.cols[idx-2];
  if(idx===6)return c.volume;
  if(idx===7)return c.oi;
  return 0;
}

function fmtPrice(p){
  if(p>=1000)return p.toLocaleString('ru-RU',{maximumFractionDigits:2});
  if(p>=1)   return p.toLocaleString('ru-RU',{maximumFractionDigits:4});
  return p.toLocaleString('ru-RU',{maximumFractionDigits:8});
}
function pctHtml(v){
  if(v==null)return`<span class="pct pending">···</span>`;
  const cls=v>0.001?'up':v<-0.001?'down':'flat';
  return`<span class="pct ${cls}">${v>0?'+':''}${v.toFixed(2)}%</span>`;
}

function render(){
  const list=getCoins();
  if(!list.length){
    tbody.innerHTML=`<tr><td colspan="11"><div class="empty-state"><div class="big">∅</div>Нет монет под фильтры</div></td></tr>`;
    footerNote.textContent=''; renderFavList(); populateOiSelect(list); return;
  }
  tbody.innerHTML=list.map(c=>{
    const pp=prevPrices.get(c.key);
    let flash=''; if(pp!==undefined&&pp!==c.price)flash=c.price>pp?'flash-up':'flash-down';
    prevPrices.set(c.key,c.price);
    const isFav=state.favorites.has(c.key);
    const isHot=state.hotRowsOn&&c.cols.some((v,i)=>{
      const thresh=i===0?state.spike1:i===1?state.spike5:0;
      return v!==null&&thresh>0&&Math.abs(v)>=thresh;
    });
    const spark=sparklineSVG(c.key);
    const fund=state.funding.get(c.key);
    const lsr=state.lsRatio.get(c.key);
    const fundHtml = fund != null
      ? `<span class="fund-rate ${fund.rate>0?'fund-pos':fund.rate<0?'fund-neg':'fund-zero'}">${fund.rate>=0?'+':''}${fund.rate.toFixed(4)}%</span>`
      : `<span style="color:var(--text-2);font-size:11px">···</span>`;
    const lsHtml = lsr
      ? `<div class="ls-bar"><div class="ls-long" style="width:${lsr.longPct.toFixed(0)}%"></div></div><div class="ls-nums"><span class="ls-l">${lsr.longPct.toFixed(0)}%</span><span class="ls-s">${lsr.shortPct.toFixed(0)}%</span></div>`
      : `<span style="color:var(--text-2);font-size:11px">···</span>`;
    return`<tr class="${flash} ${isHot?'hot-row':''}" data-key="${c.key}">
      <td><div class="sym-cell">
        <button class="star-btn ${isFav?'fav':''}" data-fav="${c.key}">★</button>
        <span class="ex-tag ${c.exchange}">${c.exchange.slice(0,3).toUpperCase()}</span>
        <span class="sym-name chart-trigger" data-key="${c.key}">${c.symbol}</span>
      </div></td>
      <td class="mono">$${fmtPrice(c.price)}</td>
      ${c.cols.map(v=>pctHtml(v)).map(h=>`<td>${h}</td>`).join('')}
      <td class="mono">$${(c.volume/1e6).toFixed(1)}M</td>
      <td class="mono">${c.oi>0?'$'+(c.oi/1e6).toFixed(1)+'M':'—'}</td>
      <td class="fund-cell">${fundHtml}</td>
      <td class="ls-cell">${lsHtml}</td>
      <td class="spark-cell chart-trigger" data-key="${c.key}">${spark}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-fav]').forEach(btn=>{
    btn.onclick=e=>{e.stopPropagation();toggleFavorite(btn.getAttribute('data-fav'));};
  });
  tbody.querySelectorAll('.chart-trigger').forEach(el=>{
    el.onclick=()=>openModal(el.getAttribute('data-key'));
  });

  footerNote.textContent=`Показано ${list.length} · обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
  renderFavList(); populateOiSelect(list);
}

// ============================================================================
// MODAL CHART
// ============================================================================
let modalOpen=false;
const CHART_INTERVALS=[
  {label:'1м',val:'1m'},{label:'5м',val:'5m'},{label:'15м',val:'15m'},
  {label:'1ч',val:'1h'},{label:'4ч',val:'4h'},{label:'1д',val:'1d'},
];
let chartInterval='15m';

async function openModal(key){
  const coin=state.coins.get(key); if(!coin)return;
  modalOpen=true;
  let modal=$('chartModal');
  if(!modal){
    modal=document.createElement('div'); modal.id='chartModal'; modal.className='modal-overlay';
    modal.innerHTML=`<div class="modal-box">
      <div class="modal-head">
        <div class="modal-title" id="modalTitle"></div>
        <div class="modal-ivs" id="modalIvs"></div>
        <button class="modal-close" id="modalClose">✕</button>
      </div>
      <div class="modal-body">
        <canvas id="chartCanvas" height="220"></canvas>
        <canvas id="volCanvas"   height="70"></canvas>
        <canvas id="oiCanvas"    height="70"></canvas>
      </div>
      <div id="modalStatus" class="modal-status"></div>
    </div>`;
    document.body.appendChild(modal);
    $('modalClose').onclick=closeModal;
    modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});
  }
  $('modalTitle').textContent=`${coin.symbol} · ${coin.exchange}`;
  $('modalStatus').textContent='Загружаем свечи...';
  modal.style.display='flex';

  // interval buttons
  const ivs=$('modalIvs');
  ivs.innerHTML=CHART_INTERVALS.map(iv=>`<button class="chart-iv-btn ${iv.val===chartInterval?'active':''}" data-iv="${iv.val}">${iv.label}</button>`).join('');
  ivs.querySelectorAll('.chart-iv-btn').forEach(btn=>{
    btn.onclick=async()=>{
      chartInterval=btn.getAttribute('data-iv');
      ivs.querySelectorAll('.chart-iv-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      await loadAndDrawChart(key,coin);
    };
  });

  await loadAndDrawChart(key,coin);
}

async function loadAndDrawChart(key,coin){
  $('modalStatus').textContent='Загружаем свечи...';
  const klines=await fetchKlines(coin.exchange,coin.symbol,chartInterval,120);
  if(!klines||!klines.length){$('modalStatus').textContent='Не удалось загрузить данные';return;}
  $('modalStatus').textContent='';
  drawCandleChart($('chartCanvas'),klines);
  drawBarChart($('volCanvas'),klines,'volume','Объём','#3b82f6');

  // OI из буфера скринера
  const hist=(state.history.get(key)||[]).filter(h=>h.oi>0);
  if(hist.length>1){
    const oiPts=hist.slice(-120).map(h=>({t:h.t,v:h.oi}));
    drawLineChart($('oiCanvas'),oiPts,'OI','#ffb02e');
  } else {
    const ctx=$('oiCanvas').getContext('2d');
    ctx.clearRect(0,0,$('oiCanvas').width,$('oiCanvas').height);
    ctx.fillStyle='#646d80'; ctx.font='11px JetBrains Mono,monospace';
    ctx.textAlign='center'; ctx.fillText('OI: копим историю...',$('oiCanvas').width/2,35);
  }
}

function closeModal(){
  const m=$('chartModal'); if(m)m.style.display='none'; modalOpen=false;
}

// Simple canvas candlestick chart
function drawCandleChart(canvas,klines){
  const dpr=window.devicePixelRatio||1;
  const W=canvas.offsetWidth||canvas.parentElement.offsetWidth||700,H=220;
  canvas.width=W*dpr; canvas.height=H*dpr; canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);

  const pad={l:54,r:8,t:10,b:28};
  const cw=W-pad.l-pad.r, ch=H-pad.t-pad.b;
  const highs=klines.map(k=>k.h), lows=klines.map(k=>k.l);
  const mn=Math.min(...lows), mx=Math.max(...highs), rng=mx-mn||1;
  const n=klines.length;
  const bw=Math.max(1,Math.floor((cw/n)*0.7));

  // grid
  ctx.strokeStyle='#1b1f29'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){
    const y=pad.t+ch*(1-i/4);
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(W-pad.r,y);ctx.stroke();
    const val=mn+rng*(i/4);
    ctx.fillStyle='#646d80';ctx.font='10px JetBrains Mono,monospace';ctx.textAlign='right';
    ctx.fillText(val>=1000?val.toFixed(0):val.toFixed(val>=1?2:4),pad.l-4,y+3);
  }

  // candles
  klines.forEach((k,i)=>{
    const x=pad.l+(i/n)*cw+cw/n/2;
    const yH=pad.t+ch*(1-(k.h-mn)/rng);
    const yL=pad.t+ch*(1-(k.l-mn)/rng);
    const yO=pad.t+ch*(1-(k.o-mn)/rng);
    const yC=pad.t+ch*(1-(k.c-mn)/rng);
    const up=k.c>=k.o;
    const color=up?'#3ddc84':'#ff5d5d';
    ctx.strokeStyle=color; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x,yH);ctx.lineTo(x,yL);ctx.stroke();
    ctx.fillStyle=color;
    const cy=Math.min(yO,yC), ch2=Math.max(1,Math.abs(yC-yO));
    ctx.fillRect(x-bw/2,cy,bw,ch2);
  });

  // time labels
  ctx.fillStyle='#646d80';ctx.font='9px JetBrains Mono,monospace';ctx.textAlign='center';
  const step=Math.max(1,Math.floor(n/6));
  for(let i=0;i<n;i+=step){
    const x=pad.l+(i/n)*cw+cw/n/2;
    const d=new Date(klines[i].t);
    ctx.fillText(`${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`,x,H-8);
  }
}

function drawBarChart(canvas,klines,field,label,color){
  const dpr=window.devicePixelRatio||1;
  const W=canvas.offsetWidth||canvas.parentElement.offsetWidth||700,H=70;
  canvas.width=W*dpr; canvas.height=H*dpr; canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  const pad={l:54,r:8,t:6,b:14};
  const cw=W-pad.l-pad.r,ch=H-pad.t-pad.b;
  const vals=klines.map(k=>k[field]||0), mx=Math.max(...vals)||1;
  const n=klines.length;
  ctx.fillStyle='#646d80';ctx.font='9px JetBrains Mono,monospace';ctx.textAlign='left';
  ctx.fillText(label,2,H/2+3);
  klines.forEach((k,i)=>{
    const x=pad.l+(i/n)*cw,bw=(cw/n)*0.85,h=((k[field]||0)/mx)*ch;
    ctx.fillStyle=color+'88';
    ctx.fillRect(x,pad.t+ch-h,bw,h);
  });
}

function drawLineChart(canvas,pts,label,color){
  const dpr=window.devicePixelRatio||1;
  const W=canvas.offsetWidth||canvas.parentElement.offsetWidth||700,H=70;
  canvas.width=W*dpr; canvas.height=H*dpr; canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  const pad={l:54,r:8,t:6,b:14};
  const cw=W-pad.l-pad.r,ch=H-pad.t-pad.b;
  const vals=pts.map(p=>p.v), mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||1;
  const n=pts.length;
  ctx.fillStyle='#646d80';ctx.font='9px JetBrains Mono,monospace';ctx.textAlign='left';
  ctx.fillText(label,2,H/2+3);
  ctx.strokeStyle=color; ctx.lineWidth=1.5;
  ctx.beginPath();
  pts.forEach((p,i)=>{
    const x=pad.l+(i/(n-1))*cw, y=pad.t+ch*(1-(p.v-mn)/rng);
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  });
  ctx.stroke();
}

// ============================================================================
// OI CHART (sidebar sparkline)
// ============================================================================
function populateOiSelect(list){
  const sel=$('oiSymbolSelect');
  const withOi=list.filter(c=>c.oi>0).slice(0,200);
  sel.innerHTML=withOi.map(c=>`<option value="${c.key}">${c.symbol} · ${c.exchange}</option>`).join('')||`<option value="">Нет данных OI</option>`;
  if(state.oiSelectedKey&&withOi.some(c=>c.key===state.oiSelectedKey))sel.value=state.oiSelectedKey;
  else if(withOi.length){state.oiSelectedKey=withOi[0].key;sel.value=withOi[0].key;}
}
function renderOiChart(){
  const key=state.oiSelectedKey,svg=$('oiSvg'),title=$('oiChartTitle');
  if(!key||!state.history.has(key)){svg.innerHTML='';title.textContent='—';return;}
  const coin=state.coins.get(key);
  const hist=(state.history.get(key)||[]).filter(h=>h.oi>0);
  if(!coin||hist.length<2){
    svg.innerHTML=`<text x="124" y="48" text-anchor="middle" fill="#646d80" font-size="10">Копим историю...</text>`;
    title.textContent=coin?`${coin.symbol} · ${coin.exchange}`:'—';return;
  }
  const pts=hist.slice(-OI_HISTORY_MAX_POINTS);
  const vals=pts.map(p=>p.oi),mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||1;
  const w=248,h=90,pad=6;
  const coords=pts.map((p,i)=>[pad+(i/(pts.length-1))*(w-pad*2),h-pad-((p.oi-mn)/rng)*(h-pad*2)]);
  const pathD=coords.map((c,i)=>(i===0?`M${c[0]},${c[1]}`:`L${c[0]},${c[1]}`)).join(' ');
  const areaD=`${pathD} L${coords[coords.length-1][0]},${h-pad} L${coords[0][0]},${h-pad} Z`;
  const chg=vals[0]?((vals[vals.length-1]-vals[0])/vals[0])*100:0;
  const up=chg>=0,color=up?'#3ddc84':'#ff5d5d';
  svg.innerHTML=`<defs><linearGradient id="og" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".35"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${areaD}" fill="url(#og)"/><path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`;
  title.innerHTML=`<span>${coin.symbol} <span style="color:var(--text-2)">${coin.exchange}</span></span><span style="color:${color}">${up?'+':''}${chg.toFixed(2)}%</span>`;
}

// ============================================================================
// UI WIRING
// ============================================================================
function setBtnSpinning(on){ $('refreshBtn').classList.toggle('icon-spin',on); }

function wireControls(){
  renderExchangeToggle(); renderPresets(); renderTableHead();

  $('search').addEventListener('input',e=>{state.search=e.target.value;render();});
  $('minVolume').value=state.minVolume;
  $('minVolume').addEventListener('input',e=>{state.minVolume=+e.target.value||0;saveSettings();render();});
  $('minOI').value=state.minOI;
  $('minOI').addEventListener('input',e=>{state.minOI=+e.target.value||0;saveSettings();render();});
  $('sortTf').addEventListener('change',e=>{
    const tf=e.target.value;
    const idx=state.colTFs.indexOf(tf);
    state.sortColIdx=idx>=0?2+idx:3;
    state.sortDir=-1;saveSettings();render();renderTableHead();
  });
  $('refreshBtn').addEventListener('click',refreshAll);

  const sndBtn=$('soundBtn');
  sndBtn.classList.toggle('active',state.soundOn);
  sndBtn.onclick=()=>{state.soundOn=!state.soundOn;sndBtn.classList.toggle('active',state.soundOn);saveSettings();if(state.soundOn)playBeep(880,.1);};

  wireSwitch('toggleAlerts',state.alertsOn,v=>{state.alertsOn=v;saveSettings();});
  wireSwitch('toggleVoice', state.voiceOn, v=>{state.voiceOn=v;saveSettings();if(v)speakAlert({symbol:'GASP',pct:1,windowLabel:'тест'});});
  wireSwitch('toggleHotRows',state.hotRowsOn,v=>{state.hotRowsOn=v;saveSettings();render();});
  wireSwitch('toggleAuto',state.autoRefresh,v=>{state.autoRefresh=v;saveSettings();});

  $('spike1').value=state.spike1;$('lblSpike1').textContent=state.spike1.toFixed(1)+'%';
  $('spike1').addEventListener('input',e=>{state.spike1=+e.target.value;$('lblSpike1').textContent=state.spike1.toFixed(1)+'%';saveSettings();renderPresets();});
  $('spike5').value=state.spike5;$('lblSpike5').textContent=state.spike5.toFixed(1)+'%';
  $('spike5').addEventListener('input',e=>{state.spike5=+e.target.value;$('lblSpike5').textContent=state.spike5.toFixed(1)+'%';saveSettings();renderPresets();});

  $('oiSymbolSelect').addEventListener('change',e=>{state.oiSelectedKey=e.target.value;renderOiChart();});

  document.querySelectorAll('.mini-tab').forEach(tab=>{
    tab.onclick=()=>{
      document.querySelectorAll('.mini-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const tgt=tab.getAttribute('data-tab');
      $('panelAlerts').style.display=tgt==='alerts'?'block':'none';
      $('panelFavs').style.display=tgt==='favs'?'block':'none';
      $('panelOi').style.display=tgt==='oi'?'block':'none';
      if(tgt==='oi')renderOiChart();
    };
  });

  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});
}

function wireSwitch(id,init,cb){
  const el=$(id); el.classList.toggle('on',init);
  el.onclick=()=>{const v=!el.classList.contains('on');el.classList.toggle('on',v);cb(v);};
}

// ============================================================================
// CLOCK + loops
// ============================================================================
setInterval(()=>{clockEl.textContent=new Date().toLocaleTimeString('ru-RU');},1000);
clockEl.textContent=new Date().toLocaleTimeString('ru-RU');

function scheduleRefresh(){
  setInterval(()=>{if(state.autoRefresh&&state.selectedExchanges.has('binance'))refreshBinance();},2000);
  setInterval(()=>{if(state.autoRefresh&&state.selectedExchanges.has('bybit'))  refreshBybit();  },3000);
  setInterval(()=>{if(state.autoRefresh&&state.selectedExchanges.has('okx'))    refreshOKX();    },4000);
}

// Обновляем % и sparklines каждую секунду без полного rebuild DOM
setInterval(()=>{
  const now=Date.now();
  document.querySelectorAll('tbody tr[data-key]').forEach(tr=>{
    const key=tr.getAttribute('data-key'),coin=state.coins.get(key);
    if(!coin)return;
    const cells=tr.querySelectorAll('td');
    // cols: 0=sym,1=price,2..5=tf,6=vol,7=oi,8=spark
    state.colTFs.forEach((tf,i)=>{
      const tfDef=TF_OPTIONS.find(t=>t.key===tf);
      if(cells[2+i])cells[2+i].innerHTML=pctHtml(pctChange(key,now,tfDef.ms,coin.change24h));
    });
    if(cells[8])cells[8].innerHTML=sparklineSVG(key);
  });
},1000);

// ============================================================================
// MODAL CSS + TF picker CSS — вставляем динамически
// ============================================================================
const extraCSS=document.createElement('style');
extraCSS.textContent=`
.th-inner{display:flex;flex-direction:column;align-items:center;gap:2px;}
.th-sort-part{font-size:9px;color:var(--text-2);cursor:pointer;}
.tf-pick-btn{background:var(--bg-3);border:1px solid var(--line-strong);color:var(--acc);
  border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700;cursor:pointer;
  font-family:var(--font-mono);white-space:nowrap;}
.tf-pick-btn:hover{background:var(--acc-dim);}
.tf-picker{background:var(--bg-2);border:1px solid var(--line-strong);border-radius:8px;
  padding:4px;min-width:70px;box-shadow:0 8px 24px #00000090;}
.tf-opt{padding:6px 12px;border-radius:5px;font-family:var(--font-mono);font-size:12px;
  color:var(--text-1);cursor:pointer;}
.tf-opt:hover{background:var(--bg-3);color:var(--text-0);}
.tf-opt.active{color:var(--acc);background:var(--acc-dim);}
.spark-cell{cursor:pointer;padding:6px 8px;}
.spark-cell:hover{opacity:.8;}
.sym-name.chart-trigger{cursor:pointer;color:var(--acc);}
.sym-name.chart-trigger:hover{text-decoration:underline;}

/* Funding Rate */
.fund-cell{text-align:right;padding:8px 10px;}
.fund-rate{font-family:var(--font-mono);font-size:12px;font-weight:700;
  padding:2px 6px;border-radius:4px;}
.fund-pos{color:#ff5d5d;background:#ff5d5d18;}
.fund-neg{color:#3ddc84;background:#3ddc8418;}
.fund-zero{color:var(--text-2);}

/* Long/Short ratio */
.ls-cell{padding:6px 10px;min-width:90px;}
.ls-bar{height:4px;border-radius:2px;background:#ff5d5d55;overflow:hidden;margin-bottom:3px;}
.ls-long{height:100%;background:#3ddc84;border-radius:2px;transition:width .3s;}
.ls-nums{display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:10px;}
.ls-l{color:#3ddc84;font-weight:700;}
.ls-s{color:#ff5d5d;font-weight:700;}

/* Modal */
.modal-overlay{display:none;position:fixed;inset:0;background:#00000090;z-index:300;
  align-items:center;justify-content:center;padding:20px;}
.modal-box{background:var(--bg-1);border:1px solid var(--line-strong);border-radius:14px;
  width:100%;max-width:860px;max-height:90vh;overflow-y:auto;}
.modal-head{display:flex;align-items:center;gap:10px;padding:14px 16px;
  border-bottom:1px solid var(--line);}
.modal-title{font-family:var(--font-mono);font-weight:700;font-size:15px;flex:1;}
.modal-ivs{display:flex;gap:4px;}
.chart-iv-btn{background:var(--bg-2);border:1px solid var(--line-strong);color:var(--text-2);
  padding:4px 10px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;
  font-family:var(--font-mono);}
.chart-iv-btn.active{background:var(--acc-dim);border-color:var(--acc);color:var(--acc);}
.modal-close{background:none;border:none;color:var(--text-2);font-size:18px;cursor:pointer;padding:4px;}
.modal-close:hover{color:var(--text-0);}
.modal-body{padding:12px 16px;display:flex;flex-direction:column;gap:6px;}
.modal-body canvas{width:100%;border-radius:6px;display:block;}
.modal-status{text-align:center;color:var(--text-2);font-size:11px;padding:4px 0 10px;
  font-family:var(--font-mono);}
`;
document.head.appendChild(extraCSS);

// ============================================================================
// INIT
// ============================================================================
wireControls();
render();
refreshAll();
scheduleRefresh();

// Funding + L/S — сразу и потом каждые 30 секунд
setTimeout(refreshFundingAndLSR, 3000);
setInterval(refreshFundingAndLSR, 30000);

// Автосохранение буфера истории каждые 30 секунд
setInterval(saveHistory, HISTORY_SAVE_INTERVAL_MS);
