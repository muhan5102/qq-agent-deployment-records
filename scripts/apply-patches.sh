#!/usr/bin/env bash
set -uo pipefail

# Version dispatcher used by systemd ExecStartPre.
# Each supported version has an independent, fail-closed patch entry.

APP_DIR="${APP_DIR:-/mnt/data/qq-agent/app}"
ENTRY_DIR="${ENTRY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
NODE="${NODE:-$APP_DIR/.runtime/node-v22.23.2-linux-x64/bin/node}"

[ -d "$APP_DIR" ] || { echo "找不到 APP_DIR：$APP_DIR" >&2; exit 2; }
[ -x "$NODE" ] || { echo "找不到可执行 Node：$NODE" >&2; exit 2; }

version="$(cd "$APP_DIR" && "$NODE" -p "require('./package.json').version" 2>/dev/null)"
case "$version" in
  0.9.5)
    entry="$ENTRY_DIR/apply-patches-v0.9.5.sh"
    ;;
  0.9.6)
    entry="$ENTRY_DIR/apply-patches-v0.9.6.sh"
    ;;
  0.9.10)
    entry="$ENTRY_DIR/apply-patches-v0.9.10.sh"
    ;;
  0.9.11)
    entry="$ENTRY_DIR/apply-patches-v0.9.11.sh"
    ;;
  0.9.12)
    entry="$ENTRY_DIR/apply-patches-v0.9.12.sh"
    ;;
  0.9.13)
    entry="$ENTRY_DIR/apply-patches-v0.9.13.sh"
    ;;
  *)
    echo "没有为版本 $version 配置可启动的本地补丁入口，拒绝启动。" >&2
    exit 2
    ;;
esac

[ -f "$entry" ] || {
  echo "版本 $version 的补丁入口不存在：$entry" >&2
  exit 2
}

exec /usr/bin/bash "$entry" "$@"
