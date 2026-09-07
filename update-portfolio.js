const fs = require('fs');

const CORE = {SPY:18.0,EWJ:5.0,ACWI:1.2,VGT:18.0,XLV:18.0,INFR:5.4,CNYA:4.4,CAPVX:30.0};
const CUSTOM = {SPY:18.0,FJP:5.0,ACWI:1.24,VGT:18.0,GRID:1.8,FTXL:1.8,CIBR:1.8,MRVL:1.8,CLS:1.8,XLV:9.0,CNYA:4.36,INFR:5.40,CAPVX:30.0};
const YAHOO_TICKERS = ["SPY","EWJ","ACWI","VGT","XLV","CNYA","FJP","GRID","FTXL","CIBR","MRVL","CLS","AGG","INFR"];
const LONG_START = "2025-07-01";
const SHORT_START = "2026-07-17";
const PRICES_PATH = "data/prices.json";
const INDEX_PATH = "index.html";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function isoFromUnix(t){ return new Date(t*1000).toISOString().slice(0,10); }

async function fetchYahoo(ticker){
  const now = Math.floor(Date.now()/1000);
  const period1 = now - 30*86400; // 30-day lookback window for overlap/safety
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${now}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart.result[0];
  const ts = r.timestamp || [];
  const closeArr = r.indicators.quote[0].close;
  const adjArr = r.indicators.adjclose ? r.indicators.adjclose[0].adjclose : null;
  const out = {};
  for (let i=0;i<ts.length;i++){
    const c = (adjArr && adjArr[i]!=null) ? adjArr[i] : closeArr[i];
    if (c==null) continue;
    out[isoFromUnix(ts[i])] = Math.round(c*10000)/10000;
  }
  return out;
}

