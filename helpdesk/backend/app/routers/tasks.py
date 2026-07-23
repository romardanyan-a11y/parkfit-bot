from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import (
    Department,
    Task,
    TaskEvent,
    Tag,
    ChecklistItem,
    User,
    Notification,
    ROLE_ADMIN,
    TASK_STATUSES,
    TASK_PRIORITIES,
    TASK_TYPES,
)
from ..schemas import (
    TaskIn,
    TaskOut,
    TaskUpdateIn,
    TaskDetailOut,
    ChecklistItemIn,
    ChecklistItemUpdate,
    ChecklistItemOut,
)
from ..mailer import send_email, mail_text
from ..mailcfg import get_mail_config
from ..config import settings
from .departments import visible_department_ids

router = APIRouter(prefix="/api", tags=["tasks"])


def apply_tags(db: Session, task: Task, tag_ids):
    if tag_ids is None:
        return
    task.tags = db.query(Tag).filter(Tag.id.in_(tag_ids)).all() if tag_ids else []


def notify_assignee(db: Session, task: Task, assignee_id: int, actor: User):
    """In-app notification + email when a task is assigned to someone else."""
    if not assignee_id or assignee_id == actor.id:
        return
    assignee = db.query(User).get(assignee_id)
    if not assignee:
        return
    db.add(Notification(
        recipient_id=assignee.id,
        kind="task_assigned",
        title="Task assigned to you",
        body=f"{task.key}: {task.title}",
        payload=str(task.id),
    ))
    cfg = get_mail_config(db)
    if cfg["enabled"] and cfg["notify_assigned"]:
        subject, body = mail_text("assigned", assignee.preferred_language,
                                  key=task.key, title=task.title, url=cfg["base_url"])
        send_email(assignee.email, subject, body)


def notify_new_task(db: Session, task: Task, dep: Department, author: User):
    """Email everyone who can see the department (plus admins) about a new task."""
    from ..models import USER_APPROVED
    cfg = get_mail_config(db)
    if not (cfg["enabled"] and cfg["notify_new_task"]):
        return
    recipients = {u.id: u for u in dep.allowed_users if u.status == USER_APPROVED}
    for a in db.query(User).filter(User.role == ROLE_ADMIN, User.status == USER_APPROVED).all():
        recipients[a.id] = a
    recipients.pop(author.id, None)
    for u in recipients.values():
        subject, body = mail_text("new_task", u.preferred_language,
                                  key=task.key, title=task.title, dep=dep.name, url=cfg["base_url"])
        send_email(u.email, subject, body)


def ensure_department_access(user: User, dep_id: int):
    allowed = visible_department_ids(user)
    if allowed is not None and dep_id not in allowed:
        raise HTTPException(status_code=403, detail="No access to this department")


def log_event(db: Session, task: Task, actor: User, kind: str, detail: str):
    db.add(TaskEvent(task_id=task.id, actor_id=actor.id, kind=kind, detail=detail))


def next_key(db: Session, dep: Department) -> str:
    # Tracker-style key: first letters of department name + running number.
    prefix = "".join([c for c in dep.name.upper() if c.isalnum()])[:4] or "TASK"
    count = db.query(Task).filter(Task.department_id == dep.id).count()
    return f"{prefix}-{count + 1}"


