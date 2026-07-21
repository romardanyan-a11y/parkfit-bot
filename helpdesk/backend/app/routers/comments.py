import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import get_current_user
from ..models import Task, Comment, Attachment, User, Notification, USER_APPROVED
from ..schemas import CommentIn, CommentOut, AttachmentOut
from ..mailer import send_email_many
from ..security import decode_token
from .tasks import ensure_department_access, log_event

router = APIRouter(prefix="/api", tags=["comments"])


def _get_task(db: Session, task_id: int, user: User) -> Task:
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    ensure_department_access(user, task.department_id)
    return task


def _save_upload(file: UploadFile, task: Task, user: User, db: Session, comment_id=None) -> Attachment:
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
        comment_id=comment_id,
        filename=file.filename or stored_name,
        stored_name=stored_name,
        content_type=file.content_type or "application/octet-stream",
        size=size,
        uploaded_by_id=user.id,
    )
    db.add(att)
    return att


@router.post("/tasks/{task_id}/comments", response_model=CommentOut)
def add_comment(task_id: int, data: CommentIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = _get_task(db, task_id, user)
    body = (data.body or "").strip()
    # Body may be empty when the comment is only file attachments (uploaded next).
    comment = Comment(task_id=task.id, author_id=user.id, body=body)
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
                body=body[:200],
                payload=str(task.id),
            ))
    db.commit()
    db.refresh(comment)

    if body:
        send_email_many(
            [u.email for u in recipients],
            f"[HelpDesk] New comment on {task.key}: {task.title}",
            f"{user.full_name or user.email} commented:\n\n{body}",
        )
    return comment


@router.post("/tasks/{task_id}/attachments", response_model=AttachmentOut)
def upload_attachment(
    task_id: int,
    file: UploadFile = File(...),
    comment_id: int = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = _get_task(db, task_id, user)
    if comment_id is not None:
        c = db.query(Comment).get(comment_id)
        if not c or c.task_id != task.id:
            raise HTTPException(status_code=400, detail="Bad comment")
    att = _save_upload(file, task, user, db, comment_id=comment_id)
    if comment_id is None:
        log_event(db, task, user, "attachment", file.filename or "")
    db.commit()
    db.refresh(att)
    return att


@router.post("/comments/{comment_id}/attachments", response_model=AttachmentOut)
def upload_comment_attachment(comment_id: int, file: UploadFile = File(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    comment = db.query(Comment).get(comment_id)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    task = _get_task(db, comment.task_id, user)
    att = _save_upload(file, task, user, db, comment_id=comment.id)
    db.commit()
    db.refresh(att)
    return att


def _resolve_user(request: Request, token, db: Session) -> User:
    """Auth via Authorization header OR a ?token= query param (needed so that
    <img>/<video> tags — which cannot send headers — can stream media)."""
    raw = None
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        raw = auth[7:]
    elif token:
        raw = token
    if not raw:
        raise HTTPException(status_code=401, detail="Not authenticated")
    sub = decode_token(raw)
    if not sub:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).get(int(sub))
    if not user or user.status != USER_APPROVED:
        raise HTTPException(status_code=403, detail="Not allowed")
    return user


def _load_attachment(db: Session, att_id: int, user: User) -> Attachment:
    att = db.query(Attachment).get(att_id)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    task = db.query(Task).get(att.task_id)
    ensure_department_access(user, task.department_id)
    path = os.path.join(settings.UPLOAD_DIR, att.stored_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File missing")
    return att


def _range_response(path: str, content_type: str, request: Request):
    """Serve a file inline with HTTP Range support, so <video> can seek and
    play in the browser (Safari in particular requires 206 Partial Content)."""
    file_size = os.path.getsize(path)
    range_header = request.headers.get("range")
    base_headers = {"Accept-Ranges": "bytes", "Content-Disposition": "inline"}

    if range_header and range_header.startswith("bytes="):
        try:
            start_s, end_s = range_header[6:].split("-", 1)
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else file_size - 1
        except ValueError:
            start, end = 0, file_size - 1
        start = max(0, start)
        end = min(end, file_size - 1)
        if start > end:
            start = 0
        length = end - start + 1

        def stream_range():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {**base_headers,
                   "Content-Range": f"bytes {start}-{end}/{file_size}",
                   "Content-Length": str(length)}
        return StreamingResponse(stream_range(), status_code=206, headers=headers, media_type=content_type)

    def stream_full():
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk

    headers = {**base_headers, "Content-Length": str(file_size)}
    return StreamingResponse(stream_full(), headers=headers, media_type=content_type)


@router.get("/attachments/{att_id}/view")
def view_attachment(att_id: int, request: Request, token: str = None, db: Session = Depends(get_db)):
    """Serve the file INLINE (with HTTP range support) so images/videos can be
    viewed and played directly in the browser without downloading."""
    user = _resolve_user(request, token, db)
    att = _load_attachment(db, att_id, user)
    path = os.path.join(settings.UPLOAD_DIR, att.stored_name)
    return _range_response(path, att.content_type or "application/octet-stream", request)


@router.get("/attachments/{att_id}/download")
def download_attachment(att_id: int, request: Request, token: str = None, db: Session = Depends(get_db)):
    user = _resolve_user(request, token, db)
    att = _load_attachment(db, att_id, user)
    path = os.path.join(settings.UPLOAD_DIR, att.stored_name)
    return FileResponse(path, filename=att.filename, media_type=att.content_type)
