"""Export / import / scheduled backups.

A backup is a single self-contained JSON document holding every ticket, its
comments, history, checklist, tags, attachments (file bytes included as
base64), plus users, departments, access rights and app settings. It can be
downloaded, re-imported to fully restore state, and is written automatically
on a configurable schedule.
"""
import base64
import glob
import logging
import os
import threading
import time
from datetime import datetime

from .config import settings
from .database import SessionLocal
from . import models

log = logging.getLogger("helpdesk.backup")

EXPORT_VERSION = 1

# ---- backup config keys (stored in AppSetting) ----
K_ENABLED = "backup_enabled"
K_INTERVAL = "backup_interval_hours"
K_KEEP = "backup_keep"
K_LAST = "backup_last_at"


# ---------------------------------------------------------------------------
# datetime helpers
# ---------------------------------------------------------------------------
def _dt(v):
    return v.isoformat() if v else None


def _pdt(v):
    if not v:
        return None
    try:
        return datetime.fromisoformat(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------
def _get(db, key, default=None):
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    return row.value if row else default


def _set(db, key, value):
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(models.AppSetting(key=key, value=value))


def get_config(db) -> dict:
    return {
        "enabled": _get(db, K_ENABLED, "false") == "true",
        "interval_hours": int(_get(db, K_INTERVAL, "24") or 24),
        "keep": int(_get(db, K_KEEP, "14") or 14),
        "last_backup_at": _get(db, K_LAST, None),
    }


def set_config(db, enabled=None, interval_hours=None, keep=None):
    if enabled is not None:
        _set(db, K_ENABLED, "true" if enabled else "false")
    if interval_hours is not None:
        _set(db, K_INTERVAL, str(max(1, int(interval_hours))))
    if keep is not None:
        _set(db, K_KEEP, str(max(1, int(keep))))
    db.commit()


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def build_export(db, include_files: bool = True) -> dict:
    def att_content(a):
        if not include_files:
            return None
        path = os.path.join(settings.UPLOAD_DIR, a.stored_name or "")
        if a.stored_name and os.path.exists(path):
            try:
                with open(path, "rb") as f:
                    return base64.b64encode(f.read()).decode("ascii")
            except OSError:
                return None
        return None

    users = db.query(models.User).all()
    departments = db.query(models.Department).all()
    tags = db.query(models.Tag).all()
    tasks = db.query(models.Task).all()

    return {
        "version": EXPORT_VERSION,
        "exported_at": datetime.utcnow().isoformat(),
        "users": [{
            "id": u.id, "email": u.email, "password_hash": u.password_hash,
            "full_name": u.full_name, "description": u.description, "role": u.role,
            "status": u.status, "preferred_language": u.preferred_language,
            "must_change_password": bool(u.must_change_password),
            "position_id": u.position_id,
            "created_at": _dt(u.created_at),
            "department_ids": [d.id for d in u.departments],
        } for u in users],
        "positions": [{"id": p.id, "name": p.name, "name_en": p.name_en or "",
                       "name_zh": p.name_zh or "", "created_at": _dt(p.created_at)}
                      for p in db.query(models.Position).all()],
        "user_aliases": [{
            "id": a.id, "owner_id": a.owner_id, "target_id": a.target_id,
            "alias": a.alias or "", "display": bool(a.display), "created_at": _dt(a.created_at),
        } for a in db.query(models.UserAlias).all()],
        "departments": [{
            "id": d.id, "name": d.name, "description": d.description,
            "created_at": _dt(d.created_at), "created_by_id": d.created_by_id,
        } for d in departments],
        "tags": [{"id": t.id, "name": t.name, "color": t.color, "created_at": _dt(t.created_at)} for t in tags],
        "tasks": [{
            "id": t.id, "key": t.key, "department_id": t.department_id, "title": t.title,
            "description": t.description, "status": t.status, "priority": t.priority,
            "type": t.type, "author_id": t.author_id, "assignee_id": t.assignee_id,
            "due_date": _dt(t.due_date), "archived": t.archived,
            "created_at": _dt(t.created_at), "updated_at": _dt(t.updated_at),
            "tag_ids": [tg.id for tg in t.tags],
        } for t in tasks],
        "comments": [{
            "id": c.id, "task_id": c.task_id, "author_id": c.author_id,
            "body": c.body, "created_at": _dt(c.created_at),
        } for c in db.query(models.Comment).all()],
        "attachments": [{
            "id": a.id, "task_id": a.task_id, "filename": a.filename,
            "stored_name": a.stored_name, "content_type": a.content_type,
            "size": a.size, "uploaded_by_id": a.uploaded_by_id,
            "created_at": _dt(a.created_at), "content_b64": att_content(a),
        } for a in db.query(models.Attachment).all()],
        "task_events": [{
            "id": e.id, "task_id": e.task_id, "actor_id": e.actor_id,
            "kind": e.kind, "detail": e.detail, "created_at": _dt(e.created_at),
        } for e in db.query(models.TaskEvent).all()],
        "checklist_items": [{
            "id": i.id, "task_id": i.task_id, "text": i.text,
            "is_done": i.is_done, "position": i.position, "created_at": _dt(i.created_at),
        } for i in db.query(models.ChecklistItem).all()],
        "notifications": [{
            "id": n.id, "recipient_id": n.recipient_id, "kind": n.kind,
            "title": n.title, "body": n.body, "payload": n.payload,
            "is_read": n.is_read, "created_at": _dt(n.created_at),
        } for n in db.query(models.Notification).all()],
        "settings": {s.key: s.value for s in db.query(models.AppSetting).all()},
    }


# ---------------------------------------------------------------------------
# Import (full restore — replaces all data)
# ---------------------------------------------------------------------------
def restore_import(db, data: dict) -> dict:
    if not isinstance(data, dict) or "tasks" not in data:
        raise ValueError("Invalid backup file")

    # Wipe existing data (children first, then association tables via Core).
    db.query(models.Notification).delete()
    db.query(models.TaskRead).delete()
    db.query(models.ChecklistItem).delete()
    db.query(models.TaskEvent).delete()
    db.query(models.Attachment).delete()
    db.query(models.Comment).delete()
    db.query(models.UserAlias).delete()
    db.execute(models.task_tags.delete())
    db.execute(models.user_department_access.delete())
    db.query(models.Task).delete()
    db.query(models.Tag).delete()
    db.query(models.Department).delete()
    db.query(models.User).delete()
    db.query(models.Position).delete()
    db.query(models.AppSetting).delete()
    db.flush()

    # Positions first — users reference them via position_id.
    for p in data.get("positions", []):
        db.add(models.Position(
            id=p["id"], name=p["name"],
            name_en=p.get("name_en", ""), name_zh=p.get("name_zh", ""),
            created_at=_pdt(p.get("created_at")),
        ))
    db.flush()

    # Departments
    for d in data.get("departments", []):
        db.add(models.Department(
            id=d["id"], name=d["name"], description=d.get("description", ""),
            created_at=_pdt(d.get("created_at")), created_by_id=d.get("created_by_id"),
        ))
    # Users
    for u in data.get("users", []):
        db.add(models.User(
            id=u["id"], email=u["email"], password_hash=u["password_hash"],
            full_name=u.get("full_name", ""), description=u.get("description", ""),
            role=u.get("role", "agent"), status=u.get("status", "approved"),
            preferred_language=u.get("preferred_language", "ru"),
            must_change_password=u.get("must_change_password", False),
            position_id=u.get("position_id"),
            created_at=_pdt(u.get("created_at")),
        ))
    # Tags
    for t in data.get("tags", []):
        db.add(models.Tag(id=t["id"], name=t["name"], color=t.get("color", "#6b7280"),
                          created_at=_pdt(t.get("created_at"))))
    db.flush()

    # User <-> department access
    for u in data.get("users", []):
        for did in u.get("department_ids", []):
            db.execute(models.user_department_access.insert().values(user_id=u["id"], department_id=did))

    # Tasks
    for t in data.get("tasks", []):
        db.add(models.Task(
            id=t["id"], key=t.get("key"), department_id=t["department_id"], title=t["title"],
            description=t.get("description", ""), status=t.get("status", "open"),
            priority=t.get("priority", "normal"), type=t.get("type", "task"),
            author_id=t.get("author_id"), assignee_id=t.get("assignee_id"),
            due_date=_pdt(t.get("due_date")), archived=t.get("archived", False),
            created_at=_pdt(t.get("created_at")), updated_at=_pdt(t.get("updated_at")),
        ))
    db.flush()

    # Task <-> tag links
    for t in data.get("tasks", []):
        for tag_id in t.get("tag_ids", []):
            db.execute(models.task_tags.insert().values(task_id=t["id"], tag_id=tag_id))

    # Comments
    for c in data.get("comments", []):
        db.add(models.Comment(id=c["id"], task_id=c["task_id"], author_id=c.get("author_id"),
                             body=c["body"], created_at=_pdt(c.get("created_at"))))
    # Attachments (+ restore files to disk)
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    for a in data.get("attachments", []):
        db.add(models.Attachment(
            id=a["id"], task_id=a["task_id"], filename=a.get("filename"),
            stored_name=a.get("stored_name"), content_type=a.get("content_type"),
            size=a.get("size", 0), uploaded_by_id=a.get("uploaded_by_id"),
            created_at=_pdt(a.get("created_at")),
        ))
        b64 = a.get("content_b64")
        if b64 and a.get("stored_name"):
            try:
                with open(os.path.join(settings.UPLOAD_DIR, a["stored_name"]), "wb") as f:
                    f.write(base64.b64decode(b64))
            except (OSError, ValueError):
                log.warning("Could not restore attachment file %s", a.get("stored_name"))
    # Events
    for e in data.get("task_events", []):
        db.add(models.TaskEvent(id=e["id"], task_id=e["task_id"], actor_id=e.get("actor_id"),
                               kind=e.get("kind"), detail=e.get("detail", ""), created_at=_pdt(e.get("created_at"))))
    # Checklist
    for i in data.get("checklist_items", []):
        db.add(models.ChecklistItem(id=i["id"], task_id=i["task_id"], text=i["text"],
                                    is_done=i.get("is_done", False), position=i.get("position", 0),
                                    created_at=_pdt(i.get("created_at"))))
    # Notifications
    for n in data.get("notifications", []):
        db.add(models.Notification(id=n["id"], recipient_id=n.get("recipient_id"), kind=n.get("kind"),
                                   title=n.get("title"), body=n.get("body", ""), payload=n.get("payload", ""),
                                   is_read=n.get("is_read", False), created_at=_pdt(n.get("created_at"))))
    # Personal aliases (owner & target users now exist)
    for a in data.get("user_aliases", []):
        db.add(models.UserAlias(
            id=a["id"], owner_id=a.get("owner_id"), target_id=a.get("target_id"),
            alias=a.get("alias", ""), display=a.get("display", True),
            created_at=_pdt(a.get("created_at")),
        ))
    # Settings
    for k, v in (data.get("settings") or {}).items():
        db.add(models.AppSetting(key=k, value=v))

    db.commit()
    return {
        "users": len(data.get("users", [])),
        "departments": len(data.get("departments", [])),
        "tasks": len(data.get("tasks", [])),
        "comments": len(data.get("comments", [])),
    }


# ---------------------------------------------------------------------------
# Backup files on disk
# ---------------------------------------------------------------------------
def _timestamp() -> str:
    return datetime.utcnow().strftime("%Y%m%d-%H%M%S")


def write_backup_file(db, keep: int | None = None) -> str:
    import json
    os.makedirs(settings.BACKUP_DIR, exist_ok=True)
    data = build_export(db, include_files=True)
    name = f"helpdesk-backup-{_timestamp()}.json"
    path = os.path.join(settings.BACKUP_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    _set(db, K_LAST, datetime.utcnow().isoformat())
    db.commit()
    _rotate(keep if keep is not None else get_config(db)["keep"])
    log.info("Wrote backup %s", name)
    return path


def _rotate(keep: int):
    files = sorted(glob.glob(os.path.join(settings.BACKUP_DIR, "helpdesk-backup-*.json")))
    for old in files[:-keep] if keep > 0 else []:
        try:
            os.remove(old)
        except OSError:
            pass


def list_backups() -> list:
    files = sorted(glob.glob(os.path.join(settings.BACKUP_DIR, "helpdesk-backup-*.json")), reverse=True)
    out = []
    for p in files:
        try:
            st = os.stat(p)
            out.append({"name": os.path.basename(p), "size": st.st_size,
                        "created_at": datetime.utcfromtimestamp(st.st_mtime).isoformat()})
        except OSError:
            continue
    return out


# ---------------------------------------------------------------------------
# Scheduler (background thread)
# ---------------------------------------------------------------------------
def _scheduler_loop():
    while True:
        try:
            db = SessionLocal()
            try:
                cfg = get_config(db)
                if cfg["enabled"]:
                    last = _pdt(cfg["last_backup_at"])
                    due = last is None or (datetime.utcnow() - last).total_seconds() >= cfg["interval_hours"] * 3600
                    if due:
                        write_backup_file(db, keep=cfg["keep"])
            finally:
                db.close()
        except Exception as exc:  # noqa: BLE001
            log.warning("Backup scheduler error: %s", exc)
        time.sleep(60)


def start_scheduler():
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    log.info("Backup scheduler started")
