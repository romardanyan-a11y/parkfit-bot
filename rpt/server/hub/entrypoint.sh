#!/bin/bash
set -e

# Ждём, пока backend создаст host key и authorized_keys в общем томе /keys.
# Важно: host key должен создать именно backend — он же отдаёт его публичную
# часть роботам. Если хаб сгенерирует свой ключ, роботы получат несовпадение.
for i in $(seq 1 60); do
    if [ -f /keys/ssh_host_ed25519_key ]; then
        break
    fi
    echo "[hub] ожидание /keys/ssh_host_ed25519_key ($i)..."
    sleep 1
done

# На случай если backend ещё не поднялся — сгенерируем host key сами.
if [ ! -f /keys/ssh_host_ed25519_key ]; then
    echo "[hub] генерирую host key самостоятельно"
    ssh-keygen -t ed25519 -N "" -f /keys/ssh_host_ed25519_key
fi

# authorized_keys должен существовать (пусть даже пустой).
touch /keys/authorized_keys
chmod 600 /keys/ssh_host_ed25519_key /keys/authorized_keys || true

# Alpine `adduser -D` создаёт rtunnel с заблокированным паролем ('!' в /etc/shadow),
# из-за чего sshd отвергает вход ещё до проверки ключа:
# "User rtunnel not allowed because account is locked".
# Разблокируем аккаунт случайным паролем. Вход по паролю всё равно запрещён в
# sshd_config (PasswordAuthentication no) — робот заходит только по ключу.
if grep -q '^rtunnel:!' /etc/shadow 2>/dev/null; then
    RTPW="$(head -c 12 /dev/urandom | base64)"
    if printf '%s\n%s\n' "$RTPW" "$RTPW" | passwd rtunnel >/dev/null 2>&1; then
        echo "[hub] аккаунт rtunnel разблокирован"
    else
        sed -i 's/^rtunnel:!/rtunnel:*/' /etc/shadow
        echo "[hub] аккаунт rtunnel разблокирован (shadow)"
    fi
fi

echo "[hub] запуск sshd на порту 22 (внутри контейнера)"
exec /usr/sbin/sshd -D -e
