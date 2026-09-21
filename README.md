# mdesign-webui — MiniMax Design 原生 WebUI 反代

把桌面版 MiniMax Design 复刻为浏览器可直接访问的 WebUI：**同一套渲染端与 gateway**，
只把 Electron 壳换成零依赖 Node 反代，并把 ComfyUI / m3-proxy / opencode 的后端端点
挂到同一 origin 下。桌面版资产（渲染端/gateway/插件）为 MiniMax 专有，**不入库**，
部署时经 `deploy/extract-from-app.sh` 从你自己机器上已安装的桌面版提取。

> **免责声明 / Disclaimer**：本项目**仅供学习与技术研究用途（for educational
> purposes only）**，不得用于商业或其他用途；按"现状"提供，不作任何担保或维护
> 承诺，使用产生的一切后果由使用者自行承担。本项目为非官方工具，与 MiniMax
> 公司无关联、未获其认可。"MiniMax Design"、"Hailuo" 等名称与商标归其权利人
> 所有。仓库不含任何 MiniMax 专有代码或资源；请自行遵守桌面版软件许可协议与
> 当地法律，仅在你拥有合法授权的副本上使用提取脚本。

## 架构

```
浏览器 ── http://<server>:80 ── mdesign-webui.mjs（零依赖 Node）
   ├─ /                     渲染端静态（注入 __HILO_CONFIG__ + shim.js 后下发）
   ├─ /api /backend /files /ws → hilo gateway（127.0.0.1:8001，systemd 常驻）
   │                           ├─ 云端 design.minimax.cn（登录态=播种的 mcode token）
   │                           └─ opencode serve（127.0.0.1:4096，agent 会话后端）
   ├─ /comfy/*              → ComfyUI 8188（服务端注入 Bearer，浏览器免持 token）
   ├─ /m3/*                 → m3-proxy 8319（本仓 m3-proxy/，OpenAI 兼容 LLM 端点）
   └─ :18188                → ComfyUI 8188（gateway 的 ComfyUI 集成探测口，鉴权注入）
```

## 关键机制

- **复刻原生**：渲染端就是 app.asar 里的 `/out/renderer`（Vite SPA，官方自带
  `webPlatform` 浏览器降级）；注入的 `__HILO_CONFIG__` 把 gatewayUrl 指到同源。
- **shim.js**：替代 preload 的 `window.hilo`（ipcRenderer/auth/diagnostics…），
  `ipcRenderer.invoke` 全部可观察 no-op，桌面专属能力优雅降级。
- **登录态播种**：桌面版由 Electron 主进程 `POST /api/auth/token` 推 token；webui 版
  由本服务读 m3-proxy 的 token 文件（含续期产物——m3-proxy 临期自动续期，见
  `m3-proxy/README.md`）定时播种，gateway 即以你自己的 MiniMax 账号访问云端
  （模型目录/技能市场 200）。
- **opencode 集成**：gateway 的 agent 会话后端指向本机 `opencode serve`
  （127.0.0.1:4096）；opencode 以 `HOME=<部署目录>/hilo-home` 隔离运行，插件
  （opencode-plugin-hilo）从桌面版资产中一并提取。
- **ComfyUI 端点复制**：
  - `/comfy/*` 全量反代（REST + WebSocket），鉴权在服务端注入；
  - `:18188` 转发器满足 gateway ComfyUI 集成（原生托管后端端口）的探测，
    `MWEB_REWRITE_BACKEND` 把下发到浏览器的内容里 `127.0.0.1:18188` 改写为
    服务器地址，画布内嵌 ComfyUI 面板即可直连；
  - ComfyUI 侧需固定 `SECRET_KEY` 环境变量（Usgromana 是其登录鉴权插件的名称，
    非密钥值），否则每次重启随机换密钥、token 全失效；真实 SECRET_KEY 与铸出的
    长寿命 JWT 只存于服务器 systemd drop-in（0600），不入库。
