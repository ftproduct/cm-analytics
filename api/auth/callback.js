// /api/auth/callback.js — step 2 of Google OAuth: exchange the code, verify the
// domain, issue the session cookie.
const { makeSessionCookie, parseCookies } = require('../_auth.js');

function fail(res, message) {
  res.status(403).send(
    `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>` +
    `<body style="font:15px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem">` +
    `<h1 style="font-size:1.25rem">Sign-in failed</h1><p>${message}</p>` +
    `<p><a href="/api/auth/login">Try again</a></p></body>`
  );
}

module.exports = async (req, res) => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const secret = process.env.SESSION_SECRET;
  if (!clientId || !clientSecret || !secret) {
    return fail(res, 'OAuth is not fully configured on this deployment.');
  }

  const { code, state } = req.query || {};
  if (!code || !state) return fail(res, 'Missing authorization code.');

  const raw = parseCookies(req).ma_oauth_state || '';
  const [expectedState, encodedNext] = raw.split('|');
  if (!expectedState || expectedState !== state) {
    return fail(res, 'Sign-in state did not match. Start again from the app.');
  }
  const next = encodedNext ? decodeURIComponent(encodedNext) : '/';

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  let tokenJson;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${proto}://${host}/api/auth/callback`,
        grant_type: 'authorization_code'
      })
    });
    tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return fail(res, 'Google rejected the authorization code.');
  } catch {
    return fail(res, 'Could not reach Google to complete sign-in.');
  }

  // The id_token is signed by Google and arrives over TLS directly from the
  // token endpoint, so reading the payload is sufficient here.
  let email = null;
  try {
    const payload = JSON.parse(Buffer.from(tokenJson.id_token.split('.')[1], 'base64').toString('utf8'));
    email = String(payload.email || '').toLowerCase();
    if (payload.email_verified === false) return fail(res, 'That Google address is not verified.');
  } catch {
    return fail(res, 'Could not read the identity token returned by Google.');
  }

  const domain = (process.env.ALLOWED_EMAIL_DOMAIN || 'freighttiger.com').toLowerCase();
  if (!email.endsWith('@' + domain)) {
    return fail(res, `Sign in with your @${domain} address.`);
  }

  res.setHeader('Set-Cookie', [
    makeSessionCookie(email, secret),
    'ma_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  ]);
  res.writeHead(302, { Location: next.startsWith('/') ? next : '/' });
  res.end();
};
