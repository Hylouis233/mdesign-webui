# m3-proxy — mcode 订阅 MiniMax-M3 反代（零依赖）

把 mcode（Minimax Code）订阅里的 MiniMax-M3 模型反代成标准 API，供 webui 的
`/m3/*` 路由与其他 OpenAI 协议客户端使用。**仅供学习与技术研究用途**，需要你
自己的 mcode 订阅账号；请遵守服务条款。

## 接口（除 /health 外均需 `Authorization: Bearer <PROXY_TOKEN>`）

| 端点 | 说明 |
|---|---|
| `GET /health` | 状态（免鉴权；token 剩余小时数、模型列表） |
| `GET /v1/models` | 模型列表（OpenAI 格式） |
| `POST /v1/messages` | Anthropic Messages 原生透传（含 SSE 流式） |
| `POST /v1/chat/completions` | OpenAI 兼容（协议自动翻译；支持流式） |
| `GET /v1/token` | 仅 Python 版：返回当前 access token（供同机 seeder 拉取） |

## 两个实现，怎么选

| | `m3_proxy.py`（推荐常驻） | `m3-proxy.mjs` |
|---|---|---|
| 运行时 | Python 3 标准库 | Node >= 18 |
| 凭据来源 | 自管 token 文件 + **临期自动续期**（写入 `m3_token_renewed.json`） | 直接读 mcode CLI 的 `~/.minimax/cli-auth/**/local-runtime.auth.json`（mcode 运行期间它自己续期） |
| `/v1/token` 端点 | 有 | 无 |
| 适用 | 服务器 systemd 常驻、配合 webui seeder | 本机装着 mcode CLI 的场合，不落额外凭据文件 |

上游均为官方 mavis 端点（`MAVIS_BASE` 可覆盖）；续期走 mcode 客户端同款接口。

## 使用（Python 版）

```bash
# 1) 准备 token 文件（与你账号的登录态对应）：
#    {"auth": {"accessToken": "<JWT>", "realUserID": "<数字ID>"}}
#    token 取自你已登录的 mcode CLI（~/.minimax/.../auth.json）或官方客户端。
cp env.example myenv && vim myenv          # 填 PROXY_TOKEN（随机长串）、M3_TOKEN_FILE
set -a; . ./myenv; set +a                  # 或用 systemd EnvironmentFile
python3 m3_proxy.py                        # 监听 127.0.0.1:8319

# 2) 冒烟：
curl -s localhost:8319/health
curl -s -H "Authorization: Bearer $PROXY_TOKEN" localhost:8319/v1/models
curl -s -H "Authorization: Bearer $PROXY_TOKEN" localhost:8319/v1/chat/completions \
  -d '{"model":"MiniMax-M3","messages":[{"role":"user","content":"你好"}]}'
```

token 临期（<5 分钟）自动续期，新 token 写入**同目录** `m3_token_renewed.json`
（0600，不覆盖原文件）；续期失败会退回旧 token 并在下次重试。

## 使用（Node 版）

```bash
PROXY_TOKEN=<随机长串> node m3-proxy.mjs   # 需本机 mcode CLI 登录过
```

## 与 webui 接线（自动登录的关键）

`mweb/env` 里：

```bash
MWEB_M3_URL=http://127.0.0.1:8319
MWEB_M3_TOKEN=<同 PROXY_TOKEN>                    # webui 转发 /m3/* 时注入
MWEB_TOKEN_FILE=/opt/m4e/m3-proxy/m3_token.json          # 回退
MWEB_TOKEN_RENEWED_FILE=/opt/m4e/m3-proxy/m3_token_renewed.json   # 优先：m3-proxy 续期产物
```

这样 webui seeder 每次播种拿到的都是 m3-proxy 刚续期的新 token，登录态全自动
维持；`MWEB_SEED_INTERVAL_SEC`（默认 600s）控制播种频率。

systemd 单元示例（Python 版常驻）：

```ini
[Unit]
Description=m3-proxy (mcode subscription MiniMax-M3 reverse proxy, 8319)
After=network-online.target

[Service]
User=<运行用户>
WorkingDirectory=/opt/m4e/m3-proxy
EnvironmentFile=/opt/m4e/m3-proxy/env
ExecStart=/usr/bin/python3 /opt/m4e/m3-proxy/m3_proxy.py
Restart=always

[Install]
WantedBy=multi-user.target
```

## 安全

- `PROXY_TOKEN` 是调用方令牌（随机长串，勿用弱值）；真实 token 文件、
  `env`、`m3_token_renewed.json` 均已 gitignore，权限 0600。
- 默认只听回环；对外暴露前自加防护（上游是按你账号计费的订阅）。
