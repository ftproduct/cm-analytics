// /api/auth/logout.js — clears the session cookie and returns to the app.
const { makeClearCookie } = require('../_auth.js');

module.exports = async (req, res) => {
  res.setHeader('Set-Cookie', makeClearCookie());
  res.writeHead(302, { Location: '/' });
  res.end();
};
