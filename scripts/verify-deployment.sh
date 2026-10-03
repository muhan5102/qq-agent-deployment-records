#!/usr/bin/env bash
#
# 部署自检：逐项检查运行状态并给出结论（只读，不做任何修改）
#
# 用法：bash verify-deployment.sh
#
# 注意：账号处于养号期时，Agent 服务是停着的、QQ 也未登录，
# 此时「服务」与「登录态」两项判定为“未运行”属于预期状态，不是故障。

set -uo pipefail

APP_DIR="${QQBOT_APP_DIR:-/mnt/data/qq-agent/app}"
ACCESS_FILE="${QQBOT_ACCESS_FILE:-/mnt/data/qq-agent/deployment-access.txt}"
CONTAINER="${QQBOT_CONTAINER:-qq-agent-snowluma}"
SERVICE="${QQBOT_SERVICE:-qq-agent-linux}"

pass=0
fail=0
warn=0

line() { printf '%s：%s\n' "$1" "$2"; }

check_service() {
  local state
  state="$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)"
  if [ "$state" = "active" ]; then
    line "机器人服务" "运行中 ($state)"
    pass=$((pass + 1))
  elif [ "$state" = "inactive" ]; then
    line "机器人服务" "未运行（养号期停用属预期）"
    warn=$((warn + 1))
  else
    line "机器人服务" "异常 ($state)"
    fail=$((fail + 1))
  fi
  line "开机自启" "$(systemctl --user is-enabled "$SERVICE" 2>/dev/null || echo '未启用')"
}

check_container() {
  local status
  status="$(sudo docker ps --filter "name=$CONTAINER" --format '{{.Status}}' 2>/dev/null || true)"
  if [ -n "$status" ]; then
    line "协议端容器" "$status"
    pass=$((pass + 1))
  else
    line "协议端容器" "未运行"
    fail=$((fail + 1))
  fi
}

check_login() {
  if [ ! -f "$ACCESS_FILE" ]; then
    line "QQ 登录态" "缺少凭据文件，跳过"
    warn=$((warn + 1))
    return
  fi
  local token reply
  token="$(sudo awk -F': ' '/OneBot token:/{print $2}' "$ACCESS_FILE")"
  reply="$(curl -sS -m 10 -H "authorization: Bearer $token" \
    -H 'content-type: application/json' -d '{}' \
    http://127.0.0.1:3000/get_login_info 2>/dev/null || true)"
  if printf '%s' "$reply" | grep -q '"retcode":0'; then
    line "QQ 登录态" "正常（retcode=0）"
    pass=$((pass + 1))
  else
    line "QQ 登录态" "未登录或协议端未就绪"
    warn=$((warn + 1))
  fi
}

check_ports() {
  local listening
  listening="$(ss -ltn 2>/dev/null | grep -cE ':3000|:3001' || true)"
  if [ "${listening:-0}" -ge 2 ]; then
    line "OneBot 端口" "3000/3001 已监听"
    pass=$((pass + 1))
  else
    line "OneBot 端口" "未监听（协议端未就绪）"
    warn=$((warn + 1))
  fi
}

check_version() {
  if [ -f "$APP_DIR/package.json" ]; then
    line "程序版本" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -1)"
    pass=$((pass + 1))
  else
    line "程序版本" "找不到 package.json"
    fail=$((fail + 1))
  fi
}

printf '部署自检（%s）\n\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
check_service
check_container
check_login
check_ports
check_version

printf '\n通过 %d 项，注意 %d 项，失败 %d 项\n' "$pass" "$warn" "$fail"
[ "$fail" -eq 0 ]
