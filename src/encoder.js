import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BIN_DIR, PID_FILE, STREAM_LOG } from './store.js';
import { dim, hhmmss, status } from './ui.js';

function findInWinGet() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.toLowerCase().includes('ffmpeg')) continue;
      const root = path.join(base, dir);
      for (const entry of fs.readdirSync(root, { recursive: true })) {
        const s = String(entry);
        if (s.toLowerCase().endsWith('ffmpeg.exe')) return path.join(root, s);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function findFfmpeg() {
  const candidates = [
    process.env.TTLIVE_FFMPEG,
    path.join(BIN_DIR, 'ffmpeg.exe'),
    path.join(BIN_DIR, 'ffmpeg'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  const winget = findInWinGet();
  if (winget) return winget;

  const finder = process.platform === 'win32' ? 'where' : 'which';
  const which = spawnSync(finder, ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

/** Length of the media file in seconds (0 if ffprobe is unavailable). */
export function probeDuration(ffmpeg, file) {
  const probe = path.join(
    path.dirname(ffmpeg),
    process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
  );
  if (!fs.existsSync(probe)) return 0;
  const r = spawnSync(
    probe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8', windowsHide: true },
  );
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function ffmpegHint() {
  return [
    'ffmpeg not found.',
    '',
    'Install it one of these ways:',
    '  1) winget install --id Gyan.FFmpeg -e',
    '  2) drop ffmpeg.exe into  ' + BIN_DIR,
    '  3) set TTLIVE_FFMPEG=C:\\path\\to\\ffmpeg.exe',
  ].join('\n');
}

export function buildArgs({ file, url, bitrate = '2500k', fps = 30, loop = true, duration = 0, audioBitrate = '128k', seek = 0 }) {
  const level = process.env.TTLIVE_DEBUG ? 'warning' : 'error';
  const args = ['-hide_banner', '-loglevel', level, '-progress', 'pipe:1', '-nostats', '-fflags', '+genpts'];
  if (loop) args.push('-stream_loop', '-1');
  if (seek > 0) args.push('-ss', String(Math.floor(seek)));
  args.push('-re', '-i', file);
  if (duration > 0) args.push('-t', String(Math.floor(duration)));
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-bufsize', String(parseInt(bitrate, 10) * 2) + 'k',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-g', String(fps * 2),
    '-keyint_min', String(fps * 2),
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-af', 'aresample=async=1:first_pts=0',
    '-b:a', audioBitrate,
    '-ar', '44100',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'flv',
    url,
  );
  return args;
}

/**
 * Start pushing a file to an RTMP endpoint. Resolves when ffmpeg exits.
 */
export function stream({ ffmpeg, file, url, bitrate, fps, loop, duration, seek = 0 }) {
  const args = buildArgs({ file, url, bitrate, fps, loop, duration, seek });
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  // lets `ttlive stop` find and end this stream from another shell
  try {
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  } catch {
    /* ignore */
  }

  // persistent stderr so a failed stream can be diagnosed after the fact
  const log = fs.createWriteStream(STREAM_LOG, { flags: 'a' });
  const safeUrl = String(url).replace(/(wsSecret|wsTime|sign|pri)=[^&]+/gi, '$1=***');
  log.write(
    `\n=== ${new Date().toISOString()} pid ${child.pid} loop=${loop} duration=${duration}\n` +
      `file ${file}\nurl  ${safeUrl}\n`,
  );

  const clearPid = () => {
    try {
      if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(child.pid)) fs.unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    try {
      log.end();
    } catch {
      /* ignore */
    }
  };
  child.on('exit', clearPid);
  child.on('error', clearPid);

  let started = Date.now();
  let speed = '';
  let lastErr = '';
  let lastOut = 0;
  let stopping = false;

  const onData = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const [k, v] = line.split('=');
      if (k === 'out_time_us' && v) {
        const secs = Number(v) / 1e6;
        if (Number.isFinite(secs) && secs > lastOut) lastOut = secs;
        status(dim(`> live  ${hhmmss(secs)}${speed ? `  ${speed}` : ''}  `));
      } else if (k === 'speed' && v) {
        speed = v;
      }
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', (d) => {
    lastErr = (lastErr + d.toString()).slice(-4000);
    log.write(d);
  });

  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: -1, error: e, stopped: stopping }));
    child.on('exit', (code, signal) =>
      resolve({ code, signal, stopped: stopping, stderr: lastErr, uptime: Date.now() - started, played: lastOut }),
    );
  });

  return {
    child,
    done,
    get stopped() {
      return stopping;
    },
    stop() {
      if (stopping) return;
      stopping = true;
      // 'q' on stdin lets ffmpeg flush the FLV trailer; kill as a fallback.
      try {
        child.stdin.write('q');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000).unref();
    },
  };
}
