from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Table,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base

# ---------------------------------------------------------------------------
# Roles / statuses (kept as plain strings so they are easy to extend)
# ---------------------------------------------------------------------------
ROLE_ADMIN = "admin"
ROLE_AGENT = "agent"        # regular approved user who works on tickets
ROLE_OBSERVER = "observer"  # highlighted "watcher" account, shown everywhere
ROLES = (ROLE_ADMIN, ROLE_AGENT, ROLE_OBSERVER)

USER_PENDING = "pending"
USER_APPROVED = "approved"
USER_REJECTED = "rejected"

# Yandex-Tracker-like ticket lifecycle
TASK_STATUSES = ("open", "in_progress", "need_info", "resolved", "closed")
TASK_PRIORITIES = ("trivial", "minor", "normal", "major", "critical", "blocker")
TASK_TYPES = ("task", "bug", "incident", "request")


# Association: which departments a user is allowed to see.
user_department_access = Table(
    "user_department_access",
    Base.metadata,
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("department_id", Integer, ForeignKey("departments.id", ondelete="CASCADE"), primary_key=True),
)

# Association: tags attached to a task (Tracker-style labels).
task_tags = Table(
    "task_tags",
    Base.metadata,
    Column("task_id", Integer, ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(255), default="")
    description = Column(Text, default="")           # message the user writes on registration
    role = Column(String(20), default=ROLE_AGENT)
    status = Column(String(20), default=USER_PENDING)  # pending / approved / rejected
    preferred_language = Column(String(5), default="ru")
    position_id = Column(Integer, ForeignKey("positions.id"), nullable=True)  # job title
    # When True, the user is forced to set a new password on next login
    # (used after an admin resets it to a temporary one).
    must_change_password = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    departments = relationship(
        "Department",
        secondary=user_department_access,
        back_populates="allowed_users",
    )
    position = relationship("Position")


class Position(Base):
    """A job title / должность, managed by admins (e.g. "Главный инженер")."""

    __tablename__ = "positions"

    id = Column(Integer, primary_key=True)
    name = Column(String(150), unique=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class UserAlias(Base):
    """A personal, private nickname one user assigns to another.

    Only the owner sees the alias, and only when `display` is on.
    """

    __tablename__ = "user_aliases"
    __table_args__ = (UniqueConstraint("owner_id", "target_id", name="uq_alias_owner_target"),)

    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    target_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    alias = Column(String(150), default="")
    display = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Department(Base):
    """A division / направление, e.g. "Поломойки". Holds tickets."""

    __tablename__ = "departments"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by_id = Column(Integer, ForeignKey("users.id"))

    allowed_users = relationship(
        "User",
        secondary=user_department_access,
        back_populates="departments",
    )
    tasks = relationship("Task", back_populates="department", cascade="all, delete-orphan")


class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True)
    key = Column(String(30), unique=True, index=True)   # e.g. DEP-12, Tracker-style key
    department_id = Column(Integer, ForeignKey("departments.id", ondelete="CASCADE"))
    title = Column(String(500), nullable=False)
    description = Column(Text, default="")

    status = Column(String(20), default="open")
    priority = Column(String(20), default="normal")
    type = Column(String(20), default="task")

    author_id = Column(Integer, ForeignKey("users.id"))
    assignee_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    due_date = Column(DateTime, nullable=True)
    archived = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    department = relationship("Department", back_populates="tasks")
    author = relationship("User", foreign_keys=[author_id])
    assignee = relationship("User", foreign_keys=[assignee_id])
    comments = relationship("Comment", back_populates="task", cascade="all, delete-orphan")
    attachments = relationship("Attachment", back_populates="task", cascade="all, delete-orphan")
    history = relationship("TaskEvent", back_populates="task", cascade="all, delete-orphan")
    tags = relationship("Tag", secondary=task_tags, back_populates="tasks")
    checklist = relationship(
        "ChecklistItem",
        back_populates="task",
        cascade="all, delete-orphan",
        order_by="ChecklistItem.position",
    )


class Tag(Base):
    __tablename__ = "tags"

    id = Column(Integer, primary_key=True)
    name = Column(String(100), unique=True, nullable=False)
    color = Column(String(20), default="#6b7280")
    created_at = Column(DateTime, default=datetime.utcnow)

    tasks = relationship("Task", secondary=task_tags, back_populates="tags")


class ChecklistItem(Base):
    __tablename__ = "checklist_items"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id", ondelete="CASCADE"))
    text = Column(String(1000), nullable=False)
    is_done = Column(Boolean, default=False)
    position = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    task = relationship("Task", back_populates="checklist")


class Comment(Base):
    __tablename__ = "comments"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id", ondelete="CASCADE"))
    author_id = Column(Integer, ForeignKey("users.id"))
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    task = relationship("Task", back_populates="comments")
    author = relationship("User")


class Attachment(Base):
    __tablename__ = "attachments"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id", ondelete="CASCADE"))
    filename = Column(String(500))
    stored_name = Column(String(500))
    content_type = Column(String(200))
    size = Column(Integer, default=0)
    uploaded_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    task = relationship("Task", back_populates="attachments")
    uploaded_by = relationship("User")


class TaskEvent(Base):
    """Activity log for a ticket (status changes, assignments, etc.)."""

    __tablename__ = "task_events"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id", ondelete="CASCADE"))
    actor_id = Column(Integer, ForeignKey("users.id"))
    kind = Column(String(50))       # status / assignee / priority / created / due_date ...
    detail = Column(Text, default="")   # JSON-ish "from->to" description
    created_at = Column(DateTime, default=datetime.utcnow)

    task = relationship("Task", back_populates="history")
    actor = relationship("User")


class Notification(Base):
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True)
    recipient_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"))
    kind = Column(String(50))           # registration_request / task_assigned ...
    title = Column(String(255))
    body = Column(Text, default="")
    payload = Column(Text, default="")  # e.g. related user/task id
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class AppSetting(Base):
    """Single-row key/value store for the editable UI palette and options."""

    __tablename__ = "app_settings"
    __table_args__ = (UniqueConstraint("key", name="uq_setting_key"),)

    id = Column(Integer, primary_key=True)
    key = Column(String(100), index=True)
    value = Column(Text, default="")
