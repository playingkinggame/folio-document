"""Folio API: upload documents, chat with them, summarize them."""
import hashlib
import hmac
import json
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, rag
from .config import settings
from .llm import candidates
from .loaders import SUPPORTED, load_pages, split_pages
from .store import get_store, mem_info

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("folio")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await run_in_threadpool(get_store)  # load the embedding model + open Qdrant once at startup
    if not candidates():
        log.warning("No LLM API keys found. Set GROQ_API_KEY and/or GEMINI_API_KEY in backend/.env")
    yield


app = FastAPI(title="Folio", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- schemas ----------
class Turn(BaseModel):
    role: str
    content: str


class ChatBody(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    history: list[Turn] = []
    doc_ids: list[str] = []


# ---------- helpers ----------
def sse(generator):
    async def stream():
        try:
            async for event in generator:
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as exc:  # noqa: BLE001
            log.exception("Stream failed")
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _ingest(path: Path, display_name: str, sha256: str, size: int) -> dict:
    log.info("Ingest start: %s (%d KB) [%s]", display_name, size // 1024, mem_info())
    pages = load_pages(path)
    log.info("Parsed %d page(s) [%s]", len(pages), mem_info())
    chunks = split_pages(pages)
    page_count = max((p.number or 0) for p in pages) or None
    del pages
    log.info("Split into %d passage(s) [%s]", len(chunks), mem_info())
    if not chunks:
        raise ValueError("No usable text could be extracted.")
    meta = {
        "id": path.stem,
        "name": display_name,
        "ext": path.suffix.lower().lstrip("."),
        "size": size,
        "pages": page_count,
        "sha256": sha256,
    }
    return get_store().add_document(meta, chunks)


# ---------- public routes ----------
@app.get("/api/config")
def config():
    return {
        "auth_required": True,
        "auth_configured": auth.auth_configured(),
        "voice": settings.voice_configured,
    }


# ---------- protected routes ----------
@app.get("/api/health", dependencies=[Depends(auth.require_auth)])
def health():
    return {
        "ok": True,
        "documents": len(get_store().list_documents()),
        "models": [f"{p}:{m}" for p, m in candidates()],
    }


@app.get("/api/documents", dependencies=[Depends(auth.require_auth)])
def list_documents():
    return get_store().list_documents()


@app.post("/api/documents", dependencies=[Depends(auth.require_auth)])
async def upload_documents(files: list[UploadFile] = File(...)):
    results = []
    limit = settings.max_upload_mb * 1024 * 1024
    for f in files:
        name = Path(f.filename or "file").name
        ext = Path(name).suffix.lower()
        if ext not in SUPPORTED:
            results.append({"name": name, "ok": False, "error": f"{ext or 'This'} files are not supported. Use PDF, DOCX, TXT or MD."})
            continue
        data = await f.read()
        if len(data) > limit:
            results.append({"name": name, "ok": False, "error": f"Larger than {settings.max_upload_mb} MB."})
            continue
        sha = hashlib.sha256(data).hexdigest()
        existing = get_store().find_by_hash(sha)
        if existing:
            results.append({"name": name, "ok": False, "error": f"Already in your library as {existing['name']}."})
            continue
        path = settings.upload_dir / f"{uuid.uuid4().hex}{ext}"
        path.write_bytes(data)
        size = len(data)
        del data  # free the upload buffer before parsing/embedding
        try:
            doc = await run_in_threadpool(_ingest, path, name, sha, size)
            results.append({"name": name, "ok": True, "document": doc})
        except Exception as exc:  # noqa: BLE001
            path.unlink(missing_ok=True)
            log.warning("Ingest failed for %s: %s", name, exc)
            results.append({"name": name, "ok": False, "error": str(exc)})
    return {"results": results}


@app.delete("/api/documents/{doc_id}", dependencies=[Depends(auth.require_auth)])
async def delete_document(doc_id: str):
    removed = await run_in_threadpool(get_store().remove_document, doc_id)
    if not removed:
        raise HTTPException(404, "Document not found")
    for p in settings.upload_dir.glob(f"{doc_id}.*"):
        p.unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/chat", dependencies=[Depends(auth.require_auth)])
async def chat(body: ChatBody):
    history = [t.model_dump() for t in body.history]
    return sse(rag.answer_stream(body.question.strip(), history, body.doc_ids))


@app.post("/api/solve", dependencies=[Depends(auth.require_auth)])
async def solve(body: ChatBody):
    history = [t.model_dump() for t in body.history]
    return sse(rag.solve_stream(body.question.strip(), history, body.doc_ids))


@app.post("/api/documents/{doc_id}/summary", dependencies=[Depends(auth.require_auth)])
async def summarize(doc_id: str):
    return sse(rag.summary_stream(doc_id))


# ---------- voice (LiveKit) ----------
class VoiceBody(BaseModel):
    doc_ids: list[str] = []


@app.post("/api/voice/token", dependencies=[Depends(auth.require_auth)])
def voice_token(body: VoiceBody):
    """Gives the browser a LiveKit token. The voice worker joins the room automatically."""
    if not settings.voice_configured:
        raise HTTPException(501, "Voice is not set up. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to backend/.env.")
    try:
        from livekit import api
    except ImportError:
        raise HTTPException(501, "Voice packages are missing. Run: pip install -r requirements-voice.txt")
    room = f"folio-{uuid.uuid4().hex[:10]}"
    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(f"student-{uuid.uuid4().hex[:6]}")
        .with_name("You")
        .with_metadata(json.dumps({"doc_ids": body.doc_ids}))
        .with_grants(api.VideoGrants(room_join=True, room=room))
        .to_jwt()
    )
    return {"url": settings.livekit_url, "token": token, "room": room}


def require_agent(x_agent_key: str = Header(default="")) -> None:
    if not hmac.compare_digest(x_agent_key, settings.agent_key):
        raise HTTPException(401, "Bad agent key")


class AgentSearch(BaseModel):
    query: str
    doc_ids: list[str] = []


@app.get("/api/voice/documents", dependencies=[Depends(require_agent)])
def agent_documents():
    return [{"id": d["id"], "name": d["name"], "pages": d.get("pages")} for d in get_store().list_documents()]


@app.post("/api/voice/search", dependencies=[Depends(require_agent)])
async def agent_search(body: AgentSearch):
    hits = await run_in_threadpool(get_store().search, body.query, settings.top_k + 2, body.doc_ids or None)
    return [
        {"doc": h.get("doc_name"), "page": h.get("page"), "text": h.get("text")}
        for h in hits
        if h["score"] >= settings.min_score
    ]


@app.get("/api/voice/document", dependencies=[Depends(require_agent)])
async def agent_document(name: str, max_chars: int = 12000):
    """Full text of one document, found by (part of) its name. Used for 'solve problem 3' by voice."""
    needle = name.lower().strip()
    docs = get_store().list_documents()
    doc = next((d for d in docs if needle and (needle in d["name"].lower() or d["id"] == name)), None)
    if not doc:
        raise HTTPException(404, "No document with that name")
    text = await run_in_threadpool(rag.document_text, doc)
    return {"name": doc["name"], "text": text[:max_chars], "truncated": len(text) > max_chars}


# ---------- built frontend (production image) ----------
if settings.static_dir.exists():
    app.mount("/", StaticFiles(directory=str(settings.static_dir), html=True), name="static")