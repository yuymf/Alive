#!/usr/bin/env bash
# 一条命令起 Alive 全双工语音三件套：VoxCPM2 TTS 侧车 / LiveKit 服务器 / agent worker。
#
# 用法：
#   alive/voice/start-all.sh start     # 启动（已跑的跳过）+ 等健康 + 预热模型
#   alive/voice/start-all.sh stop      # 停三件套
#   alive/voice/start-all.sh status    # 看 pid / 端口 / 健康
#   alive/voice/start-all.sh warmup    # 只跑一次合成，量首字耗时
#
# 配置来源（按顺序 overlay，后者覆盖前者）：本目录 voice.env → $ALIVE_HOME/.env → 进程环境。
# voice.env 随仓库走（只有本机地址与 LiveKit dev 默认账密），用户私有覆盖放 $ALIVE_HOME/.env。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ALIVE_HOME="${ALIVE_HOME:-$HOME/.alive}"
RUN_DIR="${ALIVE_RUN_DIR:-$ALIVE_HOME/run}"
LOG_DIR="${ALIVE_LOG_DIR:-$ALIVE_HOME/logs}"
PY="${ALIVE_PY:-$REPO_ROOT/.venv-voice/bin/python}"
mkdir -p "$RUN_DIR" "$LOG_DIR"

