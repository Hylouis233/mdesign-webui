#!/usr/bin/env bash
# extract-from-app.sh — 从本机已安装的 MiniMax Design 桌面版提取 webui 所需资产。
#
# 产出（均为 MiniMax 专有资产，只进部署包，不入 git）：
#   out/renderer/        渲染端静态文件（app.asar 的 /out/renderer）
#   out/gateway/         gateway bundle（dist + package.json，node_modules 重建）
#   out/bundled-plugins/ 内置插件（comfyui 面板等）
#   out/conf out/mcp-tools out/agent-profiles out/project-templates out/opencode-plugin-hilo
#
# 用法：bash extract-from-app.sh [.app 路径，默认 /Applications/MiniMax Design.app]
set -euo pipefail

APP="${1:-/Applications/MiniMax Design.app}"
R="$APP/Contents/Resources"
OUT="$(cd "$(dirname "$0")" && pwd)/out"

[ -d "$R" ] || { echo "找不到 $R（先安装 MiniMax Design 桌面版）" >&2; exit 1; }
command -v npx >/dev/null || { echo "需要 node/npx" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

echo "[1/3] 解包 app.asar 提取渲染端 ..."
npx --yes @electron/asar extract "$R/app.asar" "$OUT/.asar"
cp -R "$OUT/.asar/out/renderer" "$OUT/renderer"
rm -rf "$OUT/.asar"

echo "[2/3] 复制 gateway 与插件资产 ..."
mkdir -p "$OUT/gateway"
cp -R "$R/gateway/dist" "$R/gateway/package.json" "$OUT/gateway/"
for d in bundled-plugins conf mcp-tools agent-profiles project-templates opencode-plugin-hilo; do
  [ -d "$R/$d" ] && cp -R "$R/$d" "$OUT/"
done

echo "[3/3] 校验 ..."
[ -f "$OUT/renderer/index.html" ] || { echo "renderer 缺失" >&2; exit 1; }
[ -f "$OUT/gateway/dist/main.js" ] || { echo "gateway 缺失" >&2; exit 1; }
du -sh "$OUT"/*
echo "完成：$OUT（配合 install-on-server.sh 部署）"
