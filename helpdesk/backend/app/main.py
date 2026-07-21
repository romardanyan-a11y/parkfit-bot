import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import inspect, text

from .config import settings
from .database import Base, engine, SessionLocal
from .seed import seed_admin
from .backup import start_scheduler
from .routers import auth, departments, tasks, comments, admin, notifications, tags, backups, positions, users, settings as settings_router

app = FastAPI(title="HelpDesk", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(departments.router)
app.include_router(tasks.router)
app.include_router(comments.router)
app.include_router(admin.router)
app.include_router(notifications.router)
app.include_router(tags.router)
app.include_router(backups.router)
app.include_router(positions.router)
app.include_router(users.router)
app.include_router(settings_router.router)


@app.on_event("startup")
def on_startup():
    # Ensure data / upload directories exist (SQLite file lives under /data).
    db_url = settings.DATABASE_URL
    if db_url.startswith("sqlite"):
        path = db_url.split("///")[-1]
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    os.makedirs(settings.BACKUP_DIR, exist_ok=True)

    Base.metadata.create_all(bind=engine)
    ensure_schema()
    db = SessionLocal()
    try:
        seed_admin(db)
    finally:
        db.close()

    # Background thread that writes automatic backups on the configured schedule.
    start_scheduler()


def ensure_schema():
    """Minimal additive migrations for columns added after first release."""
    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns("users")}
    # Added nullable (no default) so it works on both SQLite and Postgres;
    # NULL reads as falsy/None in Python, new rows get proper defaults via the ORM.
    with engine.begin() as conn:
        if "must_change_password" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN must_change_password BOOLEAN"))
        if "position_id" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN position_id INTEGER"))


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Static frontend (served by the same container).
# ---------------------------------------------------------------------------
FRONTEND_DIR = os.getenv("FRONTEND_DIR", "/app/frontend")

if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
