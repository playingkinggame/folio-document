"""LLM access with a fallback chain: Groq -> Gemini (configurable).

If a model errors out (rate limit, timeout, outage) before it produces any text,
the next candidate answers instead, so a chat never dies on one provider.
"""
import logging
from typing import AsyncIterator

from langchain_core.messages import BaseMessage

from .config import settings

log = logging.getLogger("folio.llm")
_cache: dict[tuple, object] = {}


class LLMUnavailable(RuntimeError):
    pass


def candidates() -> list[tuple[str, str]]:
    """Ordered (provider, model) pairs that have an API key configured."""
    out: list[tuple[str, str]] = []
    for provider in settings.llm_providers:
        p = provider.lower()
        if p == "groq" and settings.groq_api_key:
            out += [("groq", m) for m in [settings.groq_model, *settings.groq_extra_models]]
        elif p in ("gemini", "google") and settings.gemini_api_key:
            out += [("gemini", m) for m in [settings.gemini_model, *settings.gemini_extra_models]]
    # de-duplicate while keeping order
    seen, unique = set(), []
    for c in out:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    return unique


def _build(provider: str, model: str, temperature: float):
    key = (provider, model, temperature)
    if key in _cache:
        return _cache[key]
    if provider == "groq":
        from langchain_groq import ChatGroq

        llm = ChatGroq(model=model, api_key=settings.groq_api_key, temperature=temperature, max_retries=0, timeout=45)
    else:
        from langchain_google_genai import ChatGoogleGenerativeAI

        llm = ChatGoogleGenerativeAI(
            model=model, google_api_key=settings.gemini_api_key, temperature=temperature, max_retries=0, timeout=45
        )
    _cache[key] = llm
    return llm


def _text(content) -> str:
    """Chat chunks can be a str or a list of content parts depending on the provider."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and part.get("type") == "text":
                parts.append(part.get("text", ""))
        return "".join(parts)
    return ""


async def stream_llm(messages: list[BaseMessage], temperature: float = 0.2) -> AsyncIterator[str]:
    cands = candidates()
    if not cands:
        raise LLMUnavailable("No LLM API key configured. Set GROQ_API_KEY and/or GEMINI_API_KEY in backend/.env.")

    last_error: Exception | None = None
    for provider, model in cands:
        started = False
        try:
            llm = _build(provider, model, temperature)
            async for chunk in llm.astream(messages):
                text = _text(chunk.content)
                if text:
                    started = True
                    yield text
            if started:
                return
            log.warning("%s/%s returned an empty answer, trying next model", provider, model)
        except Exception as exc:  # noqa: BLE001 - we want to fall back on any provider failure
            last_error = exc
            log.warning("%s/%s failed: %s", provider, model, exc)
            if started:
                raise
    raise LLMUnavailable(f"All models failed. Last error: {last_error}")


async def complete(messages: list[BaseMessage], temperature: float = 0.0) -> str:
    return "".join([t async for t in stream_llm(messages, temperature)]).strip()
