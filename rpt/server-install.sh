#!/usr/bin/env bash
###############################################################################
#  RPT server-install.sh
#
#  Установщик ЦЕНТРАЛЬНОГО СЕРВЕРА. Запускать НА СЕРВЕРЕ ОТ ROOT из каталога
#  репозитория (рядом должен лежать каталог server/):
#     sudo bash server-install.sh
#
#  Что делает:
#    1. спрашивает порт веб-панели (НЕ 80/443), порт SSH-хаба, внешний адрес,
#       пароль администратора;
#    2. ставит Docker (если нужно);
#    3. копирует проект в /opt/rpt-server и пишет .env;
#    4. поднимает контейнеры (hub + backend) через docker compose;
#    5. ставит консоль управления rptctl;
#    6. печатает адрес панели и данные для входа.
###############################################################################
set -euo pipefail

C_G='\033[32m'; C_R='\033[31m'; C_Y='\033[33m'; C_B='\033[36m'; C_0='\033[0m'
ok()   { echo -e "${C_G}✔${C_0} $*"; }
info() { echo -e "${C_B}»${C_0} $*"; }
warn() { echo -e "${C_Y}!${C_0} $*"; }
die()  { echo -e "${C_R}✖${C_0} $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Запустите от root:  sudo bash server-install.sh"

SELF_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SRC_DIR="$SELF_DIR/server"
[ -d "$SRC_DIR" ] || die "Не найден каталог server/ рядом со скриптом. Запускайте из репозитория."

APP_DIR=/opt/rpt-server

echo -e "${C_B}==================== RPT · установка СЕРВЕРА ====================${C_0}"

# --------------------------------------------------------------------------
# 1. Параметры
# --------------------------------------------------------------------------
DEFAULT_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
read -rp "Внешний адрес/IP этого сервера [${DEFAULT_IP}]: " PUBHOST; PUBHOST="${PUBHOST:-$DEFAULT_IP}"
[ -n "$PUBHOST" ] || die "Адрес сервера обязателен"

while :; do
  read -rp "Порт веб-панели (НЕ 80/443) [8443]: " WEB_PORT; WEB_PORT="${WEB_PORT:-8443}"
  case "$WEB_PORT" in
    80|443) warn "Порт $WEB_PORT запрещён. Выберите другой." ;;
    ''|*[!0-9]*) warn "Нужно число." ;;
    *) break ;;
  esac
done

read -rp "Порт SSH-хаба (к нему подключаются роботы) [2222]: " HUB_PORT; HUB_PORT="${HUB_PORT:-2222}"
read -rsp "Пароль администратора веб-панели: " ADMIN_PASS; echo
[ -n "$ADMIN_PASS" ] || die "Пароль администратора обязателен"

echo
info "адрес=$PUBHOST  web=$WEB_PORT  hub=$HUB_PORT"
read -rp "Продолжить? [Y/n]: " yn; case "${yn:-Y}" in [Nn]*) exit 0;; esac

# --------------------------------------------------------------------------
# 2. Docker
# --------------------------------------------------------------------------
if ! command -v docker >/dev/null; then
  info "Устанавливаю Docker..."
  curl -fsSL https://get.docker.com | sh || die "Не удалось установить Docker"
fi
systemctl enable --now docker 2>/dev/null || true
docker compose version >/dev/null 2>&1 || die "Нужен docker compose v2 (обновите Docker)"
ok "Docker готов"

# --------------------------------------------------------------------------
# 3. Копируем проект и пишем .env
# --------------------------------------------------------------------------
info "Копирую проект в $APP_DIR ..."
mkdir -p "$APP_DIR"
cp -r "$SRC_DIR/." "$APP_DIR/"

cat > "$APP_DIR/.env" <<EOF
RPT_WEB_PORT=$WEB_PORT
RPT_HUB_PORT=$HUB_PORT
RPT_HUB_PUBLIC_HOST=$PUBHOST
RPT_ADMIN_PASSWORD=$ADMIN_PASS
EOF

# Источник для обновлений через `rptctl update` (если ставим из git-клона).
REPO_URL="$(git -C "$SELF_DIR" config --get remote.origin.url 2>/dev/null || true)"
REPO_BRANCH="$(git -C "$SELF_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -n "$REPO_URL" ]; then
  {
    echo "RPT_REPO_URL=$REPO_URL"
    echo "RPT_REPO_BRANCH=${REPO_BRANCH:-main}"
  } >> "$APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"
ok ".env создан"

# --------------------------------------------------------------------------
# 4. Запуск
# --------------------------------------------------------------------------
info "Сборка и запуск контейнеров..."
( cd "$APP_DIR" && docker compose up -d --build ) || die "docker compose не поднялся"
ok "Контейнеры запущены"

# --------------------------------------------------------------------------
# 5. rptctl
# --------------------------------------------------------------------------
cp "$APP_DIR/rptctl" /usr/local/bin/rptctl 2>/dev/null || true
chmod +x /usr/local/bin/rptctl 2>/dev/null || true
# rptctl должен смотреть на /opt/rpt-server
sed -i "s#RPT_SERVER_DIR:-/opt/rpt-server#RPT_SERVER_DIR:-$APP_DIR#" /usr/local/bin/rptctl 2>/dev/null || true
ok "rptctl установлен"

# --------------------------------------------------------------------------
# 6. Итог
# --------------------------------------------------------------------------
echo
echo -e "${C_G}================= УСТАНОВКА ЗАВЕРШЕНА =================${C_0}"
echo -e "  Веб-панель:  ${C_B}http://${PUBHOST}:${WEB_PORT}${C_0}"
echo -e "  Пароль:      (введённый вами)"
echo -e "  SSH-хаб:     ${PUBHOST}:${HUB_PORT}  (открыть в файрволе!)"
echo
echo -e "  Консоль:     ${C_B}rptctl${C_0}   (status | logs | restart | set-port | set-password)"
echo
warn "Откройте в файрволе TCP-порты: $WEB_PORT (панель) и $HUB_PORT (хаб)."
echo
echo "Добавление робота:"
echo "  1) В панели нажмите «Синхронизация ключей» — появится код."
echo "  2) На роботе:  sudo bash robot-install.sh  (введите этот код)."
echo "  3) Примите робота в разделе «Ожидают подтверждения»."
