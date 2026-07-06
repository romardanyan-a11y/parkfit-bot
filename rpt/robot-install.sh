#!/usr/bin/env bash
###############################################################################
#  RPT robot-install.sh
#
#  Установщик РОБОТА. Запускать НА РОБОТЕ ОТ ROOT:
#     sudo bash robot-install.sh
#
#  Что делает:
#    1. спрашивает серийник и название робота;
#    2. создаёт пользователя (по умолчанию RM / 536yfj67) с sudo-правами;
#    3. ставит зависимости (docker, curl, jq, openssh-server);
#    4. включает host sshd (в него будет заходить админ через туннель);
#    5. разворачивает контейнер обратного туннеля (/opt/rpt-robot);
#    6. ставит консоль управления rptctl;
#    7. запускает синхронизацию ключей с сервером (rptctl sync).
#
#  Скрипт самодостаточен — файлы туннеля он создаёт сам.
###############################################################################
set -euo pipefail

C_G='\033[32m'; C_R='\033[31m'; C_Y='\033[33m'; C_B='\033[36m'; C_0='\033[0m'
ok()   { echo -e "${C_G}✔${C_0} $*"; }
info() { echo -e "${C_B}»${C_0} $*"; }
warn() { echo -e "${C_Y}!${C_0} $*"; }
die()  { echo -e "${C_R}✖${C_0} $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Запустите от root:  sudo bash robot-install.sh"

CONF_DIR=/etc/rpt-robot
APP_DIR=/opt/rpt-robot

echo -e "${C_B}==================== RPT · установка РОБОТА ====================${C_0}"

# --------------------------------------------------------------------------
# 1. Опрос параметров
# --------------------------------------------------------------------------
read -rp "Серийный номер робота (SN): " SERIAL
[ -n "$SERIAL" ] || die "Серийник обязателен"
read -rp "Название робота [$SERIAL]: " NAME; NAME="${NAME:-$SERIAL}"

read -rp "Имя пользователя сессии [RM]: " SSH_USER; SSH_USER="${SSH_USER:-RM}"
read -rp "Пароль пользователя $SSH_USER [536yfj67]: " SSH_PASS; SSH_PASS="${SSH_PASS:-536yfj67}"

read -rp "Адрес/IP центрального сервера: " SERVER_HOST
[ -n "$SERVER_HOST" ] || die "Адрес сервера обязателен"
read -rp "Порт веб-панели сервера [8443]: " WEB_PORT; WEB_PORT="${WEB_PORT:-8443}"
read -rp "Порт SSH-хаба сервера [2222]: " HUB_PORT; HUB_PORT="${HUB_PORT:-2222}"

WEB_URL="http://${SERVER_HOST}:${WEB_PORT}"

echo
info "SN=$SERIAL  имя=$NAME  пользователь=$SSH_USER"
info "сервер=$SERVER_HOST  web=$WEB_PORT  hub=$HUB_PORT"
read -rp "Продолжить установку? [Y/n]: " yn; case "${yn:-Y}" in [Nn]*) exit 0;; esac

# --------------------------------------------------------------------------
# 2. Зависимости
# --------------------------------------------------------------------------
info "Проверка зависимостей..."
PKG=""
command -v apt-get >/dev/null && PKG=apt
command -v dnf     >/dev/null && PKG="${PKG:-dnf}"
command -v yum     >/dev/null && PKG="${PKG:-yum}"

install_pkgs() {
  case "$PKG" in
    apt) apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
    *)   warn "Неизвестный менеджер пакетов — установите вручную: $*" ;;
  esac
}

command -v curl        >/dev/null || install_pkgs curl
command -v jq          >/dev/null || install_pkgs jq
command -v ssh-keygen  >/dev/null || install_pkgs openssh-client
command -v sshd        >/dev/null || install_pkgs openssh-server || \
    install_pkgs openssh || true

# Docker
if ! command -v docker >/dev/null; then
  info "Устанавливаю Docker..."
  curl -fsSL https://get.docker.com | sh || die "Не удалось установить Docker"
fi
systemctl enable --now docker 2>/dev/null || true
docker compose version >/dev/null 2>&1 || warn "docker compose v2 не найден — обновите Docker"
ok "Зависимости готовы"

# --------------------------------------------------------------------------
# 3. Пользователь сессии
# --------------------------------------------------------------------------
if id "$SSH_USER" >/dev/null 2>&1; then
  warn "Пользователь $SSH_USER уже существует — обновляю пароль и права"
