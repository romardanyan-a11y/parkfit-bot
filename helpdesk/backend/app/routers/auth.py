from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import User, Notification, USER_APPROVED, USER_PENDING, ROLE_ADMIN, ROLE_AGENT
from ..schemas import RegisterIn, TokenOut, UserOut, LanguageIn, ChangePasswordIn
from ..security import hash_password, verify_password, create_access_token
from ..mailer import send_email_many

router = APIRouter(prefix="/api/auth", tags=["auth"])


def user_to_out(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name or "",
        "description": user.description or "",
        "role": user.role,
        "status": user.status,
        "preferred_language": user.preferred_language or "ru",
        "must_change_password": bool(user.must_change_password),
        "created_at": user.created_at,
        "department_ids": [d.id for d in user.departments],
    }


@router.post("/register", response_model=UserOut)
def register(data: RegisterIn, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        full_name=data.full_name or "",
        description=data.description or "",
        role=ROLE_AGENT,
        status=USER_PENDING,
        preferred_language=data.preferred_language or "ru",
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Notify every admin about the registration request.
    admins = db.query(User).filter(User.role == ROLE_ADMIN).all()
    for admin in admins:
        db.add(Notification(
            recipient_id=admin.id,
            kind="registration_request",
            title="New registration request",
            body=f"{user.email} requested access",
            payload=str(user.id),
        ))
    db.commit()

    send_email_many(
        [a.email for a in admins],
        "[HelpDesk] New registration request",
        f"{user.full_name or user.email} ({user.email}) requested access.\n\n"
        f"Message: {user.description or '-'}\n\nApprove or reject in the Administration section.",
    )
    return user_to_out(user)


@router.post("/login", response_model=TokenOut)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    # OAuth2PasswordRequestForm uses "username"; we treat it as email.
    user = db.query(User).filter(User.email == form.username).first()
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect email or password")
    if user.status == USER_PENDING:
        raise HTTPException(status_code=403, detail="Account pending approval")
    if user.status != USER_APPROVED:
        raise HTTPException(status_code=403, detail="Account not approved")
    token = create_access_token(user.id)
    return TokenOut(access_token=token)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user_to_out(user)


@router.put("/me/language", response_model=UserOut)
def set_language(data: LanguageIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if data.language not in ("ru", "en", "zh"):
        raise HTTPException(status_code=400, detail="Unsupported language")
    user.preferred_language = data.language
    db.commit()
    db.refresh(user)
    return user_to_out(user)


@router.put("/me/password", response_model=UserOut)
def change_password(data: ChangePasswordIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Set a new permanent password (used for the forced temp-password change)."""
    if len(data.new_password or "") < 6:
        raise HTTPException(status_code=400, detail="Password too short (min 6)")
    user.password_hash = hash_password(data.new_password)
    user.must_change_password = False
    db.commit()
    db.refresh(user)
    return user_to_out(user)
