module.exports = async function handler(req, res) {
  const clientId = process.env.UPSTOX_CLIENT_ID;
  const clientSecret = process.env.UPSTOX_CLIENT_SECRET;
  const redirectUri = process.env.UPSTOX_REDIRECT_URI;

  const query = req.query || {};
  const code = query.code;
  const returnedState = query.state;
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").filter(Boolean).map(v => {
      const i = v.indexOf("=");
      return [v.slice(0, i).trim(), decodeURIComponent(v.slice(i + 1))];
    })
  );

  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).send("Upstox credentials are not configured in Vercel.");
    return;
  }

  if (!code) {
    res.status(400).send("Upstox authorization code missing.");
    return;
  }

  if (!returnedState || !cookies.upstox_oauth_state || returnedState !== cookies.upstox_oauth_state) {
    res.status(400).send("Invalid OAuth state. Please start the connection again.");
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
      "accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await tokenResponse.json();

  if (!tokenResponse.ok || !data.access_token) {
    res.status(502).send("Upstox token exchange failed. Check the API app credentials and redirect URI.");
    return;
  }

  res.setHeader("Set-Cookie", [
    "upstox_access_token=" + encodeURIComponent(data.access_token) +
      "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400",
    "upstox_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ]);

  res.writeHead(302, { Location: "/?upstox=connected" });
  res.end();
};
