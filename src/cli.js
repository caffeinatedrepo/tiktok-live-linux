import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  CAPTURE_FILE,
  CONFIG_FILE,
  PID_FILE,
  SESSION_FILE,
  readJson,
  writeJson,
} from './store.js';
import {
  cookieHeader,
  importFromStudio,
  loadSession,
  parseCookieString,
  saveSession,
  sessionJar,
} from './cookies.js';
import {
  continueRoom,
  createInfo,
  createRoom,
  defaultCreateBody,
  defaultQuery,
  discoverIds,
  extractPushUrl,
  extractRoomId,
  extractStreamId,
  formEncode,
  pingAnchor,
} from './api.js';
import { findFfmpeg, ffmpegHint, probeDuration, stream } from './encoder.js';
import { learn, sniff, studioExe } from './learn.js';
import {
  banner,
  bold,
  cyan,
  dim,
  err,
  green,
  hhmmss,
  magenta,
  maskKey,
  out,
  red,
  statusDone,
  yellow,
} from './ui.js';

/* ------------------------------------------------------------------ */
/* tiny arg parser                                                     */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key.startsWith('no-')) {
        flags[key.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

/* ------------------------------------------------------------------ */
/* help                                                                */
/* ------------------------------------------------------------------ */

function help() {
  banner();
  out('');
  out(bold('USAGE'));
  out('  ttlive <command> [options]');
  out('');
  out(bold('COMMANDS'));
  out(`  ${cyan('login')}     save your TikTok session (no stream keys involved)`);
  out(`  ${cyan('learn')}     one-time: watch Studio's own Go Live request ${dim('(Windows)')}`);
  out(`  ${cyan('sniff')}     dump the webcast requests Studio makes ${dim('(Windows)')}`);
  out(`  ${cyan('go')}        create a live room and push a video file to it`);
  out(`  ${cyan('push')}      push a video file to an RTMP url you already have`);
  out(`  ${cyan('end')}       mark the last room finished (stopping the stream ends it)`);
  out(`  ${cyan('stop')}      kill the stream ffmpeg started by this CLI`);
  out(`  ${cyan('doctor')}    show environment / session status`);
  out('');
  out(bold('EXAMPLES'));
  out('  ttlive login --from-studio');
  out('  ttlive login --cookie "sessionid=...; sid_tt=..."');
  out('  ttlive learn                       ' + dim('# then click Go Live in Studio once'));
  out('  ttlive go --title "Join me" --file clip.mp4');
  out('  ttlive go --title "Join me" --file clip.mp4 --duration 3600 --bitrate 3000k');
  out('  ttlive push --url rtmp://... --file clip.mp4');
  out('');
  out(bold('GO OPTIONS'));
  out('  --title <text>      live title                      (default: "Join me")');
  out('  --file <path>       video file to stream            (required)');
  out('  --duration <sec>    stop after N seconds            (default: until Ctrl+C)');
  out('  --bitrate <rate>    video bitrate                   (default: 2500k)');
  out('  --fps <n>           frame rate                      (default: 30)');
  out('  --no-loop           play the file once, then end');
  out('  --no-reconnect      do not restart ffmpeg if the connection drops');
  out('  --url-only          print the push url and exit (no ffmpeg)');
  out('  --dry-run           show the request without creating a room');
  out('  --print-request     dump the exact HTTP request (cookies redacted)');
  out('');
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdLogin(flags) {
  banner();
  if (flags.cookie && typeof flags.cookie === 'string') {
    const jar = parseCookieString(flags.cookie);
    if (!jar.sessionid) throw new Error('that cookie string has no sessionid');
    saveSession(jar, 'manual');
    out(green('saved session') + dim(`  ${SESSION_FILE}`));
    out(dim(`  ${Object.keys(jar).length} cookies`));
    return;
  }
  if (flags['from-studio']) {
    if (process.platform !== 'win32') {
      throw new Error(
        '--from-studio is Windows only. On Linux use: ttlive login --cookie "sessionid=...; sid_tt=..."',
      );
    }
    const s = importFromStudio();
    out(green('imported session from TikTok LIVE Studio'));
    out(dim(`  ${Object.keys(s.cookies).length} cookies -> ${SESSION_FILE}`));
    return;
  }
  out('usage:');
  out('  ttlive login --cookie "sessionid=...; sid_tt=..."');
  out('  ttlive login --from-studio          ' + dim('# Windows only'));
  out('');
  out(dim('tip: run `ttlive learn` while logged into Studio - it saves the session too.'));
}

async function cmdDoctor(flags) {
  banner();
  const rows = [];
  rows.push(['node', process.version]);
  const ff = findFfmpeg();
  rows.push(['ffmpeg', ff || red('not found')]);
  if (process.platform === 'win32') rows.push(['studio', studioExe() || red('not found')]);
  const sess = loadSession();
  rows.push([
    'session',
    sess?.cookies?.sessionid
      ? green(`ok (${sess.source}, ${new Date(sess.savedAt).toLocaleString()})`)
      : red('not logged in'),
  ]);
  const cap = readJson(CAPTURE_FILE, null);
  rows.push([
    'capture',
    cap ? green(`ok (${new Date(cap.capturedAt).toLocaleString()})`) : yellow('missing - run `ttlive learn`'),
  ]);
  const cfg = discoverIds();
  rows.push(['device id', cfg.deviceId || dim('(will be generated)')]);

  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out(`  ${dim(k.padEnd(w))}  ${v}`);

  if (flags.net) {
    out('');
    if (!sess?.cookies?.sessionid) {
      out(red('cannot probe: not logged in'));
      return;
    }
    out(dim('probing /webcast/room/create_info/ ...'));
    try {
      const info = await createInfo(sess.cookies, defaultQuery());
      const d = info?.data || {};
      out(green('session accepted by webcast'));
      const interesting = [
        ['region', d.active_region],
        ['live status', d.live_status],
        ['last room', d.last_room_id_str],
        ['title', d.title],
        ['cover', d.cover?.uri],
        ['group live', d.is_group_live_session],
      ].filter(([, v]) => v !== undefined);
      for (const [k, v] of interesting) out(`  ${dim(k)}  ${v}`);
      if (process.env.TTLIVE_DEBUG) out(JSON.stringify(info, null, 2));
    } catch (e) {
      out(red('probe failed: ') + e.message);
      if (e.payload) out(dim(JSON.stringify(e.payload).slice(0, 600)));
    }
  }
}

async function runStream({ file, url, flags, jar, roomId, streamId, seek = 0, loop }) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error(ffmpegHint());

  const duration = Number(flags.duration || 0);
  const bitrate = String(flags.bitrate || '2500k');
  const fps = Number(flags.fps || 30);
  const useLoop = loop === undefined ? flags.loop !== false : loop;

  out('');
  out(`  ${dim('room')}    ${roomId || dim('-')}`);
  out(`  ${dim('ingest')}  ${maskKey(url)}`);
  out(`  ${dim('file')}    ${path.basename(file)}`);
  out(`  ${dim('mode')}    ${useLoop ? 'loop' : 'once'} - ${bitrate} - ${fps}fps${duration ? ` - ${hhmmss(duration)} max` : ''}${seek > 0 ? ` - resume ${hhmmss(seek)}` : ''}`);
  out('');
  out(dim('  Ctrl+C to stop'));
  out('');

  const runner = stream({ ffmpeg, file, url, bitrate, fps, loop: useLoop, duration, seek });

  let heartbeat = null;
  if (jar && roomId) {
    const beat = () => pingAnchor(jar, { roomId, streamId, status: 2 }).catch(() => {});
    heartbeat = setInterval(beat, 5000);
    beat();
  }

  const onSigint = () => {
    statusDone(dim('  stopping...'));
    runner.stop();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);

  const result = await runner.done;

  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigint);
  if (heartbeat) clearInterval(heartbeat);

  // A closed connection at the end of a timed run (or after Ctrl+C) is expected:
  // ffmpeg reports a muxing error even though the stream itself was fine.
  const ok =
    result.code === 0 ||
    result.stopped ||
    (duration > 0 && result.uptime / 1000 >= duration - 2);

  if (ok) {
    out(green('  stream finished') + dim(`  ${hhmmss(result.uptime / 1000)}`));
  } else {
    out(red('  ffmpeg exited ') + dim(`code ${result.code}`));
    const tail = (result.stderr || '').trim().split(/\r?\n/).slice(-6).join('\n');
    if (tail) err(dim(tail));
  }
  return { ...result, ok };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask TikTok whether the room is still living (ping status=2). */
async function roomStillLiving(jar, roomId, streamId) {
  try {
    await pingAnchor(jar, { roomId, streamId, status: 2 });
    return true;
  } catch (e) {
    const code = e.payload?.status_code;
    if (code === 30003 || code === 4003150) return false;
    return true; // network hiccup: let ffmpeg retry
  }
}

async function cmdGo(flags) {
  banner();
  const file = flags.file;
  if (!file) throw new Error('--file is required');
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);

  const title = String(flags.title || 'Join me');
  const jar = sessionJar();

  if (!flags['url-only'] && !flags['dry-run'] && !findFfmpeg()) {
    throw new Error(ffmpegHint());
  }

  out('');
  out(dim('  reading room settings from TikTok...'));
  let info = null;
  try {
    info = await createInfo(jar, defaultQuery());
  } catch (e) {
    out(red('  create_info failed: ') + e.message);
    if (e.payload) out(dim(JSON.stringify(e.payload).slice(0, 600)));
    throw new Error('could not read room settings');
  }
  const d = info?.data || {};

  if (d.block_status) {
    out(yellow('  account reports a live block: ') + (d.block_prompt || d.block_status));
  }

  const capture = readJson(CAPTURE_FILE, null);
  const body =
    capture?.body && typeof capture.body === 'object'
      ? { ...capture.body, title }
      : defaultCreateBody({
          title,
          coverUri: d.cover?.uri || '',
          isGroupLive: !!d.is_group_live_session,
        });

  const query = {
    ...defaultQuery({ priority_region: d.active_region || '' }),
    ...(capture?.query || {}),
  };

  if (flags['print-request']) {
    out('');
    out(dim('POST https://webcast.tiktokv.com/webcast/room/create/'));
    out(dim('query  ') + JSON.stringify(query, null, 2));
    out(dim('body   ') + JSON.stringify(body, null, 2));
    out(dim('form   ') + formEncode(body));
    out(dim('cookie ') + '(redacted, ' + Object.keys(jar).length + ' cookies)');
  }

  if (flags['dry-run']) {
    out('');
    out(yellow('dry run') + dim(' - no room created'));
    return;
  }

  out('');
  out(dim('  creating live room...'));
  let res;
  try {
    res = await createRoom(jar, body, query);
  } catch (e) {
    // RoomStatusCode.holdLiving: a previous room is still alive on this account.
    if (e.payload?.status_code === 30005) {
      out(yellow('  a room is already live, resuming it...'));
      try {
        const cont = await continueRoom(jar, query);
        res = { status_code: 0, data: cont?.data?.room || cont?.data };
      } catch (e2) {
        out(red('  resume failed: ') + e2.message);
        throw new Error('room resume failed');
      }
    } else {
      out(red('  create failed: ') + e.message);
      if (e.payload) out(dim(JSON.stringify(e.payload).slice(0, 800)));
      out('');
      out(dim('  If this keeps failing, run `ttlive learn` once so the CLI can replay'));
      out(dim('  the exact request TikTok LIVE Studio sends.'));
      throw new Error('room create failed');
    }
  }

  const pushUrl = extractPushUrl(res);
  const roomId = extractRoomId(res);
  const streamId = extractStreamId(res);

  if (!pushUrl) {
    out(red('  no rtmp push url in the response'));
    if (process.env.TTLIVE_DEBUG) out(JSON.stringify(res, null, 2).slice(0, 4000));
    throw new Error('no push url');
  }

  const cfg = readJson(CONFIG_FILE, {});
  writeJson(CONFIG_FILE, { ...cfg, lastRoomId: roomId, lastStreamId: streamId });

  out(green('  live room created') + dim(`  ${roomId || ''}`));

  if (flags['url-only']) {
    out('');
    out(pushUrl);
    out('');
    out(dim('  the room closes when this stream is never started or is stopped'));
    return;
  }

  const mediaDuration = probeDuration(findFfmpeg() || '', file);
  let seek = 0;
  let played = 0;
  let attempt = 0;
  for (;;) {
    // after a drop, resume from where the stream stopped instead of replaying from 0
    const useLoop = seek > 0 ? false : flags.loop !== false;
    const result = await runStream({
      file,
      url: pushUrl,
      flags,
      jar,
      roomId,
      streamId,
      seek,
      loop: useLoop,
    });
    played += result.played || 0;

    if (result.stopped) break;

    // a resumed run reached the end of the file: next cycle starts at 0 again
    if (seek > 0 && result.code === 0) {
      seek = 0;
      continue;
    }

    if (result.ok) break;
    if (flags.reconnect === false) break;
    if (!roomId || !jar) break;
    if (attempt >= 10) {
      out(red('  giving up after 10 reconnects'));
      break;
    }
    if (!(await roomStillLiving(jar, roomId, streamId))) {
      out(yellow('  room is no longer live - not reconnecting'));
      break;
    }
    if (result.uptime > 60_000) attempt = 0;
    attempt++;
    seek = mediaDuration > 0 ? played % mediaDuration : 0;
    out(yellow(`  reconnecting (${attempt}/10) at ${hhmmss(seek)} in 2s...`));
    await sleep(2000);
  }

  if (roomId) {
    out(dim('  stopping the stream closes the room...'));
    try {
      await pingAnchor(jar, { roomId, streamId, status: 4 });
    } catch {
      /* best effort */
    }
    out(green('  stream stopped'));
  }
}

async function cmdPush(flags) {
  banner();
  const file = flags.file;
  const url = flags.url;
  if (!file) throw new Error('--file is required');
  if (!url) throw new Error('--url is required');
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  await runStream({ file, url: String(url), flags });
}

async function cmdEnd(flags) {
  banner();
  const jar = sessionJar();
  const cfg = readJson(CONFIG_FILE, {});
  const roomId = flags.room || cfg.lastRoomId;
  const streamId = cfg.lastStreamId || '';
  if (!roomId) throw new Error('no room id known (use --room <id>)');
  try {
    await pingAnchor(jar, { roomId: String(roomId), streamId, status: 4 });
    out(green('room marked finished') + dim(`  ${roomId}`));
  } catch (e) {
    out(red('end failed: ') + e.message);
  }
  out(dim('  Studio ends lives by stopping the RTMP push; Ctrl+C the stream does that.'));
}

async function cmdStop() {
  banner();
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  } catch {
    out(yellow('no running stream found') + dim('  (no pid file)'));
    return;
  }
  if (!pid) {
    out(yellow('no running stream found'));
    return;
  }

  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (r.status === 0) out(green('stream stopped') + dim(`  pid ${pid}`));
    else out(red('could not stop pid ') + pid + dim('  ' + (r.stderr || '').trim()));
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      out(green('stream stopped') + dim(`  pid ${pid}`));
    } catch (e) {
      out(red('could not stop pid ') + pid + dim('  ' + e.message));
    }
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

