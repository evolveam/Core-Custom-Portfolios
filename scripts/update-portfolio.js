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

  fs.writeFileSync(PRICES_PATH, JSON.stringify({dates, prices, capvxAnchors: seed.capvxAnchors}));

  let html = fs.readFileSync(INDEX_PATH, "utf8");
  const re = /(<script id="portfolio-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  if (!re.test(html)) throw new Error("portfolio-data script tag not found in index.html");
  html = html.replace(re, (m, a, b, c) => a + JSON.stringify(out) + c);
  fs.writeFileSync(INDEX_PATH, html);

  console.log("Agregado hasta: " + dates[dates.length-1] + (capvxNav ? ` (CAPVX NAV ${capvxNav.date} @ ${capvxNav.nav})` : " (CAPVX: sin lectura nueva, interpolado)"));
}

main().catch(err => { console.error(err); process.exit(1); });
