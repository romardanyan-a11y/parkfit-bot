from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_admin, get_current_user
from ..models import (
    Department,
    User,
    Notification,
    ROLE_ADMIN,
    ROLE_AGENT,
    USER_APPROVED,
    USER_PENDING,
    USER_REJECTED,
)
from ..schemas import UserOut, ApproveIn, AccessIn, UserMini
from .auth import user_to_out

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/users", response_model=list[UserOut])
def list_users(status: str | None = None, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    q = db.query(User).order_by(User.created_at.desc())
    if status:
        q = q.filter(User.status == status)
    return [user_to_out(u) for u in q.all()]


@router.post("/users/{user_id}/approve", response_model=UserOut)
def approve_user(user_id: int, data: ApproveIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    user = db.query(User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.status = USER_APPROVED
    if data.role in (ROLE_ADMIN, ROLE_AGENT):
        user.role = data.role
    if data.department_ids is not None:
        deps = db.query(Department).filter(Department.id.in_(data.department_ids)).all()
        user.departments = deps
    db.commit()
    db.refresh(user)
    return user_to_out(user)


@router.post("/users/{user_id}/reject", response_model=UserOut)
def reject_user(user_id: int, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    user = db.query(User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.status = USER_REJECTED
    db.commit()
    db.refresh(user)
    return user_to_out(user)


@router.put("/users/{user_id}/access", response_model=UserOut)
def set_access(user_id: int, data: AccessIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    user = db.query(User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    deps = db.query(Department).filter(Department.id.in_(data.department_ids)).all()
    user.departments = deps
    db.commit()
    db.refresh(user)
    return user_to_out(user)


@router.put("/users/{user_id}/role", response_model=UserOut)
def set_role(user_id: int, data: ApproveIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    user = db.query(User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if data.role not in (ROLE_ADMIN, ROLE_AGENT):
        raise HTTPException(status_code=400, detail="Bad role")
    user.role = data.role
    db.commit()
    db.refresh(user)
    return user_to_out(user)


@router.delete("/users/{user_id}")
def delete_user(user_id: int, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    user = db.query(User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    db.delete(user)
    db.commit()
    return {"ok": True}


@router.get("/assignees", response_model=list[UserMini])
def list_assignees(dep_id: int | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Approved users available as assignees. Optionally scoped to a department."""
    q = db.query(User).filter(User.status == USER_APPROVED)
    users = q.all()
    if dep_id is not None:
        result = []
        for u in users:
            if u.role == ROLE_ADMIN or any(d.id == dep_id for d in u.departments):
                result.append(u)
        users = result
    return users
