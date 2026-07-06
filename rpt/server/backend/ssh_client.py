"""
RPT server — установка SSH/SFTP соединений с роботами через hub.

Путь соединения:
  backend  ->  hub:<assigned_port>  --(обратный туннель робота)-->  robot:22

Аутентификация на роботе — по admin-ключу под пользователем robot['ssh_user'] (RM).
Проверка host key робота отключена (known_hosts=None): доверенная внутренняя сеть,
маршрут проходит только внутри инфраструктуры сервера. См. DOCUMENTATION.md.
"""

import asyncio
import socket
import os

import asyncssh

import keymgr

HUB_HOST = os.environ.get("RPT_HUB_INTERNAL_HOST", "hub")
CONNECT_TIMEOUT = 12


def is_port_open(host, port, timeout=3):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def robot_tunnel_online(robot):
    port = robot.get("assigned_port")
    if not port:
        return False
    return is_port_open(HUB_HOST, port, timeout=3)


async def connect_robot(robot):
    """Открыть asyncssh соединение с роботом. Бросает исключение при ошибке."""
    port = robot.get("assigned_port")
    if not port:
        raise RuntimeError("Роботу не назначен порт (не одобрен?)")
    user = robot.get("ssh_user") or "RM"
    conn = await asyncio.wait_for(
        asyncssh.connect(
            host=HUB_HOST,
            port=port,
            username=user,
            client_keys=[keymgr.ADMIN_KEY],
            known_hosts=None,
            keepalive_interval=20,
            keepalive_count_max=3,
        ),
        timeout=CONNECT_TIMEOUT,
    )
    return conn
