#!/usr/bin/env node
/**
 * mdesign-webui — MiniMax Design 原生 WebUI 反代（零第三方依赖）。
 *
 * 把桌面版 MiniMax Design（本机 app.asar 内的渲染端 + gateway）复刻为浏览器可用的
 * WebUI：静态托管原生渲染端、按需注入 __HILO_CONFIG__（同源 gateway），并把
 * ComfyUI / m3-proxy 的模型后端端点挂到同一 origin 下。
 *
 * 路由：
 *   /                      原生渲染端（注入运行时配置后下发 index.html）
 *   /assets/* 等静态文件    原生渲染端资源
 *   /api/* /backend/* /files/* /ws   → 本地 hilo gateway（含 WebSocket）
 *   /comfy/*               → ComfyUI（服务端注入鉴权头；/comfy/ws 走 WS）
 *   /m3/*                  → m3-proxy（OpenAI/Anthropic 兼容；服务端注入 Bearer）
 *   /mweb/health           本服务状态（免鉴权）
 *
 * 登录态：定时读取 m3 token 文件（同 m3-proxy 约定），POST /api/auth/token
 * 播种给 gateway —— 桌面版里这一步由 Electron 主进程完成。
 *
 * 环境变量（或同目录 config.json，见 config.example.json）：
 *   MWEB_PORT(80) MWEB_BIND(0.0.0.0)
 *   MWEB_RENDERER_DIR(./renderer) MWEB_GATEWAY(http://127.0.0.1:8001)
 *   MWEB_COMFY_URL MWEB_COMFY_TOKEN MWEB_COMFY_PREFIX(/comfy)
 *   MWEB_M3_URL MWEB_M3_TOKEN MWEB_M3_PREFIX(/m3)
 *   MWEB_TOKEN_FILE(m3_token.json) MWEB_SEED_INTERVAL_SEC(600)
 *   MWEB_APP_VERSION(3.0.17) MWEB_REGION(domestic) MWEB_PUBLIC_ORIGIN(自动)
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HERE = path.dirname(new URL(import.meta.url).pathname);

function loadConfig() {
  let fileCfg = {};
  for (const p of [path.join(HERE, "config.json"), "/etc/m4e/webui.json"]) {
    try { fileCfg = JSON.parse(fs.readFileSync(p, "utf8")); break; } catch {}
  }
  const env = process.env;
  const get = (k, d) => env[k] ?? fileCfg[k] ?? d;
  return {
    port: parseInt(get("MWEB_PORT", "80"), 10),
    bind: get("MWEB_BIND", "0.0.0.0"),
    rendererDir: path.resolve(get("MWEB_RENDERER_DIR", path.join(HERE, "renderer"))),
    gateway: get("MWEB_GATEWAY", "http://127.0.0.1:8001").replace(/\/$/, ""),
    comfyUrl: get("MWEB_COMFY_URL", ""),
    comfyToken: get("MWEB_COMFY_TOKEN", ""),
    comfyPrefix: get("MWEB_COMFY_PREFIX", "/comfy").replace(/\/$/, ""),
    m3Url: get("MWEB_M3_URL", ""),
    m3Token: get("MWEB_M3_TOKEN", ""),
    m3Prefix: get("MWEB_M3_PREFIX", "/m3").replace(/\/$/, ""),
    tokenFile: get("MWEB_TOKEN_FILE", path.join(HERE, "m3_token.json")),
    tokenRenewedFile: get("MWEB_TOKEN_RENEWED_FILE", ""),
    seedIntervalSec: parseInt(get("MWEB_SEED_INTERVAL_SEC", "600"), 10),
    appVersion: get("MWEB_APP_VERSION", "3.0.17"),
    region: get("MWEB_REGION", "domestic"),
    publicOrigin: get("MWEB_PUBLIC_ORIGIN", ""),
    comfyForward: get("MWEB_COMFY_FORWARD", ""),        // 如 0.0.0.0:18188 → 转发到 comfy（gateway 集成探测口）
    rewriteBackend: get("MWEB_REWRITE_BACKEND_ORIGIN", ""), // 如 http://HOST:18188，把响应里的 127.0.0.1:18188 改写掉
  };
}
const CFG = loadConfig();

const GATEWAY_PREFIXES = ["/api/", "/backend/", "/files/", "/ws", "/heartbeat"];
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".wasm": "application/wasm", ".map": "application/json",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8",
};

function log(...a) { console.log(new Date().toISOString(), "[mweb]", ...a); }
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(b) });
  res.end(b);
}
function parseUpstream(u) {
  const m = u.match(/^(https?):\/\/([^/:]+)(?::(\d+))?/);
  if (!m) throw new Error("bad upstream url: " + u);
  return { proto: m[1], host: m[2], port: m[3] ? +m[3] : (m[1] === "https" ? 443 : 80) };
}

// ---------- 登录态播种（桌面版由 Electron 主进程 POST /api/auth/token） ----------
function readToken() {
  for (const p of [CFG.tokenRenewedFile, path.join(HERE, "m3_token_renewed.json"), CFG.tokenFile]) {
    if (!p) continue;
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      const auth = d.auth ?? d;
      if (auth.accessToken) return { token: auth.accessToken, uid: String(auth.realUserID ?? "0") };
    } catch {}
  }
  return null;
}
async function seedGatewayToken() {
  const t = readToken();
  if (!t) return log("seed: token 文件不可读，跳过");
  try {
    const r = await fetch(CFG.gateway + "/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t.token, userID: t.uid }),
    });
    log("seed: gateway /api/auth/token ->", r.status);
  } catch (e) { log("seed: 失败", String(e).slice(0, 120)); }
}

// ---------- 渲染端静态 + 注入 ----------
function deviceIdFile() {
  const p = path.join(HERE, ".device-id");
  try { return fs.readFileSync(p, "utf8").trim(); } catch {}
  const id = crypto.randomUUID();
  try { fs.writeFileSync(p, id, { mode: 0o600 }); } catch {}
  return id;
}
const DEVICE_ID = deviceIdFile();

function shimScript() {
  const p = path.join(HERE, "shim.js");
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

function injectConfig(html, origin) {
  const proto = origin.startsWith("https") ? "https" : "http";
  const wsProto = proto === "https" ? "wss" : "ws";
  const cfg = {
    gatewayUrl: origin,
    wsUrl: `${wsProto}://${origin.split("://")[1]}/ws`,
    env: "production", channel: "prod", region: CFG.region,
    appVersion: CFG.appVersion, domain: CFG.region === "overseas" ? "https://hailuoai.video" : "https://hailuoai.com",
    deviceId: DEVICE_ID, ipCountry: CFG.region === "overseas" ? "US" : "CN",
    downloadSource: "default", rendererPid: 0, folderPath: "",
    cpuCount: 8, electronVersion: "", chromeVersion: "",
    webui: true,
  };
  const shim = `<script>window.__HILO_CONFIG__=${JSON.stringify(cfg)};</script>` +
    `<script>${shimScript().replace(/<\/script>/g, "<\\/script>")}</script>`;
  const out = html.replace(/<head(\s[^>]*)?>/i, (m) => m + "\n" + shim);
  if (out === html) log("warn: index.html 无 <head>，__HILO_CONFIG__ 未注入");
  return out;
}

function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: "not found" });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- HTTP 反代 ----------
const TEXTY = /json|javascript|text\/html|text\/plain|event-stream/;

function proxyHttp(req, res, upstreamBase, extraHeaders, prefixToStrip = "", rewriteFrom = "", rewriteTo = "") {
  const u = parseUpstream(upstreamBase);
  let target = req.url;
  if (prefixToStrip && target.startsWith(prefixToStrip)) target = target.slice(prefixToStrip.length) || "/";
  const opts = {
    protocol: u.proto + ":", hostname: u.host, port: u.port,
    method: req.method, path: target,
    headers: { ...req.headers, host: `${u.host}:${u.port}`, ...extraHeaders },
  };
  const up = http.request(opts, (ur) => {
    const h = { ...ur.headers };
    delete h["content-security-policy"]; // 桌面端 CSP 指向 app://，浏览器态放开
    const ctype = String(h["content-type"] || "");
    const doRewrite = rewriteFrom && rewriteTo && TEXTY.test(ctype);
    if (doRewrite) {
      delete h["content-length"];
      res.writeHead(ur.statusCode, h);
      let buf = "";
      ur.setEncoding("utf8");
      ur.on("data", (c) => { buf += c; });
      ur.on("end", () => res.end(buf.split(rewriteFrom).join(rewriteTo)));
      return;
    }
    res.writeHead(ur.statusCode, h);
    ur.pipe(res);
  });
  up.on("error", (e) => { try { json(res, 502, { error: "upstream: " + String(e.message || e).slice(0, 200) }); } catch {} });
  // 客户端提前断开时释放上游连接（正常结束时 writableEnded 已置位，不误杀）
  res.on("close", () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
}

// ---------- WebSocket 反代（原始字节管道，upgrade 头透传） ----------
function proxyUpgrade(req, socket, head, upstreamBase, extraHeaders, prefixToStrip = "") {
  const u = parseUpstream(upstreamBase);
  let target = req.url;
  if (prefixToStrip && target.startsWith(prefixToStrip)) target = target.slice(prefixToStrip.length) || "/";
  const up = net.connect(u.port, u.host, () => {
    const lines = [`${req.method} ${target} HTTP/1.1`, `Host: ${u.host}:${u.port}`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"].includes(k)) continue;
      if (extraHeaders[k.toLowerCase()] !== undefined) continue;
      lines.push(`${k}: ${v}`);
    }
    for (const [k, v] of Object.entries(req.headers)) {
      if (["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"].includes(k)) lines.push(`${k}: ${v}`);
    }
    for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`);
    up.write(lines.join("\r\n") + "\r\n\r\n" + (head.length ? head : ""));
  });
  up.on("error", () => { try { socket.destroy(); } catch {} });
  socket.on("error", () => { try { up.destroy(); } catch {} });
  up.pipe(socket); socket.pipe(up);
}

// ---------- 主路由 ----------
const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  const origin = CFG.publicOrigin || `http://${req.headers.host || `127.0.0.1:${CFG.port}`}`;

  // 状态页
  if (urlPath === "/mweb/health") {
    return json(res, 200, {
      ok: true, service: "mdesign-webui",
      renderer: fs.existsSync(path.join(CFG.rendererDir, "index.html")) ? "ready" : "missing",
      gateway: CFG.gateway, comfy: CFG.comfyUrl || "(off)", m3: CFG.m3Url || "(off)",
    });
  }

  // ComfyUI 反代（服务端注入鉴权头 → 浏览器无需持有 ComfyUI token）
  if (CFG.comfyUrl && (urlPath === CFG.comfyPrefix || urlPath.startsWith(CFG.comfyPrefix + "/"))) {
    const h = {};
    if (CFG.comfyToken) { h["Authorization"] = "Bearer " + CFG.comfyToken; }
    return proxyHttp(req, res, CFG.comfyUrl, h, CFG.comfyPrefix);
  }

  // m3-proxy 反代（LLM 端点挂到 webui 同源）
  if (CFG.m3Url && (urlPath === CFG.m3Prefix || urlPath.startsWith(CFG.m3Prefix + "/"))) {
    const h = CFG.m3Token ? { Authorization: "Bearer " + CFG.m3Token } : {};
    return proxyHttp(req, res, CFG.m3Url, h, CFG.m3Prefix);
  }

  // gateway 反代（渲染端 API 面；可把响应里的托管后端 origin 改写为公网可达值）
  const prefixHit = (p) => urlPath === p || urlPath.startsWith(p.endsWith("/") ? p : p + "/");
  if (GATEWAY_PREFIXES.some(prefixHit)) {
    const rw = CFG.rewriteBackend ? ["127.0.0.1:18188", CFG.rewriteBackend.replace(/^https?:\/\//, "")] : [];
    return proxyHttp(req, res, CFG.gateway, {}, "", rw[0] || "", rw[1] || "");
  }

  // 渲染端静态
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method" });
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = rel.replace(/\/+$/, "/index.html");
  try { rel = decodeURIComponent(rel); } catch { return json(res, 400, { error: "bad url" }); }
  const filePath = path.normalize(path.join(CFG.rendererDir, rel));
  // 解码+规整后必须仍落在 rendererDir 之内（带 path.sep，防同名前缀兄弟目录绕过）
  if (filePath !== CFG.rendererDir && !filePath.startsWith(CFG.rendererDir + path.sep)) {
    return json(res, 403, { error: "forbidden" });
  }
  if (filePath.endsWith("index.html")) {
    fs.readFile(filePath, "utf8", (err, html) => {
      if (err) return json(res, 404, { error: "renderer missing (run extract step)" });
      const body = injectConfig(html, origin);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(body);
    });
    return;
  }
  serveStatic(req, res, filePath);
});

server.on("upgrade", (req, socket, head) => {
  const urlPath = req.url.split("?")[0];
  if (CFG.comfyUrl && (urlPath === CFG.comfyPrefix + "/ws" || urlPath.startsWith(CFG.comfyPrefix + "/ws"))) {
    const h = CFG.comfyToken ? { Authorization: "Bearer " + CFG.comfyToken } : {};
    return proxyUpgrade(req, socket, head, CFG.comfyUrl, h, CFG.comfyPrefix);
  }
  if (CFG.m3Url && urlPath.startsWith(CFG.m3Prefix + "/")) {
    const h = CFG.m3Token ? { Authorization: "Bearer " + CFG.m3Token } : {};
    return proxyUpgrade(req, socket, head, CFG.m3Url, h, CFG.m3Prefix);
  }
  // gateway 的 /ws（渲染端事件流）
  proxyUpgrade(req, socket, head, CFG.gateway, {});
});

server.listen(CFG.port, CFG.bind, () => {
  log(`listening http://${CFG.bind}:${CFG.port}`);
  log(`renderer=${CFG.rendererDir} gateway=${CFG.gateway} comfy=${CFG.comfyUrl || "-"} m3=${CFG.m3Url || "-"}`);
  seedGatewayToken();
  if (CFG.seedIntervalSec > 0) setInterval(seedGatewayToken, CFG.seedIntervalSec * 1000);
});

// ---------- 托管后端探测口（127.0.0.1:18188 → ComfyUI 8188，注入鉴权） ----------
// gateway 的 ComfyUI 集成恒定探测 127.0.0.1:18188（原生托管 fork 端口）。
// 服务器上没有 linux 托管包，用它桥到现有 8188 实例，模型即那一套。
if (CFG.comfyForward && CFG.comfyUrl) {
  const fwdMatch = CFG.comfyForward.match(/^([A-Za-z0-9._-]+):(\d+)$/);
  if (!fwdMatch) {
    log("comfy-forward: MWEB_COMFY_FORWARD 应为 host:port（如 0.0.0.0:18188），忽略: " + CFG.comfyForward);
  } else {
    const fwdBind = fwdMatch[1], fwdPort = fwdMatch[2];
    const fwd = http.createServer((req, res) => {
      const h = {};
      if (CFG.comfyToken) h["Authorization"] = "Bearer " + CFG.comfyToken;
      proxyHttp(req, res, CFG.comfyUrl, h);
    });
    fwd.on("upgrade", (req, socket, head) => {
      const h = {};
      if (CFG.comfyToken) h["Authorization"] = "Bearer " + CFG.comfyToken;
      proxyUpgrade(req, socket, head, CFG.comfyUrl, h);
    });
    fwd.listen(parseInt(fwdPort, 10), fwdBind || "0.0.0.0", () => {
      log(`comfy-forward ${fwdBind}:${fwdPort} -> ${CFG.comfyUrl} (auth injected)`);
    });
  }
}
