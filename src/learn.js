import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CAPTURE_FILE, writeJson } from './store.js';
import { saveSession } from './cookies.js';
import { extractPushUrl, extractRoomId } from './api.js';
import { cyan, dim, green, out, statusDone, yellow } from './ui.js';

const STUDIO_ROOT = 'C:\\Program Files\\TikTok LIVE Studio';

export function studioExe() {
  if (process.env.TTLIVE_STUDIO_EXE) return process.env.TTLIVE_STUDIO_EXE;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(STUDIO_ROOT, 'launcher_config.json'), 'utf8'));
    const exe = path.join(STUDIO_ROOT, cfg.cur_path, 'TikTok LIVE Studio.exe');
    if (fs.existsSync(exe)) return exe;
  } catch {
    /* fall through */
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(e));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 15000).unref();
    });
  }

  on(fn) {
    this.handlers.push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Launch TikTok LIVE Studio with remote debugging, then watch for the exact
 * `/webcast/room/create/` call it makes when the user clicks "Go Live".
 *
 * This is the "learn once" step: afterwards the CLI can replay the request
 * (with your cookies) without the GUI.
 */
export async function learn({ port = 9223, timeoutMs = 15 * 60 * 1000 } = {}) {
  const exe = studioExe();
  if (!exe) throw new Error('TikTok LIVE Studio not found (set TTLIVE_STUDIO_EXE)');

  let child = null;
  try {
    await getJson(`http://127.0.0.1:${port}/json/version`);
  } catch {
    out(dim('starting TikTok LIVE Studio with remote debugging...'));
    child = spawn(exe, [`--remote-debugging-port=${port}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  }

  let targets = [];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      targets = (await getJson(`http://127.0.0.1:${port}/json/list`)).filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl,
      );
      if (targets.length) break;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  if (!targets.length) {
    throw new Error(
      'could not attach to Studio (debug port never came up).\n' +
        '  Studio blocks auto-launch on this machine (it needs elevation).\n' +
        '  Start it yourself in PowerShell, then run this command again:\n' +
        `    & "${exe}" --remote-debugging-port=${port}`,
    );
  }

  out(green('attached') + dim(`  ${targets.length} page target(s)`));
  out('');
  out(bold_line('Now in the Studio window: click  Go Live  once.'));
  out(dim('The CLI is only watching. It will save the request and your session, then you can cancel the live.'));
  out('');

  const sessions = new Map();
  let finished = null;
  const finish = (value) => {
    if (!finished) finished = value;
  };

  const attach = async (target) => {
    if (sessions.has(target.id)) return;
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    sessions.set(target.id, cdp);
    try {
      await cdp.ready;
      await cdp.send('Network.enable');
      await cdp.send('Page.enable');
    } catch {
      return;
    }

    const inflight = new Map();

    cdp.on(async (msg) => {
      const { method, params } = msg;

      if (method === 'Network.requestWillBeSent') {
        const url = params.request?.url || '';
        if (!url.includes('/webcast/room/create/')) return;
        inflight.set(params.requestId, {
          url,
          method: params.request.method,
          headers: params.request.headers,
          postData: params.request.postData,
          targetId: target.id,
        });
        statusDone(dim('  captured create request, waiting for response...'));
      }

      if (method === 'Network.loadingFinished' && inflight.has(params.requestId)) {
        const req = inflight.get(params.requestId);
        inflight.delete(params.requestId);
        try {
          const body = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
          req.responseRaw = body.body;
        } catch {
          /* body may be gone */
        }
        finish(req);
      }

      if (method === 'Network.responseReceived') {
        const url = params.response?.url || '';
        if (url.includes('/webcast/room/create/')) {
          const req = [...inflight.values()].find((r) => r.url === url);
          if (req) req.status = params.response.status;
        }
      }
    });
  };

  const poll = setInterval(async () => {
    try {
      const list = (await getJson(`http://127.0.0.1:${port}/json/list`)).filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl,
      );
      for (const t of list) attach(t);
    } catch {
      /* ignore */
    }
  }, 2000);

  await Promise.all(targets.map(attach));

  const start = Date.now();
  while (!finished && Date.now() - start < timeoutMs) {
    await sleep(400);
  }
  clearInterval(poll);

  // grab cookies while we are attached - this also logs the CLI in
  let cookieJar = null;
  for (const cdp of sessions.values()) {
    try {
      const all = await cdp.send('Network.getAllCookies');
      const jar = {};
      for (const c of all.cookies || []) {
        if (!/tiktok\.com$/.test(c.domain.replace(/^\./, ''))) continue;
        if (c.value) jar[c.name] = c.value;
      }
      if (jar.sessionid) {
        cookieJar = jar;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  for (const cdp of sessions.values()) cdp.close();

  if (cookieJar) {
    saveSession(cookieJar, 'studio-cdp');
    out(green('saved session') + dim('  ~/.ttlive/session.json'));
  }

  if (!finished) throw new Error('timed out waiting for a Go Live click');

  const req = finished;
  let body = req.postData;
  if (typeof body === 'string') {
    const ct = String(req.headers?.['content-type'] || req.headers?.['Content-Type'] || '');
    if (ct.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(body));
    } else {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep raw string */
      }
    }
  }

  let response = null;
  try {
    response = JSON.parse(req.responseRaw);
  } catch {
    /* ignore */
  }

  const capture = {
    capturedAt: new Date().toISOString(),
    url: req.url,
    method: req.method,
    query: Object.fromEntries(new URL(req.url).searchParams),
    body,
    headers: {
      'content-type': req.headers?.['content-type'] || req.headers?.['Content-Type'],
      'user-agent': req.headers?.['user-agent'] || req.headers?.['User-Agent'],
    },
    response: response
      ? {
          statusCode: response.status_code,
          roomId: extractRoomId(response),
          pushUrl: extractPushUrl(response),
        }
      : null,
  };

  writeJson(CAPTURE_FILE, capture);
  out(green('saved request template') + dim('  ~/.ttlive/capture.json'));
  if (capture.response?.pushUrl) {
    out(dim('  push url seen: ') + cyan(capture.response.pushUrl.replace(/\/[^/]+$/, '/***')));
  }
  out('');
  out(bold_line('Next:'));
  out('  ' + yellow('ttlive go --title "Join me" --file clip.mp4'));
  return capture;
}

function bold_line(s) {
  return '\x1b[1m' + s + '\x1b[0m';
}

/**
 * Attach to Studio and dump every webcast request it makes. Useful for
 * discovering the exact query/body shape of an endpoint.
 */
export async function sniff({ port = 9223, seconds = 30, filter = 'webcast.tiktok.com' } = {}) {
  const exe = studioExe();
  if (!exe) throw new Error('TikTok LIVE Studio not found (set TTLIVE_STUDIO_EXE)');

  try {
    await getJson(`http://127.0.0.1:${port}/json/version`);
  } catch {
    out(dim('starting TikTok LIVE Studio with remote debugging...'));
    const child = spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }

  const deadline = Date.now() + 60000;
  let targets = [];
  while (Date.now() < deadline) {
    try {
      targets = (await getJson(`http://127.0.0.1:${port}/json/list`)).filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl,
      );
      if (targets.length) break;
    } catch {
      /* not up */
    }
    await sleep(1000);
  }
  if (!targets.length) {
    throw new Error(
      'could not attach to Studio (debug port never came up).\n' +
        '  Studio blocks auto-launch on this machine (it needs elevation).\n' +
        '  Start it yourself in PowerShell, then run this command again:\n' +
        `    & "${exe}" --remote-debugging-port=${port}`,
    );
  }

  out(green('attached') + dim(`  capturing for ${seconds}s, filter: ${filter}`));
  out(dim('  now use the Studio UI (open the Go Live page, click around)'));
  out('');

  const entries = [];
  const sessions = new Map();

  const attach = async (target) => {
    if (sessions.has(target.id)) return;
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    sessions.set(target.id, cdp);
    try {
      await cdp.ready;
      await cdp.send('Network.enable');
    } catch {
      return;
    }
    cdp.on((msg) => {
      if (msg.method !== 'Network.requestWillBeSent') return;
      const r = msg.params.request;
      if (!r?.url?.includes(filter)) return;
      const u = new URL(r.url);
      const entry = {
        at: new Date().toISOString(),
        method: r.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        body: r.postData || null,
        headers: r.headers,
      };
      entries.push(entry);
      out(cyan(r.method) + ' ' + u.pathname + dim('  (' + (r.postData ? r.postData.length + 'b body' : 'no body') + ')'));
    });
  };

  await Promise.all(targets.map(attach));

  const poll = setInterval(async () => {
    try {
      const list = (await getJson(`http://127.0.0.1:${port}/json/list`)).filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl,
      );
      for (const t of list) attach(t);
    } catch {
      /* ignore */
    }
  }, 2000);

  await sleep(seconds * 1000);
  clearInterval(poll);
  for (const s of sessions.values()) s.close();

  writeJson(CAPTURE_FILE.replace('capture.json', 'sniff.json'), entries);
  out('');
  out(green(`${entries.length} request(s)`) + dim('  -> ~/.ttlive/sniff.json'));
  return entries;
}

