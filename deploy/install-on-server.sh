#!/usr/bin/env bash
# install-on-server.sh — 在 Linux 服务器上部署 mdesign webui（gateway + opencode + :80 反代）。
#
# 前置：
#   * 本地先跑 extract-from-app.sh，产物 out/ 与本脚本同级
#   * 服务器：node>=22（本文按 /opt/node22）、ffmpeg、python3
#   * 服务器已装 opencode（opencode.ai，>=1.18，官方安装器默认 /usr/local/bin/opencode）；可用 OPENCODE_BIN 覆盖
#   * 服务器已有 m3-proxy（8319）与 ComfyUI（8188，Bearer 鉴权）在跑
#
# 用法（本地执行）：
#   SSH_DST=root@<server> bash install-on-server.sh          # 上传资产+写密钥模板
#   #    手工编辑 mweb/env 填真实密钥，然后：
#   SSH_DST=root@<server> bash install-on-server.sh --units  # 装 systemd 并启动
set -euo pipefail

SSH_DST="${SSH_DST:?请设置 SSH_DST=root@<server>}"
REMOTE_DIR="${REMOTE_DIR:-/opt/m4e/webui}"     # 部署目录（示例按 /opt/m4e）
SRV_USER="${SRV_USER:-m4e}"                     # 运行服务的系统用户
OPENCODE_BIN="${OPENCODE_BIN:-/usr/local/bin/opencode}"  # systemd ExecStart 需绝对路径
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"

[ -d "$OUT/renderer" ] || { echo "先跑 extract-from-app.sh" >&2; exit 1; }

echo "[1/7] 上传资产 ..."
ssh "$SSH_DST" "mkdir -p $REMOTE_DIR"
tar -C "$OUT" -czf - . | ssh "$SSH_DST" "tar -C $REMOTE_DIR -xzf - && chown -R $SRV_USER $REMOTE_DIR"
scp "$HERE/../mdesign-webui.mjs" "$HERE/../shim.js" "$SSH_DST:$REMOTE_DIR/"

echo "[2/7] 重建 linux 原生模块（better-sqlite3/sharp/@node-rs/xxhash 需与 bundle 版本对齐）..."
ssh "$SSH_DST" "cd $REMOTE_DIR/gateway && /opt/node22/bin/npm install --no-save better-sqlite3@12.11.1 sharp@0.35.4 @node-rs/xxhash@1.7.6 ws undici && chown -R $SRV_USER node_modules"

echo "[3/7] 写运行目录与密钥环境文件 ..."
# 密钥逐项填写（不入库）：COMFY token=ComfyUI Bearer JWT；M3 token=m3-proxy 的 PROXY_TOKEN
ssh "$SSH_DST" "mkdir -p $REMOTE_DIR/mweb $REMOTE_DIR/hilo-home $REMOTE_DIR/hilo-data $REMOTE_DIR/output_files && chown -R $SRV_USER $REMOTE_DIR"
if ! ssh "$SSH_DST" "test -f $REMOTE_DIR/mweb/env"; then
  scp "$HERE/../mweb/env.example" "$SSH_DST:$REMOTE_DIR/mweb/env"
  ssh "$SSH_DST" "chmod 600 $REMOTE_DIR/mweb/env && chown $SRV_USER $REMOTE_DIR/mweb/env"
fi
echo "  → 请手工编辑 $REMOTE_DIR/mweb/env 填入真实密钥后重跑本脚本 --units"

if [ "${1:-}" != "--units" ]; then
  echo "[skip] 未加 --units，只上传资产；填好密钥后: SSH_DST=$SSH_DST bash $0 --units"
  exit 0
fi

echo "[4/7] 安装 systemd 单元 ..."
ssh "$SSH_DST" "cat > /etc/systemd/system/mdesign-gateway.service <<'EOF'
[Unit]
Description=MiniMax Design gateway (hilo, webui backend, 8001)
After=network-online.target
Wants=network-online.target

[Service]
User=$SRV_USER
WorkingDirectory=$REMOTE_DIR/gateway
Environment=NODE_ENV=production
Environment=HILO_RELEASE_CHANNEL=prod
Environment=HILO_RELEASE_REGION=domestic
Environment=HILO_APP_VERSION=3.0.17
# 可选：固定设备身份（缺省由 gateway 自行生成并持久化）。填随机 UUID，勿用他人设备 ID。
#Environment=HILO_DEVICE_ID=<random-uuid>
Environment=OPENCODE_URL=http://127.0.0.1:4096
Environment=HILO_DIR=$REMOTE_DIR/hilo-home
Environment=HILO_DATA_DIR=$REMOTE_DIR/hilo-data
Environment=HILO_BUNDLED_PLUGINS_DIR=$REMOTE_DIR/bundled-plugins
Environment=NODE_PATH=$REMOTE_DIR/gateway/node_modules
ExecStart=/opt/node22/bin/node dist/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/mdesign-opencode.service <<'EOF'
[Unit]
Description=MiniMax Design opencode runtime (agent chat backend, 4096)
After=network-online.target
Wants=network-online.target

[Service]
User=$SRV_USER
Environment=OPENCODE_DISABLE_PROJECT_CONFIG=1
Environment=OPENCODE_DISABLE_CLAUDE_CODE=1
Environment=OPENCODE_DISABLE_EXTERNAL_SKILLS=1
Environment=OPENCODE_LOG_LEVEL=INFO
Environment=HOME=$REMOTE_DIR/hilo-home
ExecStart=$OPENCODE_BIN serve --hostname 127.0.0.1 --port 4096
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/mdesign-webui.service <<'EOF'
[Unit]
Description=MiniMax Design webui reverse proxy (:80)
After=network-online.target mdesign-gateway.service mdesign-opencode.service
Wants=network-online.target
Requires=mdesign-gateway.service

[Service]
User=$SRV_USER
WorkingDirectory=$REMOTE_DIR
EnvironmentFile=$REMOTE_DIR/mweb/env
ExecStart=/opt/node22/bin/node $REMOTE_DIR/mdesign-webui.mjs
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload"

echo "[5/7] 启动 ..."
ssh "$SSH_DST" "systemctl enable --now mdesign-gateway.service mdesign-opencode.service mdesign-webui.service"

echo "[6/7] 冒烟 ..."
ssh "$SSH_DST" "sleep 8; curl -sf http://127.0.0.1/mweb/health && echo; curl -sf http://127.0.0.1/api/health && echo; curl -sf http://127.0.0.1/comfy/system_stats | head -c 120 && echo; curl -sf http://127.0.0.1/m3/v1/models | head -c 120 && echo"
echo "[7/7] 完成：浏览器打开 http://<服务器地址>/"
