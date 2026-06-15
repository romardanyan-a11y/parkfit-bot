# Деплой бота ParkFit на российский VPS

Бот работает 24/7 на VPS под управлением `pm2` (автозапуск + перезапуск при сбоях).
Брони хранятся в файле `bookings.json` на диске VPS (Postgres не нужен).
Оплата хостинга — рублями/картой РФ.

---

## 1. Купить VPS

Любой из российских провайдеров (оплата рублями):
- **Timeweb Cloud** — https://timeweb.cloud → Облачные серверы
- **aeza** — https://aeza.net
- **Beget** — https://beget.com → VPS

Параметры (хватит самого дешёвого, ~150–300 ₽/мес):
- ОС: **Ubuntu 24.04** (или 22.04)
- CPU: 1 ядро, RAM: 1 ГБ, диск: 10 ГБ

После оплаты провайдер пришлёт **IP-адрес сервера**, **логин** (обычно `root`) и **пароль**.

---

## 2. Подключиться к серверу по SSH

- **Mac / Linux:** открой Терминал и введи (подставь свой IP):
  ```bash
  ssh root@ВАШ_IP
  ```
- **Windows:** открой PowerShell и ту же команду, либо используй программу **PuTTY**.

При первом подключении введи `yes`, затем пароль (он не отображается при вводе — это нормально).

---

## 3. Установить Node.js и git

Скопируй и вставь целиком:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs git
```
Проверка:
```bash
node -v   # должно показать v20.x
```

---

## 4. Скачать код бота

```bash
cd ~
git clone https://github.com/romardanyan-a11y/fitroom-mini-app-main.git
cd fitroom-mini-app-main/bot
npm install --omit=dev
```
> Если `git clone` спросит логин/пароль — значит репозиторий приватный. Напиши мне, дам способ (токен доступа).

---

## 5. Прописать токен и настройки

Создай файл `.env`:
```bash
nano .env
```
Вставь (подставь **новый** токен из @BotFather):
```
BOT_TOKEN=сюда_новый_токен
MINI_APP_URL=https://fitroom-mini-app-main.vercel.app/
```
Сохрани: `Ctrl+O` → Enter → `Ctrl+X`.

---

## 6. Запустить бота через pm2

```bash
sudo npm install -g pm2
pm2 start index.js --name parkfit-bot
pm2 save
pm2 startup
```
Последняя команда выведет ещё одну команду (начинается с `sudo env ...`) — **скопируй её и выполни**. Это включит автозапуск бота после перезагрузки сервера.

---

## 7. Проверить

```bash
pm2 logs parkfit-bot
```
Должна быть строка:
```
🤖 ParkFit бот запущен (polling). Хранилище: файл bookings.json
```
Выйти из логов: `Ctrl+C` (бот продолжит работать в фоне).

Открой бота в Telegram → `/start` → пройди бронирование → «Мои брони». Готово — бот живёт на сервере, комп можно выключать.

---

## Как обновлять бота потом

После любого `git push` в репозиторий зайди на сервер и выполни:
```bash
cd ~/fitroom-mini-app-main && git pull && cd bot && npm install --omit=dev && pm2 restart parkfit-bot
```
Файл `bookings.json` при этом не трогается — брони сохраняются.

## Полезные команды pm2
```bash
pm2 status            # статус бота
pm2 logs parkfit-bot  # логи
pm2 restart parkfit-bot
pm2 stop parkfit-bot
```
