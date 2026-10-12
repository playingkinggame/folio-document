"""Central settings, read once from environment variables / .env."""
import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _list(value: str) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


@dataclass
class Settings:
    # LLMs
    llm_providers: list[str] = field(default_factory=lambda: _list(os.getenv("LLM_PROVIDERS", "groq,gemini")))
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    groq_model: str = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
    groq_extra_models: list[str] = field(default_factory=lambda: _list(os.getenv("GROQ_EXTRA_MODELS", "llama-3.1-8b-instant")))
    gemini_api_key: str = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY", "")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    gemini_extra_models: list[str] = field(default_factory=lambda: _list(os.getenv("GEMINI_EXTRA_MODELS", "")))

    # Retrieval
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
    chunk_size: int = int(os.getenv("CHUNK_SIZE", "900"))
    chunk_overlap: int = int(os.getenv("CHUNK_OVERLAP", "150"))
    top_k: int = int(os.getenv("TOP_K", "5"))
    min_score: float = float(os.getenv("MIN_SCORE", "0.2"))
    max_summary_chars: int = int(os.getenv("MAX_SUMMARY_CHARS", "24000"))
    # Solve tab: documents up to this many characters are read in full instead of searched.
    solve_fulldoc_chars: int = int(os.getenv("SOLVE_FULLDOC_CHARS", "14000"))

    # Voice (LiveKit)
    livekit_url: str = os.getenv("LIVEKIT_URL", "")
    livekit_api_key: str = os.getenv("LIVEKIT_API_KEY", "")
    livekit_api_secret: str = os.getenv("LIVEKIT_API_SECRET", "")
    folio_api_url: str = os.getenv("FOLIO_API_URL", "http://127.0.0.1:8000")

    # Storage
    data_dir: Path = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data"))).resolve()
    qdrant_url: str = os.getenv("QDRANT_URL", "")
    qdrant_api_key: str = os.getenv("QDRANT_API_KEY", "")

    # Access
    app_secret: str = os.getenv("APP_SECRET", "change-me")
    supabase_url: str = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_jwt_secret: str = os.getenv("SUPABASE_JWT_SECRET", "")
    max_upload_mb: int = int(os.getenv("MAX_UPLOAD_MB", "25"))
    cors_origins: list[str] = field(
        default_factory=lambda: _list(
            os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
        )
    )

    @property
    def voice_configured(self) -> bool:
        return bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret)

    @property
    def agent_key(self) -> str:
        """Shared secret between the API and the voice worker (same .env, so both derive the same value)."""
        explicit = os.getenv("AGENT_API_KEY", "")
        if explicit:
            return explicit
        return hashlib.sha256(f"agent:{self.app_secret}".encode()).hexdigest()

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def qdrant_path(self) -> Path:
        return self.data_dir / "qdrant"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def registry_path(self) -> Path:
        return self.data_dir / "documents.json"

    @property
    def static_dir(self) -> Path:
        return BASE_DIR / "static"


settings = Settings()
for _p in (settings.data_dir, settings.upload_dir, settings.models_dir):
    _p.mkdir(parents=True, exist_ok=True)
