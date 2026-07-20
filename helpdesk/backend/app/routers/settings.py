import json

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_admin
from ..models import AppSetting, User

router = APIRouter(prefix="/api/settings", tags=["settings"])

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
