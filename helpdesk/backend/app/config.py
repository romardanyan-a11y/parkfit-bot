import os


class Settings:
    # Database. Defaults to a local SQLite file so the app runs with zero
    # external dependencies; docker-compose can override with a Postgres URL.
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:////data/helpdesk.db")

    # JWT / auth
    SECRET_KEY: str = os.getenv("SECRET_KEY", "change-me-in-production-please")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "10080"))  # 7 days

    # Initial administrator, created on first boot if the users table is empty.
    ADMIN_EMAIL: str = os.getenv("ADMIN_EMAIL", "admin@helpdesk.local")
    ADMIN_PASSWORD: str = os.getenv("ADMIN_PASSWORD", "admin12345")

    # File uploads
    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "/data/uploads")
    MAX_UPLOAD_MB: int = int(os.getenv("MAX_UPLOAD_MB", "20"))

    # Automatic backups
    BACKUP_DIR: str = os.getenv("BACKUP_DIR", "/data/backups")

    # --- Email (SMTP) notifications ---
    # Leave SMTP_HOST empty to disable email entirely (the app still works,
    # in-app notifications keep functioning).
    SMTP_HOST: str = os.getenv("SMTP_HOST", "")
    SMTP_PORT: int = int(os.getenv("SMTP_PORT", "587"))
    SMTP_USER: str = os.getenv("SMTP_USER", "")
    SMTP_PASSWORD: str = os.getenv("SMTP_PASSWORD", "")
    SMTP_TLS: bool = os.getenv("SMTP_TLS", "true").lower() in ("1", "true", "yes")
    SMTP_SSL: bool = os.getenv("SMTP_SSL", "false").lower() in ("1", "true", "yes")
    MAIL_FROM: str = os.getenv("MAIL_FROM", "helpdesk@localhost")
    # Public base URL used to build links inside emails.
    APP_BASE_URL: str = os.getenv("APP_BASE_URL", "http://localhost:8000")

    @property
    def email_enabled(self) -> bool:
        return bool(self.SMTP_HOST)


settings = Settings()