else
  useradd -m -s /bin/bash "$SSH_USER"
  ok "Создан пользователь $SSH_USER"
fi
echo "${SSH_USER}:${SSH_PASS}" | chpasswd
ok "Пароль установлен"

# sudo-группа (wheel в RHEL, sudo в Debian)
if getent group sudo >/dev/null; then usermod -aG sudo "$SSH_USER"; fi
if getent group wheel >/dev/null; then usermod -aG wheel "$SSH_USER"; fi
# sudo без пароля — чтобы админ через веб-терминал мог запускать sudo-команды
echo "${SSH_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/rpt-${SSH_USER}"
chmod 440 "/etc/sudoers.d/rpt-${SSH_USER}"
ok "Права sudo (NOPASSWD) выданы пользователю $SSH_USER"

# --------------------------------------------------------------------------
# 4. host sshd
# --------------------------------------------------------------------------
info "Настройка sshd робота..."
if command -v sshd >/dev/null; then
  # включаем аутентификацию по ключу (админ ходит по admin-ключу сервера)
  SSHDCFG=/etc/ssh/sshd_config
  if [ -f "$SSHDCFG" ]; then
    sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSHDCFG" || true
  fi
  systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || \
    service ssh start 2>/dev/null || true
  ok "sshd робота запущен"
else
  warn "sshd не установлен — установите openssh-server вручную"
fi

# --------------------------------------------------------------------------
# 5. Файлы туннеля
# --------------------------------------------------------------------------
info "Разворачиваю файлы туннеля в $APP_DIR ..."
mkdir -p "$APP_DIR" "$CONF_DIR"
chmod 700 "$CONF_DIR"

# Если скрипт лежит рядом с каталогом robot/ (из репозитория) — берём оттуда,
# иначе создаём файлы из встроенных шаблонов.
SELF_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [ -d "$SELF_DIR/robot" ]; then
  cp "$SELF_DIR/robot/Dockerfile" "$SELF_DIR/robot/entrypoint.sh" \
     "$SELF_DIR/robot/docker-compose.yml" "$APP_DIR/"
  cp "$SELF_DIR/robot/rptctl" /usr/local/bin/rptctl
else
  cat > "$APP_DIR/Dockerfile" <<'EOF_DOCKER'
FROM alpine:3.20
RUN apk add --no-cache autossh openssh-client curl bash coreutils
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
EOF_DOCKER

  cat > "$APP_DIR/docker-compose.yml" <<'EOF_COMPOSE'
services:
  tunnel:
    build: .
    image: rpt-robot:latest
    container_name: rpt-robot
    restart: unless-stopped
    network_mode: host
    volumes:
      - /etc/rpt-robot:/data
EOF_COMPOSE

  cat > "$APP_DIR/entrypoint.sh" <<'EOF_ENTRY'
#!/bin/bash
set -e
CONF=/data/robot.env
RUNTIME=/data/runtime.env
if [ ! -f "$CONF" ] || [ ! -f "$RUNTIME" ]; then
    echo "[robot] Нет конфигурации. Выполните: rptctl sync"; sleep 30; exit 1
fi
. "$CONF"; . "$RUNTIME"
: "${SERVER_HOST:?}"; : "${HUB_PORT:?}"; : "${ASSIGNED_PORT:?}"
if [ -n "$HUB_HOSTKEY" ]; then
    echo "[${SERVER_HOST}]:${HUB_PORT} ${HUB_HOSTKEY}" > /data/known_hosts
    chmod 644 /data/known_hosts
fi
heartbeat() {
    [ -z "$WEB_URL" ] && return
    while true; do
        curl -fsS -m 8 -X POST "${WEB_URL}/api/heartbeat" -H "Content-Type: application/json" \
            -d "{\"enroll_id\": ${ENROLL_ID:-0}, \"token\": \"${TOKEN:-}\"}" >/dev/null 2>&1 || true
        sleep 30
    done
}
heartbeat &
echo "[robot] Туннель -> порт ${ASSIGNED_PORT} -> localhost:22"
export AUTOSSH_GATETIME=0
exec autossh -M 0 -N \
    -o "ServerAliveInterval=20" -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -o "StrictHostKeyChecking=${HOSTKEY_CHECK:-accept-new}" \
    -o "UserKnownHostsFile=/data/known_hosts" -o "IdentitiesOnly=yes" \
    -i /data/tunnel_key \
    -R "0.0.0.0:${ASSIGNED_PORT}:localhost:22" \
    -p "${HUB_PORT}" "rtunnel@${SERVER_HOST}"
