import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, readJson, writeJson } from './store.js';
import { cookieHeader } from './cookies.js';

/**
 * Recovered from TikTok LIVE Studio 1.37.4:
 *   static/js/52518.fd7a5fd2.js  - axios service baseURL
 *   static/js/52518.fd7a5fd2.js  - CommonRequestParamsInterceptor
 *   static/js/async/86496.*.js   - RoomService.goLive / createRoom
 *   static/js/async/86496.*.js   - module 504972: POST form-urlencoded
 */
export const WEBCAST = 'https://webcast.tiktokv.com';
export const REFERER = 'https://livecenter.tiktok.com/';
export const APP_VERSION = '1.37.4';
/** webcast_sdk_version = Number(packageVersion.split('.').join('')) */
export const SDK_VERSION = APP_VERSION.split('.').join('');

const LOG_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'TikTok LIVE Studio',
  'logs',
);

/**
 * device_id / install_id are stable per install and are embedded all over
 * Studio's own logs, so we can recover them without touching the GUI.
 */
export function discoverIds() {
  const cfg = readJson(CONFIG_FILE, {});

  // containers have no Studio logs; the real IDs must come from the environment
  const envDevice = process.env.TTLIVE_DEVICE_ID;
  const envInstall = process.env.TTLIVE_INSTALL_ID;
  if (envDevice && envInstall) {
    if (cfg.deviceId !== envDevice || cfg.installId !== envInstall) {
      const next = { ...cfg, deviceId: envDevice, installId: envInstall };
      writeJson(CONFIG_FILE, next);
      return next;
    }
    return cfg;
  }

  let deviceId = null;
  let installId = null;
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(LOG_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      deviceId ||= src.match(/device_id:\s*'(\d{10,})'/)?.[1] || null;
      installId ||= src.match(/install_id:\s*'(\d{10,})'/)?.[1] || null;
      if (deviceId && installId) break;
    }
  } catch {
    /* ignore */
  }

  // logs are authoritative: the app's own IDs are the ones TikTok knows.
  if (deviceId && installId && (cfg.deviceId !== deviceId || cfg.installId !== installId)) {
    const next = { ...cfg, deviceId, installId };
    writeJson(CONFIG_FILE, next);
    return next;
  }
  if (cfg.deviceId && cfg.installId) return cfg;

  const next = {
    ...cfg,
    deviceId: deviceId || String(Math.floor(7.1e18 + Math.random() * 8e17)),
    installId: installId || String(Math.floor(7.1e18 + Math.random() * 8e17)),
  };
  writeJson(CONFIG_FILE, next);
  return next;
}

/**
 * Exact query set the Studio renderer attaches to every webcast call.
 * Screen/browser fields are harmless; they are read from the current host.
 */
