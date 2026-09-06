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

function analyze(symbol, daily, five, livePrice = null) {
  if (daily.length < 21) throw new Error("Insufficient daily history");
  const d = daily.at(-1);
  const prior20 = daily.slice(-21, -1);
  const prior5 = five.slice(-7, -1);
  const high20 = Math.max(...prior20.map(x => x.h));
  const low20 = Math.min(...prior20.map(x => x.l));
  const avgVol20 = prior20.reduce((s, x) => s + x.v, 0) / prior20.length;
  const latest5 = five.at(-1);
  const avgVol5 = prior5.length ? prior5.reduce((s, x) => s + x.v, 0) / prior5.length : 0;
  const a = atr(daily) || d.c * 0.02;
  let score = 50, reasons = [];
  if (d.c > high20) { score += 25; reasons.push("20D breakout"); }
  else if (d.c > Math.max(...daily.slice(-6, -1).map(x => x.h))) { score += 12; reasons.push("short-term strength"); }
  if (d.c > daily.at(-21).c) { score += 10; reasons.push("daily trend up"); }
  if (d.c < low20) { score -= 30; reasons.push("20D breakdown"); }
  if (avgVol20 && d.v > avgVol20 * 1.5) { score += d.c >= d.o ? 10 : -10; reasons.push("daily volume expansion"); }
  const volRatio = avgVol5 && latest5 ? latest5.v / avgVol5 : null;
  if (latest5?.c > latest5?.o) { score += 5; reasons.push("5m bullish"); }
  if (volRatio && volRatio >= 1.5) { score += 10; reasons.push("5m volume surge"); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const setup = score >= 75 ? (d.c > high20 ? "BREAKOUT" : "PULLBACK") : "WAIT";
  const signal = score >= 85 ? "STRONG" : score >= 75 ? "WATCH" : "NO TRADE";
  const entry = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : d.c;
  const sl = Math.max(entry - 1.2 * a, entry * 0.97);
  const risk = Math.max(entry - sl, entry * 0.005);
  return {
    symbol, price: +d.c.toFixed(2), score, signal, setup,
    entry: +entry.toFixed(2), sl: +sl.toFixed(2),
    t1: +(entry + risk * 1.5).toFixed(2),
    t2: +(entry + risk * 2.2).toFixed(2),
    t3: +(entry + risk * 3).toFixed(2),
    rr: "1:2.2",
    volume_ratio: volRatio ? +volRatio.toFixed(2) : null,
    reason: reasons.join(" + ") || "No clean confirmation",
    data_source: "Upstox live session + V3 candles",
    candle_time: latest5 ? new Date(latest5.t).toISOString() : null
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
  const token = cookies(req).upstox_access_token;
  if (!token) return json(res, 401, { ok: false, connected: false, error: "Connect Upstox first." });

  try {
    const symbols = String(req.query?.symbols || "RELIANCE,SBIN,HDFCBANK,ICICIBANK,INFY,TCS,AXISBANK,TATASTEEL").split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
    const resolved = (await Promise.all(symbols.map(s => resolve(s, token)))).filter(Boolean);
    let quoteMap = {};
    try { quoteMap = await liveQuotes(resolved.map(x => x.instrument_key), token); } catch (_) {}
    const rows = await Promise.all(resolved.map(async x => {
      try {
        const [daily, five] = await Promise.all([
          candles(x.instrument_key, "days", "1", 60, token),
          candles(x.instrument_key, "minutes", "5", 1, token)
        ]);
        const q = quoteMap[x.instrument_key] || {};
        const livePrice = Number(q.last_price);
        return { ...x, ...analyze(x.symbol, norm(daily), norm(five), livePrice) };
      } catch (e) {
        return { ...x, score: 0, signal: "NO TRADE", setup: "WAIT", reason: e.message || "Data unavailable", data_source: "Upstox unavailable" };
      }
    }));
    rows.sort((a, b) => b.score - a.score);
    return json(res, 200, {
      ok: true, connected: true, provider: "Upstox",
      engine: "LIVE-V2-LTP+5M-SWING",
      updated_at: new Date().toISOString(),
      rows
    });
  } catch (e) {
    return json(res, 502, { ok: false, connected: true, error: e.message || "Live scanner failed" });
  }
};
