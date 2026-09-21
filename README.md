# mdesign-webui

Run the MiniMax Design desktop app in your browser.

把 MiniMax Design 桌面版搬进浏览器。渲染端和 gateway 都是官方桌面版的原生组件，本项目用一个零依赖的 Node 反代替代 Electron 壳，让整套应用跑在 Linux 服务器上，浏览器直接访问。

桌面版资产归 MiniMax 所有，不在仓库里。用 `deploy/extract-from-app.sh` 从你自己的已安装副本提取一次，之后桌面版可以卸载。

> **声明**：本项目与 MiniMax 无关，未获其认可。MiniMax Design、Hailuo 等名称与商标归其权利人所有。项目仅供学习与技术研究，不得商用；按原样提供，不附担保，使用后果自负。请遵守桌面版许可协议与当地法律，仅在拥有合法副本的机器上提取资产。

## 工作原理

```
浏览器 ── http://<server>:80 ── mdesign-webui.mjs，零依赖 Node 服务
   ├─ /            渲染端静态文件，注入 __HILO_CONFIG__ 与 shim.js 后下发
   ├─ /api /ws 等  反代到 hilo gateway 127.0.0.1:8001，由 gateway 访问云端
   ├─ /m3          反代到 m3-proxy 127.0.0.1:8319，提供 mcode 订阅的 MiniMax-M3
   └─ /comfy       反代到 ComfyUI 127.0.0.1:8188
```

- 渲染端就是 app.asar 里的 `/out/renderer`。官方代码自带浏览器降级，注入指向同源 gateway 的配置后即可脱离 Electron 运行。
- `shim.js` 顶替桌面版 preload 暴露的 `window.hilo`：IPC 调用降级为可观察的空操作，登录态改从 gateway 读取，窗口、通知等桌面能力全部优雅降级。
- 登录靠播种。桌面版由 Electron 主进程把账号 token 推给 gateway，这里由本服务定时读取 m3-proxy 的续期产物完成同样的事，gateway 就能以你的账号访问云端。
- gateway 必须以 `NODE_ENV=production` 运行，否则会指向内部预发环境，一般网络不可达。
- 另有 18188 探测口把 gateway 的 ComfyUI 集成桥到本机实例，画布里的 ComfyUI 面板因此可用。

## 快速开始

需要 Linux 服务器、Node 22+、Python 3、ffmpeg。opencode 和 ComfyUI 是可选项，分别对应聊天与图像功能。

```bash
# 1. 在装过桌面版的 mac 上提取资产
bash deploy/extract-from-app.sh

# 2. 上传资产并生成密钥模板
SSH_DST=root@<server> bash deploy/install-on-server.sh

# 3. 编辑服务器上的 mweb/env 填入真实密钥，然后安装服务并启动
SSH_DST=root@<server> bash deploy/install-on-server.sh --units
```

打开 `http://<server>/`。LLM 端点用仓库里的 m3-proxy，先按 [m3-proxy/README.md](m3-proxy/README.md) 跑起来并在 `mweb/env` 里接好，登录态即可全自动维持。

原生模块需要与 gateway bundle 对齐：`better-sqlite3@12.11.1`、`sharp@0.35.4`、`@node-rs/xxhash@1.7.6`。npm 上没有 12.11.2，装 12.11.1 即可，API 兼容。

## 登录

webui 没有登录页。所谓登录，就是把你自己 MiniMax 账号的 token 播种给 gateway。

推荐交给 m3-proxy：token 临期自动续期，webui 每次播种拿到的都是新 token，全程免维护。不想跑 m3-proxy 就手写 token 文件，路径填进 `MWEB_TOKEN_FILE`，过期后手动更新：

```json
{"auth": {"accessToken": "<JWT>", "realUserID": "<数字ID>"}}
```

日志出现 `seed: gateway /api/auth/token -> 200`、页面能加载模型目录，就是登录成功。没有登录态时静态页面与 ComfyUI 面板仍可用，模型目录、技能市场、云端生成一律 401。

## 路由与鉴权

| 端点 | 上游 | 鉴权 |
|---|---|---|
| `/` 静态资源 | 本地 renderer | 无 |
| `/api` `/backend` `/files` `/ws` | hilo gateway | 无，切勿暴露公网 |
| `/comfy/*` `/comfy/ws` | ComfyUI | 服务端注入 Bearer JWT |
| `/m3/*` | m3-proxy | 服务端注入 Bearer |
| `/mweb/health` | 自身状态 | 无 |

配置可走环境变量或 `config.json`，模板在 `config.example.json` 和 `mweb/env.example`。优先级：环境变量、`config.json`、默认值依次降低。

## 测试

```bash
node --test
```

零依赖冒烟测试，覆盖配置注入、静态服务、反代、前缀路由与路径穿越防护。

## 安全

本服务假定运行在隔离内网，gateway 免鉴权是桌面版原生设计，不要直接暴露公网。密钥清单与信任模型见 [SECURITY.md](SECURITY.md)。

## License

MIT，仅覆盖本仓库代码，提取所得的桌面版资产归其权利人所有。本项目仅供学习与技术研究，请勿用于商业或生产用途。
