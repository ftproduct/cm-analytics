// /api/auth/me.js — current session and what this deployment is serving.
const { resolveIdentity, authConfigured, hasLiveData } = require('../_auth.js');
const { isDemoMode } = require('../_databricks.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = resolveIdentity(req);
  res.status(200).json({
    authenticated: id.authenticated,
    devBypass: Boolean(id.dev),
    basicAuth: Boolean(id.basic),
    email: id.email,
    role: id.role,
    authConfigured: authConfigured(),
    liveData: hasLiveData(),
    demoMode: isDemoMode()
  });
};
