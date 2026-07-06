"""
RPT server — SQLite storage layer.

Хранит список роботов, состояние их сопряжения (pairing), назначенные порты
обратных туннелей, заметки и служебные настройки (pairing-код и т.п.).
"""

import sqlite3
import time
import secrets
import threading
import os

DB_PATH = os.environ.get("RPT_DB_PATH", "/data/rpt.db")

# Диапазон портов, которые назначаются обратным туннелям роботов на hub.
PORT_RANGE_START = int(os.environ.get("RPT_PORT_START", "20000"))
PORT_RANGE_END = int(os.environ.get("RPT_PORT_END", "20999"))

_lock = threading.RLock()


def _conn():
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with _lock, _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS robots (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                serial        TEXT UNIQUE NOT NULL,
                name          TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'pending',   -- pending|active|rejected
                tunnel_pubkey TEXT NOT NULL,
                assigned_port INTEGER,
                notes         TEXT NOT NULL DEFAULT '',
                ssh_user      TEXT NOT NULL DEFAULT 'RM',
                enroll_token  TEXT NOT NULL,
                created_at    INTEGER NOT NULL,
                last_seen     INTEGER NOT NULL DEFAULT 0,
                online        INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
        c.commit()


# --------------------------------------------------------------------------
# settings
# --------------------------------------------------------------------------
def get_setting(key, default=None):
    with _lock, _conn() as c:
        row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def set_setting(key, value):
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )
        c.commit()


# --------------------------------------------------------------------------
# pairing (окно сопряжения)
# --------------------------------------------------------------------------
def enable_pairing(ttl_seconds=600):
    """Открыть окно сопряжения. Возвращает (code, expires_at)."""
    code = "".join(secrets.choice("0123456789") for _ in range(6))
    expires = int(time.time()) + ttl_seconds
    set_setting("pairing_code", code)
    set_setting("pairing_expires", expires)
    return code, expires


def get_pairing():
    code = get_setting("pairing_code")
    expires = int(get_setting("pairing_expires", "0"))
    active = bool(code) and expires > int(time.time())
    return {"code": code if active else None, "expires": expires, "active": active}


def check_pairing_code(code):
    p = get_pairing()
    return p["active"] and p["code"] == code


def clear_pairing():
    set_setting("pairing_code", "")
    set_setting("pairing_expires", "0")


# --------------------------------------------------------------------------
# robots
# --------------------------------------------------------------------------
def _next_free_port(c):
    used = {r["assigned_port"] for r in c.execute(
        "SELECT assigned_port FROM robots WHERE assigned_port IS NOT NULL").fetchall()}
    for p in range(PORT_RANGE_START, PORT_RANGE_END + 1):
        if p not in used:
            return p
    raise RuntimeError("Свободные порты для туннелей закончились")


def create_enrollment(serial, name, tunnel_pubkey, ssh_user="RM"):
    """Создать/обновить заявку робота (status=pending). Возвращает (id, token)."""
    token = secrets.token_urlsafe(24)
    now = int(time.time())
    with _lock, _conn() as c:
        existing = c.execute("SELECT id FROM robots WHERE serial=?", (serial,)).fetchone()
        if existing:
            c.execute(
                "UPDATE robots SET name=?, tunnel_pubkey=?, ssh_user=?, "
                "status='pending', enroll_token=?, created_at=? WHERE serial=?",
                (name, tunnel_pubkey, ssh_user, token, now, serial),
            )
            rid = existing["id"]
        else:
            cur = c.execute(
                "INSERT INTO robots(serial,name,status,tunnel_pubkey,ssh_user,"
                "enroll_token,created_at) VALUES(?,?,'pending',?,?,?,?)",
                (serial, name, tunnel_pubkey, ssh_user, token, now),
            )
            rid = cur.lastrowid
        c.commit()
    return rid, token


def approve_robot(robot_id):
    with _lock, _conn() as c:
        r = c.execute("SELECT * FROM robots WHERE id=?", (robot_id,)).fetchone()
        if not r:
            return None
        port = r["assigned_port"] or _next_free_port(c)
        c.execute("UPDATE robots SET status='active', assigned_port=? WHERE id=?",
                  (port, robot_id))
        c.commit()
        return dict(c.execute("SELECT * FROM robots WHERE id=?", (robot_id,)).fetchone())


def reject_robot(robot_id):
    with _lock, _conn() as c:
        c.execute("UPDATE robots SET status='rejected' WHERE id=?", (robot_id,))
        c.commit()


def delete_robot(robot_id):
    with _lock, _conn() as c:
        c.execute("DELETE FROM robots WHERE id=?", (robot_id,))
        c.commit()


def update_robot(robot_id, name=None, notes=None):
    with _lock, _conn() as c:
        if name is not None:
            c.execute("UPDATE robots SET name=? WHERE id=?", (name, robot_id))
        if notes is not None:
            c.execute("UPDATE robots SET notes=? WHERE id=?", (notes, robot_id))
        c.commit()


def set_online(robot_id, online):
    with _lock, _conn() as c:
        c.execute("UPDATE robots SET online=?, last_seen=? WHERE id=?",
                  (1 if online else 0, int(time.time()), robot_id))
        c.commit()


def touch_heartbeat(robot_id):
    with _lock, _conn() as c:
        c.execute("UPDATE robots SET last_seen=? WHERE id=?",
                  (int(time.time()), robot_id))
        c.commit()


def get_robot(robot_id):
    with _lock, _conn() as c:
        r = c.execute("SELECT * FROM robots WHERE id=?", (robot_id,)).fetchone()
        return dict(r) if r else None


def get_robot_by_serial(serial):
    with _lock, _conn() as c:
        r = c.execute("SELECT * FROM robots WHERE serial=?", (serial,)).fetchone()
        return dict(r) if r else None


def list_robots(status=None):
    with _lock, _conn() as c:
        if status:
            rows = c.execute("SELECT * FROM robots WHERE status=? ORDER BY name", (status,)).fetchall()
        else:
            rows = c.execute("SELECT * FROM robots ORDER BY name").fetchall()
        return [dict(r) for r in rows]


def active_robots():
    return list_robots(status="active")
