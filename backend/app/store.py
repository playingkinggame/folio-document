"""Vector store (Qdrant) + local embeddings (fastembed) + a small document registry."""
import json
import logging
import threading
import time
import uuid
from pathlib import Path

from fastembed import TextEmbedding
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    FilterSelector,
    MatchAny,
    MatchValue,
    PointStruct,
    VectorParams,
)

from .config import settings
from .loaders import Chunk

log = logging.getLogger("folio.store")
COLLECTION = "documents"


def mem_info() -> str:
    """Process RSS and container (cgroup) memory, so a memory kill shows up in the logs."""
    parts = []
    try:
        with open("/proc/self/status") as f:
            rss_kb = next(int(l.split()[1]) for l in f if l.startswith("VmRSS"))
        parts.append(f"rss={rss_kb // 1024}MB")
    except Exception:  # noqa: BLE001
        pass
    for name, path in (("container", "/sys/fs/cgroup/memory.current"), ("limit", "/sys/fs/cgroup/memory.max")):
        try:
            raw = open(path).read().strip()
            parts.append(f"{name}={raw if raw == 'max' else str(int(raw) // 1048576) + 'MB'}")
        except Exception:  # noqa: BLE001
            pass
    return " ".join(parts) or "n/a"


class Store:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        log.info("Loading embedding model %s (first run downloads it)...", settings.embedding_model)
        self.embedder = TextEmbedding(
            model_name=settings.embedding_model,
            cache_dir=str(settings.models_dir),
            threads=settings.embed_threads or None,
        )
        dim = len(next(iter(self.embedder.embed(["dimension probe"]))))

        if settings.qdrant_url:
            self.client = QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key or None)
        else:
            self.client = QdrantClient(path=str(settings.qdrant_path))
        if not self.client.collection_exists(COLLECTION):
            self.client.create_collection(
                COLLECTION, vectors_config=VectorParams(size=dim, distance=Distance.COSINE)
            )
        self._docs: dict[str, dict] = self._load_registry()
        log.info("Store ready: %d document(s) [%s]", len(self._docs), mem_info())

    # ---------- registry ----------
    def _load_registry(self) -> dict[str, dict]:
        path: Path = settings.registry_path
        if path.exists():
            try:
                return json.loads(path.read_text())
            except json.JSONDecodeError:
                log.warning("documents.json is corrupt, starting with an empty library")
        return {}

    def _save_registry(self) -> None:
        tmp = settings.registry_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._docs, indent=2))
        tmp.replace(settings.registry_path)

    def list_documents(self) -> list[dict]:
        with self._lock:
            return sorted(self._docs.values(), key=lambda d: d["uploaded_at"], reverse=True)

    def get_document(self, doc_id: str) -> dict | None:
        with self._lock:
            return self._docs.get(doc_id)

    def find_by_hash(self, sha256: str) -> dict | None:
        with self._lock:
            return next((d for d in self._docs.values() if d.get("sha256") == sha256), None)

    # ---------- indexing ----------
    def add_document(self, meta: dict, chunks: list[Chunk]) -> dict:
        """Embed and index in small batches so peak memory stays flat however big the file is."""
        doc_id = meta["id"]
        step = max(1, settings.embed_batch)
        try:
            for i in range(0, len(chunks), step):
                batch = chunks[i : i + step]
                vectors = list(self.embedder.passage_embed([c.text for c in batch], batch_size=step))
                points = [
                    PointStruct(
                        id=str(uuid.uuid4()),
                        vector=vec.tolist(),
                        payload={
                            "doc_id": doc_id,
                            "doc_name": meta["name"],
                            "page": c.page,
                            "chunk": c.index,
                            "text": c.text,
                        },
                    )
                    for c, vec in zip(batch, vectors)
                ]
                with self._lock:
                    self.client.upsert(COLLECTION, points=points)
                if (i // step) % 5 == 0:
                    log.info("Indexed %d/%d passages [%s]", min(i + step, len(chunks)), len(chunks), mem_info())
        except Exception:
            # Don't leave half an upload behind in the vector store.
            with self._lock:
                self.client.delete(
                    COLLECTION,
                    points_selector=FilterSelector(
                        filter=Filter(must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))])
                    ),
                )
            raise
        with self._lock:
            meta = {**meta, "chunks": len(chunks), "uploaded_at": time.time()}
            self._docs[doc_id] = meta
            self._save_registry()
        return meta

    def remove_document(self, doc_id: str) -> bool:
        with self._lock:
            if doc_id not in self._docs:
                return False
            self.client.delete(
                COLLECTION,
                points_selector=FilterSelector(
                    filter=Filter(must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))])
                ),
            )
            del self._docs[doc_id]
            self._save_registry()
            return True

    # ---------- retrieval ----------
    def search(self, query: str, k: int, doc_ids: list[str] | None = None) -> list[dict]:
        vector = next(iter(self.embedder.query_embed(query))).tolist()
        flt = None
        if doc_ids:
            flt = Filter(must=[FieldCondition(key="doc_id", match=MatchAny(any=doc_ids))])
        with self._lock:
            result = self.client.query_points(
                COLLECTION, query=vector, limit=k, query_filter=flt, with_payload=True
            )
        hits = []
        for p in result.points:
            payload = p.payload or {}
            hits.append({**payload, "score": float(p.score)})
        return hits

    def get_chunks(self, doc_id: str) -> list[dict]:
        """All chunks of one document in reading order (used for summaries)."""
        flt = Filter(must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))])
        out: list[dict] = []
        offset = None
        with self._lock:
            while True:
                points, offset = self.client.scroll(
                    COLLECTION, scroll_filter=flt, limit=256, offset=offset, with_payload=True
                )
                out.extend(p.payload or {} for p in points)
                if offset is None:
                    break
        return sorted(out, key=lambda c: c.get("chunk", 0))


_store: Store | None = None
_store_lock = threading.Lock()


def get_store() -> Store:
    global _store
    with _store_lock:
        if _store is None:
            _store = Store()
        return _store