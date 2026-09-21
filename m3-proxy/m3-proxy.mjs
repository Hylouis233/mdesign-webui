#!/usr/bin/env node
/**
 * m3-proxy — 把 mcode（Minimax Code）订阅里的 MiniMax-M3 反代出来
 *
 * 上游：https://agent.minimaxi.com/mavis/api/v1/llm/v1  (Anthropic Messages 协议)
 * 凭据：OAuth accessToken，每次请求从 ~/.minimax/auth/prod/.../auth.json 新鲜读取
 *       （mcode 桌面版/CLI 运行期间会自动续期；不运行时 token 约 1 小时过期）
 *
 * 暴露接口（除 /health 外均需 Authorization: Bearer <PROXY_TOKEN>）：
 *   GET  /health                       状态（token 剩余时间、模型列表）
 *   GET  /v1/models                    订阅模型列表（OpenAI 格式）
 *   POST /v1/messages                  Anthropic 原生透传（含 SSE 流式）
 *   POST /v1/chat/completions          OpenAI 兼容（自动翻译协议；支持流式）
 *
 * 环境变量：
 *   PROXY_TOKEN  必填
 *   PROXY_PORT   默认 8319
 *   PROXY_BIND   默认 127.0.0.1（对外暴露改 0.0.0.0，注意令牌保密）
 *   MAVIS_BASE   可覆盖，默认 https://agent.minimaxi.com/mavis/api/v1/llm/v1
 */
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";

const PORT = Number(process.env.PROXY_PORT || 8319);
const BIND = process.env.PROXY_BIND || "127.0.0.1";
const MAVIS_BASE = (process.env.MAVIS_BASE || "https://agent.minimaxi.com/mavis/api/v1/llm/v1").replace(/\/+$/, "");
const TOKEN = process.env.PROXY_TOKEN || "";
if (!TOKEN) { console.error("缺少 PROXY_TOKEN"); process.exit(1); }
const timingSafeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

const MODELS = ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"];

// ---- token 获取与自动续期 ----
// 主凭据：~/.minimax/cli-auth/prod/cn/local-runtime.auth.json（CLI local-runtime token，
// 可直调 mavis LLM，也可走 /v1/api/user/renewal 续期；临期自动续，内存缓存）
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const jwtExpMs = (tok) => {
  try {
    const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
    return typeof p.exp === "number" ? p.exp * 1000 : 0;
  } catch { return 0; }
};
let cachedToken = null;

async function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    const f = join(d, name);
    try { await readFile(f, "utf-8"); return f; } catch {}
    try { for (const e of await readdir(d, { withFileTypes: true })) if (e.isDirectory()) stack.push(join(d, e.name)); } catch {}
  }
  return null;
}

async function readLocalRuntimeToken() {
  const f = await findFile(join(homedir(), ".minimax", "cli-auth"), "local-runtime.auth.json");
  if (!f) throw new Error("找不到 ~/.minimax/cli-auth/.../local-runtime.auth.json（mcode 是否登录过？）");
  const d = JSON.parse(await readFile(f, "utf-8"));
  const tok = d?.auth?.accessToken || d?.accessToken;
  if (!tok) throw new Error("local-runtime.auth.json 里没有 accessToken");
  return tok;
}

async function renewToken(oldTok) {
  const now = Date.now();
  const qs = new URLSearchParams({
    device_platform: "mcode", biz_id: "3", app_id: "3001", version_code: "22201",
    unix: String(now), timezone_offset: String(-new Date().getTimezoneOffset() * 60),
    sys_language: "zh", lang: "zh", device_id: "0", os_name: process.platform,
    browser_name: "mcode", user_id: process.env.MCODE_UID || "0", token: oldTok, client: "mcode",
  }).toString();
  const url = new URL("https://agent.minimaxi.com/v1/api/user/renewal?" + qs);
  const a = url.pathname + url.search;
  const yy = md5(encodeURIComponent(a) + "_{}" + md5(String(now)) + "ooui");
  const ts = Math.floor(now / 1000);
  const sig = md5(`${ts}I*7Cf%WZ#S&%1RlZJ&C2`);
  const r = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "MiniMaxCode", token: oldTok, yy, "x-timestamp": String(ts), "x-signature": sig },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`token 续期失败 HTTP ${r.status}（打开并登录 mcode 后重试）`);
  const d = await r.json();
  const nt = d?.data?.token || d?.token;
  if (!nt) throw new Error("续期响应里没有新 token");
  return nt;
}

