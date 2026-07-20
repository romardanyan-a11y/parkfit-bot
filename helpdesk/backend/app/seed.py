from sqlalchemy.orm import Session

from .config import settings
from .models import User, ROLE_ADMIN, USER_APPROVED
from .security import hash_password


def seed_admin(db: Session):
    """Create the initial administrator if there are no users yet."""
    if db.query(User).count() > 0:
        return
    admin = User(
        email=settings.ADMIN_EMAIL,
        password_hash=hash_password(settings.ADMIN_PASSWORD),
        full_name="Administrator",
        role=ROLE_ADMIN,
        status=USER_APPROVED,
        preferred_language="ru",
    )
    db.add(admin)
    db.commit()
