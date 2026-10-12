"""Folio voice tutor: talk to your documents over a LiveKit call.

Same stack as the DentalVoice agent: LiveKit Agents, Deepgram STT and Inworld TTS through
LiveKit Inference, turn detection, and an LLM fallback chain (Groq -> Gemini).
The worker never touches the vector database directly. It asks the Folio API for passages,
so the API stays the only process that owns the Qdrant folder.

Run:   python -m voice_agent.agent dev        (development, auto reload)
       python -m voice_agent.agent start      (production)
First time only: python -m voice_agent.agent download-files
"""
import asyncio
import json
import logging
import os

import httpx
from dotenv import load_dotenv

from livekit.agents import Agent, AgentSession, JobContext, RunContext, WorkerOptions, cli, function_tool, inference, llm
from livekit.plugins import google, groq, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from app.config import settings

load_dotenv()
log = logging.getLogger("folio.voice")

STT_MODEL = os.getenv("STT_MODEL", "deepgram/nova-3")
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "multi")
TTS_MODEL = os.getenv("TTS_MODEL", "inworld/inworld-tts-2")
TTS_VOICE = os.getenv("TTS_VOICE", "Ashley")
MIN_DELAY = float(os.getenv("ENDPOINTING_MIN_DELAY", "0.5"))
MAX_DELAY = float(os.getenv("ENDPOINTING_MAX_DELAY", "6.0"))

INSTRUCTIONS = """You are Folio, a friendly voice tutor. The student has uploaded study material (problem sheets, notes, papers, resumes) and talks to you by voice.

Your job: explain their questions clearly and, when they ask, solve problems step by step.

How you work:
- Use your tools. When the student mentions a problem, topic or document, call search_documents or read_document to find the exact wording before you answer. Call list_documents if you are unsure what they have.
- You may use your own knowledge of the subject to explain and solve. The documents provide the questions.
- If the text you find looks garbled or incomplete, say so and ask the student to read the part out loud.

How you speak (this is a phone call, not a page):
- Short sentences. One idea at a time. Usually two to four sentences per turn, then pause and check understanding.
- Never use markdown, bullet symbols, LaTeX or dollar signs. Say math in words: "d y by d x equals x squared", "integral of two x d x", "x to the power of three".
- For a multi-step solution, give one step, then ask "shall I go on?" unless they asked for the full answer.
- Say the final answer clearly at the end.
- Do not read out long passages. Summarize them.
- If the student interrupts, stop and answer what they asked."""


class FolioClient:
    """Tiny HTTP client for the Folio API (agent-only endpoints)."""

    def __init__(self, doc_ids: list[str]):
        self.doc_ids = doc_ids
        self.http = httpx.AsyncClient(
            base_url=settings.folio_api_url.rstrip("/"),
            headers={"X-Agent-Key": settings.agent_key},
            timeout=30,
        )

    async def documents(self) -> list[dict]:
        r = await self.http.get("/api/voice/documents")
        r.raise_for_status()
        docs = r.json()
        return [d for d in docs if not self.doc_ids or d["id"] in self.doc_ids]

    async def search(self, query: str) -> list[dict]:
        r = await self.http.post("/api/voice/search", json={"query": query, "doc_ids": self.doc_ids})
        r.raise_for_status()
        return r.json()

    async def document(self, name: str) -> dict | None:
        r = await self.http.get("/api/voice/document", params={"name": name})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()


class DocTutor(Agent):
    def __init__(self, client: FolioClient) -> None:
        super().__init__(instructions=INSTRUCTIONS)
        self.client = client

    @function_tool
    async def list_documents(self, context: RunContext) -> str:
        """List the documents in the student's library. Use it when you are unsure what material they have."""
        try:
            docs = await self.client.documents()
        except Exception as exc:  # noqa: BLE001
            log.warning("list_documents failed: %s", exc)
            return "I could not reach the library right now."
        if not docs:
            return "The library is empty."
        return "Documents: " + "; ".join(d["name"] for d in docs)

    @function_tool
    async def search_documents(self, context: RunContext, query: str) -> str:
        """Search the student's documents for passages that match a topic, problem or question.

        Args:
            query: What to look for, for example "problem 2 integrating factor" or "work experience at Infosys".
        """
        try:
            hits = await self.client.search(query)
        except Exception as exc:  # noqa: BLE001
            log.warning("search_documents failed: %s", exc)
            return "The search failed. Tell the student you could not reach their documents."
        if not hits:
            return "Nothing relevant was found in the documents."
        return "\n\n".join(
            f"[{h['doc']}{', page ' + str(h['page']) if h.get('page') else ''}]\n{h['text']}" for h in hits
        )

    @function_tool
    async def read_document(self, context: RunContext, document_name: str) -> str:
        """Read the full text of one document. Use this to solve a numbered problem or to go through a whole sheet.

        Args:
            document_name: The document's file name, or a distinctive part of it, for example "tutorialsheet1".
        """
        try:
            doc = await self.client.document(document_name)
        except Exception as exc:  # noqa: BLE001
            log.warning("read_document failed: %s", exc)
            return "I could not open that document right now."
        if not doc:
            return "No document matches that name. Call list_documents to see the exact names."
        note = " (text was cut because it is long)" if doc["truncated"] else ""
        return f"{doc['name']}{note}:\n{doc['text']}"


def build_llm() -> llm.LLM:
    """Groq first, Gemini as backup. Mirrors LLM_PROVIDERS in .env."""
    models: list[llm.LLM] = []
    for provider in settings.llm_providers:
        p = provider.lower()
        if p == "groq" and settings.groq_api_key:
            for m in [settings.groq_model, *settings.groq_extra_models]:
                models.append(groq.LLM(model=m, api_key=settings.groq_api_key))
        elif p in ("gemini", "google") and settings.gemini_api_key:
            for m in [settings.gemini_model, *settings.gemini_extra_models]:
                models.append(google.LLM(model=m, api_key=settings.gemini_api_key))
    if not models:
        raise RuntimeError("Set GROQ_API_KEY and/or GEMINI_API_KEY in backend/.env")
    return models[0] if len(models) == 1 else llm.FallbackAdapter(models)


def prewarm(proc) -> None:
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    try:
        doc_ids = json.loads(participant.metadata or "{}").get("doc_ids", [])
    except json.JSONDecodeError:
        doc_ids = []

    # Creating the Gemini/Groq clients builds SSL contexts, which blocks for a few seconds
    # on Windows. Do it in a thread so the call (and the greeting) is not delayed.
    brain = await asyncio.to_thread(build_llm)

    session = AgentSession(
        stt=inference.STT(model=STT_MODEL, language=STT_LANGUAGE),
        llm=brain,
        tts=inference.TTS(model=TTS_MODEL, voice=TTS_VOICE),
        vad=ctx.proc.userdata["vad"],
        turn_detection=MultilingualModel(),
        min_endpointing_delay=MIN_DELAY,
        max_endpointing_delay=MAX_DELAY,
    )
    await session.start(room=ctx.room, agent=DocTutor(FolioClient(doc_ids)))
    await session.generate_reply(
        instructions="Greet the student in one short sentence and ask which question or topic from their documents they want to go through."
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))