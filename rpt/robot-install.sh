#!/usr/bin/env bash
###############################################################################
#  RPT robot-install.sh  (НАТИВНЫЙ режим — без Docker)
#
#  Установщик РОБОТА. Запускать НА РОБОТЕ ОТ ROOT:
#     sudo bash robot-install.sh
#
#  Робот держит обратный SSH-туннель до сервера обычным autossh под systemd —
#  без Docker. Это надёжно работает и на VPS (LXC/OpenVZ), где Docker падает с
#  ошибкой BPF_CGROUP_DEVICE.
#
#  Что делает:
#    1. спрашивает серийник и название робота;
#    2. создаёт пользователя (по умолч. RM / 536yfj67) с правами sudo (NOPASSWD);
#    3. ставит зависимости: autossh, openssh-client/server, curl, jq;
#    4. включает host sshd (в него заходит админ через туннель);
#    5. ставит systemd-службу rpt-tunnel и консоль rptctl;
#    6. запускает синхронизацию ключей с сервером (rptctl sync).
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
UNIT=/etc/systemd/system/rpt-tunnel.service

echo -e "${C_B}============ RPT · установка РОБОТА (нативно, без Docker) ============${C_0}"

# --------------------------------------------------------------------------
# 1. Параметры
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
# 2. Зависимости (без Docker)
# --------------------------------------------------------------------------
info "Установка зависимостей..."
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
# autossh в RHEL/CentOS живёт в EPEL
if [ "$PKG" = "dnf" ] || [ "$PKG" = "yum" ]; then
  command -v autossh >/dev/null || install_pkgs epel-release || true
fi
NEED=""
command -v autossh    >/dev/null || NEED="$NEED autossh"
command -v ssh-keygen >/dev/null || NEED="$NEED openssh-clients openssh-client"
command -v curl       >/dev/null || NEED="$NEED curl"
command -v jq         >/dev/null || NEED="$NEED jq"
command -v sshd       >/dev/null || NEED="$NEED openssh-server"
# ставим по одному — имена пакетов различаются между дистрибутивами
for p in $NEED; do install_pkgs "$p" 2>/dev/null || true; done
command -v autossh >/dev/null || die "Не удалось установить autossh. Установите вручную и повторите."
command -v jq      >/dev/null || die "Не удалось установить jq."
command -v curl    >/dev/null || die "Не удалось установить curl."
ok "Зависимости готовы"

# --------------------------------------------------------------------------
# 3. Пользователь сессии
# --------------------------------------------------------------------------
if id "$SSH_USER" >/dev/null 2>&1; then
  warn "Пользователь $SSH_USER уже существует — обновляю пароль и права"
else
  useradd -m -s /bin/bash "$SSH_USER"; ok "Создан пользователь $SSH_USER"
fi
echo "${SSH_USER}:${SSH_PASS}" | chpasswd; ok "Пароль установлен"
getent group sudo  >/dev/null && usermod -aG sudo  "$SSH_USER" || true
getent group wheel >/dev/null && usermod -aG wheel "$SSH_USER" || true
echo "${SSH_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/rpt-${SSH_USER}"
chmod 440 "/etc/sudoers.d/rpt-${SSH_USER}"
ok "Права sudo (NOPASSWD) выданы пользователю $SSH_USER"

# --------------------------------------------------------------------------
# 4. host sshd
# --------------------------------------------------------------------------
info "Настройка sshd робота..."
if [ -f /etc/ssh/sshd_config ]; then
  sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config || true
fi
systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || \
  service ssh start 2>/dev/null || true
ok "sshd робота запущен"

# --------------------------------------------------------------------------
# 5. Убрать старый Docker-туннель, если был
# --------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^rpt-robot$'; then
  warn "Обнаружен старый Docker-туннель — останавливаю и удаляю"
  docker rm -f rpt-robot >/dev/null 2>&1 || true
fi

# --------------------------------------------------------------------------
# 6. Файлы службы + rptctl
# --------------------------------------------------------------------------
info "Установка службы туннеля..."
mkdir -p "$APP_DIR" "$CONF_DIR"; chmod 700 "$CONF_DIR"

SELF_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [ -f "$SELF_DIR/robot/run-tunnel.sh" ]; then
  cp "$SELF_DIR/robot/run-tunnel.sh" "$APP_DIR/run-tunnel.sh"
  cp "$SELF_DIR/robot/rpt-tunnel.service" "$UNIT"
  cp "$SELF_DIR/robot/rptctl" /usr/local/bin/rptctl
else
  # ---- встроенные копии (self-contained) ----
  cat > "$APP_DIR/run-tunnel.sh" <<'EOF_RUN'
#!/bin/bash
set -e
CONF=/etc/rpt-robot/robot.env
RUNTIME=/etc/rpt-robot/runtime.env
[ -f "$CONF" ] && . "$CONF"
[ -f "$RUNTIME" ] && . "$RUNTIME"
: "${SERVER_HOST:?нет SERVER_HOST — выполните rptctl sync}"
: "${HUB_PORT:?нет HUB_PORT}"
: "${ASSIGNED_PORT:?нет ASSIGNED_PORT — выполните rptctl sync}"
if [ -n "${HUB_HOSTKEY:-}" ]; then
    echo "[${SERVER_HOST}]:${HUB_PORT} ${HUB_HOSTKEY}" > /etc/rpt-robot/known_hosts
    chmod 644 /etc/rpt-robot/known_hosts
