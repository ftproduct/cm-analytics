// /api/_auth.js
// Session auth for the marketplace analytics app. Underscore prefix keeps Vercel
// from exposing this file as a route.
//
// Session cookie:  ma_session=<base64url(payload)>.<base64url(hmac-sha256)>
// payload = { email, exp }
//
// Access model
//   viewer     -- any signed-in address in ALLOWED_EMAIL_DOMAIN. Read-only.
//   admin      -- address listed in ADMIN_EMAILS. Additionally may run the
//                 ad-hoc SQL console and browse the Databricks catalog.
//
// Gating rule (important): the app is open in demo mode so it can be deployed
// and reviewed immediately, but the moment Databricks credentials are present
// -- i.e. the moment real business data is reachable -- a signed-in session is
// mandatory. If OAuth has not been configured by then, requests are refused
// rather than served.

const crypto = require('crypto');
const basicAuth = require('./_basicAuth.js');

const SESSION_COOKIE = 'ma_session';
const SESSION_TTL_SECONDS = 30 * 24 * 3600;

function b64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function sign(payload, secret) {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const mac = crypto.createHmac('sha256', secret).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const provided = b64urlDecode(sig);
  if (expected.length !== provided.length) return null;
  if (!crypto.timingSafeEqual(expected, provided)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function makeSessionCookie(email, secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return `${SESSION_COOKIE}=${sign({ email, exp }, secret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}
function makeClearCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function getSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  return verify(parseCookies(req)[SESSION_COOKIE], secret);
}

// Local development escape hatch. Vercel always sets VERCEL=1 in its runtime,
// so this can never be switched on in a deployment however the env is set --
// it exists so `npm run dev` can exercise the live and cached paths without
// standing up Google OAuth first.
function devBypass() {
  if (process.env.VERCEL) return false;
  return String(process.env.MA_DEV_ALLOW_ANONYMOUS || '').toLowerCase() === 'true';
}

// The site counts as protected under either scheme. Basic auth is enforced at
// the edge by middleware.js, but the API functions verify the header
// themselves too: middleware does not run under `npm run dev`, and an API that
// depends on someone else having checked is one routing change from being open.
function oauthConfigured() {
  return Boolean(process.env.SESSION_SECRET && process.env.GOOGLE_OAUTH_CLIENT_ID);
}

function authConfigured() {
  return oauthConfigured() || basicAuth.isConfigured();
}

// Verifies the Basic credentials on this request. Returns a principal when they
// match, null otherwise. Everyone holding the shared password is the same
// person as far as the app is concerned -- for per-person identity, configure
// Google OAuth instead.
function basicPrincipal(req) {
  if (!basicAuth.isConfigured()) return null;
  const creds = basicAuth.parseBasicCredentials(req.headers?.authorization);
  if (!creds) return null;
  if (!basicAuth.credentialsMatch(creds.user, creds.pass)) return null;
  return { email: null, basic: true, user: creds.user };
}

// True when real warehouse data is reachable from this deployment.
function hasLiveData() {
  return require('./_databricks.js').isConfigured();
}

function getAdmins() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isAdmin(email) {
  return Boolean(email) && getAdmins().includes(String(email).toLowerCase());
}

function getRole(email) {
  if (!email) return 'anonymous';
  return isAdmin(email) ? 'admin' : 'viewer';
}

// Guard for read endpoints. Returns the session (or a synthetic demo session)
// on pass; sends the error response and returns null on fail.
function requireAccess(req, res) {
  const session = getSession(req);
  if (session) return session;
  if (devBypass()) return { email: 'dev@localhost', dev: true };

  const basic = basicPrincipal(req);
  if (basic) return basic;

  if (hasLiveData()) {
    if (!authConfigured()) {
      res.status(500).json({
        error: 'This deployment is connected to Databricks but has no sign-in configured. ' +
               'Set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD, or SESSION_SECRET and ' +
               'GOOGLE_OAUTH_CLIENT_ID, before serving live data.'
      });
      return null;
    }
    res.status(401).json({ error: 'Not authenticated', login: '/api/auth/login' });
    return null;
  }

  if (authConfigured()) {
    res.status(401).json({ error: 'Not authenticated', login: '/api/auth/login' });
    return null;
  }

  // Demo mode, no auth configured -- open, and clearly labelled as such in the UI.
  return { email: null, demo: true };
}

// Guard for privileged endpoints (SQL console, catalog browser). Admin only,
// and never open -- even in demo mode.
function requireAdmin(req, res) {
  if (devBypass()) return { email: 'dev@localhost', dev: true };

  // With only a shared password configured there is nobody to distinguish, so
  // holding it is admin. Configure Google OAuth and ADMIN_EMAILS when Sync and
  // the SQL console should be limited to named people.
  if (!oauthConfigured()) {
    const basic = basicPrincipal(req);
    if (basic) return basic;
  }

  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated', login: '/api/auth/login' });
    return null;
  }
  if (!isAdmin(session.email)) {
    res.status(403).json({ error: 'Admin access required. Add this address to ADMIN_EMAILS.' });
    return null;
  }
  return session;
}

// The effective identity for this request, whichever scheme authenticated it.
// One place answers this so /api/auth/me -- which decides whether the UI enables
// Sync and the SQL console -- cannot disagree with requireAdmin, which enforces
// them. A greyed-out Sync button and a 401 from the sync endpoint are the same
// bug seen from two sides.
function resolveIdentity(req) {
  if (devBypass()) return { authenticated: true, email: 'dev@localhost', role: 'admin', dev: true };

  const session = getSession(req);
  if (session) return { authenticated: true, email: session.email, role: getRole(session.email) };

  // Same rule as requireAdmin: with only a shared password configured there is
  // nobody to distinguish, so holding it is admin. Once OAuth is configured,
  // named sessions decide who is admin and the shared password drops to viewer.
  const basic = basicPrincipal(req);
  if (basic) {
    return { authenticated: true, email: null, role: oauthConfigured() ? 'viewer' : 'admin', basic: true };
  }

  return { authenticated: false, email: null, role: 'anonymous' };
}

function randomToken(n = 24) {
  return b64url(crypto.randomBytes(n));
}

module.exports = {
  SESSION_COOKIE, SESSION_TTL_SECONDS,
  makeSessionCookie, makeClearCookie, parseCookies,
  getSession, requireAccess, requireAdmin, resolveIdentity,
  authConfigured, oauthConfigured, hasLiveData, isAdmin, getRole, randomToken, devBypass
};
