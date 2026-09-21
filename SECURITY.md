# Security / 密钥与信任模型

## 密钥清单（全部不入库，部署时手工放置）

| 位置（部署目录） | 内容 | 权限 |
|---|---|---|
| `mweb/env` | systemd EnvironmentFile：上游地址 + `MWEB_COMFY_TOKEN`（ComfyUI Bearer JWT）+ `MWEB_M3_TOKEN`（m3-proxy PROXY_TOKEN）+ token 文件路径 | 0600 |
| `config.json` | 环境变量等价物（可选，二选一） | 0600 |
| `m3_token.json` / `m3_token_renewed.json` | m3-proxy 维护的账号登录态（accessToken），本服务只读并播种给 gateway | m3-proxy 侧 0600 |
| `.device-id` | 首次启动自动生成的随机 UUID（渲染端设备身份） | 自动 0600 |
| ComfyUI systemd drop-in | `SECRET_KEY`（鉴权插件签发 JWT 用）+ 长寿命 JWT | 0600，服务器本地 |

`.gitignore` 已覆盖以上路径；提交前可用 `git ls-files` 复核。

## 信任模型

- **假定隔离内网**：hilo gateway 对回环免鉴权是桌面版原生设计，本反代把它带到
  `:80` 后，同网段任何人都能以你的账号身份调用云端。**不要把本服务直接暴露公网**；
  需要远程访问时自加认证/VPN。
- 浏览器端不持有任何 ComfyUI/m3 密钥（服务端注入）；MiniMax 账号 token 只存在于
  服务器文件系统。
- `MWEB_REWRITE_BACKEND` 会把响应体里的 `127.0.0.1:18188` 改写为服务器地址——
  仅对 text/json 响应做字符串替换，无注入风险面扩大。

## 上报

发现安全问题请开 private security advisory，勿直接开公开 issue。
