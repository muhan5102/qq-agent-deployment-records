#!/usr/bin/env bash
# 补丁链演练：验证"升级后能不能靠 apply-patches.sh 把本仓库补丁完整重打上去"。
#
# 升级（deploy-all.sh 的 rsync --delete）会把 app/ 整树换成上游版本，所有补丁都要重新打。
# 这个演练**只动临时目录、不碰线上代码**：把补丁涉及的源码复制一份，
#   ① 逆序反向应用 → 还原成上游原样；
#   ② 正序正向重打 → 回到补丁齐全的状态；
#   ③ 与线上文件逐字节比对（md5）。
# 任何一步对不上就报出来并退出非 0 —— 说明补丁顺序/上下文/登记有问题，别等升级当天才发现。
#
# 用法：
#   bash scripts/patch-replay-drill.sh
# 可用环境变量覆盖：
#   APP_DIR   部署目录里的 app（默认 /mnt/data/qq-agent/app）
#   PATCH_DIR 补丁目录（默认 /mnt/data/qq-agent）
set -uo pipefail

APP_DIR="${APP_DIR:-/mnt/data/qq-agent/app}"
PATCH_DIR="${PATCH_DIR:-/mnt/data/qq-agent}"

[ -d "$APP_DIR" ] || { echo "找不到 APP_DIR：$APP_DIR" >&2; exit 2; }
[ -f "$PATCH_DIR/apply-patches.sh" ] || { echo "找不到 $PATCH_DIR/apply-patches.sh" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mapfile -t ENTRIES < <(grep -oE '"[^"]+\.diff\|[^"]+"' "$PATCH_DIR/apply-patches.sh" | tr -d '"')
if [ "${#ENTRIES[@]}" -eq 0 ]; then
  echo "没从 apply-patches.sh 里读到补丁清单" >&2
  exit 2
fi
echo "清单：${#ENTRIES[@]} 条补丁"

# 收集所有补丁涉及的文件（多文件补丁也要覆盖：只登记一个 target，不代表只改一个文件）
files_raw=()
for item in "${ENTRIES[@]}"; do
  diff_file="${item%%|*}"
  if [ ! -f "$PATCH_DIR/$diff_file" ]; then
    echo "缺补丁文件：$diff_file" >&2
    exit 2
  fi
  while IFS= read -r p; do files_raw+=("$p"); done < <(
    grep -oE '^\+\+\+ b/[^ 	]+' "$PATCH_DIR/$diff_file" | sed 's|^+++ b/||' | sort -u
  )
done
mapfile -t FILES < <(printf '%s\n' "${files_raw[@]}" | sort -u)
echo "涉及文件：${#FILES[@]} 个"

mkdir -p "$WORK/app"
for f in "${FILES[@]}"; do
  if [ ! -f "$APP_DIR/$f" ]; then
    echo "线上没有这个文件（上游可能改名/删了）：$f" >&2
    exit 1
  fi
  mkdir -p "$WORK/app/$(dirname "$f")"
  cp -p "$APP_DIR/$f" "$WORK/app/$f"
done

cd "$WORK/app" || exit 2

echo "-- ① 逆序反向应用（还原成上游原样）--"
for ((i = ${#ENTRIES[@]} - 1; i >= 0; i--)); do
  item="${ENTRIES[$i]}"
  diff_file="${item%%|*}"
  if patch -p1 -R --batch --forward <"$PATCH_DIR/$diff_file" >/dev/null 2>&1; then
    echo "   ok  $diff_file"
  else
    echo "   ✗   反向失败：$diff_file" >&2
    exit 1
  fi
done

echo "-- ② 正序正向重打（模拟升级后重打）--"
for item in "${ENTRIES[@]}"; do
  diff_file="${item%%|*}"
  if patch -p1 --batch --forward <"$PATCH_DIR/$diff_file" >/dev/null 2>&1; then
    echo "   ok  $diff_file"
  else
    echo "   ✗   正向失败：$diff_file" >&2
    exit 1
  fi
done

echo "-- ③ 与线上逐字节比对 --"
bad=0
for f in "${FILES[@]}"; do
  a="$(md5sum "$APP_DIR/$f" | cut -d' ' -f1)"
  b="$(md5sum "$WORK/app/$f" | cut -d' ' -f1)"
  if [ "$a" = "$b" ]; then
    echo "   ok  $f"
  else
    echo "   ✗   内容不一致：$f（线上 ${a:0:8} / 重打 ${b:0:8}）" >&2
    bad=$((bad + 1))
  fi
done

if [ "$bad" -gt 0 ]; then
  echo
  echo "演练失败：$bad 个文件对不上，先修补丁再升级。" >&2
  exit 1
fi

echo
echo "演练通过：${#ENTRIES[@]} 条补丁可以完整反向还原并正向重打，${#FILES[@]} 个文件逐字节一致。"
