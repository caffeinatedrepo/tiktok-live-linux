# TikTok LIVE for Linux

Go live on TikTok from a Linux terminal: create a room, get the RTMP ingest URL,
and push a video file with ffmpeg. No GUI and no copying stream keys by hand.

> **Unofficial.** This project is not affiliated with TikTok. Automating TikTok
> LIVE may violate TikTok's Terms of Service and can get an account restricted
> or banned. Use an account you can afford to lose.

## Features

- creates the live room through the same private webcast API Studio uses
- reads the RTMP push URL from the response and hands it to ffmpeg
- loops a clip, or stops after a set duration
- keeps the room alive with pings
- reconnects if the RTMP connection drops, resuming where it stopped
- no npm dependencies; ffmpeg is the only external binary
- runs as a normal user or as a systemd service

## Requirements

| | |
|---|---|
| OS | Linux (x86_64 or arm64) |
| Node.js | 20 or newer |
| ffmpeg | on `PATH`, or set `TTLIVE_FFMPEG=/path/to/ffmpeg` |
| Account | allowed to go live; it must have used TikTok LIVE Studio at least once |

Install the dependencies:

```bash
# Debian / Ubuntu
sudo apt install ffmpeg
# Fedora
sudo dnf install ffmpeg
# Arch
sudo pacman -S ffmpeg
```

Node 20+ from your distro, [nvm](https://github.com/nvm-sh/nvm), or NodeSource.

## Install

```bash
git clone https://github.com/caffeinatedrepo/tiktok-live-linux.git
cd tiktok-live-linux
./install.sh
```

That symlinks `ttlive` into `~/.local/bin`. If that directory is not on your
`PATH`, the script prints the line to add to your shell profile.

Alternatives:

```bash
npm link                 # uses the package.json bin entry
node bin/ttlive.js help  # run without installing
```

## Log in

TikTok LIVE Studio does not run on Linux, so log in with a cookie string copied
from a browser where you are signed in to TikTok:

```bash
ttlive login --cookie "sessionid=...; sid_tt=...; uid_tt=..."
```

In the browser: DevTools -> Application -> Cookies -> `https://www.tiktok.com`,
then copy `sessionid`, `sid_tt`, and `uid_tt` (more cookies are fine).

The session is saved to `~/.ttlive/session.json` and is only sent to TikTok.

`--from-studio` exists for Windows machines that have Studio installed; on
Linux it exits with an explanation.

## Device IDs (required on Linux)

TikTok ties `device_id` and `install_id` to the Studio install the account has
used. Studio's logs are the source of truth on Windows, but there are no Studio
logs on Linux, so the CLI cannot discover them and will otherwise generate new
ones, which the API rejects with `status_code 10011`.

Set the values from the Windows machine that ran Studio (search
`%APPDATA%\TikTok LIVE Studio\logs\*.log` for `device_id: '...'` and
`install_id: '...'`):

```bash
export TTLIVE_DEVICE_ID=1234567890123456789
export TTLIVE_INSTALL_ID=9876543210987654321
```

or write them once to `~/.ttlive/config.json`:

```json
{
  "deviceId": "1234567890123456789",
  "installId": "9876543210987654321"
}
```

If you already use this tool on Windows, you can copy both
`~/.ttlive/config.json` and `~/.ttlive/session.json` to the Linux machine
instead.

## Go live

```bash
ttlive go --title "Join me" --file clip.mp4
```

| option | |
|---|---|
| `--title <text>` | live title (default: `Join me`) |
| `--file <path>` | video file to stream (required) |
| `--duration <sec>` | stop after N seconds |
| `--bitrate <rate>` | video bitrate (default: `2500k`) |
| `--fps <n>` | frame rate (default: `30`) |
| `--no-loop` | play the file once, then end |
| `--no-reconnect` | do not restart ffmpeg after a dropped connection |
| `--url-only` | print the RTMP URL and exit (no ffmpeg) |
| `--dry-run` | show the request without creating a room |

Stop with Ctrl+C, or from another shell:

```bash
ttlive stop
```

## Run it as a service

`systemd/ttlive.service` is a template for an always-on streamer.

```bash
sudo cp systemd/ttlive.service /etc/systemd/system/ttlive.service
sudo nano /etc/systemd/system/ttlive.service   # set User, paths, device IDs
sudo systemctl daemon-reload
sudo systemctl enable --now ttlive
journalctl -u ttlive -f
```

The session must already exist for that user (`ttlive login --cookie "..."`).
`Restart=always` brings the stream back if the process exits.

## Other commands

| command | |
|---|---|
| `ttlive push --url rtmp://... --file clip.mp4` | push to a URL you already have |
| `ttlive doctor [--net]` | check ffmpeg, session, and API access |
| `ttlive end` | best-effort finish ping for the last room |
| `ttlive learn` / `ttlive sniff` | attach to Studio (Windows only) |

## How it works

1. `room/create_info` returns the cover, region, and group-live defaults.
2. `room/create` creates the room. The response contains
   `stream_url.rtmp_push_url`.
3. ffmpeg publishes the file to that URL.
4. `room/ping/anchor` is sent every 5 seconds to keep the room alive.
5. The live ends when the RTMP push stops; there is no separate HTTP "end" call.

Requests are form-urlencoded with the same query parameters, headers, and
`x-ss-stub` (MD5 of the body) that Studio uses.

## Troubleshooting

| symptom | fix |
|---|---|
| `status_code 10011` | device/install IDs do not match the session. Set `TTLIVE_DEVICE_ID` / `TTLIVE_INSTALL_ID` (see above). |
| `status_code 30005` | the account already has a living room; the CLI resumes it. |
| `ffmpeg not found` | install ffmpeg or set `TTLIVE_FFMPEG`. |
| `ffmpeg exited code 1` | the RTMP connection was closed. Check `~/.ttlive/stream.log`; the CLI retries unless `--no-reconnect` is set. |
| live page says "LIVE has ended" | the room closed because the RTMP push stopped. Keep the stream running. |
| `403` on `tiktok.com/@you/live` from curl | TikTok serves a WAF challenge to non-browser clients. Open the page in a real browser. |
| `EACCES` on the ffmpeg binary | `chmod +x` it, or install ffmpeg from your package manager. |

## Security

This repository contains no credentials. Session cookies live in
`~/.ttlive/session.json` and are only sent to `tiktok.com` / `tiktokv.com`.

For containers or CI, pass the session through the environment instead:

- `TTLIVE_SESSION_B64` — base64 of `session.json`
- `TTLIVE_SESSION_JSON` — the raw JSON
- `TTLIVE_DEVICE_ID` / `TTLIVE_INSTALL_ID` — the IDs from the same Studio install

Treat the session file like a password: anyone who has it can act as your
account. Log out of TikTok to invalidate it.

## License

MIT — see [LICENSE](LICENSE).
