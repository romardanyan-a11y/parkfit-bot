from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_admin
from ..mailcfg import get_mail_config, set_value
from ..mailer import send_test
from ..models import User

router = APIRouter(prefix="/api/admin/mail", tags=["mail"])

# AppSetting keys for the string/bool fields the admin may edit.
FIELD_KEYS = {
    "host": "mail_host",
    "port": "mail_port",
    "user": "mail_user",
    "mail_from": "mail_from",
    "base_url": "mail_base_url",
}
BOOL_KEYS = {
    "tls": "mail_tls",
    "ssl": "mail_ssl",
    "notify_new_task": "notify_new_task",
    "notify_assigned": "notify_assigned",
    "notify_due_soon": "notify_due_soon",
}


def _masked(cfg: dict) -> dict:
    out = dict(cfg)
    out["has_password"] = bool(cfg.get("password"))
    out.pop("password", None)
    return out


@router.get("")
def get_mail(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    return _masked(get_mail_config(db))


@router.put("")
def update_mail(data: dict, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    for field, key in FIELD_KEYS.items():
        if field in data and data[field] is not None:
            set_value(db, key, str(data[field]).strip())
    for field, key in BOOL_KEYS.items():
        if field in data and data[field] is not None:
            set_value(db, key, "true" if data[field] else "false")
    # Password: only replace when a non-empty value is supplied; the UI never
    # gets the stored one back, so an untouched field must not wipe it.
    if data.get("password"):
        set_value(db, "mail_password", str(data["password"]))
    if data.get("clear_password"):
        set_value(db, "mail_password", "")
    if "due_soon_hours" in data:
        try:
            set_value(db, "due_soon_hours", str(max(1, int(data["due_soon_hours"]))))
        except (TypeError, ValueError):
            pass
    db.commit()
    return _masked(get_mail_config(db))


@router.post("/test")
def test_mail(data: dict = None, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    to = (data or {}).get("to") or admin.email
    err = send_test(to)
    return {"ok": err is None, "error": err, "to": to}
