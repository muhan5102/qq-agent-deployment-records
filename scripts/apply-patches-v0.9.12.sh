#!/usr/bin/env bash
set -uo pipefail

# Reapply the local v0.9.12 integration, video, sticker, and on-demand political-rule
# increments after a clean deployment.
# This package is local-only and must not be published to a public repository.

APP_DIR="${APP_DIR:-/mnt/data/qq-agent/app}"
PATCH_DIR="${PATCH_DIR:-$(cd "$(dirname "$0")" && pwd)}"
MAIN_PATCH_FILE="patch-local-all-0.9.12-20261028.diff"
VIDEO_PATCH_FILE="patch-video-reply-opt-0.9.12-20261030.diff"
STICKER_PATCH_FILE="patch-sticker-reply-opt-0.9.12-20261030.diff"
POLITICAL_PATCH_FILE="patch-political-module-opt-0.9.12-20261030.diff"
NODE="${NODE:-$APP_DIR/.runtime/node-v22.23.2-linux-x64/bin/node}"
DRY_RUN="${DRY_RUN:-0}"
RESTART=0

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数：$arg（支持 --restart）" >&2
      exit 2
      ;;
  esac
done

[ -d "$APP_DIR" ] || { echo "找不到 APP_DIR：$APP_DIR" >&2; exit 2; }
[ -f "$PATCH_DIR/$MAIN_PATCH_FILE" ] || { echo "找不到补丁：$MAIN_PATCH_FILE" >&2; exit 2; }
[ -f "$PATCH_DIR/$VIDEO_PATCH_FILE" ] || { echo "找不到补丁：$VIDEO_PATCH_FILE" >&2; exit 2; }
[ -f "$PATCH_DIR/$STICKER_PATCH_FILE" ] || { echo "找不到补丁：$STICKER_PATCH_FILE" >&2; exit 2; }
[ -f "$PATCH_DIR/$POLITICAL_PATCH_FILE" ] || { echo "找不到补丁：$POLITICAL_PATCH_FILE" >&2; exit 2; }
[ -x "$NODE" ] || { echo "找不到可执行 Node：$NODE" >&2; exit 2; }

cd "$APP_DIR" || exit 2

version="$("$NODE" -p "require('./package.json').version" 2>/dev/null)"
if [ "$version" != "0.9.12" ]; then
  echo "基线版本不匹配：当前 $version，本补丁只适用于 0.9.12" >&2
  exit 2
fi

for patch_file in "$MAIN_PATCH_FILE" "$VIDEO_PATCH_FILE" "$STICKER_PATCH_FILE" "$POLITICAL_PATCH_FILE"; do
  if grep -q '^+++ b/data/' "$PATCH_DIR/$patch_file"; then
    echo "补丁 $patch_file 包含 data/ 改动，拒绝应用" >&2
    exit 2
  fi
done

apply_patch_file() {
  local patch_file="$1"
  if ! patch -p1 --batch --forward < "$PATCH_DIR/$patch_file"; then
    echo "应用补丁失败：$patch_file；请从部署备份恢复后重新演练。" >&2
    exit 1
  fi
}

check_syntax() {
  mapfile -t FILES < <(
    {
      grep -oE '^\+\+\+ b/[^[:space:]]+' "$PATCH_DIR/$MAIN_PATCH_FILE"
      grep -oE '^\+\+\+ b/[^[:space:]]+' "$PATCH_DIR/$VIDEO_PATCH_FILE"
      grep -oE '^\+\+\+ b/[^[:space:]]+' "$PATCH_DIR/$STICKER_PATCH_FILE"
      grep -oE '^\+\+\+ b/[^[:space:]]+' "$PATCH_DIR/$POLITICAL_PATCH_FILE"
    } | sed 's|^+++ b/||' | sort -u
  )

  local failed=0
  for file in "${FILES[@]}"; do
    case "$file" in
      *.js|*.mjs)
        if ! "$NODE" --check "$file" >/dev/null 2>&1; then
          echo "语法检查失败：$file" >&2
          failed=$((failed + 1))
        fi
        ;;
    esac
  done
  if [ "$failed" -gt 0 ]; then
    echo "有 $failed 个文件语法检查失败，未重启服务。" >&2
    exit 1
  fi
}

# Current production state: all three source patches are present.
if patch -p1 --dry-run -R --batch --forward < "$PATCH_DIR/$POLITICAL_PATCH_FILE" >/dev/null 2>&1; then
  echo "补丁链已完整生效，无需重复应用。"
  exit 0
fi

patches_to_apply=()
if patch -p1 --dry-run --batch --forward < "$PATCH_DIR/$POLITICAL_PATCH_FILE" >/dev/null 2>&1; then
  patches_to_apply=("$POLITICAL_PATCH_FILE")
elif patch -p1 --dry-run --batch --forward < "$PATCH_DIR/$STICKER_PATCH_FILE" >/dev/null 2>&1; then
  patches_to_apply=("$STICKER_PATCH_FILE" "$POLITICAL_PATCH_FILE")
elif patch -p1 --dry-run --batch --forward < "$PATCH_DIR/$VIDEO_PATCH_FILE" >/dev/null 2>&1; then
  patches_to_apply=("$VIDEO_PATCH_FILE" "$STICKER_PATCH_FILE" "$POLITICAL_PATCH_FILE")
elif patch -p1 --dry-run --batch --forward < "$PATCH_DIR/$MAIN_PATCH_FILE" >/dev/null 2>&1; then
  patches_to_apply=("$MAIN_PATCH_FILE" "$VIDEO_PATCH_FILE" "$STICKER_PATCH_FILE" "$POLITICAL_PATCH_FILE")
else
  echo "政治规则补丁与当前源码不匹配，且前置补丁也无法从干净基线应用；未修改任何文件。" >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN：需要依次应用 ${patches_to_apply[*]}，未修改文件。"
  exit 0
fi

for patch_file in "${patches_to_apply[@]}"; do
  echo "应用补丁：$patch_file"
  apply_patch_file "$patch_file"
done

check_syntax

if ! patch -p1 --dry-run -R --batch --forward < "$PATCH_DIR/$POLITICAL_PATCH_FILE" >/dev/null 2>&1; then
  echo "政治规则补丁已写入，但反向校验不一致；请回滚后重试。" >&2
  exit 1
fi

echo "补丁链应用完成：源码语法检查通过，政治规则补丁反向校验通过。"
if [ "$RESTART" = "1" ]; then
  systemctl --user restart qq-agent-linux
  echo "已重启 qq-agent-linux。"
else
  echo "尚未重启；确认后执行：systemctl --user restart qq-agent-linux"
fi
