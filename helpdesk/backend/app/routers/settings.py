import json

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_admin, get_current_user
from ..models import AppSetting, User, ROLE_ADMIN

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Sidebar tabs that can be hidden from regular users.
NAV_TABS = ("catalog", "archive", "chat", "directory")
K_NAV = "nav_tabs"
K_NAV_EXEMPT = "nav_exempt_users"

# Neutral default palette. Admin can override any of these keys.
DEFAULT_PALETTE = {
    "primary": "#4b5563",       # slate-600, neutral
    "primary_hover": "#374151",
    "accent": "#6b7280",
    "bg": "#f3f4f6",
    "surface": "#ffffff",
    "text": "#1f2937",
    "muted": "#6b7280",
    "border": "#e5e7eb",
    "sidebar": "#111827",
    "sidebar_text": "#e5e7eb",
}
DEFAULT_APP_NAME = "HelpDesk"


def _get(db: Session, key: str, default: str) -> str:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else default


def _set(db: Session, key: str, value: str):
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


def read_settings(db: Session) -> dict:
    raw = _get(db, "palette", "")
    palette = dict(DEFAULT_PALETTE)
    if raw:
        try:
            palette.update(json.loads(raw))
        except json.JSONDecodeError:
            pass
    return {
        "palette": palette,
        "app_name": _get(db, "app_name", DEFAULT_APP_NAME),
    }


@router.get("")
def get_settings(db: Session = Depends(get_db)):
    """Public — the login page needs the palette before authentication."""
    return read_settings(db)


@router.put("")
def update_settings(data: dict, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    if "palette" in data and isinstance(data["palette"], dict):
        current = read_settings(db)["palette"]
        current.update({k: v for k, v in data["palette"].items() if k in DEFAULT_PALETTE})
        _set(db, "palette", json.dumps(current))
    if "app_name" in data and isinstance(data["app_name"], str):
        _set(db, "app_name", data["app_name"][:100])
    db.commit()
    return read_settings(db)


@router.post("/reset")
def reset_settings(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    _set(db, "palette", json.dumps(DEFAULT_PALETTE))
    _set(db, "app_name", DEFAULT_APP_NAME)
    db.commit()
    return read_settings(db)


# ---------------------------------------------------------------------------
# Sidebar tab visibility (admin-controlled feature toggles)
# ---------------------------------------------------------------------------
def read_nav_config(db: Session) -> dict:
    tabs = {k: True for k in NAV_TABS}
    raw = _get(db, K_NAV, "")
    if raw:
        try:
            saved = json.loads(raw)
            tabs.update({k: bool(v) for k, v in saved.items() if k in NAV_TABS})
        except json.JSONDecodeError:
            pass
    raw2 = _get(db, K_NAV_EXEMPT, "")
    try:
        exempt = [int(x) for x in json.loads(raw2)] if raw2 else []
    except (json.JSONDecodeError, TypeError, ValueError):
        exempt = []
    return {"tabs": tabs, "exempt_user_ids": exempt}


@router.get("/nav")
def my_nav(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Effective sidebar tabs for the current user. Admins and exempted
    users always see everything."""
    cfg = read_nav_config(db)
    if user.role == ROLE_ADMIN or user.id in cfg["exempt_user_ids"]:
        return {"tabs": {k: True for k in NAV_TABS}}
    return {"tabs": cfg["tabs"]}


@router.get("/nav/admin")
def get_nav_config(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    return read_nav_config(db)


@router.put("/nav/admin")
def update_nav_config(data: dict, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    cfg = read_nav_config(db)
    if isinstance(data.get("tabs"), dict):
        cfg["tabs"].update({k: bool(v) for k, v in data["tabs"].items() if k in NAV_TABS})
        _set(db, K_NAV, json.dumps(cfg["tabs"]))
    if isinstance(data.get("exempt_user_ids"), list):
        ids = [int(x) for x in data["exempt_user_ids"] if isinstance(x, (int, str)) and str(x).isdigit()]
        _set(db, K_NAV_EXEMPT, json.dumps(ids))
    db.commit()
    return read_nav_config(db)
