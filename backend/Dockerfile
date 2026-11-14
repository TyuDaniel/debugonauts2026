# SkyDive backend. Written with AI coding assistance (Claude Code).
# Build from the backend/ directory:  docker build -t skydive-backend .
# Run:                                docker run -p 8080:8080 skydive-backend
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SKYDIVE_CACHE=/var/cache/skydive

WORKDIR /srv

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

RUN useradd --system --no-create-home skydive \
    && mkdir -p /var/cache/skydive \
    && chown skydive /var/cache/skydive
USER skydive

EXPOSE 8080

# One worker: the exposure id -> S3 key map and the shared HTTP session live in process memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
