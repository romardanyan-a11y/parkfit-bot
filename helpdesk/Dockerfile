FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install python dependencies first (better layer caching).
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Application code + static frontend.
COPY backend/app /app/app
COPY frontend /app/frontend

# Data directory for SQLite db + uploads (mount a volume here in prod).
RUN mkdir -p /data /data/uploads

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
