#!/usr/bin/env bash
# alive-voice worker 容器编排唯一入口。start-all.sh / var/restart_agent.sh 都调这里。
# 只碰 alive-voice-worker 一个容器；不碰 sherpa / VoxCPM / LiveKit / vup-team / baseline。
#
# 回退到裸机 venv 的一行命令见 alive/voice/start-all.sh 头注释。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE="$HERE/docker-compose.yml"
LOG="${ALIVE_LOG_DIR:-$HOME/.alive/logs}/agent.log"
EV="$REPO_ROOT/var/voice-evidence/t_abbf56c0/logs"
mkdir -p "$(dirname "$LOG")" "$EV"

c() { docker compose -f "$COMPOSE" "$@"; }

case "${1:-status}" in
  up)
    c up -d
    ;;
  down)
    c down
    ;;
  restart)
    # 冷启动语义：停容器（旧进程释放日志 fd）→ 归档 + truncate 同一 inode →
    # 起容器（新进程重新 open append），确保 harness 的 seek(offset) 从 0 读到
    # 新一轮 registered worker / [latency] 行，而不是命中上一轮残留的历史行。
    if [ -n "$(c ps -q alive-voice-worker 2>/dev/null || true)" ]; then
      c stop -t 25 alive-voice-worker
    fi
    if [ -s "$LOG" ]; then
      cp -a "$LOG" "$EV/agent.log.$(date +%H%M%S).bak" 2>/dev/null || true
      : > "$LOG"   # truncate in place：inode 不变，append 写入无稀疏洞
    fi
    c up -d alive-voice-worker
    ;;
  status)
    c ps
    ;;
  logs)
    c logs --tail "${2:-80}" alive-voice-worker
    ;;
  *)
    echo "usage: $0 {up|down|restart|status|logs}" >&2
    exit 2
    ;;
esac