- **gateway 生产模式**：`NODE_ENV=production`（+HILO_RELEASE_CHANNEL/REGION），
  否则默认指向内部预发环境，多数网络不可达。

## 部署

```bash
# 0) 服务器前置：node>=22、ffmpeg、opencode(opencode.ai)、ComfyUI(8188,Bearer)
#    m3-proxy 用本仓 m3-proxy/（见其 README），先起它再起 webui

# 1) 本机（装有 MiniMax Design 桌面版）提取资产
bash deploy/extract-from-app.sh

# 2) 上传+装原生模块+写密钥模板（密钥在 mweb/env，逐项填写）
SSH_DST=root@<server> bash deploy/install-on-server.sh
#    填好密钥后：
SSH_DST=root@<server> bash deploy/install-on-server.sh --units
```

原生模块版本与 bundle 对齐：`better-sqlite3@12.11.x sharp@0.35.4 @node-rs/xxhash@1.7.6`
（registry 上 12.11.2 不存在，取 12.11.1，API 兼容）。

配置可走环境变量或 `config.json`（模板 `config.example.json`）；systemd 用
`mweb/env`（模板 `mweb/env.example`）。优先级：**环境变量 > `config.json` > 内置默认值**。

## 测试

零依赖冒烟测试（`node --test`，Node>=18）：起临时 renderer + mock gateway，
覆盖配置注入、静态服务、gateway 反代、前缀路由与路径穿越防护。

```bash
node --test
```

## 登录与账号（webui 没有登录页）

webui 的"登录"= 把**你自己 MiniMax 账号的 token** 播种给 gateway（桌面版由
Electron 主进程做，webui 版由 seeder 做）。token 来源三选一：

1. **m3-proxy 自动续期（推荐）**：`MWEB_TOKEN_RENEWED_FILE` 指向 m3-proxy 的
   `m3_token_renewed.json`，token 永远新鲜，零手工维护（接线见 `m3-proxy/README.md`）
2. **手工 token 文件**：`MWEB_TOKEN_FILE` 指向自写文件
   `{"auth":{"accessToken":"<JWT>","realUserID":"<数字ID>"}}`；过期需手动更新
3. **mcode CLI 在本机**：Node 版 m3-proxy 直接读它的凭据文件

验证：日志出现 `seed: gateway /api/auth/token -> 200`，浏览器里模型目录/技能市场
能拉出列表即登录成功。无登录态时静态 UI 与 `/comfy/*`（ComfyUI 面板）仍可用，
但模型目录/技能市场/云端聊天与生成一律 401。

## 路由与鉴权约定

| 端点 | 上游 | 鉴权 |
|---|---|---|
| `/`（静态） | 本地 renderer | 无（内网信任域） |
| `/api` `/backend` `/files` `/ws` | hilo gateway 8001 | 无（原生即回环免鉴权；**勿暴露公网**） |
| `/comfy/*` `/comfy/ws` | ComfyUI 8188 | 服务端注入 Bearer JWT |
| `/m3/*` | m3-proxy 8319 | 服务端注入 Bearer（=PROXY_TOKEN） |
| `:18188` | ComfyUI 8188 | 服务端注入 Bearer JWT |
| `/mweb/health` | 自身状态 | 无（不含敏感信息） |

## 安全

- 服务绑定与密钥全部走环境变量/`config.json`，真实 `config.json`、`mweb/env`、
  token 文件、`.device-id` 均已 gitignore（见 `SECURITY.md` 的密钥清单）。
- 本服务假定运行于隔离内网（渲染端→gateway 免鉴权是原生设计）；对外暴露前需自加
  认证层。

## License

MIT（见 `LICENSE`）。仅覆盖本仓库自写代码；提取所得的桌面版资产归其权利人所有。
再次强调：**本项目仅供学习与技术研究用途**，请勿用于商业或生产用途。
