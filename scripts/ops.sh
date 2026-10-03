#!/usr/bin/env bash
#
# QQ Agent 日常运维封装（在服务器上以 admin 用户运行）
#
# 用法：bash ops.sh <子命令> [参数]
#
# 只读子命令：status / login / ports / res / logs / health / token / version
# 变更子命令：restart-agent / pause / activate / backup-config / restore-config
# 提示子命令：qr-steps（只打印扫码恢复流程，不执行任何操作）
#
# 安全边界：本脚本不重启协议端容器、不重启服务器。这两件事会掉 QQ 登录态，
# 只有在登录已经掉线时才值得做，流程见 qr-steps 与仓库《QQ机器人-运维速查.md》第六节。
#
# 路径可用环境变量覆盖：QQBOT_APP_DIR / QQBOT_DATA_DIR / QQBOT_ACCESS_FILE

set -uo pipefail

APP_DIR="${QQBOT_APP_DIR:-/mnt/data/qq-agent/app}"
DATA_DIR="${QQBOT_DATA_DIR:-/mnt/data/qq-agent/data}"
ACCESS_FILE="${QQBOT_ACCESS_FILE:-/mnt/data/qq-agent/deployment-access.txt}"
CONTAINER="${QQBOT_CONTAINER:-qq-agent-snowluma}"
SERVICE="${QQBOT_SERVICE:-qq-agent-linux}"

die() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

need_manage() {
  [ -f "$APP_DIR/manage.sh" ] || die "找不到 $APP_DIR/manage.sh"
}

onebot_token() {
  [ -f "$ACCESS_FILE" ] || die "找不到凭据文件 $ACCESS_FILE"
  sudo awk -F': ' '/OneBot token:/{print $2}' "$ACCESS_FILE"
}

cmd_status() {
  printf '== 服务 ==\n'
  systemctl --user is-active "$SERVICE" || true
  systemctl --user is-enabled "$SERVICE" || true
  printf '\n== 协议端容器 ==\n'
  sudo docker ps --filter "name=$CONTAINER" --format '{{.Status}}' || true
  printf '\n== 登录态 ==\n'
  cmd_login
}

cmd_login() {
  local token
  token="$(onebot_token)"
  curl -sS -m 10 \
    -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d '{}' http://127.0.0.1:3000/get_login_info 2>/dev/null \
    || printf '（取不到登录信息：协议端未就绪，或 QQ 未登录）\n'
  printf '\n'
}

cmd_ports() {
  ss -ltn 2>/dev/null | grep -E ':3210|:5099|:6081|:3000|:3001' || echo '没有监听'
}

cmd_res() {
  free -m | head -2
  df -h / | tail -1
}

cmd_logs() {
  local lines="${1:-100}"
  journalctl --user -u "$SERVICE" -n "$lines" --no-pager
}

cmd_health() {
  need_manage
  ( cd "$APP_DIR" && bash manage.sh health )
}

cmd_token() {
  need_manage
  ( cd "$APP_DIR" && bash manage.sh token )
}

cmd_version() {
  [ -f "$APP_DIR/package.json" ] || die "找不到 $APP_DIR/package.json"
  printf 'qq-agent-plus：%s\n' "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -1)"
  sudo docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -i snowluma || true
}

cmd_restart_agent() {
  systemctl --user restart "$SERVICE"
  sleep 2
  systemctl --user is-active "$SERVICE" || true
  printf '注意：这里只重启机器人主体，不影响 QQ 登录态。\n'
}

cmd_pause() {
  need_manage
  ( cd "$APP_DIR" && bash manage.sh pause )
}

cmd_activate() {
  need_manage
  ( cd "$APP_DIR" && bash manage.sh activate --confirm-exclusive )
}

cmd_backup_config() {
  local suffix="${1:-manual}"
  local src="$DATA_DIR/config.json"
  local dst="$DATA_DIR/config.json.bak-$suffix"
  [ -f "$src" ] || die "找不到 $src"
  [ -e "$dst" ] && die "目标已存在：$dst"
  sudo cp "$src" "$dst"
  printf '已备份：%s\n' "$dst"
}

cmd_restore_config() {
  local suffix="${1:-}"
  [ -n "$suffix" ] || die "用法：ops.sh restore-config <备份后缀>（备份清单见第三节）"
  local src="$DATA_DIR/config.json.bak-$suffix"
  [ -f "$src" ] || die "找不到 $src"
  printf '即将用 %s 覆盖 config.json，并重启机器人主体（不影响 QQ 登录态）。\n' "$src"
  printf '确认请输入 yes：'
  read -r reply
  [ "$reply" = "yes" ] || die "已取消"
  sudo cp "$src" "$DATA_DIR/config.json"
  sudo chown admin:admin "$DATA_DIR/config.json"
  sudo chmod 600 "$DATA_DIR/config.json"
  systemctl --user restart "$SERVICE"
  sleep 2
  systemctl --user is-active "$SERVICE" || true
}

cmd_qr_steps() {
  cat <<'STEPS'
QQ 掉登录后的恢复流程（仅当登录确实已掉线时执行）：

1) 重启协议端容器，让协议端重新注入 hook
     sudo docker restart qq-agent-snowluma
     sleep 20 && sudo docker ps --filter name=qq-agent-snowluma --format '{{.Status}}'

2) 取出 noVNC 密码
     sudo grep noVNC /mnt/data/qq-agent/deployment-access.txt

3) 在云控制台防火墙中临时启用 6081，然后浏览器打开
     http://<SERVER_IP>:6081
   输入 noVNC 密码，用机器人小号扫码登录

4) 验证登录态，返回 "retcode":0 即为正常
     bash ops.sh login

5) 把 6081 改回禁用

提醒：重启容器与重启服务器都会掉登录态；登录没掉时不要做这两件事。
STEPS
}

usage() {
  cat <<'USAGE'
QQ Agent 运维脚本

  bash ops.sh status              服务、容器与登录态总览
  bash ops.sh login               查询 QQ 登录态（get_login_info）
  bash ops.sh ports               查看端口监听
  bash ops.sh res                 内存与磁盘
  bash ops.sh logs [行数]         最近日志（默认 100 行）
  bash ops.sh health              项目自带健康检查
  bash ops.sh token               打印控制台 token
  bash ops.sh version             程序版本与协议端镜像
  bash ops.sh restart-agent       重启机器人主体（不影响登录态）
  bash ops.sh pause               暂停发言（仍记录消息）
  bash ops.sh activate            恢复发言
  bash ops.sh backup-config [后缀]        备份 config.json
  bash ops.sh restore-config <后缀>       从备份恢复并重启主体
  bash ops.sh qr-steps            打印扫码恢复流程（不执行）
USAGE
}

case "${1:-}" in
  status)         cmd_status ;;
  login)          cmd_login ;;
  ports)          cmd_ports ;;
  res)            cmd_res ;;
  logs)           shift; cmd_logs "${1:-100}" ;;
  health)         cmd_health ;;
  token)          cmd_token ;;
  version)        cmd_version ;;
  restart-agent)  cmd_restart_agent ;;
  pause)          cmd_pause ;;
  activate)       cmd_activate ;;
  backup-config)  shift; cmd_backup_config "${1:-manual}" ;;
  restore-config) shift; cmd_restore_config "${1:-}" ;;
  qr-steps)       cmd_qr_steps ;;
  ""|-h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
