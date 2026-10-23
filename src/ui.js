const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');
export const magenta = wrap('35');

export function out(line = '') {
  process.stdout.write(line + '\n');
}

export function err(line = '') {
  process.stderr.write(line + '\n');
}

/** Single-line, overwritable status row on stderr. */
export function status(line) {
  if (!process.stderr.isTTY) return;
  process.stderr.write('\r\x1b[2K' + line);
}

export function statusDone(line = '') {
  if (!process.stderr.isTTY) return;
  process.stderr.write('\r\x1b[2K' + line + '\n');
}

export function banner() {
  out(bold(magenta('ttlive')) + dim('  TikTok LIVE for Linux  v0.1.0'));
}

export function hhmmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function maskKey(url) {
  // hide the stream key: last path segment plus the auth query params
  try {
    const u = new URL(String(url));
    for (const k of ['wsSecret', 'wsTime', 'pri', 'sign', 'token', 'key']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, '***');
    }
    u.pathname = u.pathname.replace(/(\/[^/]+)$/, (m) => {
      if (m.length <= 8) return m;
      return `/${m.slice(1, 4)}${'*'.repeat(Math.min(10, m.length - 6))}${m.slice(-3)}`;
    });
    return u.toString();
  } catch {
    return String(url);
  }
}
