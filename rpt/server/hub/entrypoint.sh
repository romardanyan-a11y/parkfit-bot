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
# host key — приватный, читается root'ом при старте sshd -> 600.
chmod 600 /keys/ssh_host_ed25519_key 2>/dev/null || true
# authorized_keys sshd читает от имени пользователя rtunnel, поэтому файл должен
# быть читаем этим пользователем (644), а каталог /keys — проходим (755).
chmod 644 /keys/authorized_keys 2>/dev/null || true
chmod 755 /keys 2>/dev/null || true

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

# У rtunnel должен быть СУЩЕСТВУЮЩИЙ shell, иначе sshd отвергает вход:
# "shell /usr/sbin/nologin does not exist". На Alpine путь к nologin другой.
for _sh in /sbin/nologin /usr/sbin/nologin /bin/false; do
    if [ -x "$_sh" ]; then
        sed -i "s#^\(rtunnel:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:\).*#\1$_sh#" /etc/passwd
        echo "[hub] shell rtunnel = $_sh"
        break
    fi
done

echo "[hub] запуск sshd на порту 22 (внутри контейнера)"
exec /usr/sbin/sshd -D -e
