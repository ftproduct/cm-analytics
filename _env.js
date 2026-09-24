// scripts/_env.js
// Loads a local .env into process.env for the dev server and the CLI scripts.
//
// Deliberately tiny and dependency-free, and deliberately local-only: on Vercel
// the environment comes from the project settings, and .env is gitignored so a
// token never reaches the repository.
//
// Existing environment variables always win, so `DATABRICKS_TOKEN=... npm run dev`
// overrides the file.

const fs = require('fs');
const path = require('path');

function load(file) {
  const target = file || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(target)) return { loaded: false, keys: [] };

  const keys = [];
  for (const raw of fs.readFileSync(target, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;   // real env wins
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, so tokens with = or # survive.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    keys.push(key);
  }
  return { loaded: true, keys };
}

module.exports = { load };