@router.get("/departments/{dep_id}/tasks", response_model=list[TaskOut])
def list_tasks(
    dep_id: int,
    archived: bool = Query(False),
    status: str | None = None,
    priority: str | None = None,
    type: str | None = None,
    assignee_id: int | None = None,
    tag_id: int | None = None,
    q: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_department_access(user, dep_id)
    query = db.query(Task).filter(Task.department_id == dep_id, Task.archived == archived)
    if status:
        query = query.filter(Task.status == status)
    if priority:
        query = query.filter(Task.priority == priority)
    if type:
        query = query.filter(Task.type == type)
    if assignee_id:
        query = query.filter(Task.assignee_id == assignee_id)
    if tag_id:
        query = query.filter(Task.tags.any(Tag.id == tag_id))
    if q:
        like = f"%{q}%"
        query = query.filter((Task.title.ilike(like)) | (Task.description.ilike(like)) | (Task.key.ilike(like)))
    tasks = query.order_by(Task.updated_at.desc()).all()
    return tasks


@router.post("/departments/{dep_id}/tasks", response_model=TaskDetailOut)
def create_task(dep_id: int, data: TaskIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ensure_department_access(user, dep_id)
    dep = db.query(Department).get(dep_id)
    if not dep:
        raise HTTPException(status_code=404, detail="Department not found")
    if data.priority and data.priority not in TASK_PRIORITIES:
        raise HTTPException(status_code=400, detail="Bad priority")
    if data.type and data.type not in TASK_TYPES:
        raise HTTPException(status_code=400, detail="Bad type")

    task = Task(
        key=next_key(db, dep),
        department_id=dep_id,
        title=data.title,
        description=data.description or "",
        priority=data.priority or "normal",
        type=data.type or "task",
        author_id=user.id,
        assignee_id=data.assignee_id,
        due_date=data.due_date,
        status="open",
    )
    db.add(task)
    db.flush()
    apply_tags(db, task, data.tag_ids)
    log_event(db, task, user, "created", "")
    if data.assignee_id:
        log_event(db, task, user, "assignee", f"->{data.assignee_id}")
        notify_assignee(db, task, data.assignee_id, user)
    db.commit()
    db.refresh(task)
    notify_new_task(db, task, dep, user)
    return task


@router.get("/tasks/{task_id}", response_model=TaskDetailOut)
def get_task(task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    ensure_department_access(user, task.department_id)
    return task


@router.put("/tasks/{task_id}", response_model=TaskDetailOut)
def update_task(task_id: int, data: TaskUpdateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    ensure_department_access(user, task.department_id)

    if data.title is not None:
        task.title = data.title
    if data.description is not None:
        task.description = data.description

    if data.status is not None and data.status != task.status:
        if data.status not in TASK_STATUSES:
            raise HTTPException(status_code=400, detail="Bad status")
        log_event(db, task, user, "status", f"{task.status}->{data.status}")
        task.status = data.status
        # Closing a task moves it to the archive automatically.
        task.archived = data.status == "closed"

    if data.priority is not None and data.priority != task.priority:
        if data.priority not in TASK_PRIORITIES:
            raise HTTPException(status_code=400, detail="Bad priority")
        log_event(db, task, user, "priority", f"{task.priority}->{data.priority}")
        task.priority = data.priority

    if data.type is not None and data.type != task.type:
        if data.type not in TASK_TYPES:
            raise HTTPException(status_code=400, detail="Bad type")
        log_event(db, task, user, "type", f"{task.type}->{data.type}")
        task.type = data.type

    if data.assignee_id is not None and data.assignee_id != task.assignee_id:
        log_event(db, task, user, "assignee", f"{task.assignee_id}->{data.assignee_id}")
        task.assignee_id = data.assignee_id or None
        notify_assignee(db, task, task.assignee_id, user)

    if data.due_date is not None and data.due_date != task.due_date:
        log_event(db, task, user, "due_date", str(data.due_date))
        task.due_date = data.due_date
        task.due_reminded_at = None  # re-arm the due-soon reminder for the new date

    if data.tag_ids is not None:
        apply_tags(db, task, data.tag_ids)
        log_event(db, task, user, "tags", "")

    db.commit()
    db.refresh(task)
    return task


@router.post("/tasks/{task_id}/take", response_model=TaskDetailOut)
def take_task(task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take a ticket into work: assign to self and move to in_progress."""
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    ensure_department_access(user, task.department_id)
    task.assignee_id = user.id
    log_event(db, task, user, "assignee", f"->{user.id}")
    if task.status == "open":
        log_event(db, task, user, "status", "open->in_progress")
        task.status = "in_progress"
    db.commit()
    db.refresh(task)
    return task


@router.post("/tasks/{task_id}/archive", response_model=TaskDetailOut)
def archive_task(task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    ensure_department_access(user, task.department_id)
    task.archived = True
    if task.status != "closed":
        log_event(db, task, user, "status", f"{task.status}->closed")
        task.status = "closed"
    db.commit()
    db.refresh(task)
    return task


@router.post("/tasks/{task_id}/restore", response_model=TaskDetailOut)
def restore_task(task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    ensure_department_access(user, task.department_id)
    task.archived = False
    log_event(db, task, user, "status", f"{task.status}->open")
    task.status = "open"
    db.commit()
    db.refresh(task)
    return task


# ---------------------------------------------------------------------------
# Checklist (sub-tasks inside a ticket, Tracker-style)
# ---------------------------------------------------------------------------
def _load_task_for_checklist(db: Session, task_id: int, user: User) -> Task:
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    ensure_department_access(user, task.department_id)
    return task


@router.post("/tasks/{task_id}/checklist", response_model=ChecklistItemOut)
def add_checklist_item(task_id: int, data: ChecklistItemIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = _load_task_for_checklist(db, task_id, user)
    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty item")
    max_pos = db.query(ChecklistItem).filter(ChecklistItem.task_id == task.id).count()
    item = ChecklistItem(task_id=task.id, text=text, position=max_pos)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/checklist/{item_id}", response_model=ChecklistItemOut)
def update_checklist_item(item_id: int, data: ChecklistItemUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = db.query(ChecklistItem).get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    _load_task_for_checklist(db, item.task_id, user)
    if data.text is not None:
        item.text = data.text.strip() or item.text
    if data.is_done is not None:
        item.is_done = data.is_done
    db.commit()
    db.refresh(item)
    return item


@router.delete("/checklist/{item_id}")
def delete_checklist_item(item_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = db.query(ChecklistItem).get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    _load_task_for_checklist(db, item.task_id, user)
    db.delete(item)
    db.commit()
    return {"ok": True}
