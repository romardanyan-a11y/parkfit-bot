import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_admin
from ..mailcfg import get_mail_config, set_value
from ..mailer import send_test, send_email, MAIL_T, MAIL_VARS, get_template_overrides
from ..models import User, USER_APPROVED

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


# ---------------------------------------------------------------------------
# Editable templates
# ---------------------------------------------------------------------------
@router.get("/templates")
def get_templates(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    return {
        "kinds": list(MAIL_T.keys()),
        "defaults": {k: {lang: {"subject": v[0], "body": v[1]} for lang, v in langs.items()}
                     for k, langs in MAIL_T.items()},
        "overrides": get_template_overrides(db),
        "vars": MAIL_VARS,
    }


@router.put("/templates")
def save_templates(data: dict, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Store overrides: {kind: {lang: {subject, body}}}. Empty strings mean
    "use the default"; unknown kinds/langs are dropped."""
    incoming = data.get("overrides")
    if not isinstance(incoming, dict):
        raise HTTPException(status_code=400, detail="overrides object required")
    clean = {}
    for kind, langs in incoming.items():
        if kind not in MAIL_T or not isinstance(langs, dict):
            continue
        for lang, tpl in langs.items():
            if lang not in ("ru", "en", "zh") or not isinstance(tpl, dict):
                continue
            subject = str(tpl.get("subject") or "").strip()
            body = str(tpl.get("body") or "").strip()
            if subject or body:
                clean.setdefault(kind, {})[lang] = {"subject": subject, "body": body}
    set_value(db, "mail_templates", json.dumps(clean, ensure_ascii=False))
    db.commit()
    return {"ok": True, "overrides": clean}


# ---------------------------------------------------------------------------
# Broadcast: admin writes a letter to all or selected users
# ---------------------------------------------------------------------------
@router.post("/broadcast")
def broadcast(data: dict, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    subject = str(data.get("subject") or "").strip()
    body = str(data.get("body") or "").strip()
    if not subject or not body:
        raise HTTPException(status_code=400, detail="Subject and body are required")
    cfg = get_mail_config(db)
    if not cfg["enabled"]:
        raise HTTPException(status_code=400, detail="SMTP is not configured")

    q = db.query(User).filter(User.status == USER_APPROVED)
    if not data.get("all"):
        ids = [int(x) for x in (data.get("user_ids") or []) if str(x).isdigit()]
        if not ids:
            raise HTTPException(status_code=400, detail="Pick recipients or choose 'all'")
        q = q.filter(User.id.in_(ids))
    recipients = [u.email for u in q.all() if u.email]
    for addr in recipients:
        send_email(addr, subject, body)
    return {"ok": True, "sent": len(recipients)}
