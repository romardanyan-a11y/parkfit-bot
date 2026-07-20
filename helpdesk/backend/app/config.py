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


settings = Settings()
