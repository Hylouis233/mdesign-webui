# mdesign-webui

Run the MiniMax Design desktop app in your browser.

mdesign-webui replaces the Electron shell of the official MiniMax Design desktop app with a zero-dependency Node reverse proxy, so the app's own renderer and gateway run on a Linux server and you open the result directly in a browser. Nothing is reimplemented — the UI you see is the real desktop front end.

Desktop app assets belong to MiniMax and are not in this repository. Run `deploy/extract-from-app.sh` once on a machine that has the app installed; after that the app is no longer needed.

> **Disclaimer**: This is an unofficial project for learning and technical research. It is not affiliated with or endorsed by MiniMax. "MiniMax Design", "Hailuo" and related names are trademarks of their respective owners. The code is provided as-is, without warranty, and must not be used commercially; you are responsible for your own use. Respect the desktop app's license agreement and local law, and only extract assets from copies you legitimately own.

## How it works

```
Browser ── http://<server>:80 ── mdesign-webui.mjs, a zero-dependency Node service
   ├─ /             static renderer files, served with __HILO_CONFIG__ and shim.js injected
   ├─ /api /ws ...  reverse proxy to the hilo gateway at 127.0.0.1:8001, which talks to the cloud
   ├─ /m3           reverse proxy to m3-proxy at 127.0.0.1:8319, serving MiniMax-M3 from an mcode subscription
   └─ /comfy        reverse proxy to ComfyUI at 127.0.0.1:8188
```

- The renderer is the desktop app's `/out/renderer` from app.asar. It ships with a browser fallback, so once it is injected with a config pointing at the same-origin gateway it runs outside Electron.
- `shim.js` stands in for the `window.hilo` bridge that the desktop preload exposes: IPC calls become observable no-ops, auth state is read from the gateway instead, and window, notification and other desktop-only capabilities degrade gracefully.
- Login works by seeding. The desktop app's Electron main process pushes your account token to the gateway; here the service periodically reads m3-proxy's renewed token and posts it to the gateway, so the gateway accesses the cloud as your account.
- The gateway must run with `NODE_ENV=production`; otherwise it targets an internal pre-release environment that is unreachable on most networks.
- A probe listener on port 18188 bridges the gateway's ComfyUI integration to your local ComfyUI instance, so the ComfyUI panel inside the canvas works.

## Quick start

You need a Linux server with Node 22+, Python 3 and ffmpeg. opencode and ComfyUI are optional and enable chat and image features respectively.

```bash
# 1. Extract assets on a mac that has the desktop app installed
bash deploy/extract-from-app.sh

# 2. Upload the assets and generate the secrets template
SSH_DST=root@<server> bash deploy/install-on-server.sh

# 3. Fill in the real secrets in mweb/env on the server, then install and start the services
SSH_DST=root@<server> bash deploy/install-on-server.sh --units
```

Open `http://<server>/`. For the LLM endpoint, start the bundled m3-proxy following [m3-proxy/README.md](m3-proxy/README.md) and wire it up in `mweb/env`; the login state then maintains itself.

Native modules must match the gateway bundle: `better-sqlite3@12.11.1`, `sharp@0.35.4`, `@node-rs/xxhash@1.7.6`. Version 12.11.2 does not exist on npm; 12.11.1 is API-compatible.

## Login

There is no login page. Logging in means seeding the gateway with a token from your own MiniMax account.

The recommended way is m3-proxy: it renews the token before it expires, so every seed uses a fresh token and nothing needs manual care. Without m3-proxy, write a token file by hand, point `MWEB_TOKEN_FILE` at it, and update it yourself when it expires:

```json
{"auth": {"accessToken": "<JWT>", "realUserID": "<numeric user id>"}}
```

If the log shows `seed: gateway /api/auth/token -> 200` and the model catalog loads, you are logged in. Without a login the static pages and the ComfyUI panel still work, but the model catalog, the skill market and cloud generation all return 401.

## Routes and auth

| Endpoint | Upstream | Auth |
|---|---|---|
| `/` static | local renderer | none |
| `/api` `/backend` `/files` `/ws` | hilo gateway | none — do not expose to the public internet |
| `/comfy/*` `/comfy/ws` | ComfyUI | Bearer JWT injected server-side |
| `/m3/*` | m3-proxy | Bearer injected server-side |
| `/mweb/health` | self status | none |

Configuration comes from environment variables or `config.json`; templates are `config.example.json` and `mweb/env.example`. Precedence: environment variables, then `config.json`, then defaults.

## Tests

```bash
node --test
```

Zero-dependency smoke tests covering config injection, static serving, the reverse proxy, prefix routing and path traversal protection.

## Security

The service assumes an isolated internal network. The gateway trusts loopback callers by desktop design; never expose it directly to the public internet. See [SECURITY.md](SECURITY.md) for the secret inventory and the trust model.

## License

MIT, covering only the code in this repository. Extracted desktop assets belong to their owner. This project is for learning and technical research only — no commercial or production use.
