// Vercel Edge Middleware — HTTP Basic Auth for the whole deployment (static
// pages and API). Enabled only when BASIC_AUTH_USER and BASIC_AUTH_PASSWORD
// are both set in the project environment.
//
// Exempt: /api/health (probes) and /api/sync with Authorization: Bearer
// <CRON_SECRET> (schedulers).

export const config = {
  matcher: '/:path*'
};

const REALM = 'Marketplace Analytics';

function configured() {
  return Boolean(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD);
}

function timingSafeEqualString(a, b) {
  const aa = String(a);
  const bb = String(b);
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return out === 0;
}

function parseBasic(header) {
  if (!header) return null;
  const match = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}"`,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
}

export default function middleware(request) {
  if (!configured()) return;

  const { pathname } = new URL(request.url);
  const auth = request.headers.get('authorization') || '';

  if (pathname === '/api/health') return;

  if (pathname === '/api/sync') {
    const secret = process.env.CRON_SECRET;
    if (secret && auth === `Bearer ${secret}`) return;
  }

  const creds = parseBasic(auth);
  const userOk = creds && timingSafeEqualString(creds.user, process.env.BASIC_AUTH_USER);
  const passOk = creds && timingSafeEqualString(creds.pass, process.env.BASIC_AUTH_PASSWORD);
  if (userOk && passOk) return;

  return unauthorized();
}
