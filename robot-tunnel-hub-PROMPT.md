# Промт для Claude — Robot Tunnel Hub (reverse SSH)

> Скопируй всё, что ниже разделителя, и вставь как задание.

---

Мне нужно разработать систему удалённого доступа к Linux-роботам через центральный
Linux-сервер/VPS с белым IP, используя reverse SSH tunnel.

## Идея

Есть несколько роботов на Linux. Они могут быть за NAT, за SIM-картой, с серым IP,
в чужой сети, без проброса портов — входящее подключение к ним невозможно.

Поэтому каждый робот **сам** подключается к моему серверу с белым IP и поднимает
reverse SSH tunnel. Дальше я подключаюсь к серверу, вижу список роботов online/offline,
выбираю нужного и подключаюсь к нему по SSH или SFTP через туннель.

```
[Linux Robot] ── reverse SSH tunnel ──> [Linux VPS with public IP]
                                               ^
[Operator] ────────────────────────────────────┘
```

## Параметры сервера

- IP VPS: `155.212.159.244` (в клиентском скрипте храни в конфиге, НЕ хардкодь в коде)
- Порт SSH-сервиса для роботов внутри Docker: `2222`
- Фиксированный tunnel user на VPS: `robot-tunnel`

## Два разных пользователя (это принципиально)

- **Tunnel user всегда только `robot-tunnel`.** Через него робот подключается к серверу и
  поднимает reverse tunnel. Он НЕ должен давать shell-доступ (shell = `/usr/sbin/nologin`,
  `no-pty` в authorized_keys, `AllowUsers robot-tunnel`).
- **Robot SSH/SFTP user НЕ фиксированный.** При добавлении робота я сам ввожу пользователя
  робота: `siasun`, `root`, `robot`, `admin` и т.д.

Итого:
- robot → VPS подключается как `robot-tunnel`
- VPS → robot подключается как указанный мной `robot_user`

Пример:
```
# робот -> VPS
ssh -p 2222 -N -R 127.0.0.1:22001:127.0.0.1:22 robot-tunnel@155.212.159.244

# VPS -> робот
ssh -p 22001 siasun@127.0.0.1
```

Всё реализовать в Docker.

## Порядок запуска (обязательно опиши в README/выводе скриптов)

1. На сервере: собрать и запустить hub, затем `server-key generate` → скопировать
   публичный ключ сервера.
2. На роботе: запустить `setup-robot-tunnel-client.sh`, вставить публичный ключ сервера,
   получить публичный ключ робота.
3. На сервере: `add` — ввести данные робота и вставить его публичный ключ.

---

# Файл 1: `robot-hub` (скрипт внутри контейнера сервера)

Контейнер называется `robot-tunnel-hub`. Внутри контейнера:

- sshd на порту `2222`;
- пользователь `robot-tunnel` с shell `/usr/sbin/nologin`;
- `/data/registry.json`;
- `/data/ssh/authorized_keys` (authorized_keys пользователя robot-tunnel);
- ключ сервера для доступа к роботам:
  `/data/ssh/hub_to_robot_ed25519` + `.pub`;
- **host-ключи sshd персистятся в `/data/ssh/host_keys/`** (ГЕНЕРИРУЮТСЯ ОДИН РАЗ и не
  меняются при пересборке образа — иначе у всех роботов сломается host key verification).

Меню вызывается на хосте:
```
docker exec -it robot-tunnel-hub robot-hub
# или wrapper:
robot-hub
```

## Псевдографическое меню (whiptail/dialog)

Главное меню:
- `dashboard`   — список роботов online/offline
- `select`      — выбрать робота
- `add`         — добавить робота
- `server-key`  — показать / создать / пересоздать / удалить публичный ключ сервера
- `authorized`  — показать authorized_keys
- `raw`         — показать registry.json
- `exit`        — выход

В dashboard online помечается `*`.

