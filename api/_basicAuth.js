// /api/_basicAuth.js
// Optional HTTP Basic Auth gate for the whole dashboard. When
// BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are both set, every request must
// present matching credentials. Underscore prefix keeps Vercel from exposing
// this file as a route.
//
// This sits in front of Google session auth: the browser prompt locks the
// site; Google OAuth (when configured) still governs identity and admin role.

const crypto = require('crypto');

const REALM = 'Marketplace Analytics';

function isConfigured() {
  return Boolean(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD);
}

function timingSafeEqualString(a, b) {
  const aBuf = Buffer.from(String(a), 'utf8');
  const bBuf = Buffer.from(String(b), 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still run a compare so length leaks are harder to time.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseBasicCredentials(header) {
  if (!header || typeof header !== 'string') return null;
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

function credentialsMatch(user, pass) {
  const expectedUser = process.env.BASIC_AUTH_USER || '';
  const expectedPass = process.env.BASIC_AUTH_PASSWORD || '';
  return timingSafeEqualString(user, expectedUser) &&
    timingSafeEqualString(pass, expectedPass);
}

function challenge(res) {
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Authentication required');
}

// Allow cron / health probes through without the site password.
function isExempt(req, pathname) {
  if (pathname === '/api/health') return true;
  if (pathname === '/api/sync') {
    const header = req.headers?.authorization || '';
    const secret = process.env.CRON_SECRET;
    if (secret && header === `Bearer ${secret}`) return true;
  }
  return false;
}

// Returns true when the request may proceed. On failure, sends 401 and returns false.
function requireBasicAuth(req, res, pathname) {
  if (!isConfigured()) return true;
  if (isExempt(req, pathname)) return true;

  const creds = parseBasicCredentials(req.headers?.authorization);
  if (creds && credentialsMatch(creds.user, creds.pass)) return true;

  challenge(res);
  return false;
}

module.exports = {
  REALM,
  isConfigured,
  requireBasicAuth,
  parseBasicCredentials,
  credentialsMatch
};
