import random
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..mailcfg import get_mail_config
from ..models import User, Notification, EmailCode, USER_APPROVED, USER_PENDING, ROLE_ADMIN, ROLE_AGENT
from ..schemas import RegisterIn, RegisterCodeIn, TokenOut, UserOut, LanguageIn, ChangePasswordIn
from ..security import hash_password, verify_password, create_access_token
from ..mailer import send_email, send_email_many, mail_text
from .positions import position_to_out as _position_out

CODE_TTL_MIN = 15
CODE_MAX_ATTEMPTS = 5

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
        "position_id": user.position_id,
        "position": _position_out(user.position),
        "avatar_name": user.avatar_name,
        "created_at": user.created_at,
        "department_ids": [d.id for d in user.departments],
    }


@router.post("/register/code")
def request_register_code(data: RegisterCodeIn, db: Session = Depends(get_db)):
    """Step 1 of registration: send a 4-digit code to prove the email is real.
    When SMTP is not configured the code step is skipped entirely."""
    cfg = get_mail_config(db)
    if not cfg["enabled"]:
        return {"required": False}
    if db.query(User).filter(User.email == data.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")

    # Light rate limit: one code per minute per address.
    recent = db.query(EmailCode).filter(
        EmailCode.email == data.email,
        EmailCode.created_at > datetime.utcnow() - timedelta(seconds=60),
    ).first()
    if recent:
        raise HTTPException(status_code=429, detail="Code already sent, wait a minute")

    db.query(EmailCode).filter(EmailCode.email == data.email).delete()
    code = f"{random.randint(0, 9999):04d}"
    db.add(EmailCode(email=data.email, code=code))
    db.commit()

    subject, body = mail_text("code", data.preferred_language, _db=db, code=code)
    send_email(data.email, subject, body)
    return {"required": True}


def _verify_register_code(db: Session, email: str, code: str | None):
    row = (db.query(EmailCode).filter(EmailCode.email == email)
           .order_by(EmailCode.id.desc()).first())
    if not row or row.created_at < datetime.utcnow() - timedelta(minutes=CODE_TTL_MIN):
        raise HTTPException(status_code=400, detail="code_required")
    if row.attempts >= CODE_MAX_ATTEMPTS:
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="code_required")
    if not code or code.strip() != row.code:
        row.attempts += 1
        db.commit()
        raise HTTPException(status_code=400, detail="invalid_code")
    db.query(EmailCode).filter(EmailCode.email == email).delete()


@router.post("/register", response_model=UserOut)
def register(data: RegisterIn, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    # With mail enabled the email must be confirmed by the 4-digit code.
    cfg = get_mail_config(db)
    if cfg["enabled"]:
        _verify_register_code(db, data.email, data.code)

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

    for a in admins:
        subject, body = mail_text(
            "registration_request", a.preferred_language, _db=db,
            name=user.full_name or user.email, email=user.email,
            message=user.description or "-", url=cfg["base_url"],
        )
        send_email(a.email, subject, body)
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
