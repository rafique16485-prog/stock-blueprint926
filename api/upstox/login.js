module.exports = async function handler(req, res) {
  const clientId = process.env.UPSTOX_CLIENT_ID;
  const redirectUri = process.env.UPSTOX_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    res.status(500).json({
      ok: false,
      error: "UPSTOX_CLIENT_ID or UPSTOX_REDIRECT_URI is not configured in Vercel."
    });
    return;
  }

  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  res.setHeader(
    "Set-Cookie",
    "upstox_oauth_state=" + encodeURIComponent(state) +
      "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600"
  );

  const url = new URL("https://api.upstox.com/v2/login/authorization/dialog");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  res.writeHead(302, { Location: url.toString() });
  res.end();
};
