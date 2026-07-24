# HTTPS: https://tracker-octron.ru на отдельном IP 155.212.159.242

HelpDesk живёт на собственном публичном IP (155.212.159.242, интерфейс eth1).
Сервис `proxy` (Caddy) работает в host-сети, привязан **только** к этому IP
на портах 80/443, сам получает и продлевает сертификат Let's Encrypt и
проксирует запросы в HelpDesk (127.0.0.1:PORT).

Xray/VLESS и nginx-заглушка живут на основном IP .244 и не затрагиваются:
- nginx-заглушка привязана к `155.212.159.244:80`;
- у VLESS-инбаунда в 3x-ui поле Listen IP = `155.212.159.244`.

## Ключевой момент: policy-маршрутизация

Сервер ходит в интернет по умолчанию через eth0, а .242 висит на eth1.
Без отдельного правила ответы с адреса .242 уходят через eth0 и
отбрасываются провайдером (анти-спуфинг). Нужно правило
«всё с адреса .242 — через eth1»:

```bash
ip route add default via 155.212.159.241 dev eth1 table 100
ip rule add from 155.212.159.242 table 100
```

Проверка, что путь работает (с самого сервера):
```bash
curl --interface 155.212.159.242 -sI https://ya.ru | head -1   # HTTP/2 ...
```

Именно поэтому Caddy запущен с `network_mode: host`: его ответы уходят от
имени хоста с адресом .242 и попадают под это правило. Вариант с обычной
публикацией портов (docker-NAT) не работает: в момент выбора маршрута у
ответного пакета ещё внутренний адрес контейнера, правило не срабатывает,
и ответ уезжает в eth0.

### Сделать правило постоянным (netplan)

В файле netplan (например `/etc/netplan/50-cloud-init.yaml`) в секции `eth1`:

```yaml
    eth1:
      addresses:
        - 155.212.159.242/29
      routes:
        - to: 0.0.0.0/0
          via: 155.212.159.241
          table: 100
      routing-policy:
        - from: 155.212.159.242
          table: 100
```

Затем `netplan apply` и проверить: `ip rule` содержит
`from 155.212.159.242 lookup 100`.

## Развёртывание

`.env` (helpdesk/.env):
```
PUBLIC_IP=155.212.159.242
DOMAIN=tracker-octron.ru
PORT=8070
```

DNS: A-запись `tracker-octron.ru -> 155.212.159.242`.

Запуск:
```bash
cd ~/helpdesk/parkfit-bot
git fetch origin claude/help-desk-docker-system-scr5eq && git reset --hard FETCH_HEAD
cd helpdesk
docker compose up -d --force-recreate proxy
docker logs helpdesk_proxy --tail 20 -f   # ждать "certificate obtained successfully"
```

## Проверка после переезда
- https://tracker-octron.ru — сайт с сертификатом;
- VPN-клиент подключается как раньше (адрес .244);
- http://alexalq.ru — заглушка и /sub-alexalq/ работают;
- Админка → «Почтовый сервис» → «Адрес сайта» = `https://tracker-octron.ru`.

## Возможные ошибки
- В логах Caddy `bind: address already in use` на 443 — значит Xray снова
  слушает `*:443`: в 3x-ui у инбаунда выставить Listen IP `155.212.159.244`
  и перезапустить (`systemctl restart x-ui`); проверка:
  `ss -tlnp | grep ':443'` не должен показывать `*:443`.
- `Timeout during connect` от Let's Encrypt — не применена
  policy-маршрутизация (см. выше), проверить `ip rule` и таблицу 100.
