import os
import tempfile
import zipfile

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import get_current_admin
from ..models import User
from .. import backup

router = APIRouter(prefix="/api/admin/backup", tags=["backups"])


@router.get("/config")
def get_backup_config(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    cfg = backup.get_config(db)
    cfg["backups"] = backup.list_backups()
    return cfg


@router.put("/config")
def update_backup_config(data: dict, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    backup.set_config(
        db,
        enabled=data.get("enabled"),
        interval_hours=data.get("interval_hours"),
        keep=data.get("keep"),
    )
    return backup.get_config(db)


@router.post("/run")
def run_backup_now(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    path = backup.write_backup_file(db)
    return {"ok": True, "file": os.path.basename(path), "backups": backup.list_backups()}


@router.get("/list")
def list_backup_files(admin: User = Depends(get_current_admin)):
    return backup.list_backups()


@router.get("/download/{name}")
def download_backup(name: str, admin: User = Depends(get_current_admin)):
    # Prevent path traversal — only allow our own backup filenames.
    if ("/" in name or "\\" in name or not name.startswith("helpdesk-backup-")
            or not name.endswith((".zip", ".json"))):
        raise HTTPException(status_code=400, detail="Bad name")
    path = os.path.join(settings.BACKUP_DIR, name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Not found")
    media = "application/zip" if name.endswith(".zip") else "application/json"
    return FileResponse(path, filename=name, media_type=media)


# Live export: build a fresh archive (data + all uploaded files) and stream it.
@router.get("/export")
def export_now(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    data = backup.build_export(db, include_files=False)
    ts = data["exported_at"].replace(":", "").replace("-", "").split(".")[0]
    os.makedirs(settings.BACKUP_DIR, exist_ok=True)
    # Temp name does not match helpdesk-backup-* so it never shows in the list.
    fd, tmp = tempfile.mkstemp(suffix=".zip", prefix="export-", dir=settings.BACKUP_DIR)
    os.close(fd)
    try:
        backup.write_archive(tmp, data)
    except Exception:
        os.remove(tmp)
        raise
    return FileResponse(
        tmp,
        filename=f"helpdesk-export-{ts}.zip",
        media_type="application/zip",
        background=BackgroundTask(os.remove, tmp),
    )


@router.post("/import")
async def import_backup(file: UploadFile = File(...), admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    raw = await file.read()
    try:
        summary = backup.restore_from_bytes(db, raw)
    except (ValueError, KeyError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid backup file: {exc}")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Invalid backup file")
    return {"ok": True, "restored": summary}
