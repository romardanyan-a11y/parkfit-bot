from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import Task, TaskEvent, TaskRead, User, ROLE_ADMIN
from .departments import visible_department_ids

router = APIRouter(prefix="/api", tags=["activity"])


@router.get("/activity")
def get_activity(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Unread-activity counters for the current user.

    A task's activity = events on it (status changes, comments, new task, etc.)
    that were created by someone else after the user last opened the task.
    Aggregated up to departments and a grand total for the sidebar badge.
    """
    allowed = visible_department_ids(user)  # None == admin (all departments)

    task_rows = db.query(Task.id, Task.department_id).all()
    if allowed is not None:
        task_rows = [r for r in task_rows if r.department_id in allowed]
    task_dep = {r.id: r.department_id for r in task_rows}
    if not task_dep:
        return {"total": 0, "departments": {}, "tasks": {}}

    task_ids = list(task_dep.keys())
    reads = {
        tr.task_id: tr.last_seen_at
        for tr in db.query(TaskRead).filter(TaskRead.user_id == user.id, TaskRead.task_id.in_(task_ids))
    }

    tasks_count: dict[int, int] = {}
    events = db.query(TaskEvent.task_id, TaskEvent.actor_id, TaskEvent.created_at).filter(
        TaskEvent.task_id.in_(task_ids)
    )
    for ev in events:
        if ev.actor_id == user.id:
            continue  # your own actions are never "unread" for you
        seen = reads.get(ev.task_id)
        if seen is None or (ev.created_at and ev.created_at > seen):
            tasks_count[ev.task_id] = tasks_count.get(ev.task_id, 0) + 1

    dep_count: dict[int, int] = {}
    for tid, cnt in tasks_count.items():
        dep = task_dep.get(tid)
        if dep is not None:
            dep_count[dep] = dep_count.get(dep, 0) + cnt

    return {
        "total": sum(tasks_count.values()),
        "departments": dep_count,
        "tasks": tasks_count,
    }


@router.post("/tasks/{task_id}/seen")
def mark_seen(task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Mark a task as read up to now (clears its unread badge for this user)."""
    task = db.query(Task).get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    allowed = visible_department_ids(user)
    if allowed is not None and task.department_id not in allowed:
        raise HTTPException(status_code=403, detail="No access")
    row = db.query(TaskRead).filter(TaskRead.user_id == user.id, TaskRead.task_id == task_id).first()
    if not row:
        row = TaskRead(user_id=user.id, task_id=task_id)
        db.add(row)
    row.last_seen_at = datetime.utcnow()
    db.commit()
    return {"ok": True}