async function fetchCapvxNav(){
  const url = "https://www.acprivatemarkets.com/funds/capvx/";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`CAPVX page: HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<li class="fund-stats__item[^"]*">\s*<div class="fund-stats__item-header[^"]*">\$([\d.]+)<\/div>\s*<div class="fund-stats__item-body">\s*<div class="fund-stats__item-info[^"]*">[\s\S]*?NAV[\s\S]*?<\/div>\s*<div class="fund-stats__item-date">\s*As of (\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) throw new Error("CAPVX: NAV pattern not found on official fund page");
  const nav = parseFloat(m[1]);
  let year = parseInt(m[4],10); if (year < 100) year += 2000;
  const month = String(m[2]).padStart(2,'0');
  const day = String(m[3]).padStart(2,'0');
  const date = `${year}-${month}-${day}`;
  return { date, nav };
}

function indexedPortfolio(weights, dates, prices, startDate){
  const startIdx = dates.indexOf(startDate);
  if (startIdx < 0) return [];
  const base = {}; for (const tk in weights) base[tk] = prices[tk][dates[startIdx]];
  const out = [];
  for (let i=startIdx;i<dates.length;i++){
    const d = dates[i]; let val = 0;
    for (const tk in weights) val += (weights[tk]/100) * (prices[tk][d]/base[tk]);
    out.push({d, v: Math.round(val*1e6)/1e6});
  }
  return out;
}
function indexedSingle(dates, prices, ticker, startDate){
  const startIdx = dates.indexOf(startDate);
  if (startIdx < 0) return [];
  const base = prices[ticker][dates[startIdx]];
  return dates.slice(startIdx).map(d => ({d, v: Math.round((prices[ticker][d]/base)*1e6)/1e6}));
}
function indexed6040(dates, prices, startDate){
  const startIdx = dates.indexOf(startDate);
  if (startIdx < 0) return [];
  const baseSpy = prices.SPY[dates[startIdx]], baseAgg = prices.AGG[dates[startIdx]];
  return dates.slice(startIdx).map(d => ({d, v: Math.round((0.6*(prices.SPY[d]/baseSpy) + 0.4*(prices.AGG[d]/baseAgg))*1e6)/1e6}));
}

const RISK_TICKERS_ORDER = ["SPY","VGT","XLV","EWJ","ACWI","CNYA","INFR","CAPVX","FJP","GRID","FTXL","CIBR","MRVL","CLS","AGG"];

function dailyReturns(v){ const out=[]; for(let i=1;i<v.length;i++) out.push(v[i]/v[i-1]-1); return out; }
function annualizedVol(v){
  const r = dailyReturns(v); const n = r.length;
  const mean = r.reduce((a,b)=>a+b,0)/n;
  const variance = r.reduce((a,b)=>a+(b-mean)*(b-mean),0)/(n-1);
  return Math.sqrt(variance) * Math.sqrt(252);
}
function maxDrawdown(v){
  let peak = v[0], worst = 0;
  for (const x of v){ if (x > peak) peak = x; const dd = x/peak - 1; if (dd < worst) worst = dd; }
  return worst;
}
function annualizedReturn(v){ const n = v.length-1; return Math.pow(v[v.length-1], 252/n) - 1; }
function downsideDev(v){
  const r = dailyReturns(v); const n = r.length;
  const ssq = r.reduce((a,x)=>a+Math.min(x,0)**2,0);
  return Math.sqrt(ssq/n) * Math.sqrt(252);
}
function betaAlphaTeIr(v, benchV, portAnnRet, benchAnnRet){
  const rp = dailyReturns(v), rb = dailyReturns(benchV);
  const n = rp.length;
  const mp = rp.reduce((a,b)=>a+b,0)/n, mb = rb.reduce((a,b)=>a+b,0)/n;
  let cov=0, varB=0;
  for (let i=0;i<n;i++){ cov += (rp[i]-mp)*(rb[i]-mb); varB += (rb[i]-mb)**2; }
  const beta = varB > 0 ? cov/varB : null;
  const alpha = beta !== null ? portAnnRet - beta*benchAnnRet : null;
  const active = rp.map((x,i)=>x-rb[i]);
  const ma = active.reduce((a,b)=>a+b,0)/n;
  const varA = active.reduce((a,b)=>a+(b-ma)**2,0)/(n-1);
  const te = Math.sqrt(varA) * Math.sqrt(252);
  const ir = te > 0 ? (portAnnRet-benchAnnRet)/te : null;
  return { beta, alpha, te, ir };
}
function upDownCapture(v, benchV){
  const rp = dailyReturns(v), rb = dailyReturns(benchV);
  let portUp=1, benchUp=1, portDown=1, benchDown=1;
  for (let i=0;i<rb.length;i++){
    if (rb[i] > 0){ portUp *= (1+rp[i]); benchUp *= (1+rb[i]); }
    else if (rb[i] < 0){ portDown *= (1+rp[i]); benchDown *= (1+rb[i]); }
  }
  portUp -= 1; benchUp -= 1; portDown -= 1; benchDown -= 1;
  return {
    up: benchUp !== 0 ? portUp/benchUp : null,
    down: benchDown !== 0 ? portDown/benchDown : null
  };
}
function pearson(a, b){
  const n = a.length;
  const ma = a.reduce((x,y)=>x+y,0)/n, mb = b.reduce((x,y)=>x+y,0)/n;
  let cov=0, va=0, vb=0;
  for (let i=0;i<n;i++){ cov += (a[i]-ma)*(b[i]-mb); va += (a[i]-ma)**2; vb += (b[i]-mb)**2; }
  const denom = Math.sqrt(va*vb);
  return denom === 0 ? null : cov/denom;
}
function computeRisk(dates, prices){
  const startIdx = dates.indexOf(LONG_START);
  const windowDates = dates.slice(startIdx);

  function idxPortfolio(weights){
    const base = {}; for (const tk in weights) base[tk] = prices[tk][windowDates[0]];
    return windowDates.map(d => { let v=0; for (const tk in weights) v += (weights[tk]/100)*(prices[tk][d]/base[tk]); return v; });
  }
  function idxSingle(tk){ const base = prices[tk][windowDates[0]]; return windowDates.map(d => prices[tk][d]/base); }
  function idx6040(){
    const baseSpy = prices.SPY[windowDates[0]], baseAgg = prices.AGG[windowDates[0]];
    return windowDates.map(d => 0.6*(prices.SPY[d]/baseSpy) + 0.4*(prices.AGG[d]/baseAgg));
  }

  const series = { core: idxPortfolio(CORE), custom: idxPortfolio(CUSTOM), spx: idxSingle("SPY"), sixtyforty: idx6040() };
  const volatility = {}, maxDD = {}, annRet = {}, sharpe = {}, sortino = {};
  for (const k in series){
    volatility[k] = Math.round(annualizedVol(series[k])*1e4)/1e4;
    maxDD[k] = Math.round(maxDrawdown(series[k])*1e4)/1e4;
    annRet[k] = Math.round(annualizedReturn(series[k])*1e4)/1e4;
    sharpe[k] = Math.round((annRet[k]/volatility[k])*1e3)/1e3;
    const dd = downsideDev(series[k]);
    sortino[k] = dd > 0 ? Math.round((annRet[k]/dd)*1e3)/1e3 : null;
  }

  const beta = {}, alpha = {}, trackingError = {}, informationRatio = {}, upCapture = {}, downCapture = {};
  for (const k in series){
    const { beta: b, alpha: a, te, ir } = betaAlphaTeIr(series[k], series.spx, annRet[k], annRet.spx);
    beta[k] = b !== null ? Math.round(b*1e3)/1e3 : null;
    alpha[k] = a !== null ? Math.round(a*1e4)/1e4 : null;
    trackingError[k] = Math.round(te*1e4)/1e4;
    informationRatio[k] = ir !== null ? Math.round(ir*1e3)/1e3 : null;
    const { up, down } = upDownCapture(series[k], series.spx);
    upCapture[k] = up !== null ? Math.round(up*1e4)/1e4 : null;
    downCapture[k] = down !== null ? Math.round(down*1e4)/1e4 : null;
  }

  const returns = {};
  for (const tk of RISK_TICKERS_ORDER) returns[tk] = dailyReturns(windowDates.map(d => prices[tk][d]));
  const matrix = RISK_TICKERS_ORDER.map(t1 => RISK_TICKERS_ORDER.map(t2 => {
    const c = pearson(returns[t1], returns[t2]);
    return c === null ? null : Math.round(c*1000)/1000;
  }));

  function attribution(weights, startDate){
    const sIdx = dates.indexOf(startDate);
    const wd = dates.slice(sIdx);
    const base = {}; for (const tk in weights) base[tk] = prices[tk][wd[0]];
    const end = wd[wd.length-1];
    const rows = Object.keys(weights).map(tk => {
      const idxEnd = prices[tk][end] / base[tk];
      return { ticker: tk, weight: weights[tk], ownReturn: Math.round((idxEnd-1)*1e4)/1e4, contribution: Math.round((weights[tk]/100)*(idxEnd-1)*1e4)/1e4 };
    });
    rows.sort((a,b) => b.contribution - a.contribution);
    return rows;
  }
  const attributionData = {
    long: { core: attribution(CORE, LONG_START), custom: attribution(CUSTOM, LONG_START) },
    short: { core: attribution(CORE, SHORT_START), custom: attribution(CUSTOM, SHORT_START) },
  };

  return {
    period: { start: LONG_START, end: windowDates[windowDates.length-1] },
    volatility, maxDrawdown: maxDD, annualizedReturn: annRet, sharpe, sortino,
    beta, alpha, trackingError, informationRatio, upCapture, downCapture,
    correlation: { tickers: RISK_TICKERS_ORDER, matrix },
    attribution: attributionData
  };
}

async function main(){
  const seed = JSON.parse(fs.readFileSync(PRICES_PATH, "utf8"));
  let dates = seed.dates.slice();
  const prices = seed.prices;
  const dateSet = new Set(dates);

  let newDatesFound = false;

  // 1. Standard Yahoo tickers: pull recent window, merge new dates, using SPY's calendar as master
  const fetched = {};
  for (const tk of YAHOO_TICKERS){
    try {
      fetched[tk] = await fetchYahoo(tk);
    } catch (e) {
      console.error(`WARN: could not fetch ${tk}: ${e.message}`);
      fetched[tk] = {};
    }
  }

  const newSpyDates = Object.keys(fetched.SPY || {}).filter(d => !dateSet.has(d)).sort();
  if (newSpyDates.length){
    newDatesFound = true;
    dates = dates.concat(newSpyDates).sort();
  }

  // 2. Fill every ticker's price for every (old+new) date, forward-filling gaps
  for (const tk of YAHOO_TICKERS){
    if (!prices[tk]) prices[tk] = {};
    let last = null;
    for (const d of dates){
      if (fetched[tk] && fetched[tk][d] != null) prices[tk][d] = fetched[tk][d];
      if (prices[tk][d] != null) last = prices[tk][d];
      else if (last != null) prices[tk][d] = last; // forward-fill (illiquid names like INFR)
    }
  }

  // 3. CAPVX: real NAV from the official fund page + linear interpolation for any gap
  //    since the last known real/interpolated point.
  let capvxNav = null;
  try { capvxNav = await fetchCapvxNav(); }
  catch (e) { console.error(`WARN: could not fetch CAPVX NAV: ${e.message}`); }

  if (!prices.CAPVX) prices.CAPVX = {};
  const knownCapvxDates = Object.keys(prices.CAPVX).sort();
  const lastKnownDate = knownCapvxDates[knownCapvxDates.length-1];
  const lastKnownPrice = prices.CAPVX[lastKnownDate];

  if (capvxNav){
    if (!dates.includes(capvxNav.date)) { dates.push(capvxNav.date); dates.sort(); newDatesFound = true; }
    // interpolate any dates between lastKnownDate and capvxNav.date that don't have a CAPVX price yet
    const gapDates = dates.filter(d => d > lastKnownDate && d <= capvxNav.date && prices.CAPVX[d] == null);
    const d0 = new Date(lastKnownDate), d1 = new Date(capvxNav.date);
    const totalDays = (d1-d0) / 86400000;
    for (const d of gapDates){
      if (d === capvxNav.date){ prices.CAPVX[d] = capvxNav.nav; continue; }
      const frac = totalDays > 0 ? (new Date(d)-d0)/86400000/totalDays : 1;
      prices.CAPVX[d] = Math.round((lastKnownPrice + (capvxNav.nav-lastKnownPrice)*frac)*10000)/10000;
    }
  }
  // forward-fill CAPVX for any remaining dates (e.g. new SPY dates before/without a fresh CAPVX read)
  {
    let last = null;
    for (const d of dates){
      if (prices.CAPVX[d] != null) last = prices.CAPVX[d];
      else if (last != null) prices.CAPVX[d] = last;
    }
  }

  if (!newDatesFound){
    console.log("Sin cambios: no hay sesion nueva disponible.");
    return;
  }

  const out = {
    long: {
      start: LONG_START,
      core: indexedPortfolio(CORE, dates, prices, LONG_START),
      custom: indexedPortfolio(CUSTOM, dates, prices, LONG_START),
      spx: indexedSingle(dates, prices, "SPY", LONG_START),
      sixtyforty: indexed6040(dates, prices, LONG_START),
    },
    short: {
      start: SHORT_START,
      core: indexedPortfolio(CORE, dates, prices, SHORT_START),
      custom: indexedPortfolio(CUSTOM, dates, prices, SHORT_START),
      spx: indexedSingle(dates, prices, "SPY", SHORT_START),
      sixtyforty: indexed6040(dates, prices, SHORT_START),
    }
  };

  const risk = computeRisk(dates, prices);

  fs.writeFileSync(PRICES_PATH, JSON.stringify({dates, prices, capvxAnchors: seed.capvxAnchors}));

  let html = fs.readFileSync(INDEX_PATH, "utf8");
  const reData = /(<script id="portfolio-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const reRisk = /(<script id="risk-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  if (!reData.test(html)) throw new Error("portfolio-data script tag not found in index.html");
  if (!reRisk.test(html)) throw new Error("risk-data script tag not found in index.html");
  html = html.replace(reData, (m, a, b, c) => a + JSON.stringify(out) + c);
  html = html.replace(reRisk, (m, a, b, c) => a + JSON.stringify(risk) + c);
  fs.writeFileSync(INDEX_PATH, html);

  console.log("Agregado hasta: " + dates[dates.length-1] + (capvxNav ? ` (CAPVX NAV ${capvxNav.date} @ ${capvxNav.nav})` : " (CAPVX: sin lectura nueva, interpolado)"));
}

main().catch(err => { console.error(err); process.exit(1); });
