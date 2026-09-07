module.exports = async function handler(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").filter(Boolean).map(v => {
      const i = v.indexOf("=");
      return [v.slice(0, i).trim(), decodeURIComponent(v.slice(i + 1))];
    })
  );

  const token = cookies.upstox_access_token;
  if (!token) {
    res.status(401).json({ ok: false, connected: false, error: "Upstox is not connected." });
    return;
  }

  const instrumentKey = (req.query && req.query.instrument_key) || "NSE_INDEX|Nifty 50,NSE_INDEX|Nifty Bank,NSE_INDEX|India VIX,GLOBAL_INDEX|SGX NIFTY";
  const url = new URL("https://api.upstox.com/v3/market-quote/ltp");
  url.searchParams.set("instrument_key", instrumentKey);

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Authorization": "Bearer " + token
    }
  });

  const data = await response.json();

  if (!response.ok) {
    res.status(response.status).json({ ok: false, connected: true, error: data });
    return;
  }

  res.status(200).json({ ok: true, connected: true, provider: "Upstox", data: data.data });
};
