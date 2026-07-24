# Выпуск HelpDesk в интернет: https://tracker-octron.ru (порт 443 совместно с VLESS/Xray)

Исходная ситуация на сервере:
- `:443` слушает **Xray** (VLESS), не nginx;
- `:80` — nginx-контейнер (`~/nginx-site`) с сайтом-заглушкой `alexalq.ru`
  и прокси VPN-подписок (`/sub-alexalq/` → :2096);
- HelpDesk крутится на `:8070`.

Решение: nginx становится владельцем 443 и **SNI-диспетчером** (stream +
`ssl_preread`): по имени домена трафик уходит либо в HelpDesk, либо в
заглушку, либо прозрачно в Xray (VPN продолжает работать через 443).
Конфиг: `nginx-sni.conf` (лежит рядом).

## Порядок (важно соблюдать очерёдность)

### 0. Домен
Купить `tracker-octron.ru`, A-запись `@ -> 155.212.159.244` (и `www`, по желанию).
Проверить: `ping tracker-octron.ru`.

### 1. Сертификат (пока 443 не тронут)
Порт 80 уже отдаёт ACME из webroot. На сервере:
```bash
certbot certonly --webroot -w /ПУТЬ/К/ХОСТОВОМУ/webroot -d tracker-octron.ru
# путь смотреть в volume-маппинге nginx-контейнера на /usr/share/nginx/html:
#   docker inspect <nginx-container> --format '{{json .Mounts}}'
```

### 2. Перенести Xray с 443 на 8443
В панели 3x-ui (`:2999`): inbound VLESS, поле **Port: 443 → 8443**, сохранить
(панель перезапустит Xray). VPN-клиенты временно отвалятся — до шага 4.

⚠️ Если inbound — REALITY и в поле dest/target указан `alexalq.ru:443` —
поменять на `alexalq.ru:8445` (внутренний TLS-порт заглушки из нового конфига).
Если там внешний сайт (yahoo.com и т.п.) — ничего не менять.

### 3. Обновить nginx
- `~/nginx-site/nginx.conf` заменить содержимым `nginx-sni.conf`;
- в `~/nginx-site/docker-compose.yml` у nginx открыть 443:
  ```yaml
  ports:
    - "80:80"
    - "443:443"
  ```
- у контейнера должен быть `extra_hosts: ["host.docker.internal:host-gateway"]`
  (он уже есть, раз работает прокси на :2096).

### 4. Перезапуск
```bash
cd ~/nginx-site && docker compose up -d --force-recreate
docker logs <nginx-container> --tail 20   # не должно быть ошибок
```
Проверить:
- `https://tracker-octron.ru` — HelpDesk с замком;
- `https://alexalq.ru` — заглушка, `/sub-alexalq/` — подписки;
- VPN-клиент подключается (по-прежнему на 443).

### 5. Донастройка HelpDesk
- Админка → «Почтовый сервис» → «Адрес сайта» = `https://tracker-octron.ru`.
- Спрятать 8070 от интернета: в `helpdesk/docker-compose.yml`
  `ports: ["127.0.0.1:8070:8000"]` и `docker compose up -d`.
- (опционально) закрыть 8443 снаружи файрволом — клиенты VPN ходят через 443.

### Откат (если что-то пошло не так)
1. В 3x-ui вернуть порт inbound 8443 → 443.
2. Вернуть старый `nginx.conf`, убрать 443 из ports, `docker compose up -d`.

### Продление сертификатов
`certbot renew` продлевает оба домена через webroot на :80 — ничего менять
не нужно (проверить: `certbot renew --dry-run`).
