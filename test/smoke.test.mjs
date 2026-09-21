// test/smoke.test.mjs — 零依赖冒烟测试：临时 renderer + mock gateway，
// 覆盖配置注入、静态服务、gateway 反代、前缀路由与路径穿越防护。
// 运行：node --test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const PORT = 18000 + Math.floor(Math.random() * 2000);
const GW_PORT = 20000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;

// ---- 临时 renderer ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mweb-smoke-"));
fs.mkdirSync(path.join(tmp, "renderer"), { recursive: true });
fs.writeFileSync(path.join(tmp, "renderer", "index.html"),
  "<html><head><title>t</title></head><body>x</body></html>");
fs.writeFileSync(path.join(tmp, "renderer", "ok.txt"), "asset-ok");

// ---- mock gateway ----
const gw = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ gw: true, url: req.url }));
});
await new Promise((r) => gw.listen(GW_PORT, "127.0.0.1", r));

// ---- 被测服务 ----
const child = spawn(process.execPath, [path.join(ROOT, "mdesign-webui.mjs")], {
  env: {
    ...process.env,
    MWEB_PORT: String(PORT), MWEB_BIND: "127.0.0.1",
    MWEB_RENDERER_DIR: path.join(tmp, "renderer"),
    MWEB_GATEWAY: `http://127.0.0.1:${GW_PORT}`,
    MWEB_COMFY_URL: "", MWEB_M3_URL: "", MWEB_SEED_INTERVAL_SEC: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.resume(); child.stderr.resume(); // 排空管道，避免句柄滞留

after(() => {
  child.kill("SIGKILL");
  gw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch {}
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for service");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const ok = async (p) => (await fetch(BASE + p)).ok;
await until(() => ok("/mweb/health"));

test("/mweb/health 状态页", async () => {
  const j = await (await fetch(BASE + "/mweb/health")).json();
  assert.equal(j.ok, true);
  assert.equal(j.service, "mdesign-webui");
  assert.equal(j.renderer, "ready");
});

test("/ 注入 __HILO_CONFIG__ 与 shim", async () => {
  const html = await (await fetch(BASE + "/")).text();
  assert.match(html, /window\.__HILO_CONFIG__=/);
  assert.match(html, /__HILO_SHIM_APPLIED__/);
  assert.match(html, /"webui": ?true/);
});

test("静态资源命中与 404", async () => {
  assert.equal(await (await fetch(BASE + "/ok.txt")).text(), "asset-ok");
  assert.equal((await fetch(BASE + "/missing.js")).status, 404);
});

test("gateway 反代透传原始路径与查询", async () => {
  const j = await (await fetch(BASE + "/api/health?x=1")).json();
  assert.equal(j.gw, true);
  assert.equal(j.url, "/api/health?x=1");
});

test("/ws 前缀精确匹配（/ws2 不进 gateway，走静态 404）", async () => {
  const r = await fetch(BASE + "/ws2");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "not found");
});

test("路径穿越被拒（明文与编码形态）", async () => {
  const raw = (p) => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", () => resolve(-1));
    r.end();
  });
  assert.equal(await raw("/../../etc/passwd"), 403);
  assert.equal(await raw("/%2e%2e/%2e%2e/etc/passwd"), 403);
  assert.equal(await raw("/..%2f..%2fetc%2fpasswd"), 403);
});
