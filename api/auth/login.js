// /api/auth/login.js — step 1 of Google OAuth: redirect to Google's sign-in page.
const { randomToken } = require('../_auth.js');

module.exports = async (req, res) => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) { res.status(500).send('GOOGLE_OAUTH_CLIENT_ID not configured'); return; }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  const state = randomToken();
  const next = (typeof req.query?.next === 'string' && req.query.next.startsWith('/')) ? req.query.next : '/';
  res.setHeader('Set-Cookie',
    `ma_oauth_state=${state}|${encodeURIComponent(next)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
    hd: process.env.ALLOWED_EMAIL_DOMAIN || 'freighttiger.com'
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
};