fi
if [ -n "${WEB_URL:-}" ]; then
    ( while true; do
        curl -fsS -m 8 -X POST "${WEB_URL}/api/heartbeat" -H "Content-Type: application/json" \
            -d "{\"enroll_id\": ${ENROLL_ID:-0}, \"token\": \"${TOKEN:-}\"}" >/dev/null 2>&1 || true
        sleep 30
      done ) &
    HB=$!; trap 'kill $HB 2>/dev/null || true' EXIT
fi
echo "[robot] Туннель -> порт ${ASSIGNED_PORT} -> localhost:22"
export AUTOSSH_GATETIME=0
exec autossh -M 0 -N \
    -o "ServerAliveInterval=20" -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -o "StrictHostKeyChecking=${HOSTKEY_CHECK:-accept-new}" \
    -o "UserKnownHostsFile=/etc/rpt-robot/known_hosts" -o "IdentitiesOnly=yes" \
    -i /etc/rpt-robot/tunnel_key \
    -R "0.0.0.0:${ASSIGNED_PORT}:localhost:22" \
    -p "${HUB_PORT}" "rtunnel@${SERVER_HOST}"
EOF_RUN

  cat > "$UNIT" <<'EOF_UNIT'
[Unit]
Description=RPT reverse SSH tunnel (robot -> central server)
After=network-online.target sshd.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/rpt-robot/run-tunnel.sh
Restart=always
RestartSec=5
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF_UNIT

  cat > /usr/local/bin/rptctl <<'EOF_RPTCTL'
#!/usr/bin/env bash
# rptctl — консоль управления RPT-роботом (нативный режим, systemd).
set -euo pipefail
CONF_DIR=/etc/rpt-robot
CONF="$CONF_DIR/robot.env"; RUNTIME="$CONF_DIR/runtime.env"; TUNNEL_KEY="$CONF_DIR/tunnel_key"; SVC=rpt-tunnel
C_G='\033[32m'; C_R='\033[31m'; C_Y='\033[33m'; C_B='\033[36m'; C_0='\033[0m'
say(){ echo -e "$*"; }; ok(){ echo -e "${C_G}✔${C_0} $*"; }
warn(){ echo -e "${C_Y}!${C_0} $*"; }; err(){ echo -e "${C_R}✖${C_0} $*" >&2; }
need_root(){ [ "$(id -u)" = 0 ] || { err "Нужны права root (sudo rptctl ...)"; exit 1; }; }
load_conf(){ [ -f "$CONF" ] || { err "Нет $CONF. Запустите robot-install.sh"; exit 1; }
  . "$CONF"; WEB_URL="${WEB_URL:-http://${SERVER_HOST}:${WEB_PORT}}"; }
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
  systemctl enable "$SVC" >/dev/null 2>&1 || true
  systemctl restart "$SVC"
  ok "Туннель запущен."; }
cmd_status(){ load_conf
  say "${C_B}RPT робот${C_0}  |  SN: $SERIAL  |  имя: $NAME"
  say "Сервер: $SERVER_HOST  (hub: $HUB_PORT, web: $WEB_PORT)"
  [ -f "$RUNTIME" ] && { . "$RUNTIME"; say "Туннельный порт: ${ASSIGNED_PORT:-—}"; }
  echo
  if systemctl is-active --quiet "$SVC"; then ok "Служба туннеля: работает"; else err "Служба туннеля: остановлена"; fi; }
cmd_restart(){ need_root; systemctl restart "$SVC"; ok "Перезапущен"; }
cmd_stop(){ need_root; systemctl stop "$SVC"; ok "Остановлен"; }
cmd_start(){ need_root; systemctl enable "$SVC" >/dev/null 2>&1 || true; systemctl start "$SVC"; ok "Запущен"; }
cmd_logs(){ journalctl -u "$SVC" -n 100 -f; }
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

chmod +x "$APP_DIR/run-tunnel.sh" /usr/local/bin/rptctl
systemctl daemon-reload
ok "Служба rpt-tunnel и rptctl установлены"

# --------------------------------------------------------------------------
# 7. Конфиг робота
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
# 8. Запуск / синхронизация
# --------------------------------------------------------------------------
echo
if [ -f "$CONF_DIR/runtime.env" ] && [ -f "$CONF_DIR/tunnel_key" ]; then
  info "Найдена прежняя конфигурация (робот уже был одобрен). Запускаю службу..."
  systemctl enable rpt-tunnel >/dev/null 2>&1 || true
  systemctl restart rpt-tunnel
  sleep 2
  rptctl status || true
  echo
  ok "Готово. Если робот не онлайн — выполните ${C_B}sudo rptctl sync${C_0}."
else
  info "Откройте веб-панель сервера, нажмите «Синхронизация ключей» и введите код здесь."
  echo
  read -rp "Начать синхронизацию сейчас? [Y/n]: " s; case "${s:-Y}" in [Nn]*)
    warn "Позже выполните:  sudo rptctl sync"; exit 0;; esac
  rptctl sync
fi
echo
ok "Управление роботом:  ${C_B}rptctl${C_0}  (rptctl status | logs | restart | sync)"
