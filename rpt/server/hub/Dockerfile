FROM alpine:3.20

RUN apk add --no-cache openssh-server bash

# Пользователь для обратных туннелей. Без пароля, без shell — только форвардинг.
RUN adduser -D -s /usr/sbin/nologin rtunnel 2>/dev/null || adduser -D -s /sbin/nologin rtunnel

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
