from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_current_admin
from ..models import Department, Task, User, ROLE_ADMIN
from ..schemas import DepartmentIn, DepartmentOut

router = APIRouter(prefix="/api/departments", tags=["departments"])


def visible_department_ids(user: User):
    """Admins see everything; agents only their granted departments."""
    if user.role == ROLE_ADMIN:
        return None  # None == all
    return {d.id for d in user.departments}


def dept_to_out(db: Session, dep: Department) -> dict:
    total = db.query(Task).filter(Task.department_id == dep.id, Task.archived == False).count()  # noqa: E712
    open_cnt = db.query(Task).filter(
        Task.department_id == dep.id,
        Task.archived == False,  # noqa: E712
        Task.status.in_(("open", "in_progress", "need_info")),
    ).count()
    return {
        "id": dep.id,
        "name": dep.name,
        "description": dep.description or "",
        "created_at": dep.created_at,
        "open_tasks": open_cnt,
        "total_tasks": total,
    }


@router.get("", response_model=list[DepartmentOut])
def list_departments(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    allowed = visible_department_ids(user)
    q = db.query(Department).order_by(Department.name.asc())
    deps = q.all()
    if allowed is not None:
        deps = [d for d in deps if d.id in allowed]
    return [dept_to_out(db, d) for d in deps]


@router.post("", response_model=DepartmentOut)
def create_department(data: DepartmentIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    dep = Department(name=data.name, description=data.description or "", created_by_id=admin.id)
    db.add(dep)
    db.commit()
    db.refresh(dep)
    return dept_to_out(db, dep)


@router.put("/{dep_id}", response_model=DepartmentOut)
def update_department(dep_id: int, data: DepartmentIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    dep = db.query(Department).get(dep_id)
    if not dep:
        raise HTTPException(status_code=404, detail="Department not found")
    dep.name = data.name
    dep.description = data.description or ""
    db.commit()
    db.refresh(dep)
    return dept_to_out(db, dep)


@router.delete("/{dep_id}")
def delete_department(dep_id: int, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    dep = db.query(Department).get(dep_id)
    if not dep:
        raise HTTPException(status_code=404, detail="Department not found")
    db.delete(dep)
    db.commit()
    return {"ok": True}
