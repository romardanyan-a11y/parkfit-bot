"""Mail service configuration.

Admin-editable SMTP settings and notification toggles stored in AppSetting;
environment variables act as defaults for fresh installations.
"""
from .config import settings as env
from .database import SessionLocal
from .models import AppSetting


def _get(db, key: str, default: str = "") -> str:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row is not None else default


def set_value(db, key: str, value: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


def get_mail_config(db=None) -> dict:
    own = False
    if db is None:
        db = SessionLocal()
        own = True
    try:
        cfg = {
            "host": _get(db, "mail_host", env.SMTP_HOST),
            "port": int(_get(db, "mail_port", str(env.SMTP_PORT)) or 587),
            "user": _get(db, "mail_user", env.SMTP_USER),
            "password": _get(db, "mail_password", env.SMTP_PASSWORD),
            "tls": _get(db, "mail_tls", "true" if env.SMTP_TLS else "false") == "true",
            "ssl": _get(db, "mail_ssl", "true" if env.SMTP_SSL else "false") == "true",
            "mail_from": _get(db, "mail_from", env.MAIL_FROM),
            "base_url": _get(db, "mail_base_url", env.APP_BASE_URL),
            # Notification toggles
            "notify_new_task": _get(db, "notify_new_task", "true") == "true",
            "notify_assigned": _get(db, "notify_assigned", "true") == "true",
            "notify_due_soon": _get(db, "notify_due_soon", "true") == "true",
            "due_soon_hours": int(_get(db, "due_soon_hours", "24") or 24),
        }
        cfg["enabled"] = bool(cfg["host"])
        return cfg
    finally:
        if own:
            db.close()
