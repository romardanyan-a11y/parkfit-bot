from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import Notification, User
from ..schemas import NotificationOut

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut])
def list_notifications(unread: bool = False, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Notification).filter(Notification.recipient_id == user.id)
    if unread:
        q = q.filter(Notification.is_read == False)  # noqa: E712
    return q.order_by(Notification.created_at.desc()).limit(100).all()


@router.post("/{notif_id}/read", response_model=NotificationOut)
def mark_read(notif_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    notif = db.query(Notification).get(notif_id)
    if not notif or notif.recipient_id != user.id:
        raise HTTPException(status_code=404, detail="Not found")
    notif.is_read = True
    db.commit()
    db.refresh(notif)
    return notif


@router.post("/read-all")
def mark_all_read(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(Notification).filter(
        Notification.recipient_id == user.id,
        Notification.is_read == False,  # noqa: E712
    ).update({"is_read": True})
    db.commit()
    return {"ok": True}