async function cmdSniff(flags) {
  banner();
  if (process.platform !== 'win32') {
    throw new Error('sniff attaches to TikTok LIVE Studio, which is Windows only');
  }
  return sniff({
    port: Number(flags.port || 9223),
    seconds: Number(flags.seconds || 30),
    filter: String(flags.filter || 'webcast.tiktok'),
  });
}

async function cmdLearn(flags) {
  banner();
  if (process.platform !== 'win32') {
    throw new Error('learn attaches to TikTok LIVE Studio, which is Windows only');
  }
  const capture = await learn({ port: Number(flags.port || 9223) });
  if (flags.file) {
    out('');
    out(dim('  starting stream with the captured template...'));
    await cmdGo({ ...flags, 'print-request': false });
  }
  return capture;
}

/* ------------------------------------------------------------------ */

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags } = parseArgs(rest);

  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      help();
      return;
    case 'login':
      return cmdLogin(flags);
    case 'learn':
      return cmdLearn(flags);
    case 'sniff':
      return cmdSniff(flags);
    case 'go':
    case 'live':
    case 'stream':
      return cmdGo(flags);
    case 'push':
      return cmdPush(flags);
    case 'end':
      return cmdEnd(flags);
    case 'stop':
      return cmdStop();
    case 'doctor':
      return cmdDoctor(flags);
    case 'version':
    case '-v':
      out('ttlive 0.1.0');
      return;
    default:
      help();
      throw new Error(`unknown command: ${cmd}`);
  }
}
