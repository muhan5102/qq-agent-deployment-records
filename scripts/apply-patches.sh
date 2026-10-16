#!/usr/bin/env bash
# 升级后重新打本地补丁。
#
# 背景：`deploy-all.sh` 的 `rsync --delete` 会整树替换 `app/src/`，
# 我们改过的文件每次升级都会被覆盖回去。
#
# 这个脚本只做一件事：把 patches/ 清单里的补丁逐条对到目标文件上——
# 已经生效的跳过，没生效的打上，对不上的报冲突并退出（**不会硬打**）。
# 默认不改运行状态，需要重启服务时显式加 `--restart`。
#
# 用法：
#   scripts/apply-patches.sh                 # 检查并补齐，不重启
#   scripts/apply-patches.sh --restart       # 补齐后重启机器人服务
#   DRY_RUN=1 scripts/apply-patches.sh       # 只看会做什么，不落盘
#
# 可用环境变量覆盖：
#   APP_DIR   部署目录里的 app（默认 /mnt/data/qq-agent/app）
#   PATCH_DIR 补丁所在目录（默认 /mnt/data/qq-agent）
#   NODE      node 可执行文件（默认 app/.runtime 里那个，找不到就用 PATH 上的 node）

set -uo pipefail

APP_DIR="${APP_DIR:-/mnt/data/qq-agent/app}"
PATCH_DIR="${PATCH_DIR:-/mnt/data/qq-agent}"
NODE="${NODE:-$APP_DIR/.runtime/node-v22.23.2-linux-x64/bin/node}"
DRY_RUN="${DRY_RUN:-0}"

RESTART=0
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（支持 --restart）" >&2; exit 2 ;;
  esac
done

[ -d "$APP_DIR" ] || { echo "找不到 APP_DIR：$APP_DIR" >&2; exit 2; }
[ -f "$NODE" ] || NODE="$(command -v node || true)"

# 补丁文件 | 目标文件（相对 app/）
PATCHES=(
  "patch-memory-qq-2026-10-09.diff|src/memory/memory-global.js"
  "patch-sticker-note-40-2026-10-14.diff|src/onebot/sticker-manager.js"
  "patch-memory-guard-2026-10-15.diff|src/core/orchestrator.js"
  "patch-text-nudge-2026-10-16.diff|src/core/orchestrator.js"
)

applied=0; pending=0; failed=0

cd "$APP_DIR" || exit 2

for item in "${PATCHES[@]}"; do
  diff_file="${item%%|*}"
  target="${item##*|}"
  path="$PATCH_DIR/$diff_file"

  if [ ! -f "$path" ]; then
    echo "[跳过] $diff_file —— 补丁文件不存在"
    failed=$((failed + 1))
    continue
  fi
  if [ ! -f "$target" ]; then
    echo "[异常] $diff_file —— 目标文件不存在：$target（上游可能改过文件名）"
    failed=$((failed + 1))
    continue
  fi

  # 已经打过：反向 dry-run 能对上
  if patch -p1 --dry-run -R --force < "$path" >/dev/null 2>&1; then
    echo "[已生效] $diff_file"
    applied=$((applied + 1))
    continue
  fi

  # 还没打：正向 dry-run 能对上
  if patch -p1 --dry-run --force < "$path" >/dev/null 2>&1; then
    if [ "$DRY_RUN" = "1" ]; then
      echo "[待打] $diff_file -> $target（DRY_RUN，未落盘）"
      pending=$((pending + 1))
      continue
    fi
    echo "[打补丁] $diff_file -> $target"
    if ! patch -p1 --forward < "$path"; then
      echo "        打补丁失败" >&2
      failed=$((failed + 1))
      continue
    fi
    if [[ "$target" == *.js ]]; then
      if "$NODE" --check "$target" >/dev/null 2>&1; then
        echo "        语法检查通过"
      else
        echo "        语法检查**失败**，请立刻回退该文件" >&2
        failed=$((failed + 1))
        continue
      fi
    fi
    pending=$((pending + 1))
    continue
  fi

  echo "[冲突] $diff_file —— 上下文对不上，**没有动它**；请按 patches/README.md 手工重做" >&2
  failed=$((failed + 1))
done

echo
echo "已生效 $applied / 本次补打 $pending / 需处理 $failed"

if [ "$failed" -gt 0 ]; then
  echo "有不需处理的问题，未重启服务。" >&2
  exit 1
fi

if [ "$pending" -gt 0 ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN：没有实际改动。"
  elif [ "$RESTART" = "1" ]; then
    systemctl --user restart qq-agent-linux
    echo "已重启 qq-agent-linux（源码改动要重启才生效）。"
  else
    echo "源码已改，但**没有重启**。确认无误后执行：systemctl --user restart qq-agent-linux"
  fi
else
  echo "没有需要补打的补丁，未重启。"
fi
