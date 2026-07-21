from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_current_admin
from ..models import Position, User
from ..schemas import PositionIn, PositionOut

router = APIRouter(prefix="/api/positions", tags=["positions"])


def position_to_out(p: Position | None):
    if not p:
        return None
    return {
        "id": p.id,
        "name_ru": p.name or "",
        "name_en": p.name_en or "",
        "name_zh": p.name_zh or "",
    }


@router.get("", response_model=list[PositionOut])
def list_positions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return [position_to_out(p) for p in db.query(Position).order_by(Position.name.asc()).all()]


@router.post("", response_model=PositionOut)
def create_position(data: PositionIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    name_ru = (data.name_ru or "").strip()
    if not name_ru:
        raise HTTPException(status_code=400, detail="Russian name is required")
    pos = Position(name=name_ru, name_en=(data.name_en or "").strip(), name_zh=(data.name_zh or "").strip())
    db.add(pos)
    db.commit()
    db.refresh(pos)
    return position_to_out(pos)


@router.put("/{pos_id}", response_model=PositionOut)
def update_position(pos_id: int, data: PositionIn, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    pos = db.query(Position).get(pos_id)
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")
    name_ru = (data.name_ru or "").strip()
    if not name_ru:
        raise HTTPException(status_code=400, detail="Russian name is required")
    pos.name = name_ru
    pos.name_en = (data.name_en or "").strip()
    pos.name_zh = (data.name_zh or "").strip()
    db.commit()
    db.refresh(pos)
    return position_to_out(pos)


@router.delete("/{pos_id}")
def delete_position(pos_id: int, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    pos = db.query(Position).get(pos_id)
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")
    for u in db.query(User).filter(User.position_id == pos_id).all():
        u.position_id = None
    db.delete(pos)
    db.commit()
    return {"ok": True}
