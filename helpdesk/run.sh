#!/usr/bin/env bash
# ===========================================================================
# HelpDesk — скрипт скачивания и запуска в Docker
#
#   Использование:
#       ./run.sh                 # порт 8000 по умолчанию
#       PORT=8080 ./run.sh       # запустить на порту 8080
#
#   Или укажите порт прямо в файле .env строкой  PORT=8080
# ===========================================================================
set -euo pipefail

# ----------------------- НАСТРОЙКИ (можно менять) --------------------------
REPO_URL="${REPO_URL:-https://github.com/romardanyan-a11y/parkfit-bot.git}"
BRANCH="${BRANCH:-claude/help-desk-docker-system-scr5eq}"
PORT="${PORT:-8000}"          # <-- ПОРТ, на котором откроется сайт
DIR="${DIR:-parkfit-bot}"     # папка, куда клонируется репозиторий
# ---------------------------------------------------------------------------

echo "==> Проверяю Docker…"
if ! command -v docker >/dev/null 2>&1; then
  echo "!!  Docker не установлен. Установите его: https://docs.docker.com/get-docker/"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "!!  Docker Compose не найден. Установите плагин 'docker compose'."
  exit 1
fi

# 1. Скачать репозиторий (или обновить, если уже склонирован)
if [ -d "$DIR/.git" ]; then
  echo "==> Обновляю репозиторий в '$DIR' (ветка $BRANCH)"
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout "$BRANCH"
  git -C "$DIR" pull origin "$BRANCH"
else
  echo "==> Клонирую $REPO_URL (ветка $BRANCH) в '$DIR'"
  git clone --branch "$BRANCH" "$REPO_URL" "$DIR"
fi

cd "$DIR/helpdesk"

# 2. Подготовить .env (пароль админа, SMTP и т.д.)
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Создан .env из .env.example."
  echo "    ВАЖНО: смените ADMIN_PASSWORD и SECRET_KEY в .env ДО первого запуска."
fi

# 3. Прописать выбранный порт в .env
if grep -q '^PORT=' .env; then
  sed -i.bak "s/^PORT=.*/PORT=${PORT}/" .env && rm -f .env.bak
else
  printf '\nPORT=%s\n' "${PORT}" >> .env
fi

# 4. Собрать и запустить контейнер
echo "==> Собираю образ и запускаю контейнер на порту ${PORT}…"
$DC up --build -d

echo ""
echo "======================================================================"
echo " Готово! Сайт открыт на:  http://localhost:${PORT}"
echo " Админ по умолчанию:      admin@helpdesk.local  /  admin12345"
echo "----------------------------------------------------------------------"
echo " Логи:            $DC logs -f       (в папке $DIR/helpdesk)"
echo " Остановить:      $DC down"
echo " Сменить порт:    PORT=НОВЫЙ_ПОРТ ./run.sh   (или строка PORT= в .env)"
echo "======================================================================"
