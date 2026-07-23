"""Background due-date reminders.

Every few minutes: find active tasks whose deadline falls within the
configured window, email the assignee (or the author when unassigned) in
their language, drop an in-app notification, and stamp the task so the
reminder is sent only once.
"""
import logging
import threading
import time
from datetime import datetime, timedelta

from .database import SessionLocal
from .mailcfg import get_mail_config
from .mailer import mail_text, send_email
from .models import Notification, Task

log = logging.getLogger("helpdesk.notifier")

CHECK_EVERY_SEC = 300
ACTIVE_STATUSES = ("open", "in_progress", "need_info")


def check_due_tasks(db) -> int:
    """One pass; returns how many reminders were sent."""
    cfg = get_mail_config(db)
    if not cfg["notify_due_soon"]:
        return 0
    now = datetime.utcnow()
    horizon = now + timedelta(hours=cfg["due_soon_hours"])
    tasks = db.query(Task).filter(
        Task.archived == False,  # noqa: E712
        Task.due_date.isnot(None),
        Task.due_reminded_at.is_(None),
        Task.due_date <= horizon,
        Task.status.in_(ACTIVE_STATUSES),
    ).all()

    sent = 0
    for task in tasks:
        recipient = task.assignee or task.author
        if recipient and recipient.email:
            due_str = task.due_date.strftime("%d.%m.%Y")
            subject, body = mail_text(
                "due", recipient.preferred_language,
                key=task.key, title=task.title, due=due_str, url=cfg["base_url"],
            )
            if cfg["enabled"]:
                send_email(recipient.email, subject, body)
            db.add(Notification(
                recipient_id=recipient.id,
                kind="task_due",
                title=subject,
                body=task.title,
                payload=str(task.id),
            ))
            sent += 1
        task.due_reminded_at = now
    db.commit()
    if sent:
        log.info("Sent %d due-soon reminders", sent)
    return sent


def _loop():
    while True:
        try:
            db = SessionLocal()
            try:
                check_due_tasks(db)
            finally:
                db.close()
        except Exception as exc:  # noqa: BLE001
            log.warning("Due-reminder loop error: %s", exc)
        time.sleep(CHECK_EVERY_SEC)


def start_notifier():
    threading.Thread(target=_loop, daemon=True).start()
    log.info("Due-date notifier started")