**Online определяется точно** (без ложных совпадений вроде 22001 vs 220010):
```
ss -H -tln "sport = :<VPS_PORT>" | grep -q . && echo online
```

Карточка выбранного робота:
- `connect`    — SSH к роботу
- `sftp`       — SFTP к роботу
- `details`    — данные робота
- `rename`     — переименовать
- `notes`      — изменить заметки
- `show-key`   — показать public key робота
- `update-key` — заменить public key робота
- `remove`     — удалить робота
- `back`       — назад

## add (спрашивает)

- Robot name
- Robot SN
- VPS port — **предложить следующий свободный порт (22001, 22002, …) и проверить,
  что порт ещё не занят в registry**
- Robot SSH/SFTP user
- Notes
- Robot public key

Tunnel user НЕ спрашивать — всегда `robot-tunnel`.

## registry.json (атомарная запись через tmp+mv, парсинг через jq)

```json
{
  "robot-name": {
    "sn": "...",
    "port": 22001,
    "tunnel_user": "robot-tunnel",
    "robot_user": "siasun",
    "notes": "...",
    "public_key": "ssh-ed25519 ...",
    "created_at": "...",
    "updated_at": "..."
  }
}
```

## Строка в /data/ssh/authorized_keys (для каждого робота)

Используй `restrict` + точечно возвращай нужное:
```
restrict,port-forwarding,permitlisten="127.0.0.1:<VPS_PORT>" ssh-ed25519 AAAA... robot-name
```
(`restrict` выключает pty/x11/agent/user-rc и будущие опции; `port-forwarding` возвращает
проброс; `permitlisten` жёстко ограничивает робота ровно его портом на loopback.)

## update-key

- выбрать робота;
- показать текущий ключ;
- спросить новый public key;
- удалить старую строку из authorized_keys по этому порту;
- добавить новую строку с `permitlisten` на тот же порт;
- обновить `public_key` и `updated_at` в registry.

## remove

- удалить робота из registry;
- удалить строку authorized_keys, привязанную к порту робота.

## connect / sftp (используют ключ сервера)

```
ssh  -i /data/ssh/hub_to_robot_ed25519 -o IdentitiesOnly=yes -p <PORT> <ROBOT_USER>@127.0.0.1
sftp -i /data/ssh/hub_to_robot_ed25519 -o IdentitiesOnly=yes -o Port=<PORT> <ROBOT_USER>@127.0.0.1
```

## server-key (подменю)

- `show`     — показать публичный ключ сервера;
- `generate` — создать, если нет:
  `ssh-keygen -t ed25519 -f /data/ssh/hub_to_robot_ed25519 -N "" -C "hub-to-robot"`
- `recreate` — пересоздать (с предупреждением: новый public key надо заново добавить
  на ВСЕХ роботах, иначе connect будет спрашивать пароль);
- `delete`   — удалить ключ;
- `back`.

## sshd-конфиг hub-контейнера

```
Port 2222
HostKey /data/ssh/host_keys/ssh_host_ed25519_key     # персистентный!
PasswordAuthentication no
PermitRootLogin no
AllowUsers robot-tunnel
AllowTcpForwarding remote        # только reverse (-R), не -L/-D
GatewayPorts no                  # reverse-порты слушают только 127.0.0.1
X11Forwarding no
ClientAliveInterval 30           # реапить мёртвые туннели и освобождать порт
ClientAliveCountMax 3
AuthorizedKeysFile /data/ssh/authorized_keys
```

---

# Файл 2: `setup-robot-tunnel-client.sh` (запускается на роботе)

Скрипт должен:

- установить нужные пакеты (autossh, openssh-client, docker при отсутствии);
- проверить, что на роботе работает SSH server на порту 22;
- остановить и отключить старые systemd-сервисы туннеля, если есть:
  `robot-reverse-tunnel.service`, `robot-tunnel.service`, `reverse-ssh.service`;
