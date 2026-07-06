#!/bin/bash
# RPT robot — держит обратный SSH-туннель до hub и шлёт heartbeat.
# Конфиг монтируется в /data (с хоста /etc/rpt-robot).
set -e

CONF=/data/robot.env
RUNTIME=/data/runtime.env

if [ ! -f "$CONF" ] || [ ! -f "$RUNTIME" ]; then
    echo "[robot] Нет конфигурации ($CONF / $RUNTIME). Сначала выполните: rptctl sync"
    # не выходим сразу, чтобы docker restart не крутил в бесконечном цикле слишком быстро
    sleep 30
    exit 1
fi

# shellcheck disable=SC1090
. "$CONF"
. "$RUNTIME"

: "${SERVER_HOST:?}"; : "${HUB_PORT:?}"; : "${ASSIGNED_PORT:?}"

# ---- known_hosts для проверки хоста хаба ----
if [ -n "$HUB_HOSTKEY" ]; then
    echo "[${SERVER_HOST}]:${HUB_PORT} ${HUB_HOSTKEY}" > /data/known_hosts
    chmod 644 /data/known_hosts
fi

# ---- heartbeat в фоне ----
heartbeat() {
    [ -z "$WEB_URL" ] && return
    while true; do
        curl -fsS -m 8 -X POST "${WEB_URL}/api/heartbeat" \
            -H "Content-Type: application/json" \
            -d "{\"enroll_id\": ${ENROLL_ID:-0}, \"token\": \"${TOKEN:-}\"}" \
            >/dev/null 2>&1 || true
        sleep 30
    done
}
heartbeat &

echo "[robot] Туннель: rtunnel@${SERVER_HOST}:${HUB_PORT}  ->  порт ${ASSIGNED_PORT} -> localhost:22"

export AUTOSSH_GATETIME=0
exec autossh -M 0 -N \
    -o "ServerAliveInterval=20" \
    -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -o "StrictHostKeyChecking=${HOSTKEY_CHECK:-accept-new}" \
    -o "UserKnownHostsFile=/data/known_hosts" \
    -o "IdentitiesOnly=yes" \
    -i /data/tunnel_key \
    -R "0.0.0.0:${ASSIGNED_PORT}:localhost:22" \
    -p "${HUB_PORT}" \
    "rtunnel@${SERVER_HOST}"