EOF_ENTRY
  chmod +x "$APP_DIR/entrypoint.sh"

  # rptctl (встроенная копия)
  cat > /usr/local/bin/rptctl <<'EOF_RPTCTL'
#!/usr/bin/env bash
# rptctl — консоль управления RPT-роботом (запускается на хосте робота).
set -euo pipefail
CONF_DIR=/etc/rpt-robot; APP_DIR=/opt/rpt-robot
CONF="$CONF_DIR/robot.env"; RUNTIME="$CONF_DIR/runtime.env"; TUNNEL_KEY="$CONF_DIR/tunnel_key"
C_G='\033[32m'; C_R='\033[31m'; C_Y='\033[33m'; C_B='\033[36m'; C_0='\033[0m'
say(){ echo -e "$*"; }; ok(){ echo -e "${C_G}✔${C_0} $*"; }
warn(){ echo -e "${C_Y}!${C_0} $*"; }; err(){ echo -e "${C_R}✖${C_0} $*" >&2; }
need_root(){ [ "$(id -u)" = 0 ] || { err "Нужны права root (sudo rptctl ...)"; exit 1; }; }
load_conf(){ [ -f "$CONF" ] || { err "Нет $CONF. Запустите robot-install.sh"; exit 1; }
  . "$CONF"; WEB_URL="${WEB_URL:-http://${SERVER_HOST}:${WEB_PORT}}"; }
compose(){ ( cd "$APP_DIR" && docker compose "$@" ); }
install_admin_key(){
  local APUB="$1" HOME_DIR SSH_DIR AK
  HOME_DIR="$(getent passwd "$SSH_USER" | cut -d: -f6)"
  [ -n "$HOME_DIR" ] || { err "Пользователь $SSH_USER не найден"; exit 1; }
  SSH_DIR="$HOME_DIR/.ssh"; AK="$SSH_DIR/authorized_keys"
  mkdir -p "$SSH_DIR"; chmod 700 "$SSH_DIR"; touch "$AK"; chmod 600 "$AK"
  grep -qF "$APUB" "$AK" 2>/dev/null || { echo "$APUB" >> "$AK"; ok "Admin-ключ сервера добавлен"; }
  chown -R "$SSH_USER":"$SSH_USER" "$SSH_DIR"; }
cmd_sync(){
  need_root; load_conf
  say "${C_B}== Синхронизация ключей с сервером ==${C_0}"
  say "Сервер: $SERVER_HOST | веб: $WEB_URL | hub-порт: $HUB_PORT"
  if [ ! -f "$TUNNEL_KEY" ]; then
    ssh-keygen -t ed25519 -N "" -C "rpt-robot-${SERIAL}" -f "$TUNNEL_KEY" >/dev/null
    ok "Сгенерирован туннельный ключ робота"; fi
  local PUB; PUB="$(cat "${TUNNEL_KEY}.pub")"
  echo; read -rp "Введите КОД сопряжения (с веб-панели): " CODE
  [ -n "$CODE" ] || { err "Код пуст"; exit 1; }
  local RESP; RESP="$(curl -fsS -m 15 -X POST "${WEB_URL}/api/enroll" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg c "$CODE" --arg s "$SERIAL" --arg n "$NAME" --arg k "$PUB" --arg u "$SSH_USER" \
              '{code:$c,serial:$s,name:$n,tunnel_pubkey:$k,ssh_user:$u}')" )" \
    || { err "Сервер отклонил заявку (код неверный/просрочен?)"; exit 1; }
  local EID TOK; EID="$(echo "$RESP" | jq -r '.enroll_id')"; TOK="$(echo "$RESP" | jq -r '.token')"
  ok "Заявка отправлена (id=$EID). Ожидаю подтверждения..."
  warn "Примите робота в веб-панели: раздел «Ожидают подтверждения»."
  local STATUS DATA i=0
  while :; do
    DATA="$(curl -fsS -m 10 "${WEB_URL}/api/enroll/${EID}?token=${TOK}")" || true
    STATUS="$(echo "$DATA" | jq -r '.status // "?"')"
    case "$STATUS" in active) ok "Подтверждено!"; break ;; rejected) err "Отклонено."; exit 1 ;; esac
    i=$((i+1)); [ $i -gt 120 ] && { err "Тайм-аут ожидания."; exit 1; }
    printf "\r  ожидание... %ss" "$((i*3))"; sleep 3
  done; echo
  local PORT HKEY APUB
  PORT="$(echo "$DATA" | jq -r '.assigned_port')"; HKEY="$(echo "$DATA" | jq -r '.hub_hostkey')"
  APUB="$(echo "$DATA" | jq -r '.admin_pubkey')"
  { echo "ENROLL_ID=$EID"; echo "TOKEN=$TOK"; echo "ASSIGNED_PORT=$PORT"; echo "HUB_HOSTKEY=\"$HKEY\""; } > "$RUNTIME"
  chmod 600 "$RUNTIME"; ok "Назначен порт: $PORT"
  install_admin_key "$APUB"
  compose up -d --build
  ok "Туннель запущен."; }
