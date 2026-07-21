import os
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import get_current_user
from ..models import (
    Conversation,
    ConversationMember,
    ConversationRead,
    ConversationTask,
    ChatMessage,
    ChatFile,
    Task,
    User,
    ROLE_ADMIN,
    USER_APPROVED,
)
from ..schemas import (
    ChatMessageIn,
    ChatMessageOut,
    ChatFileOut,
    GroupIn,
    MembersIn,
    ConvTaskIn,
    UserMini,
)
from .comments import _resolve_user, _range_response, _maybe_convert_heic
from .departments import visible_department_ids

router = APIRouter(prefix="/api/chat", tags=["chat"])

MAX_MESSAGES = 300


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _get_conv_for(db: Session, conv_id: int, user: User) -> Conversation:
    conv = db.query(Conversation).get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    member = db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conv_id,
        ConversationMember.user_id == user.id,
    ).first()
    if not member:
        raise HTTPException(status_code=403, detail="Not a member")
    return conv


def _user_mini(u: User | None):
    if not u:
        return None
    return {"id": u.id, "email": u.email, "full_name": u.full_name or "",
            "role": u.role, "avatar_name": u.avatar_name}


def _conv_out(db: Session, conv: Conversation, user: User) -> dict:
    members = [m.user for m in conv.members if m.user]
    last = (db.query(ChatMessage)
            .filter(ChatMessage.conversation_id == conv.id)
            .order_by(ChatMessage.id.desc()).first())
    read = db.query(ConversationRead).filter(
        ConversationRead.conversation_id == conv.id,
        ConversationRead.user_id == user.id,
    ).first()
    unread_q = db.query(ChatMessage).filter(
        ChatMessage.conversation_id == conv.id,
        ChatMessage.author_id != user.id,
    )
    if read and read.last_seen_at:
        unread_q = unread_q.filter(ChatMessage.created_at > read.last_seen_at)
    unread = unread_q.count()
    return {
        "id": conv.id,
        "type": conv.type,
        "name": conv.name or "",
        "avatar_name": conv.avatar_name,
        "created_by_id": conv.created_by_id,
        "members": [_user_mini(u) for u in members],
        "last_message": {
            "body": (last.body or "")[:120] if last else "",
            "has_files": bool(last and last.files),
            "author": _user_mini(last.author) if last else None,
            "created_at": last.created_at.isoformat() if last else None,
        } if last else None,
        "unread": unread,
    }


def _mark_seen(db: Session, conv_id: int, user: User):
    row = db.query(ConversationRead).filter(
        ConversationRead.conversation_id == conv_id,
        ConversationRead.user_id == user.id,
    ).first()
    if not row:
        row = ConversationRead(conversation_id=conv_id, user_id=user.id)
        db.add(row)
    row.last_seen_at = datetime.utcnow()
    db.commit()


