const BASE = "https://api.upstox.com";

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const i = part.indexOf("=");
    return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }));
}

function json(res, status, body) {
  res.status(status).setHeader("Cache-Control", "no-store");
  return res.json(body);
}

async function api(path, token, options = {}) {
  const r = await fetch(BASE + path, {
    ...options,
    headers: { Accept: "application/json", Authorization: "Bearer " + token, ...(options.headers || {}) }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.errors?.[0]?.message || data?.message || "Upstox " + r.status);
  return data;
}

async function liveQuotes(keys, token) {
  if (!keys.length) return {};
  const d = await api("/v3/market-quote/ltp?instrument_key=" + encodeURIComponent(keys.join(",")), token);
  return d?.data || {};
}
const clean = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

async function resolve(symbol, token) {
  const d = await api("/v2/instruments/search?query=" + encodeURIComponent(symbol) + "&exchanges=NSE&segments=EQ&page_number=1&records=20", token);
  const rows = Array.isArray(d?.data) ? d.data : [];
  const exact = rows.find(x => x.segment === "NSE_EQ" && clean(x.trading_symbol) === clean(symbol));
  const x = exact || rows.find(x => x.segment === "NSE_EQ");
  return x ? { symbol, instrument_key: x.instrument_key, trading_symbol: x.trading_symbol } : null;
}

function dayIST(offset) {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

async function candles(key, unit, interval, fromDays, token) {
  const to = dayIST(0);
  const from = dayIST(fromDays);
  const d = await api("/v3/historical-candle/" + encodeURIComponent(key) + "/" + unit + "/" + interval + "/" + to + "/" + from, token);
  return Array.isArray(d?.data?.candles) ? d.data.candles : [];
}

function timeframeConfig(tf) {
  const map = {
    "5m":  { unit: "minutes", interval: "5",  days: 30,   label: "5m"  },
    "15m": { unit: "minutes", interval: "15", days: 30,   label: "15m" },
    "1H":  { unit: "hours",   interval: "1",  days: 90,   label: "1H"  },
    "4H":  { unit: "hours",   interval: "4",  days: 90,   label: "4H"  },
    "1D":  { unit: "days",    interval: "1",  days: 365,  label: "1D"  },
    "1W":  { unit: "weeks",   interval: "1",  days: 1825, label: "1W"  }
  };
  const key = String(tf || "5m").trim();
  return map[key] || map[key.toLowerCase()] || map["5m"];
}

function norm(rows) {
  return rows.map(c => ({
    t: new Date(c[0]).getTime(),
    o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +(c[5] || 0)
  })).filter(x => x.c > 0).sort((a, b) => a.t - b.t);
}

function atr(rows, n = 14) {
  if (rows.length < n + 1) return null;
  const tr = rows.slice(1).map((x, i) => Math.max(x.h - x.l, Math.abs(x.h - rows[i].c), Math.abs(x.l - rows[i].c)));
  return tr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function analyze(symbol, daily, tfRows, livePrice = null, tfLabel = "5m") {
  if (daily.length < 21) throw new Error("Insufficient daily history");
  if (tfRows.length < 8) throw new Error("Insufficient " + tfLabel + " history");
  const d = daily.at(-1);
  const prior20 = daily.slice(-21, -1);
  const latest = tfRows.at(-1);
  const priorTf = tfRows.slice(-7, -1);
  const high20 = Math.max(...prior20.map(x => x.h));
  const low20 = Math.min(...prior20.map(x => x.l));
  const avgVol20 = prior20.reduce((s, x) => s + x.v, 0) / prior20.length;
  const highTf = Math.max(...priorTf.map(x => x.h));
  const avgVolTf = priorTf.length ? priorTf.reduce((s, x) => s + x.v, 0) / priorTf.length : 0;
  const a = atr(daily) || d.c * 0.02;
  let score = 50, reasons = [];
  if (latest.c > highTf) { score += 18; reasons.push(tfLabel + " breakout"); }
  else if (latest.c > Math.max(...tfRows.slice(-6, -1).map(x => x.h))) { score += 10; reasons.push(tfLabel + " strength"); }
  if (d.c > daily.at(-21).c) { score += 10; reasons.push("daily trend up"); }
  else if (d.c < daily.at(-21).c) { score -= 8; reasons.push("daily trend weak"); }
  if (d.c < low20) { score -= 25; reasons.push("20D breakdown"); }
  if (avgVol20 && d.v > avgVol20 * 1.5) { score += d.c >= d.o ? 8 : -8; reasons.push("daily volume expansion"); }
  const volRatio = avgVolTf && latest ? latest.v / avgVolTf : null;
  if (latest.c > latest.o) { score += 5; reasons.push(tfLabel + " bullish"); }
  else if (latest.c < latest.o) { score -= 3; reasons.push(tfLabel + " bearish"); }
  if (volRatio && volRatio >= 1.5) { score += 10; reasons.push(tfLabel + " volume surge"); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const setup = score >= 75 ? (latest.c > highTf ? "BREAKOUT" : "PULLBACK") : "WAIT";
  const signal = score >= 85 ? "STRONG" : score >= 75 ? "WATCH" : "NO TRADE";
  const entry = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : latest.c;
  const sl = Math.max(entry - 1.2 * a, entry * 0.97);
  const risk = Math.max(entry - sl, entry * 0.005);
  return {
    symbol, price: +entry.toFixed(2), score, signal, setup,
    entry: +entry.toFixed(2), sl: +sl.toFixed(2),
    t1: +(entry + risk * 1.5).toFixed(2),
    t2: +(entry + risk * 2.2).toFixed(2),
    t3: +(entry + risk * 3).toFixed(2),
    rr: "1:2.2",
    volume_ratio: volRatio ? +volRatio.toFixed(2) : null,
    timeframe: tfLabel,
    reason: reasons.join(" + ") || "No clean confirmation",
    data_source: "Upstox live LTP + V3 " + tfLabel + " candles",
    candle_time: latest ? new Date(latest.t).toISOString() : null
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
  const token =
    cookies(req).upstox_access_token ||
    process.env.UPSTOX_ANALYTICS_TOKEN;

  if (!token) {
    return json(res, 401, {
      ok: false,
      connected: false,
      error: "Upstox token missing. Add UPSTOX_ANALYTICS_TOKEN in Vercel, or connect via OAuth."
    });
  }

  try {
    const symbols = String(req.query?.symbols || "RELIANCE,SBIN,HDFCBANK,ICICIBANK,INFY,TCS,AXISBANK,TATASTEEL").split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
    const tf = String(req.query?.tf || "5m").trim();
    const cfg = timeframeConfig(tf);
    const resolved = (await Promise.all(symbols.map(s => resolve(s, token)))).filter(Boolean);
    let quoteMap = {};
    try {
      const rawQuotes = await liveQuotes(resolved.map(x => x.instrument_key), token);
      for (const [key, value] of Object.entries(rawQuotes || {})) {
        quoteMap[key] = value;
        if (value?.instrument_token) quoteMap[value.instrument_token] = value;
      }
    } catch (_) {}
    const rows = await Promise.all(resolved.map(async x => {
      try {
        const [daily, tfCandles] = await Promise.all([
          candles(x.instrument_key, "days", "1", 60, token),
          candles(x.instrument_key, cfg.unit, cfg.interval, cfg.days, token)
        ]);
        const q = quoteMap[x.instrument_key] || {};
        const livePrice = Number(q.last_price);
        return { ...x, ...analyze(x.symbol, norm(daily), norm(tfCandles), livePrice, cfg.label) };
      } catch (e) {
        return { ...x, score: 0, signal: "NO TRADE", setup: "WAIT", reason: e.message || "Data unavailable", data_source: "Upstox unavailable" };
      }
    }));
    rows.sort((a, b) => b.score - a.score);
    return json(res, 200, {
      ok: true, connected: true, provider: "Upstox",
      auth: cookies(req).upstox_access_token ? "oauth" : "analytics_token",
      engine: "LIVE-V3-LTP+" + cfg.label + "-SCANNER",
      timeframe: cfg.label,
      updated_at: new Date().toISOString(),
      rows
    });
  } catch (e) {
    return json(res, 502, { ok: false, connected: true, error: e.message || "Live scanner failed" });
  }
};
