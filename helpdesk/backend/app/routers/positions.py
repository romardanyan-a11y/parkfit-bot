from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_current_admin
from ..models import Position, User
from ..schemas import PositionIn, PositionOut

router = APIRouter(prefix="/api/positions", tags=["positions"])


@router.get("", response_model=list[PositionOut])
def list_positions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(Position).order_by(Position.name.asc()).all()


@router.post("", response_model=PositionOut)
def create_position(data: PositionIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Empty name")
    existing = db.query(Position).filter(Position.name == name).first()
    if existing:
        return existing
    pos = Position(name=name)
    db.add(pos)
    db.commit()
    db.refresh(pos)
    return pos


@router.put("/{pos_id}", response_model=PositionOut)
def update_position(pos_id: int, data: PositionIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    pos = db.query(Position).get(pos_id)
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Empty name")
    pos.name = name
    db.commit()
    db.refresh(pos)
    return pos


@router.delete("/{pos_id}")
def delete_position(pos_id: int, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    pos = db.query(Position).get(pos_id)
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")
    # Detach from any users first so the FK doesn't dangle.
    for u in db.query(User).filter(User.position_id == pos_id).all():
        u.position_id = None
    db.delete(pos)
    db.commit()
    return {"ok": True}
