const crypto = require("crypto");

module.exports = async function handler(req, res) {
  const clientId = process.env.UPSTOX_CLIENT_ID;
  const clientSecret = process.env.UPSTOX_CLIENT_SECRET;
  const redirectUri = process.env.UPSTOX_REDIRECT_URI;

  const query = req.query || {};
  const code = query.code;
  const returnedState = query.state;

  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).send("Upstox credentials are not configured in Vercel.");
    return;
  }

  if (!code) {
    res.status(400).send("Upstox authorization code missing.");
    return;
  }

  // Verify the signed state without depending on a browser cookie.
  let stateValid = false;
  try {
    const parts = String(returnedState || "").split(".");
    if (parts.length === 2) {
      const [encoded, signature] = parts;
      const expected = crypto
        .createHmac("sha256", clientSecret)
        .update(encoded)
        .digest("base64url");

      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        stateValid = Number.isFinite(payload.ts) && Date.now() - payload.ts <= 10 * 60 * 1000;
      }
    }
  } catch (_) {
    stateValid = false;
  }

  if (!stateValid) {
    res.status(400).send("Invalid or expired OAuth state. Please start the Upstox connection again.");
    return;
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const tokenResponse = await fetch("https://api.upstox.com/v2/login/authorization/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await tokenResponse.json();

  if (!tokenResponse.ok || !data.access_token) {
    res.status(502).send("Upstox token exchange failed. Check the API app credentials and redirect URI.");
    return;
  }

  res.setHeader(
    "Set-Cookie",
    "upstox_access_token=" + encodeURIComponent(data.access_token) +
      "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400"
  );

  res.writeHead(302, { Location: "/?upstox=connected" });
  res.end();
};
