// test/m3proxy.test.mjs — m3-proxy（Python 版）冒烟：鉴权与端点面。
// 不需要真实账号 token（无 token 文件场景），验证服务起得来、401/200 语义正确。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 21000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const PROXY_TOKEN = "smoke-test-token";

const hasPy = spawnSync("python3", ["--version"]).status === 0;

const child = hasPy ? spawn("python3", [path.join(ROOT, "m3-proxy", "m3_proxy.py")], {
  env: {
    ...process.env,
    PROXY_TOKEN, PROXY_PORT: String(PORT), PROXY_BIND: "127.0.0.1",
    M3_TOKEN_FILE: "/nonexistent/m3_token.json",
  },
  stdio: ["ignore", "pipe", "pipe"],
}) : null;
if (child) child.stdout.resume(), child.stderr.resume();

after(() => { if (child) child.kill("SIGKILL"); });

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch {}
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for m3-proxy");
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("m3-proxy 鉴权与端点面（无 token 场景）", { skip: !hasPy && "python3 不可用" }, async () => {
  await until(async () => (await fetch(BASE + "/health")).ok);
  // /health 免鉴权：无 token 文件 → ok:false 但 HTTP 200
  const h = await (await fetch(BASE + "/health")).json();
  assert.equal(h.service, "m3-proxy-py");
  assert.equal(h.ok, false);
  // 无 Bearer → 401
  assert.equal((await fetch(BASE + "/v1/models")).status, 401);
  // 错 Bearer → 401
  assert.equal((await fetch(BASE + "/v1/models", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  // 对 Bearer → 200，模型列表可读
  const r = await fetch(BASE + "/v1/models", { headers: { Authorization: "Bearer " + PROXY_TOKEN } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.data.some((m) => m.id === "MiniMax-M3"));
  // /v1/token 无凭据 → 503（服务面存在，凭据缺位）
  const t = await fetch(BASE + "/v1/token", { headers: { Authorization: "Bearer " + PROXY_TOKEN } });
  assert.equal(t.status, 503);
});
