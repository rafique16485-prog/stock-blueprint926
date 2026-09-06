const crypto = require("crypto");

module.exports = async function handler(req, res) {
  const clientId = process.env.UPSTOX_CLIENT_ID;
  const clientSecret = process.env.UPSTOX_CLIENT_SECRET;
  const redirectUri = process.env.UPSTOX_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).json({
      ok: false,
      error: "UPSTOX_CLIENT_ID, UPSTOX_CLIENT_SECRET or UPSTOX_REDIRECT_URI is not configured in Vercel."
    });
    return;
  }

  // Signed, short-lived OAuth state avoids relying on a browser cookie surviving
  // the external Upstox redirect while still protecting against CSRF.
  const payload = JSON.stringify({
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex")
  });
  const encoded = Buffer.from(payload).toString("base64url");
  const signature = crypto
    .createHmac("sha256", clientSecret)
    .update(encoded)
    .digest("base64url");
  const state = encoded + "." + signature;

  const url = new URL("https://api.upstox.com/v2/login/authorization/dialog");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  res.writeHead(302, { Location: url.toString() });
  res.end();
};
