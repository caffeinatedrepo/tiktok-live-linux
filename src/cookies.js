import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SESSION_FILE, readJson, writeJson } from './store.js';

const STUDIO_COOKIES = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'TikTok LIVE Studio',
  'Network',
  'Cookies',
);
const STUDIO_LOCAL_STATE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'TikTok LIVE Studio',
  'Local State',
);

const IMPORTANT = [
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'sid_guard',
  'uid_tt',
  'uid_tt_ss',
  'ttwid',
  'msToken',
  'odin_tt',
  'store-idc',
  'tt-target-idc',
];

/* ------------------------------------------------------------------ */
/* cookie jar                                                          */
/* ------------------------------------------------------------------ */

export function parseCookieString(input) {
  const jar = {};
  for (const part of String(input).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

export function cookieHeader(jar) {
  return Object.entries(jar || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function loadSession() {
  // deployed instances have no Studio profile: accept the jar via environment
  const b64 = process.env.TTLIVE_SESSION_B64;
  if (b64) {
    try {
      const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      return parsed.cookies ? parsed : { cookies: parsed };
    } catch {
      /* fall through */
    }
  }
  const env = process.env.TTLIVE_SESSION_JSON;
  if (env) {
    try {
      const parsed = JSON.parse(env);
      return parsed.cookies ? parsed : { cookies: parsed };
    } catch {
      /* fall through */
    }
  }
  return readJson(SESSION_FILE, null);
}

export function saveSession(jar, source) {
  const payload = {
    savedAt: new Date().toISOString(),
    source,
    cookies: jar,
  };
  writeJson(SESSION_FILE, payload);
  return payload;
}

export function sessionJar() {
  const s = loadSession();
  if (!s?.cookies || !s.cookies.sessionid) {
    throw new Error(
      'not logged in. run `ttlive login --cookie "<cookie string>"` or `ttlive login --from-studio`',
    );
  }
  return s.cookies;
}

/* ------------------------------------------------------------------ */
/* Windows DPAPI (only used when importing from the Studio profile)    */
/* ------------------------------------------------------------------ */

function unprotectDpapi(buf) {
  const b64 = buf.toString('base64');
  const ps = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "Add-Type -AssemblyName System.Security; " +
      `$b=[Convert]::FromBase64String('${b64}'); ` +
      "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))",
  ];
  const r = spawnSync('powershell', ps, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) {
    throw new Error('DPAPI unprotect failed (are you the same Windows user that runs Studio?)');
  }
  return Buffer.from(r.stdout.trim(), 'base64');
}

function masterKey() {
  if (!fs.existsSync(STUDIO_LOCAL_STATE)) {
    throw new Error(`TikTok LIVE Studio profile not found at ${STUDIO_LOCAL_STATE}`);
  }
  const state = JSON.parse(fs.readFileSync(STUDIO_LOCAL_STATE, 'utf8'));
  const enc = state?.os_crypt?.encrypted_key;
  if (!enc) throw new Error('Studio profile has no os_crypt key (unsupported version)');
  const raw = Buffer.from(enc, 'base64');
  // strip the "DPAPI" prefix
  return unprotectDpapi(raw.subarray(5));
}

function decryptValue(enc, key, host = '') {
  if (!enc || enc.length < 4) return '';
  const prefix = enc.subarray(0, 3).toString('latin1');
  if (prefix === 'v20') {
    throw new Error(
      'Studio is using app-bound cookie encryption (v20); use `--cookie` instead',
    );
  }
  if (prefix !== 'v10') return enc.toString('utf8');
  const nonce = enc.subarray(3, 15);
  const payload = enc.subarray(15);
  const tag = payload.subarray(payload.length - 16);
  const data = payload.subarray(0, payload.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  let plain = Buffer.concat([decipher.update(data), decipher.final()]);
  // newer Chromium prepends sha256(host_key) to the plaintext
  if (host && plain.length > 32) {
    const expected = crypto.createHash('sha256').update(host).digest();
    if (plain.subarray(0, 32).equals(expected)) plain = plain.subarray(32);
  }
  return plain.toString('utf8');
}

const DUMP_PY = `
import json, os, shutil, sqlite3, sys, tempfile
src = sys.argv[1]
tmp = os.path.join(tempfile.gettempdir(), 'ttlive_cookies.db')
shutil.copy2(src, tmp)
con = sqlite3.connect(tmp)
rows = con.execute("select host_key, name, encrypted_value, value from cookies").fetchall()
out = []
for host, name, enc, val in rows:
    out.append({
        "host": host,
        "name": name,
        "enc": (enc or b"").hex(),
        "val": val or "",
    })
print(json.dumps(out))
`;

function dumpStudioCookies() {
  if (!fs.existsSync(STUDIO_COOKIES)) {
    throw new Error(`Studio cookie database not found at ${STUDIO_COOKIES}`);
  }
  const py = process.env.TTLIVE_PYTHON || 'python';
  const script = path.join(os.tmpdir(), 'ttlive_dump_cookies.py');
  fs.writeFileSync(script, DUMP_PY, 'utf8');
  const r = spawnSync(py, [script, STUDIO_COOKIES], { encoding: 'utf8', maxBuffer: 32 << 20 });
  if (r.error) throw new Error(`could not run ${py}: ${r.error.message}`);
  if (r.status !== 0) throw new Error('cookie dump failed: ' + (r.stderr || '').trim());
  return JSON.parse(r.stdout);
}

/**
 * Import the session TikTok LIVE Studio already has, straight out of its
 * Chromium profile. No manual key copying, no browser window.
 */
export function importFromStudio() {
  const rows = dumpStudioCookies();
  const key = masterKey();
  const jar = {};
  for (const row of rows) {
    if (!row.host.endsWith('tiktok.com') && !row.host.endsWith('tiktokv.com')) continue;
    let value = row.val;
    if (!value && row.enc) {
      try {
        value = decryptValue(Buffer.from(row.enc, 'hex'), key, row.host);
      } catch {
        continue;
      }
    }
    if (value) jar[row.name] = value;
  }
  if (!jar.sessionid) {
    throw new Error(
      'Studio is not logged in (no sessionid cookie). Open TikTok LIVE Studio, sign in, then retry.',
    );
  }
  const picked = {};
  for (const name of IMPORTANT) if (jar[name]) picked[name] = jar[name];
  // keep anything else that looks session related
  for (const [k, v] of Object.entries(jar)) {
    if (!(k in picked) && /^(sid_|uid_|session|store-|tt-|ttwid|odin_)/.test(k)) picked[k] = v;
  }
  return saveSession(picked, 'tiktok-live-studio');
}
