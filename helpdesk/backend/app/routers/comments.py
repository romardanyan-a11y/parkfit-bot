import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import get_current_user
from ..models import Task, Comment, Attachment, User, Notification
from ..schemas import CommentIn, CommentOut, AttachmentOut
from ..mailer import send_email_many
from .tasks import ensure_department_access, log_event

router = APIRouter(prefix="/api", tags=["comments"])


def _get_task(db: Session, task_id: int, user: User) -> Task:
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    ensure_department_access(user, task.department_id)
    return task


@router.post("/tasks/{task_id}/comments", response_model=CommentOut)
def add_comment(task_id: int, data: CommentIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = _get_task(db, task_id, user)
    if not data.body.strip():
        raise HTTPException(status_code=400, detail="Empty comment")
    comment = Comment(task_id=task.id, author_id=user.id, body=data.body)
    db.add(comment)
    log_event(db, task, user, "comment", "")

    # Notify the other interested parties (assignee + author) except the commenter.
    recipients = []
    for u in (task.assignee, task.author):
        if u and u.id != user.id:
            recipients.append(u)
            db.add(Notification(
                recipient_id=u.id,
                kind="task_comment",
                title=f"New comment on {task.key}",
                body=data.body[:200],
                payload=str(task.id),
            ))
    db.commit()
    db.refresh(comment)

    send_email_many(
        [u.email for u in recipients],
        f"[HelpDesk] New comment on {task.key}: {task.title}",
        f"{user.full_name or user.email} commented:\n\n{data.body}",
    )
    return comment


@router.post("/tasks/{task_id}/attachments", response_model=AttachmentOut)
def upload_attachment(task_id: int, file: UploadFile = File(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = _get_task(db, task_id, user)

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(file.filename or "")[1]
    stored_name = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(settings.UPLOAD_DIR, stored_name)

    size = 0
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    with open(dest, "wb") as out:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                out.close()
                os.remove(dest)
                raise HTTPException(status_code=413, detail="File too large")
            out.write(chunk)

    att = Attachment(
        task_id=task.id,
        filename=file.filename or stored_name,
        stored_name=stored_name,
        content_type=file.content_type or "application/octet-stream",
        size=size,
        uploaded_by_id=user.id,
    )
    db.add(att)
    log_event(db, task, user, "attachment", file.filename or "")
    db.commit()
    db.refresh(att)
    return att


@router.get("/attachments/{att_id}/download")
def download_attachment(att_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    att = db.query(Attachment).get(att_id)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    task = db.query(Task).get(att.task_id)
    ensure_department_access(user, task.department_id)
    path = os.path.join(settings.UPLOAD_DIR, att.stored_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File missing")
    return FileResponse(path, filename=att.filename, media_type=att.content_type)
