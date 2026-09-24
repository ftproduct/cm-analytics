// /api/auth/me.js — current session and what this deployment is serving.
const { getSession, getRole, authConfigured, hasLiveData, devBypass } = require('../_auth.js');
const { isDemoMode } = require('../_databricks.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = getSession(req);
  const dev = !session && devBypass();
  res.status(200).json({
    authenticated: Boolean(session) || dev,
    devBypass: dev,
    email: session?.email || (dev ? 'dev@localhost' : null),
    role: dev ? 'admin' : getRole(session?.email),
    authConfigured: authConfigured(),
    liveData: hasLiveData(),
    demoMode: isDemoMode()
  });
};