cmd_status(){ load_conf
  say "${C_B}RPT робот${C_0}  |  SN: $SERIAL  |  имя: $NAME"
  say "Сервер: $SERVER_HOST  (hub: $HUB_PORT, web: $WEB_PORT)"
  [ -f "$RUNTIME" ] && { . "$RUNTIME"; say "Туннельный порт: ${ASSIGNED_PORT:-—}"; }
  echo
  if docker ps --format '{{.Names}}' | grep -q '^rpt-robot$'; then ok "Туннель: работает"; else err "Туннель: остановлен"; fi; }
cmd_restart(){ need_root; compose restart; ok "Перезапущен"; }
cmd_stop(){ need_root; compose down; ok "Остановлен"; }
cmd_start(){ need_root; compose up -d; ok "Запущен"; }
cmd_logs(){ compose logs -f --tail=100; }
cmd_config(){ load_conf; echo "--- $CONF ---"; cat "$CONF"; [ -f "$RUNTIME" ] && { echo "--- $RUNTIME ---"; cat "$RUNTIME"; }; }
menu(){ while :; do echo
  say "${C_B}==== RPT robot · меню ====${C_0}"
  say " 1) Статус"; say " 2) Синхронизация ключей"; say " 3) Перезапустить"
  say " 4) Остановить"; say " 5) Запустить"; say " 6) Логи"; say " 7) Конфигурация"; say " 0) Выход"
  read -rp "Выбор: " ch
  case "$ch" in 1) cmd_status;; 2) cmd_sync;; 3) cmd_restart;; 4) cmd_stop;; 5) cmd_start;;
    6) cmd_logs;; 7) cmd_config;; 0) exit 0;; *) warn "Неверный выбор";; esac; done; }
case "${1:-menu}" in
  sync) cmd_sync;; status) cmd_status;; restart) cmd_restart;; stop) cmd_stop;;
  start) cmd_start;; logs) cmd_logs;; config) cmd_config;; info) cmd_status;; menu) menu;;
  help|-h|--help) echo "rptctl {sync|status|restart|stop|start|logs|config|info}";;
  *) err "Неизвестная команда: $1"; exit 1;; esac
EOF_RPTCTL
fi
chmod +x /usr/local/bin/rptctl
ok "rptctl установлен в /usr/local/bin/rptctl"

# --------------------------------------------------------------------------
# 6. Конфиг робота
# --------------------------------------------------------------------------
cat > "$CONF_DIR/robot.env" <<EOF
SERIAL="$SERIAL"
NAME="$NAME"
SSH_USER="$SSH_USER"
SERVER_HOST="$SERVER_HOST"
WEB_PORT="$WEB_PORT"
HUB_PORT="$HUB_PORT"
WEB_URL="$WEB_URL"
EOF
chmod 600 "$CONF_DIR/robot.env"
ok "Конфигурация сохранена в $CONF_DIR/robot.env"

# --------------------------------------------------------------------------
# 7. Синхронизация ключей
# --------------------------------------------------------------------------
echo
info "Теперь откройте веб-панель сервера, нажмите «Синхронизация ключей»"
info "и введите показанный код здесь."
echo
read -rp "Начать синхронизацию сейчас? [Y/n]: " s; case "${s:-Y}" in [Nn]*)
  warn "Позже выполните:  sudo rptctl sync"; exit 0;; esac

rptctl sync
echo
ok "Готово. Управление роботом:  ${C_B}rptctl${C_0}  (или rptctl status | logs | restart | sync)"
