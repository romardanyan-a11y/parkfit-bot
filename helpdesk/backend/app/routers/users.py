from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import User, Position, UserAlias, USER_APPROVED
from ..schemas import DirectoryUserOut, ProfileIn, AliasIn, AliasOut, UserOut
from .auth import user_to_out
from .positions import position_to_out

router = APIRouter(prefix="/api", tags=["users"])


def _directory_row(u: User) -> dict:
    return {
        "id": u.id,
        "email": u.email,
        "full_name": u.full_name or "",
        "role": u.role,
        "description": u.description or "",
        "position_id": u.position_id,
        "position": position_to_out(u.position),
    }


@router.get("/users", response_model=list[DirectoryUserOut])
def list_directory(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Public staff directory — visible to every approved user."""
    users = db.query(User).filter(User.status == USER_APPROVED).order_by(User.full_name.asc()).all()
    return [_directory_row(u) for u in users]


@router.put("/users/me/profile", response_model=UserOut)
def update_my_profile(data: ProfileIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if data.full_name is not None:
        user.full_name = data.full_name.strip()
    if data.description is not None:
        user.description = data.description
    if data.position_id is not None:
        # 0 / null clears the position; otherwise it must exist.
        if data.position_id == 0:
            user.position_id = None
        else:
            pos = db.query(Position).get(data.position_id)
            if not pos:
                raise HTTPException(status_code=400, detail="Position not found")
            user.position_id = pos.id
    db.commit()
    db.refresh(user)
    return user_to_out(user)


# ---------------------------------------------------------------------------
# Personal aliases (private nicknames for other users)
# ---------------------------------------------------------------------------
@router.get("/aliases", response_model=list[AliasOut])
def list_my_aliases(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(UserAlias).filter(UserAlias.owner_id == user.id).all()
    return [{"target_id": r.target_id, "alias": r.alias or "", "display": bool(r.display)} for r in rows]


@router.put("/aliases/{target_id}", response_model=AliasOut)
def set_alias(target_id: int, data: AliasIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    target = db.query(User).get(target_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    row = db.query(UserAlias).filter(
        UserAlias.owner_id == user.id, UserAlias.target_id == target_id
    ).first()
    if not row:
        row = UserAlias(owner_id=user.id, target_id=target_id)
        db.add(row)
    row.alias = (data.alias or "").strip()
    row.display = bool(data.display)
    db.commit()
    db.refresh(row)
    return {"target_id": row.target_id, "alias": row.alias or "", "display": bool(row.display)}


@router.delete("/aliases/{target_id}")
def delete_alias(target_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(UserAlias).filter(
        UserAlias.owner_id == user.id, UserAlias.target_id == target_id
    ).delete()
    db.commit()
    return {"ok": True}
