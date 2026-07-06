"""
RPT server — управление ключами и authorized_keys для hub.

* admin keypair — которым backend ходит на роботов под пользователем RM;
* hub host key — стабильный ключ хоста SSH-хаба (чтобы роботы могли его проверять);
* authorized_keys — файл, который читает hub-sshd; в него для каждого активного
  робота пишется его туннельный публичный ключ с ограничением permitlisten.
"""

import os
import subprocess

KEYS_DIR = os.environ.get("RPT_KEYS_DIR", "/keys")

ADMIN_KEY = os.path.join(KEYS_DIR, "admin_ed25519")
ADMIN_PUB = ADMIN_KEY + ".pub"
HUB_HOST_KEY = os.path.join(KEYS_DIR, "ssh_host_ed25519_key")
HUB_HOST_PUB = HUB_HOST_KEY + ".pub"
AUTHORIZED_KEYS = os.path.join(KEYS_DIR, "authorized_keys")


def ensure_keys():
    """Сгенерировать admin-ключ и host-ключ hub, если их ещё нет."""
    os.makedirs(KEYS_DIR, exist_ok=True)
    if not os.path.exists(ADMIN_KEY):
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "rpt-admin",
             "-f", ADMIN_KEY],
            check=True, capture_output=True,
        )
        os.chmod(ADMIN_KEY, 0o600)
    if not os.path.exists(HUB_HOST_KEY):
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "rpt-hub-host",
             "-f", HUB_HOST_KEY],
            check=True, capture_output=True,
        )
        os.chmod(HUB_HOST_KEY, 0o600)
    if not os.path.exists(AUTHORIZED_KEYS):
        open(AUTHORIZED_KEYS, "a").close()
        os.chmod(AUTHORIZED_KEYS, 0o600)


def admin_public_key():
    with open(ADMIN_PUB) as f:
        return f.read().strip()


def hub_host_public_key():
    with open(HUB_HOST_PUB) as f:
        return f.read().strip()


def rebuild_authorized_keys(active_robots):
    """
    Переписать authorized_keys hub на основании активных роботов.

    Каждый робот получает строку с ограничениями:
      * restrict            — запретить всё (pty, agent, X11, exec ...);
      * port-forwarding     — но разрешить проброс портов;
      * permitlisten="*:P"  — робот может слушать (обратный туннель -R) только
                              на своём назначенном порту P и ни на каком другом.
    Это не даёт роботу перехватить чужой порт.
    """
    lines = []
    for r in active_robots:
        port = r.get("assigned_port")
        pub = (r.get("tunnel_pubkey") or "").strip()
        if not port or not pub:
            continue
        opts = f'restrict,port-forwarding,permitlisten="*:{port}"'
        lines.append(f"{opts} {pub} rpt-robot-{r['serial']}")
    tmp = AUTHORIZED_KEYS + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    os.chmod(tmp, 0o600)
    os.replace(tmp, AUTHORIZED_KEYS)
