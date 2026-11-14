"""SkyDive backend. Written with AI coding assistance (Claude Code); see README.

Run from backend/:  .venv/bin/uvicorn app.main:app --port 8000
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

app = FastAPI(title="SkyDive")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.get("/api/health")
def health():
    return {"ok": True}


# Each package owns its own router; a missing one must not take the others down.
for _mod in ("app.spherex.routes", "app.extras.routes"):
    try:
        import importlib

        app.include_router(importlib.import_module(_mod).router)
    except ModuleNotFoundError as e:  # package not built yet
        if e.name != _mod:
            raise