export function defaultQuery(extra = {}) {
  const { deviceId, installId } = discoverIds();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
  return {
    aid: '8311',
    app_name: 'tiktok_live_studio',
    device_id: deviceId,
    install_id: installId,
    channel: 'studio',
    version_code: APP_VERSION,
    device_platform: 'windows',
    timezone_name: tz,
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'en-US',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version:
      `5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `TikTokLIVEStudio/${APP_VERSION} Chrome/136.0.7103.59 Electron/36.4.0 Safari/537.36`,
    language: 'en',
    app_language: 'en',
    webcast_language: 'en',
    priority_region: '',
    webcast_sdk_version: SDK_VERSION,
    live_mode: '6',
    ...extra,
  };
}

/**
 * Body of POST /webcast/room/create/, rebuilt from [getCreateRoomParams].
 * Studio posts it as application/x-www-form-urlencoded (qs.stringify).
 */
export function defaultCreateBody({ title, coverUri = '', isGroupLive = false }) {
  return {
    title: title || '',
    live_studio: 1,
    gen_replay: true,
    chat_auth: 1, // AuthSwitch.on
    age_restricted: 0,
    cover_uri: coverUri || '',
    close_room_when_close_stream: false,
    hashtag_id: 0,
    game_tag_id: 0,
    screenshot_cover_status: 2, // ScreenshotCoverStatusEnum.CoverStatusClosed
    multi_stream_scene: 0, // Orientation.horizontal
    gift_auth: 1,
    chat_l2: 1, // hideSpam default true -> AuthSwitch.on
    star_comment_switch: true,
    multi_stream_source: 1, // MultiStreamSourceEnum.MainVertical
    is_group_live_session: !!isGroupLive,
    open_commercial_content_toggle: false,
    commercial_content_promote_myself: false,
    commercial_content_promote_third_party: false,
    rtc_net_enabled: false,
  };
}

/** qs.stringify equivalent for the flat payload Studio sends. */
export function formEncode(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => p.append(`${k}[${i}]`, String(item)));
    } else if (typeof v === 'boolean') {
      p.append(k, v ? 'true' : 'false');
    } else {
      p.append(k, String(v));
    }
  }
  return p.toString();
}

const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `TikTokLIVEStudio/${APP_VERSION} Chrome/136.0.7103.59 Electron/36.4.0 Safari/537.36`;

export async function request(
  pathname,
  { method = 'POST', query = {}, body, form = false, jar } = {},
) {
  const url = new URL(WEBCAST + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  let payload;
  if (body !== undefined) payload = form ? formEncode(body) : JSON.stringify(body);

  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': form
      ? 'application/x-www-form-urlencoded; charset=UTF-8'
      : 'application/json;charset=UTF-8',
    origin: REFERER.slice(0, -1),
    referer: REFERER,
    'user-agent': UA,
    sdk_aid: '8311',
    // NtpTimeInterceptor: performance.now()
    'webcast-ntp-t0': String(Math.round(performance.now() * 1000) / 1000),
    cookie: cookieHeader(jar),
  };
  // CommonRequestParamsInterceptor: x-tt-store-region = userInfo.region
  if (query.priority_region) headers['x-tt-store-region'] = String(query.priority_region);
  // Request interceptor: md5 of the serialized body string.
  if (payload) headers['x-ss-stub'] = crypto.createHash('md5').update(payload).digest('hex');

  const res = await fetch(url, { method, headers, body: payload });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }

  if (!res.ok) {
    const msg = json?.data?.message || json?.message || text.slice(0, 300);
    throw new Error(`${pathname} -> HTTP ${res.status} ${msg}`);
  }
  if (json && json.status_code && json.status_code !== 0) {
    const msg =
      json?.data?.prompts?.[0]?.display_text?.text ||
      json?.data?.prompt ||
      json?.data?.message ||
      json?.message ||
      'unknown';
    const e = new Error(`${pathname} -> status_code ${json.status_code}: ${msg}`);
    e.payload = json;
    throw e;
  }
  return json;
}

export const createInfo = (jar, query) =>
  request('/webcast/room/create_info/', {
    jar,
    body: {},
    query: { ...query, live_studio: '1' },
  });

export const createRoom = (jar, body, query) =>
  request('/webcast/room/create/', { jar, body, form: true, query });

/**
 * RoomService.recoverLastRoom -> getRoomInfoWhenContinue.
 * Returns { status_code, data: { room } } for the room that is still living.
 */
export async function continueRoom(jar, query) {
  try {
    return await request('/webcast/room/continue/', { method: 'GET', jar, query });
  } catch {
    return request('/webcast/room/continue/', { jar, body: {}, form: true, query });
  }
}

/** RoomService.PingAnchor: form body { status, room_id, stream_id }. */
export const pingAnchor = (jar, { roomId, streamId, status = 2 }) =>
  request('/webcast/room/ping/anchor/', {
    jar,
    form: true,
    body: { status, room_id: roomId, stream_id: streamId },
    query: defaultQuery(),
  });

/** Pull the RTMP ingest URL out of a room/create response. */
export function extractPushUrl(payload) {
  const d = payload?.data || payload || {};
  const room = d.room || d;
  const su = room.stream_url || {};
  const candidates = [
    su.rtmp_push_url,
    ...(Array.isArray(su.complete_push_urls) ? su.complete_push_urls : []),
    ...(Array.isArray(su.push_urls) ? su.push_urls : []),
    ...(Array.isArray(room.push_urls) ? room.push_urls : []),
    room.rtmp_push_url,
  ].filter((u) => typeof u === 'string' && u.startsWith('rtmp'));

  const withKey = candidates.find((u) => /\/[^/]{6,}$/.test(u) && !u.endsWith('/'));
  return withKey || candidates[0] || null;
}

export function extractRoomId(payload) {
  const d = payload?.data || payload || {};
  return (
    d.room?.id_str ||
    d.living_room_attrs?.room_id_str ||
    d.room_id_str ||
    (d.room_id != null ? String(d.room_id) : null) ||
    d.id_str ||
    null
  );
}

export function extractStreamId(payload) {
  const d = payload?.data || payload || {};
  return (
    d.room?.stream_id_str ||
    d.stream_id_str ||
    (d.stream_id != null ? String(d.stream_id) : null) ||
    ''
  );
}
