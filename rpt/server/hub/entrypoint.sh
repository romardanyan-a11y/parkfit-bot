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

echo "[hub] запуск sshd на порту 22 (внутри контейнера)"
exec /usr/sbin/sshd -D -e
