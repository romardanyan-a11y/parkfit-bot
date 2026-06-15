# Деплой бота ParkFit на Railway

Бот работает на long-polling и хранит брони в Postgres. Хостим как постоянный воркер на Railway — без локального запуска на компе.

## 0. Перед деплоем (обязательно)

Старый токен утёк в git-историю. **Перевыпусти токен в @BotFather:**
`/mybots` → выбрать бота → Bot Settings → API Token → Revoke current token.
Новый токен **никуда в код не вписывай** — он пойдёт только в переменные окружения Railway.

## 1. Создать проект на Railway

1. Зарегистрируйся на https://railway.app (вход через GitHub).
2. **New Project → Deploy from GitHub repo** → выбери репозиторий `fitroom-mini-app-main`.
3. В настройках сервиса укажи **Root Directory**: `bot`
   (тогда Railway будет ставить зависимости и запускать именно папку бота; команда запуска — `npm start`).

## 2. Добавить базу данных

1. В проекте: **New → Database → Add PostgreSQL**.
2. Railway создаст переменную `DATABASE_URL`. Привяжи её к сервису бота:
   сервис бота → **Variables → Add Reference → выбрать `DATABASE_URL` из Postgres**.
   Таблица `bookings` создастся автоматически при первом запуске.

## 3. Переменные окружения сервиса бота

В сервисе бота → **Variables** добавь:

| Переменная     | Значение                                              |
|----------------|-------------------------------------------------------|
| `BOT_TOKEN`    | новый токен из @BotFather                             |
| `MINI_APP_URL` | `https://fitroom-mini-app-main.vercel.app/`           |
| `DATABASE_URL` | подтянется как Reference из Postgres (см. шаг 2)       |

## 4. Деплой

Railway задеплоит автоматически. Проверь вкладку **Deploy Logs** — должно появиться:

```
🤖 ParkFit бот запущен (polling). Хранилище: Postgres
```

Дальше любой `git push` в `main` запускает авто-редеплой. Бот работает 24/7, локальный запуск больше не нужен.

## Локальная разработка

Без `DATABASE_URL` бот пишет брони в `bot/bookings.json` (этот файл в `.gitignore`).

```bash
cd bot
cp .env.example .env   # вписать BOT_TOKEN
npm install
npm run dev
```