for f in "$HERE/voice.env" "$ALIVE_HOME/.env"; do
  if [ -f "$f" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$f"
    set +a
  fi
done

: "${VOXCPM_HOST:=127.0.0.1}"
: "${VOXCPM_PORT:=8801}"
: "${VOXCPM_MODEL:=/mnt/data/models/VoxCPM2}"
: "${VOXCPM_CUDA:=1}"
: "${LIVEKIT_BIND:=127.0.0.1}"
: "${LIVEKIT_NODE_IP:=127.0.0.1}"
: "${LIVEKIT_URL:=ws://127.0.0.1:7880}"
: "${LIVEKIT_API_KEY:=devkey}"
: "${LIVEKIT_API_SECRET:=secret}"
: "${LIVEKIT_WORKER_PORT:=8081}"
: "${VOXCPM_URL:=http://127.0.0.1:$VOXCPM_PORT}"
: "${WARMUP_TEXT:=你好，我是你的语音助手。}"
export VOXCPM_HOST VOXCPM_PORT VOXCPM_MODEL VOXCPM_URL LIVEKIT_URL LIVEKIT_API_KEY \
  LIVEKIT_API_SECRET LIVEKIT_WORKER_PORT

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# 端口反查真实监听进程 pid：setsid 后 $! 可能不是最终进程，pid 文件以端口为准最可靠。
pid_of_port() { ss -tlnp 2>/dev/null | grep -E ":$1\b" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

health_voxcpm() { curl -sS --noproxy '*' -m 5 "http://$VOXCPM_HOST:$VOXCPM_PORT/health"; }
health_livekit() { curl -sS --noproxy '*' -m 5 -o /dev/null -w '%{http_code}' "http://$LIVEKIT_BIND:7880/"; }

start_voxcpm() {
  if pid_alive "$RUN_DIR/voxcpm.pid"; then
    echo "[voxcpm] already running pid=$(cat "$RUN_DIR/voxcpm.pid")"
  else
    echo "[voxcpm] starting on $VOXCPM_HOST:$VOXCPM_PORT (model=$VOXCPM_MODEL, CUDA_VISIBLE_DEVICES=$VOXCPM_CUDA)"
    CUDA_VISIBLE_DEVICES="$VOXCPM_CUDA" setsid nohup "$PY" "$HERE/voxcpm/server.py" \
      >"$LOG_DIR/voxcpm.log" 2>&1 &
    echo $! >"$RUN_DIR/voxcpm.pid"
  fi
  for _ in $(seq 1 60); do
    if health_voxcpm >/dev/null 2>&1; then
      local lp; lp=$(pid_of_port "$VOXCPM_PORT"); [ -n "$lp" ] && echo "$lp" >"$RUN_DIR/voxcpm.pid"
      echo "[voxcpm] health ok: $(health_voxcpm) pid=$(cat "$RUN_DIR/voxcpm.pid")"
      return 0
    fi
    sleep 1
  done
  echo "[voxcpm] health 超时，见 $LOG_DIR/voxcpm.log" >&2
  return 1
}

start_livekit() {
  if pid_alive "$RUN_DIR/livekit.pid"; then
    echo "[livekit] already running pid=$(cat "$RUN_DIR/livekit.pid")"
  else
    echo "[livekit] starting on $LIVEKIT_BIND:7880 --dev (node-ip=$LIVEKIT_NODE_IP)"
    setsid nohup livekit-server --dev --bind "$LIVEKIT_BIND" --node-ip "$LIVEKIT_NODE_IP" \
      >"$LOG_DIR/livekit.log" 2>&1 &
    echo $! >"$RUN_DIR/livekit.pid"
  fi
  for _ in $(seq 1 30); do
    if [ "$(health_livekit 2>/dev/null || true)" = "200" ]; then
      local lp; lp=$(pid_of_port 7880); [ -n "$lp" ] && echo "$lp" >"$RUN_DIR/livekit.pid"
      echo "[livekit] http://$LIVEKIT_BIND:7880/ → 200 pid=$(cat "$RUN_DIR/livekit.pid")"
      return 0
    fi
    sleep 1
  done
  echo "[livekit] 起不来，见 $LOG_DIR/livekit.log" >&2
  return 1
}

warmup() {
  echo "[warmup] 首次合成（含模型加载/编译，可能要几分钟）→ 文本: $WARMUP_TEXT"
  local t0 t1 out
  t0=$(date +%s.%N)
  out=$(curl -sS --noproxy '*' -m 900 -o "$RUN_DIR/warmup.pcm" -w '%{http_code}' \
    -X POST "http://$VOXCPM_HOST:$VOXCPM_PORT/v1/audio/speech" \
    -H 'Content-Type: application/json' \
    -d "{\"input\":\"$WARMUP_TEXT\",\"voice\":\"default\"}")
  t1=$(date +%s.%N)
  if [ "$out" != "200" ]; then
    echo "[warmup] 失败 http=$out，见 $LOG_DIR/voxcpm.log" >&2
    return 1
  fi
  echo "[warmup] http=$out bytes=$(stat -c%s "$RUN_DIR/warmup.pcm") seconds=$(echo "$t1 - $t0" | bc)"
}

start_agent() {
  if pid_alive "$RUN_DIR/agent.pid"; then
    echo "[agent] already running pid=$(cat "$RUN_DIR/agent.pid")"
  else
    echo "[agent] starting worker (port $LIVEKIT_WORKER_PORT, url $LIVEKIT_URL)"
    ( cd "$HERE/agent" && setsid nohup "$PY" agent.py dev >"$LOG_DIR/agent.log" 2>&1 & echo $! >"$RUN_DIR/agent.pid" )
  fi
  for _ in $(seq 1 90); do
    if grep -qE "registered worker|registered.*worker" "$LOG_DIR/agent.log" 2>/dev/null; then
      local lp; lp=$(pid_of_port "$LIVEKIT_WORKER_PORT"); [ -n "$lp" ] && echo "$lp" >"$RUN_DIR/agent.pid"
      echo "[agent] registered: $(grep -E 'registered worker' "$LOG_DIR/agent.log" | tail -1) pid=$(cat "$RUN_DIR/agent.pid")"
      return 0
    fi
    sleep 1
  done
  echo "[agent] 没等到注册，见 $LOG_DIR/agent.log" >&2
  return 1
}

stop_one() {
  local name="$1" pidfile="$RUN_DIR/$1.pid"
  if pid_alive "$pidfile"; then
    local p; p=$(cat "$pidfile")
    echo "[$name] stopping pid=$p"
    kill "$p" 2>/dev/null || true
    for _ in $(seq 1 20); do pid_alive "$pidfile" || break; sleep 0.5; done
    pid_alive "$pidfile" && { echo "[$name] 未退出，SIGKILL"; kill -9 "$p" 2>/dev/null || true; }
  else
    echo "[$name] not running"
  fi
  rm -f "$pidfile"
}

status() {
  for n in voxcpm livekit agent; do
    if pid_alive "$RUN_DIR/$n.pid"; then echo "$n: pid=$(cat "$RUN_DIR/$n.pid")"; else echo "$n: down"; fi
  done
  ss -tlnp 2>/dev/null | grep -E ":($VOXCPM_PORT|7880|7881|$LIVEKIT_WORKER_PORT)\b" || true
  echo "voxcpm health: $(health_voxcpm 2>/dev/null || echo down)"
}

case "${1:-start}" in
  start) start_voxcpm; start_livekit; warmup; start_agent; status ;;
  stop) stop_one agent; stop_one livekit; stop_one voxcpm ;;
  restart) "$0" stop; "$0" start ;;
  status) status ;;
  warmup) warmup ;;
  *) echo "用法: $0 {start|stop|restart|status|warmup}" >&2; exit 2 ;;
esac
