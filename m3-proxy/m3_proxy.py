#!/usr/bin/env python3
"""m3-proxy（Python 版）— mcode 订阅 MiniMax-M3 反代，零第三方依赖。

从 m3-proxy.mjs 移植，供无 Node 的服务器使用：
  GET  /health                  状态（免鉴权）
  GET  /v1/models               模型列表
  POST /v1/messages             Anthropic 原生透传（含 SSE 流式）
  POST /v1/chat/completions     OpenAI 兼容（协议翻译，支持流式）

凭据：token 文件（默认与本文件同目录 m3_token.json，格式同 mcode 的
local-runtime.auth.json：{"auth":{"accessToken":..., "realUserID":...}}）。
临期（<5 分钟）自动调用 mcode 同款续期接口（md5 双签名），续出的新
token 写入 m3_token_renewed.json（不覆盖原文件）。

环境变量：PROXY_TOKEN(必填) PROXY_PORT(8319) PROXY_BIND(127.0.0.1)
          M3_TOKEN_FILE MAVIS_BASE(https://agent.minimaxi.com/mavis/api/v1/llm/v1)
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PROXY_PORT", "8319"))
BIND = os.environ.get("PROXY_BIND", "127.0.0.1")
TOKEN = os.environ.get("PROXY_TOKEN", "")
MAVIS_BASE = os.environ.get("MAVIS_BASE", "https://agent.minimaxi.com/mavis/api/v1/llm/v1").rstrip("/")
RENEW_BASE = "https://agent.minimaxi.com"
HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.environ.get("M3_TOKEN_FILE", os.path.join(HERE, "m3_token.json"))
RENEWED_FILE = os.path.join(HERE, "m3_token_renewed.json")
MODELS = ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"]
UA = "MiniMaxCode"
STOP_MAP = {"end_turn": "stop", "stop_sequence": "stop", "max_tokens": "length", "tool_use": "tool_calls"}

if not TOKEN:
    raise SystemExit("缺少 PROXY_TOKEN")


def md5(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def jwt_exp_ms(tok: str) -> int:
    try:
        p = tok.split(".")[1]
        p += "=" * (-len(p) % 4)
        payload = json.loads(base64.urlsafe_b64decode(p))
        return int(payload.get("exp", 0)) * 1000
    except Exception:
        return 0


def _read_token_file(path):
    try:
        d = json.load(open(path, encoding="utf-8"))
        auth = d.get("auth", d)
        tok = auth.get("accessToken")
        if tok:
            return tok, auth.get("realUserID") or "0"
    except Exception:
        pass
    return None, "0"


def renew_token(old_tok: str, uid: str) -> str:
    now = int(time.time() * 1000)
    q = urllib.parse.urlencode({
        "device_platform": "mcode", "biz_id": "3", "app_id": "3001",
        "version_code": "22201", "unix": str(now),
        "timezone_offset": "28800", "sys_language": "zh", "lang": "zh",
        "device_id": "0", "os_name": "linux", "browser_name": "mcode",
        "user_id": uid, "token": old_tok, "client": "mcode",
    })
    pathsearch = "/v1/api/user/renewal?" + q
    yy = md5(urllib.parse.quote(pathsearch, safe="") + "_{}" + md5(str(now)) + "ooui")
    ts = now // 1000
    sig = md5(f"{ts}I*7Cf%WZ#S&%1RlZJ&C2")
    req = urllib.request.Request(
        RENEW_BASE + pathsearch, method="POST",
        headers={"Accept": "application/json", "Content-Type": "application/json",
                 "User-Agent": UA, "token": old_tok, "yy": yy,
                 "x-timestamp": str(ts), "x-signature": sig})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read())
    nt = (d.get("data") or {}).get("token") or d.get("token")
    if not nt:
        raise RuntimeError("续期响应里没有新 token")
    return nt


_cache = {"tok": None, "at": 0}


def get_access_token():
    tok = _cache.get("tok")
    exp = jwt_exp_ms(tok) if tok else 0
    if tok and (not exp or exp > time.time() * 1000 + 300_000):
        return tok
    for path in (RENEWED_FILE, TOKEN_FILE):
        t, uid = _read_token_file(path)
        if not t:
            continue
        exp = jwt_exp_ms(t)
        if not exp or exp > time.time() * 1000 + 300_000:
            _cache["tok"] = t
            return t
        try:
            nt = renew_token(t, uid)
            _cache["tok"] = nt
            try:
                fd = os.open(RENEWED_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    json.dump({"auth": {"accessToken": nt, "realUserID": uid}}, f)
            except Exception:
                pass
            return nt
        except Exception:
            continue
    # 全部续期失败：返回还剩下的那个（可能仍可用几分钟）
    t, _ = _read_token_file(RENEWED_FILE) if os.path.exists(RENEWED_FILE) else (None, "0")
    t = t or _read_token_file(TOKEN_FILE)[0]
    if t:
        _cache["tok"] = t
        return t
    raise RuntimeError("没有可用 token（请更新 m3_token.json）")


def mavis_request(body_bytes: bytes, accept: str):
    tok = get_access_token()
    req = urllib.request.Request(
        MAVIS_BASE + "/messages", data=body_bytes, method="POST",
        headers={"Content-Type": "application/json", "Accept": accept,
                 "Authorization": "Bearer " + tok,
                 "anthropic-version": "2023-06-01", "User-Agent": UA})
    return urllib.request.urlopen(req, timeout=240)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _authed(self):
        return hmac.compare_digest(self.headers.get("Authorization") or "", "Bearer " + TOKEN)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 32 * 1024 * 1024:
            raise RuntimeError("请求体超过 32MB 上限")
        return self.rfile.read(n) if n else b""

    # ---------- GET ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            try:
                tok = get_access_token()
                hours = max(0.0, (jwt_exp_ms(tok) - time.time() * 1000) / 3600000)
                return self._json(200, {"ok": True, "service": "m3-proxy-py", "model_default": "MiniMax-M3",
                                        "models": MODELS, "token_hours_left": round(hours, 2), "auto_renew": True})
            except Exception as e:
                return self._json(200, {"ok": False, "service": "m3-proxy-py", "error": "token unavailable: " + str(e)[:120]})
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        if path == "/v1/models":
            return self._json(200, {"object": "list",
                                    "data": [{"id": m, "object": "model", "owned_by": "minimax-mcode-subscription"} for m in MODELS]})
        if path == "/v1/token":
            # 供同机其他受限服务（如 webui seeder）取当前 access token 的唯一通道：
            # 文件权限之外走 HTTP + Bearer；token 由本服务自治续期，永远新鲜。
            try:
                tok = get_access_token()
                hours = max(0.0, (jwt_exp_ms(tok) - time.time() * 1000) / 3600000)
                uid = "0"
                for p in (RENEWED_FILE, TOKEN_FILE):
                    t, u = _read_token_file(p)
                    if t == tok:
                        uid = u
                        break
                return self._json(200, {"accessToken": tok, "realUserID": uid,
                                        "expires_in_hours": round(hours, 2)})
            except Exception as e:
                return self._json(503, {"error": "token unavailable: " + str(e)[:120]})
        return self._json(404, {"error": f"not found: GET {path}"})

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split("?")[0]
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        body = self._body()
        try:
            if path == "/v1/messages":
                return self._passthrough(body)
            if path == "/v1/chat/completions":
                return self._openai_compat(body)
        except urllib.error.HTTPError as e:
            detail = e.read()[:400].decode("utf-8", "ignore")
            return self._json(e.code, {"error": {"message": f"mavis {e.code}: {detail}"}})
        except Exception as e:
            return self._json(500, {"error": {"message": str(e)[:300]}})
        return self._json(404, {"error": f"not found: POST {path}"})

    # Anthropic 原生透传（支持 SSE）
    def _passthrough(self, body):
        is_stream = re.search(rb'"stream"\s*:\s*true', body) is not None
        try:
            up = mavis_request(body, "text/event-stream" if is_stream else "application/json")
        except urllib.error.HTTPError as e:
            raise e
        self.send_response(up.status)
        ctype = up.headers.get("Content-Type", "application/json")
        self.send_header("Content-Type", ctype)
        if not is_stream:
            data = up.read()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            try:
                for line in up:
                    self.wfile.write(line)
                    self.wfile.flush()
            except Exception:
                pass
        return None

    # OpenAI 兼容翻译
    def _openai_compat(self, body):
        try:
            o = json.loads(body)
        except Exception:
            return self._json(400, {"error": {"message": "invalid JSON"}})
        msgs = o.get("messages") or []

        def _txtx(c):
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return "\n".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
            return str(c or "")

        system = "\n\n".join(_txtx(m.get("content")) for m in msgs if m.get("role") == "system")

        def _blocks(m):
            c = m.get("content")
            blocks = []
            if isinstance(c, str) and c:
                blocks.append({"type": "text", "text": c})
            elif isinstance(c, list):
                for p in c:
                    if not isinstance(p, dict):
                        continue
                    if p.get("type") == "text":
                        blocks.append({"type": "text", "text": p.get("text", "")})
                    elif p.get("type") == "image_url":
                        try:
                            u = (p.get("image_url") or {}).get("url", "")
                            if u.startswith("data:"):
                                mt, _, b64 = u.partition(",")
                                blocks.append({"type": "image", "source": {"type": "base64", "media_type": mt.split(";")[0] or "image/png", "data": b64}})
                        except Exception:
                            pass
            for tc in m.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {"_raw": fn.get("arguments")}
                blocks.append({"type": "tool_use", "id": tc.get("id") or "call_0",
                               "name": fn.get("name") or "tool", "input": args})
            return blocks

        out = []
        pending_results = []
        for m in msgs:
            role = m.get("role")
            if role == "system":
                continue
            if role == "tool":
                pending_results.append({"type": "tool_result",
                                        "tool_use_id": m.get("tool_call_id") or "call_0",
                                        "content": _txtx(m.get("content")) or " "})
                continue
            blocks = _blocks(m)
            arole = "assistant" if role == "assistant" else "user"
            if pending_results and arole == "user":
                blocks = pending_results + blocks
                pending_results = []
            if not blocks:
                blocks = [{"type": "text", "text": " "}]
            if out and out[-1]["role"] == arole:
                out[-1]["content"].extend(blocks)
            else:
                out.append({"role": arole, "content": blocks})
        if pending_results:
            out.append({"role": "user", "content": pending_results})
        if not out:
            out = [{"role": "user", "content": [{"type": "text", "text": " "}]}]
        abody = {"model": o.get("model") or "MiniMax-M3",
                 "max_tokens": min(int(o.get("max_tokens") or 4096), 32768),
                 "messages": out}
        if system:
            abody["system"] = system
        if o.get("temperature") is not None:
            abody["temperature"] = o["temperature"]
        if o.get("top_p") is not None:
            abody["top_p"] = o["top_p"]
        if o.get("stop"):
            abody["stop_sequences"] = o["stop"] if isinstance(o["stop"], list) else [o["stop"]]
        if o.get("tools"):
            atools = []
            for t in o["tools"]:
                fn = (t or {}).get("function") or {}
                if fn.get("name"):
                    atools.append({"name": fn["name"], "description": fn.get("description") or "",
                                   "input_schema": fn.get("parameters") or {"type": "object", "properties": {}}})
            if atools:
                abody["tools"] = atools
        tc = o.get("tool_choice")
        if tc == "required":
            abody["tool_choice"] = {"type": "any"}
        elif isinstance(tc, dict) and (tc.get("function") or {}).get("name"):
            abody["tool_choice"] = {"type": "tool", "name": tc["function"]["name"]}
        elif tc == "none":
            abody.pop("tools", None)
        stream = bool(o.get("stream"))
        if stream:
            abody["stream"] = True

        up = mavis_request(json.dumps(abody).encode(), "text/event-stream" if stream else "application/json")

        if not stream:
            d = json.loads(up.read())
            text = "".join(c.get("text", "") for c in d.get("content", []) if c.get("type") == "text")
            tool_calls = []
            for c in d.get("content", []):
                if c.get("type") == "tool_use":
                    tool_calls.append({"id": c.get("id"), "type": "function",
                                       "function": {"name": c.get("name"),
                                                    "arguments": json.dumps(c.get("input") or {}, ensure_ascii=False)}})
            msg = {"role": "assistant", "content": text or None}
            if tool_calls:
                msg["tool_calls"] = tool_calls
            finish = STOP_MAP.get(d.get("stop_reason"), "stop")
            if d.get("stop_reason") == "tool_use":
                finish = "tool_calls"
            u = d.get("usage") or {}
            return self._json(200, {
                "id": d.get("id"), "object": "chat.completion", "created": int(time.time()),
                "model": d.get("model"),
                "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
                "usage": {"prompt_tokens": u.get("input_tokens", 0), "completion_tokens": u.get("output_tokens", 0),
                          "total_tokens": u.get("input_tokens", 0) + u.get("output_tokens", 0)}})

        # 流式：Anthropic SSE -> OpenAI chunk
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        cid = "chatcmpl-%d" % int(time.time() * 1000)

        def send(obj):
            self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
            self.wfile.flush()

        send({"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
              "model": abody["model"], "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
        usage = {"p": 0, "c": 0}
        tool_idx = -1
        for raw in up:
            line = raw.decode("utf-8", "ignore").rstrip("\n")
            if not line.startswith("data:"):
                continue
            try:
                d = json.loads(line[5:].strip())
            except Exception:
                continue
            t = d.get("type")
            if t == "message_start":
                usage["p"] = (d.get("message") or {}).get("usage", {}).get("input_tokens", 0)
            elif t == "content_block_delta" and (d.get("delta") or {}).get("type") == "text_delta":
                send({"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                      "model": abody["model"],
                      "choices": [{"index": 0, "delta": {"content": d["delta"].get("text", "")}, "finish_reason": None}]})
            elif t == "message_delta":
                usage["c"] = (d.get("usage") or {}).get("output_tokens", usage["c"])
                send({"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                      "model": abody["model"],
                      "choices": [{"index": 0, "delta": {}, "finish_reason": STOP_MAP.get((d.get("delta") or {}).get("stop_reason"), "stop")}]})
            elif t == "message_stop":
                send({"id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
                      "model": abody["model"],
                      "choices": [{"index": 0, "delta": {}, "finish_reason": None}],
                      "usage": {"prompt_tokens": usage["p"], "completion_tokens": usage["c"],
                                "total_tokens": usage["p"] + usage["c"]}})
        try:
            self.wfile.write(b"data: [DONE]\n\n")
        except Exception:
            pass
        return None


if __name__ == "__main__":
    srv = ThreadingHTTPServer((BIND, PORT), H)
    print(f"[m3-proxy-py] http://{BIND}:{PORT}  上游 {MAVIS_BASE}", flush=True)
    srv.serve_forever()
