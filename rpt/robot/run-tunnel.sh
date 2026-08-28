#!/bin/bash
# RPT robot — нативный запуск обратного туннеля (без Docker).
# Запускается systemd-юнитом rpt-tunnel.service. Держит autossh + heartbeat.
set -e

CONF=/etc/rpt-robot/robot.env
RUNTIME=/etc/rpt-robot/runtime.env

# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
# shellcheck disable=SC1090
[ -f "$RUNTIME" ] && . "$RUNTIME"

: "${SERVER_HOST:?нет SERVER_HOST — выполните rptctl sync}"
: "${HUB_PORT:?нет HUB_PORT}"
: "${ASSIGNED_PORT:?нет ASSIGNED_PORT — робот не одобрен? выполните rptctl sync}"

# known_hosts для проверки подлинности хаба
if [ -n "${HUB_HOSTKEY:-}" ]; then
    echo "[${SERVER_HOST}]:${HUB_PORT} ${HUB_HOSTKEY}" > /etc/rpt-robot/known_hosts
    chmod 644 /etc/rpt-robot/known_hosts
fi

# heartbeat в фоне (пока жив туннель)
if [ -n "${WEB_URL:-}" ]; then
    (
        while true; do
            curl -fsS -m 8 -X POST "${WEB_URL}/api/heartbeat" \
                -H "Content-Type: application/json" \
                -d "{\"enroll_id\": ${ENROLL_ID:-0}, \"token\": \"${TOKEN:-}\"}" \
                >/dev/null 2>&1 || true
            sleep 30
        done
    ) &
    HB=$!
    trap 'kill $HB 2>/dev/null || true' EXIT
fi

echo "[robot] Туннель: rtunnel@${SERVER_HOST}:${HUB_PORT} -> порт ${ASSIGNED_PORT} -> localhost:22"

export AUTOSSH_GATETIME=0
exec autossh -M 0 -N \
    -o "ServerAliveInterval=20" \
    -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -o "StrictHostKeyChecking=${HOSTKEY_CHECK:-accept-new}" \
    -o "UserKnownHostsFile=/etc/rpt-robot/known_hosts" \
    -o "IdentitiesOnly=yes" \
    -i /etc/rpt-robot/tunnel_key \
    -R "0.0.0.0:${ASSIGNED_PORT}:localhost:22" \
    -p "${HUB_PORT}" \
    "rtunnel@${SERVER_HOST}"
