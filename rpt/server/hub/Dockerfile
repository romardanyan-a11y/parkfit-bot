FROM alpine:3.20

RUN apk add --no-cache openssh-server bash

# Пользователь для обратных туннелей. Только форвардинг, shell — существующий
# nologin (иначе sshd: "shell does not exist"). Разблокировку и коррекцию shell
# дополнительно делает entrypoint.sh на старте.
RUN adduser -D -s /sbin/nologin rtunnel

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