# ---------------------------------------------------------------------------
# conversations
# ---------------------------------------------------------------------------
@router.get("/conversations")
def list_conversations(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conv_ids = [m.conversation_id for m in db.query(ConversationMember)
                .filter(ConversationMember.user_id == user.id)]
    convs = db.query(Conversation).filter(Conversation.id.in_(conv_ids)).all() if conv_ids else []
    out = [_conv_out(db, c, user) for c in convs]
    # Most recently active first.
    out.sort(key=lambda c: (c["last_message"]["created_at"] if c["last_message"] else ""), reverse=True)
    return out


@router.get("/unread")
def chat_unread(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    total = 0
    for m in db.query(ConversationMember).filter(ConversationMember.user_id == user.id):
        read = db.query(ConversationRead).filter(
            ConversationRead.conversation_id == m.conversation_id,
            ConversationRead.user_id == user.id,
        ).first()
        q = db.query(ChatMessage).filter(
            ChatMessage.conversation_id == m.conversation_id,
            ChatMessage.author_id != user.id,
        )
        if read and read.last_seen_at:
            q = q.filter(ChatMessage.created_at > read.last_seen_at)
        total += q.count()
    return {"total": total}


@router.post("/dm/{user_id}")
def open_dm(user_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get or create a direct-message conversation with another user."""
    if user_id == user.id:
        raise HTTPException(status_code=400, detail="Cannot DM yourself")
    other = db.query(User).get(user_id)
    if not other or other.status != USER_APPROVED:
        raise HTTPException(status_code=404, detail="User not found")
    # Find an existing DM shared by exactly these two users.
    my_convs = {m.conversation_id for m in db.query(ConversationMember)
                .filter(ConversationMember.user_id == user.id)}
    their = db.query(ConversationMember).filter(
        ConversationMember.user_id == user_id,
        ConversationMember.conversation_id.in_(my_convs or {0}),
    ).all()
    for m in their:
        conv = db.query(Conversation).get(m.conversation_id)
        if conv and conv.type == "dm":
            return _conv_out(db, conv, user)
    conv = Conversation(type="dm", created_by_id=user.id)
    db.add(conv)
    db.flush()
    db.add(ConversationMember(conversation_id=conv.id, user_id=user.id))
    db.add(ConversationMember(conversation_id=conv.id, user_id=user_id))
    db.commit()
    db.refresh(conv)
    return _conv_out(db, conv, user)


@router.post("/groups")
def create_group(data: GroupIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name required")
    conv = Conversation(type="group", name=name, created_by_id=user.id)
    db.add(conv)
    db.flush()
    ids = set(data.member_ids or []) | {user.id}
    for uid in ids:
        if db.query(User).get(uid):
            db.add(ConversationMember(conversation_id=conv.id, user_id=uid))
    db.commit()
    db.refresh(conv)
    return _conv_out(db, conv, user)


@router.put("/groups/{conv_id}")
def rename_group(conv_id: int, data: GroupIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conv = _get_conv_for(db, conv_id, user)
    if conv.type != "group":
        raise HTTPException(status_code=400, detail="Not a group")
    if user.role != ROLE_ADMIN and conv.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="Only the creator or admin")
    conv.name = (data.name or "").strip() or conv.name
    db.commit()
    return _conv_out(db, conv, user)


@router.post("/groups/{conv_id}/members")
def add_members(conv_id: int, data: MembersIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conv = _get_conv_for(db, conv_id, user)
    if conv.type != "group":
        raise HTTPException(status_code=400, detail="Not a group")
    existing = {m.user_id for m in conv.members}
    for uid in data.user_ids or []:
        if uid not in existing and db.query(User).get(uid):
            db.add(ConversationMember(conversation_id=conv.id, user_id=uid))
    db.commit()
    db.refresh(conv)
    return _conv_out(db, conv, user)


@router.delete("/groups/{conv_id}/members/{member_id}")
def remove_member(conv_id: int, member_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conv = _get_conv_for(db, conv_id, user)
    if conv.type != "group":
        raise HTTPException(status_code=400, detail="Not a group")
    # Anyone can leave; only the creator/admin removes others.
    if member_id != user.id and user.role != ROLE_ADMIN and conv.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="Only the creator or admin")
    db.query(ConversationMember).filter(
        ConversationMember.conversation_id == conv_id,
        ConversationMember.user_id == member_id,
    ).delete()
    db.commit()
    return {"ok": True}


@router.delete("/groups/{conv_id}")
def delete_group(conv_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conv = _get_conv_for(db, conv_id, user)
    if conv.type != "group":
        raise HTTPException(status_code=400, detail="Not a group")
    if user.role != ROLE_ADMIN and conv.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="Only the creator or admin")
    # Remove chat files from disk.
    for msg in conv.messages:
        for f in msg.files:
            path = os.path.join(settings.UPLOAD_DIR, f.stored_name or "")
            if f.stored_name and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
    db.query(ConversationRead).filter(ConversationRead.conversation_id == conv_id).delete()
    db.query(ConversationTask).filter(ConversationTask.conversation_id == conv_id).delete()
    db.delete(conv)
    db.commit()
    return {"ok": True}


@router.post("/groups/{conv_id}/avatar")
def group_avatar(conv_id: int, file: UploadFile = File(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from .users import process_avatar_upload, _remove_stored
    conv = _get_conv_for(db, conv_id, user)
    if conv.type != "group":
        raise HTTPException(status_code=400, detail="Not a group")
    name = process_avatar_upload(file)
    _remove_stored(conv.avatar_name)
    conv.avatar_name = name
    db.commit()
    return _conv_out(db, conv, user)


@router.get("/conversations/{conv_id}/avatar")
def conv_avatar(conv_id: int, request: Request, token: str = None, db: Session = Depends(get_db)):
    user = _resolve_user(request, token, db)
    conv = _get_conv_for(db, conv_id, user)
    if not conv.avatar_name:
        raise HTTPException(status_code=404, detail="No avatar")
    path = os.path.join(settings.UPLOAD_DIR, conv.avatar_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No avatar")
    return FileResponse(path, media_type="image/jpeg")


# ---------------------------------------------------------------------------
# messages
# ---------------------------------------------------------------------------
@router.get("/conversations/{conv_id}/messages", response_model=list[ChatMessageOut])
def list_messages(conv_id: int, q: str | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_conv_for(db, conv_id, user)
    query = db.query(ChatMessage).filter(ChatMessage.conversation_id == conv_id)
    if q:
        query = query.filter(ChatMessage.body.ilike(f"%{q}%"))
    msgs = query.order_by(ChatMessage.id.desc()).limit(MAX_MESSAGES).all()
    if not q:
        _mark_seen(db, conv_id, user)  # viewing the conversation == reading it
    return list(reversed(msgs))


@router.post("/conversations/{conv_id}/messages", response_model=ChatMessageOut)
def send_message(conv_id: int, data: ChatMessageIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_conv_for(db, conv_id, user)
    body = (data.body or "").strip()
    # Empty body allowed: files may follow right after.
    msg = ChatMessage(conversation_id=conv_id, author_id=user.id, body=body)
    db.add(msg)
    db.commit()
    db.refresh(msg)
    _mark_seen(db, conv_id, user)
    return msg


@router.post("/messages/{message_id}/files", response_model=ChatFileOut)
def upload_chat_file(message_id: int, file: UploadFile = File(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    import mimetypes
    msg = db.query(ChatMessage).get(message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    _get_conv_for(db, msg.conversation_id, user)
    if msg.author_id != user.id:
        raise HTTPException(status_code=403, detail="Not your message")

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(file.filename or "")[1]
    stored = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(settings.UPLOAD_DIR, stored)
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

    filename = file.filename or stored
    content_type = file.content_type or ""
    if content_type in ("", "application/octet-stream", "binary/octet-stream"):
        guessed, _ = mimetypes.guess_type(filename)
        content_type = guessed or "application/octet-stream"
    converted = _maybe_convert_heic(dest, stored, filename, content_type)
    if converted:
        stored, filename, content_type, size = converted

    cf = ChatFile(message_id=msg.id, filename=filename, stored_name=stored,
                  content_type=content_type, size=size)
    db.add(cf)
    db.commit()
    db.refresh(cf)
    return cf


def _load_chat_file(db: Session, file_id: int, user: User) -> ChatFile:
    cf = db.query(ChatFile).get(file_id)
    if not cf:
        raise HTTPException(status_code=404, detail="File not found")
    msg = db.query(ChatMessage).get(cf.message_id)
    _get_conv_for(db, msg.conversation_id, user)
    path = os.path.join(settings.UPLOAD_DIR, cf.stored_name or "")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File missing")
    return cf


@router.get("/files/{file_id}/view")
def view_chat_file(file_id: int, request: Request, token: str = None, db: Session = Depends(get_db)):
    user = _resolve_user(request, token, db)
    cf = _load_chat_file(db, file_id, user)
    path = os.path.join(settings.UPLOAD_DIR, cf.stored_name)
    return _range_response(path, cf.content_type or "application/octet-stream", request)


@router.get("/files/{file_id}/download")
def download_chat_file(file_id: int, request: Request, token: str = None, db: Session = Depends(get_db)):
    user = _resolve_user(request, token, db)
    cf = _load_chat_file(db, file_id, user)
    path = os.path.join(settings.UPLOAD_DIR, cf.stored_name)
    return FileResponse(path, filename=cf.filename, media_type=cf.content_type)


@router.get("/conversations/{conv_id}/files")
def conversation_files(conv_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """All attachments in a conversation, newest first (right-panel tab)."""
    _get_conv_for(db, conv_id, user)
    rows = (db.query(ChatFile).join(ChatMessage, ChatFile.message_id == ChatMessage.id)
            .filter(ChatMessage.conversation_id == conv_id)
            .order_by(ChatFile.id.desc()).all())
    out = []
    for f in rows:
        out.append({"id": f.id, "filename": f.filename, "content_type": f.content_type,
                    "size": f.size, "created_at": f.created_at.isoformat() if f.created_at else None,
                    "author": _user_mini(f.message.author if f.message else None)})
    return out


@router.post("/conversations/{conv_id}/seen")
def seen(conv_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_conv_for(db, conv_id, user)
    _mark_seen(db, conv_id, user)
    return {"ok": True}


# ---------------------------------------------------------------------------
# tasks pinned to a group
# ---------------------------------------------------------------------------
@router.get("/conversations/{conv_id}/tasks")
def conv_tasks(conv_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_conv_for(db, conv_id, user)
    rows = db.query(ConversationTask).filter(ConversationTask.conversation_id == conv_id).all()
    out = []
    for r in rows:
        task = r.task
        if task:
            out.append({"id": task.id, "key": task.key, "title": task.title,
                        "status": task.status, "department_id": task.department_id})
    return out


@router.post("/conversations/{conv_id}/tasks")
def attach_task(conv_id: int, data: ConvTaskIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    conv = _get_conv_for(db, conv_id, user)
    if conv.type != "group":
        raise HTTPException(status_code=400, detail="Tasks attach to groups only")
    task = db.query(Task).get(data.task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    allowed = visible_department_ids(user)
    if allowed is not None and task.department_id not in allowed:
        raise HTTPException(status_code=403, detail="No access to this task")
    exists = db.query(ConversationTask).filter(
        ConversationTask.conversation_id == conv_id,
        ConversationTask.task_id == task.id,
    ).first()
    if not exists:
        db.add(ConversationTask(conversation_id=conv_id, task_id=task.id))
        db.commit()
    return conv_tasks(conv_id, user, db)


@router.delete("/conversations/{conv_id}/tasks/{task_id}")
def detach_task(conv_id: int, task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_conv_for(db, conv_id, user)
    db.query(ConversationTask).filter(
        ConversationTask.conversation_id == conv_id,
        ConversationTask.task_id == task_id,
    ).delete()
    db.commit()
    return {"ok": True}
