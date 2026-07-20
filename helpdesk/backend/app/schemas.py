from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, EmailStr


# ---------- Auth / users ----------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    full_name: Optional[str] = ""
    description: Optional[str] = ""
    preferred_language: Optional[str] = "ru"


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: int
    email: str  # not EmailStr: internal TLDs like .local are valid here
    full_name: str
    description: str
    role: str
    status: str
    preferred_language: str
    created_at: datetime
    department_ids: List[int] = []

    class Config:
        from_attributes = True


class LanguageIn(BaseModel):
    language: str


class ApproveIn(BaseModel):
    role: Optional[str] = "agent"
    department_ids: List[int] = []


class AccessIn(BaseModel):
    department_ids: List[int] = []


# ---------- Departments ----------
class DepartmentIn(BaseModel):
    name: str
    description: Optional[str] = ""


class DepartmentOut(BaseModel):
    id: int
    name: str
    description: str
    created_at: datetime
    open_tasks: int = 0
    total_tasks: int = 0

    class Config:
        from_attributes = True


# ---------- Tasks ----------
class TagIn(BaseModel):
    name: str
    color: Optional[str] = "#6b7280"


class TagOut(BaseModel):
    id: int
    name: str
    color: str

    class Config:
        from_attributes = True


class ChecklistItemIn(BaseModel):
    text: str


class ChecklistItemUpdate(BaseModel):
    text: Optional[str] = None
    is_done: Optional[bool] = None


class ChecklistItemOut(BaseModel):
    id: int
    text: str
    is_done: bool
    position: int

    class Config:
        from_attributes = True


class TaskIn(BaseModel):
    title: str
    description: Optional[str] = ""
    priority: Optional[str] = "normal"
    type: Optional[str] = "task"
    assignee_id: Optional[int] = None
    due_date: Optional[datetime] = None
    tag_ids: Optional[List[int]] = None


class TaskUpdateIn(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    type: Optional[str] = None
    assignee_id: Optional[int] = None
    due_date: Optional[datetime] = None
    tag_ids: Optional[List[int]] = None


class UserMini(BaseModel):
    id: int
    email: str
    full_name: str

    class Config:
        from_attributes = True


class CommentOut(BaseModel):
    id: int
    body: str
    created_at: datetime
    author: Optional[UserMini]

    class Config:
        from_attributes = True


class CommentIn(BaseModel):
    body: str


class AttachmentOut(BaseModel):
    id: int
    filename: str
    content_type: str
    size: int
    created_at: datetime

    class Config:
        from_attributes = True


class EventOut(BaseModel):
    id: int
    kind: str
    detail: str
    created_at: datetime
    actor: Optional[UserMini]

    class Config:
        from_attributes = True


class TaskOut(BaseModel):
    id: int
    key: str
    department_id: int
    title: str
    description: str
    status: str
    priority: str
    type: str
    author: Optional[UserMini]
    assignee: Optional[UserMini]
    due_date: Optional[datetime]
    archived: bool
    created_at: datetime
    updated_at: datetime
    tags: List[TagOut] = []

    class Config:
        from_attributes = True


class TaskDetailOut(TaskOut):
    comments: List[CommentOut] = []
    attachments: List[AttachmentOut] = []
    history: List[EventOut] = []
    checklist: List[ChecklistItemOut] = []


# ---------- Notifications ----------
class NotificationOut(BaseModel):
    id: int
    kind: str
    title: str
    body: str
    payload: str
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True


# ---------- Settings / palette ----------
class SettingsOut(BaseModel):
    palette: dict
    app_name: str