async function getAccessToken() {
  // 缓存仍有效（>5 分钟）直接用
  if (cachedToken) {
    const exp = jwtExpMs(cachedToken);
    if (!exp || exp > Date.now() + 300_000) return { token: cachedToken, expiresAtMs: exp };
  }
  let tok = await readLocalRuntimeToken();
  const exp = jwtExpMs(tok);
  if (!exp || exp > Date.now() + 300_000) { cachedToken = tok; return { token: tok, expiresAtMs: exp }; }
  // 临期：尝试续期；失败则退回原 token（可能仍可用几分钟）
  try {
    const nt = await renewToken(tok);
    cachedToken = nt;
    return { token: nt, expiresAtMs: jwtExpMs(nt) };
  } catch {
    cachedToken = tok;
    return { token: tok, expiresAtMs: exp };
  }
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function authorized(req) {
  return timingSafeEq(req.headers["authorization"] || "", `Bearer ${TOKEN}`);
}
async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("请求体过大"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}

// ---- Anthropic 原生透传（含 SSE） ----
async function proxyMessages(req, res, bodyBuf) {
  const { token } = await getAccessToken();
  const isStream = bodyBuf.includes('"stream":true') || /"stream"\s*:\s*true/.test(bodyBuf);
  const up = await fetch(`${MAVIS_BASE}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: isStream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "User-Agent": "MiniMaxCode",
    },
    body: bodyBuf,
  });
  if (!up.ok) {
    const t = await up.text().catch(() => "");
    return json(res, up.status, { error: { message: `mavis ${up.status}: ${t.slice(0, 400)}`, upstream_status: up.status } });
  }
  const h = {};
  up.headers.forEach((v, k) => { if (!["content-encoding","transfer-encoding","content-length","connection"].includes(k)) h[k] = v; });
  res.writeHead(up.status, h);
  if (up.body) {
    const rd = up.body.getReader();
    try { for(;;){ const {done,value}=await rd.read(); if(done)break; res.write(Buffer.from(value)); } } catch {}
  }
  res.end();
}

// ---- OpenAI -> Anthropic 翻译 ----
function openaiToAnthropic(o) {
  const msgs = Array.isArray(o.messages) ? o.messages : [];
  const system = msgs.filter(m => m.role === "system").map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n\n");
  const out = [];
  for (const m of msgs) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.filter(p => p.type === "text").map(p => p.text).join("\n") : String(m.content ?? "");
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n" + content;
    else out.push({ role, content: content || " " });
  }
  if (!out.length) out.push({ role: "user", content: " " });
  const body = {
    model: o.model || "MiniMax-M3",
    max_tokens: Math.min(Number(o.max_tokens) || 4096, 32768),
    messages: out,
  };
  if (system) body.system = system;
  if (o.temperature != null) body.temperature = o.temperature;
  if (o.top_p != null) body.top_p = o.top_p;
  if (o.stop) body.stop_sequences = Array.isArray(o.stop) ? o.stop : [o.stop];
  if (o.stream) body.stream = true;
  return body;
}
const stopMap = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls" };

async function openaiCompat(req, res, raw) {
  let o; try { o = JSON.parse(raw); } catch { return json(res, 400, { error: { message: "invalid JSON" } }); }
  if (!MODELS.includes(o.model) && o.model) { /* 允许透传，但默认 M3 */ }
  const body = openaiToAnthropic(o);
  const { token } = await getAccessToken();
  const up = await fetch(`${MAVIS_BASE}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: body.stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "User-Agent": "MiniMaxCode",
    },
    body: JSON.stringify(body),
  });
  if (!up.ok) {
    const t = await up.text().catch(() => "");
    return json(res, up.status, { error: { message: `mavis ${up.status}: ${t.slice(0, 400)}`, upstream_status: up.status } });
  }

  if (!body.stream) {
    const d = await up.json();
    const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    return json(res, 200, {
      id: d.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: d.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: stopMap[d.stop_reason] || "stop" }],
      usage: { prompt_tokens: d.usage?.input_tokens ?? 0, completion_tokens: d.usage?.output_tokens ?? 0, total_tokens: (d.usage?.input_tokens ?? 0) + (d.usage?.output_tokens ?? 0) },
    });
  }

  // 流式：Anthropic SSE -> OpenAI chunk
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const id = "chatcmpl-" + Date.now();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const rd = up.body.getReader();
  let buf = "", usage = { prompt_tokens: 0, completion_tokens: 0 };
  try {
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += Buffer.from(value).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, i); buf = buf.slice(i + 2);
        let type = "", data = "";
        for (const line of evt.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let d; try { d = JSON.parse(data); } catch { continue; }
        if (type === "message_start") usage.prompt_tokens = d.message?.usage?.input_tokens ?? 0;
        else if (type === "content_block_delta" && d.delta?.type === "text_delta")
          send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, delta: { content: d.delta.text }, finish_reason: null }] });
        else if (type === "message_delta") {
          usage.completion_tokens = d.usage?.output_tokens ?? usage.completion_tokens;
          const fin = stopMap[d.delta?.stop_reason] || "stop";
          send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, delta: {}, finish_reason: fin }] });
        } else if (type === "message_stop") {
          send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
        }
      }
    }
  } catch {}
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  try {
    if (path === "/health") {
      let hours = null;
      try { const { expiresAtMs } = await getAccessToken(); hours = Math.max(0, (expiresAtMs - Date.now()) / 3600000); } catch (e) { return json(res, 200, { ok: false, error: "token unavailable: " + e.message }); }
      return json(res, 200, { ok: true, service: "m3-proxy", model_default: "MiniMax-M3", models: MODELS, token_hours_left: +hours.toFixed(2), auto_renew: true });
    }
    if (!authorized(req)) return json(res, 401, { error: { message: "unauthorized" } });

    if (path === "/v1/models" && req.method === "GET")
      return json(res, 200, { object: "list", data: MODELS.map(m => ({ id: m, object: "model", owned_by: "minimax-mcode-subscription" })) });

    if (path === "/v1/messages" && req.method === "POST") {
      const raw = await readBody(req);
      return await proxyMessages(req, res, raw);
    }
    if (path === "/v1/chat/completions" && req.method === "POST") {
      const raw = await readBody(req);
      return await openaiCompat(req, res, raw);
    }
    return json(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
  } catch (e) {
    return json(res, 500, { error: { message: String(e.message ?? e) } });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`[m3-proxy] http://${BIND}:${PORT}  上游 ${MAVIS_BASE}`);
  console.log("[m3-proxy] Anthropic 原生: POST /v1/messages · OpenAI 兼容: POST /v1/chat/completions");
});