- спросить: Robot name, Robot SN, VPS reverse port, Robot SSH/SFTP user, Notes;
  **tunnel user НЕ спрашивать — всегда robot-tunnel**;
- сохранить параметры и VPS host/port в `/opt/robot-tunnel-client/tunnel.conf`
  (VPS IP НЕ хардкодить в коде);
- создать ключ робота `/opt/robot-tunnel-client/id_ed25519` (+ `.pub`);
- попросить вставить публичный ключ сервера `hub_to_robot_ed25519.pub`;
- добавить этот ключ сервера в `~<robot_user>/.ssh/authorized_keys` (создать .ssh с
  правами 700, authorized_keys 600, владелец = robot_user);
- собрать образ `robot-tunnel-client:latest`;
- пересоздать контейнер `robot-tunnel-client`, запустить `--network host`;
- смонтировать `/opt/robot-tunnel-client:/config` (НЕ read-only — нужен chmod/known_hosts);
- в конце вывести публичный ключ робота для добавления в robot-hub `add`.

## Клиентский контейнер (autossh)

```
autossh -M 0 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=/config/known_hosts \   # персистентный known_hosts
  -i /config/id_ed25519 \
  -o IdentitiesOnly=yes \
  -p 2222 \
  -N \
  -R 127.0.0.1:${VPS_PORT}:127.0.0.1:22 \
  robot-tunnel@${VPS_HOST}
```

В логах контейнера должно быть `robot-tunnel@155.212.159.244`, а НЕ `hub@...`.
Если видно `hub@...` — работает старый сервис/конфиг: скрипт обязан принудительно
остановить старые сервисы и пересоздать контейнер.

## Запуск клиента

```
docker run -d \
  --name robot-tunnel-client \
  --restart unless-stopped \
  --network host \
  -v /opt/robot-tunnel-client:/config \
  robot-tunnel-client:latest
```

## Запуск сервера

```
docker run -d \
  --name robot-tunnel-hub \
  --restart unless-stopped \
  --network host \
  -v /opt/robot-tunnel-hub/data:/data \
  robot-tunnel-hub:latest
```

---

# Чего избегать

- systemd reverse tunnel;
- пользователя `hub`;
- захардкоженного robot_user (`siasun`) в коде — он всегда параметр;
- read-only volume `/config:ro`;
- открытия портов роботов наружу.

# Безопасность

- внешний порт для роботов: `2222/tcp`;
- порты роботов (22001, 22002, …) НЕ открывать в firewall;
- reverse-порты слушаются только на `127.0.0.1` (`GatewayPorts no`);
- `PasswordAuthentication no`, `PermitRootLogin no`, `AllowUsers robot-tunnel`,
  `AllowTcpForwarding remote`.

# Проверки

На сервере:
```
ss -tlnp | grep -E '2222|22001|22002'
# правильно: 0.0.0.0:2222 и 127.0.0.1:22001
# плохо:     0.0.0.0:22001
```

На роботе:
```
docker logs -f robot-tunnel-client
```

Диагностика:
- `Permission denied (publickey)` → публичный ключ робота не добавлен на сервер,
  добавлен не тот ключ или не тот порт.
- `connect` просит пароль robot_user → публичный ключ сервера `hub_to_robot_ed25519.pub`
  не добавлен в authorized_keys пользователя робота, либо robot-hub не использует ключ
  `/data/ssh/hub_to_robot_ed25519`.
- Робот вернулся online, но туннель падает с `remote port forwarding failed` → на сервере
  завис старый форвард; лечится `ClientAliveInterval` на hub-е (реапит мёртвые сессии).

# Формат вывода

Нужны готовые рабочие bash-файлы:
1. `robot-hub` — для контейнера сервера;
2. `setup-robot-tunnel-client.sh` — для робота;
плюс Dockerfile'ы для hub и client.

Весь интерфейс псевдографики и вывод внутри скриптов — на английском.
Комментарии минимальные. Скрипты пригодны для копипаста и запуска.
