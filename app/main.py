from __future__ import annotations

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pathlib import Path
import shutil

from app.storage import STORE, SessionData, ensure_upload_dir
from app.parsing.maptrack_csv import parse_upload
from app.analysis.metrics import basic_stats


app = FastAPI(title="MapTrack Analytics (MVP)")


# statické soubory (UI)
app.mount("/static", StaticFiles(directory="web"), name="static")


@app.get("/")
def index():
    return FileResponse("web/index.html")


@app.post("/api/upload")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Nahraj prosím CSV soubor.")

    upload_dir = ensure_upload_dir()
    dst = upload_dir / file.filename

    # uložit na disk
    try:
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Uložení souboru selhalo: {e}")

    # parse + metriky
    try:
        parsed = parse_upload(str(dst), file.filename)
        stats = basic_stats(parsed.df)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Zpracování CSV selhalo: {e}")

    session = SessionData(
        session_id=parsed.session_id,
        file_path=str(dst),
        user_id=parsed.user_id,
        task=parsed.task,
        stats=stats,
    )
    STORE.upsert(session)

    return {
        "session_id": session.session_id,
        "user_id": session.user_id,
        "task": session.task,
        "stats": session.stats,
    }


@app.get("/api/sessions")
def list_sessions():
    sessions = STORE.list_sessions()
    # zploštíme na JSON-friendly
    return {
        "sessions": [
            {
                "session_id": s.session_id,
                "user_id": s.user_id,
                "task": s.task,
                "stats": s.stats,
            }
            for s in sessions.values()
        ]
    }


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    s = STORE.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="Session nenalezena.")
    return {
        "session_id": s.session_id,
        "user_id": s.user_id,
        "task": s.task,
        "stats": s.stats,
        "file_path": s.file_path,
    }
