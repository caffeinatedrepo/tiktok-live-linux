import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = path.join(os.homedir(), '.ttlive');
export const SESSION_FILE = path.join(HOME, 'session.json');
export const CAPTURE_FILE = path.join(HOME, 'capture.json');
export const CONFIG_FILE = path.join(HOME, 'config.json');
export const PID_FILE = path.join(HOME, 'stream.pid');
export const STREAM_LOG = path.join(HOME, 'stream.log');
export const BIN_DIR = path.join(HOME, 'bin');

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureHome();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return file;
}
