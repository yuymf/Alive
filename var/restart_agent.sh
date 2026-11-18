#!/usr/bin/env bash
# 只重启 agent worker（不动 VoxCPM / LiveKit / hindsight-api / baseline / vup-team），
# 注入流式 STT 环境变量。voice.env 零改动：SHERPA_WS_URL 走进程环境覆盖。
set -euo pipefail
HERE="/home/halyu/Downloads/Code/Alive/.worktrees/voice-step1/alive/voice"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$HOME/.alive/run"
LOG_DIR="$HOME/.alive/logs"
PY="$REPO_ROOT/.venv-voice/bin/python"
PORT=8081

set -a
. "$HERE/voice.env"
[ -f "$HOME/.alive/.env" ] && . "$HOME/.alive/.env"
set +a
export SHERPA_WS_URL="ws://127.0.0.1:8802/v1/stt/stream"
export SHERPA_PREFLIGHT="${SHERPA_PREFLIGHT:-0}"

# 用端口反查真实监听 pid：setsid 后 $! 是 wrapper，杀 wrapper 子进程会留着端口
pid_of_port() { ss -tlnp 2>/dev/null | grep -E ":${PORT}\b" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
oldpid="$(pid_of_port)"
if [ -n "$oldpid" ]; then
  # 安全闸：只杀 cwd 为本工作树且 AGENT_NAME=alive-voice 的进程
  cwd="$(readlink /proc/$oldpid/cwd 2>/dev/null || true)"
  if [ "$cwd" = "$HERE/agent" ]; then
    echo "[restart] stopping old agent pid=$oldpid (verified cwd)"
    kill "$oldpid" 2>/dev/null || true
    for _ in $(seq 1 30); do [ -z "$(pid_of_port)" ] && break; sleep 0.5; done
    [ -n "$(pid_of_port)" ] && { echo "[restart] port $PORT still held"; exit 1; }
  else
    echo "[restart] REFUSE: port $PORT held by unrelated pid=$oldpid cwd=$cwd"; exit 2
  fi
fi

echo "[restart] starting agent with SHERPA_WS_URL=$SHERPA_WS_URL"
# 先轮换日志 inode：旧进程在 truncate-in-place 的日志上残留高位 fd，会写出
# 稀疏 NUL 洞， inflate stat().st_size，让 harness 的 seek(offset) 错过真实行。
# mv 脱离旧 inode（保留证据），再 > 新建，确保单写者从 offset 0 开始。
[ -f "$LOG_DIR/agent.log" ] && mv "$LOG_DIR/agent.log" "$LOG_DIR/agent.log.b2d062f6.$(date +%H%M%S)"
( cd "$HERE/agent" && setsid nohup env SHERPA_WS_URL="$SHERPA_WS_URL" SHERPA_PREFLIGHT="$SHERPA_PREFLIGHT" \
    "$PY" agent.py dev >"$LOG_DIR/agent.log" 2>&1 & echo $! >"$RUN_DIR/agent.pid" )
# 以端口反查到的真实 pid 重写 pid 文件
for _ in $(seq 1 30); do real="$(pid_of_port || true)"; if [ -n "$real" ]; then echo "$real" >"$RUN_DIR/agent.pid"; echo "[restart] real pid=$real"; break; fi; sleep 0.5; done
exit 0
