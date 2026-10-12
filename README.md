# Folio: chat with your documents

A private RAG app. Upload PDFs, Word files, notes and resumes, then ask questions.
Answers come only from your files and every claim links back to the passage it came from.

- **Frontend:** React + Vite
- **Backend:** FastAPI, LangChain, Qdrant (local vector DB), fastembed (local embeddings, no API key)
- **LLMs:** Groq and Gemini with automatic fallback (if one is rate-limited, the next answers)

## Features

| Feature | Details |
|---|---|
| Formats | PDF, DOCX, TXT, Markdown. Duplicates are detected and skipped. |
| Streaming answers | Tokens appear as they are generated. Stop button included. |
| Citations | `[1]` markers in the answer open the exact source passage, with file name and page. |
| Follow-up memory | "What about his second job?" is rewritten into a standalone search before retrieval. |
| Scope control | Tick documents in the library to search only those. |
| Summaries | One click per document. Large files are sampled evenly so the whole document is covered. |
| Solve tab | Reads the problem from your document and solves it step by step with proper math (KaTeX). Small sheets are read in full, so "solve the pdf" works. |
| Saved chats | "New chat" starts fresh; every chat is kept in the sidebar and can be reopened or deleted. Ask and Solve keep separate histories. |
| Voice tutor (LiveKit) | Press "Talk it through" and speak. Folio explains your questions out loud, looks things up in your documents, and the call transcript is saved into the chat. |
| Dictation / read aloud | Mic button and "Read aloud" use the browser's built-in speech, no keys needed. |
| Authentication | Supabase email/password sign-in; the API verifies Supabase access tokens. |
| LLM fallback | `LLM_PROVIDERS=groq,gemini` plus extra models per provider. |

## Voice tutor setup (LiveKit)

Same stack as the DentalVoice agent: LiveKit Agents, Deepgram speech-to-text and Inworld text-to-speech through LiveKit Inference, with Groq then Gemini as the brain.

1. Create a free project at [cloud.livekit.io](https://cloud.livekit.io) and put `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in `backend/.env`.
2. Install the voice packages and download the small turn-detection models (once):
   ```bash
   cd backend
   pip install -r requirements-voice.txt
   python -m voice_agent.agent download-files
   ```
3. Run the worker in a third terminal, next to the API:
   ```bash
   python -m voice_agent.agent dev
   ```
4. Restart the API. The "Talk it through" button becomes active. Tick a document first if you want the tutor to focus on it.

Try saying: "Explain problem 2 from my tutorial sheet" or "Solve question 1 and go slowly."

The worker never opens the vector database itself. It asks the API for passages, so only one process owns the Qdrant folder. Set a strong `APP_SECRET`: the worker and API derive their shared key from it.

## Run it locally

You need Python 3.11+ and Node 20+. Free API keys: [Groq](https://console.groq.com/keys) and [Google AI Studio](https://aistudio.google.com/apikey) (one is enough, both is better).

**1. Backend**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # Windows PowerShell: Copy-Item .env.example .env
# Set SUPABASE_URL and at least one LLM key in backend/.env
uvicorn app.main:app --reload --port 8000
```

The API reads `SUPABASE_URL` from `backend/.env` regardless of which folder you launch it from. The local CORS default allows both `localhost:5173` and `127.0.0.1:5173`. After changing environment variables, restart the backend; with `--reload`, changing Python code reloads it automatically.

The default LLM models are Groq `openai/gpt-oss-120b` and Gemini `gemini-3.8-flash`. Set `GROQ_MODEL` or `GEMINI_MODEL` in `backend/.env` and the Railway API variables to change them. Optional `GROQ_EXTRA_MODELS` and `GEMINI_EXTRA_MODELS` values add provider-specific fallbacks after the configured primary model.

The first start downloads the embedding model (about 130 MB) and takes a minute.

**2. Frontend** (second terminal)

```bash
cd frontend
npm install
# Put VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and VITE_API_URL in frontend/.env.local.
npm run dev
```

Open http://localhost:5173, create an account or sign in, then add a document and start asking.

## Deploy with Supabase, Railway and Vercel

The frontend and API can be deployed separately. Supabase handles user sign-in; FastAPI verifies each Supabase access token. **All signed-in users currently share the same document library.** Chats are saved in browser local storage and scoped by signed-in account, but do not follow that account to another device. Supabase login does not automatically isolate documents by user.

### 1. Create and configure Supabase

1. Create a Supabase project and enable **Email** under **Authentication → Providers**. To use the Google button on the login page, configure the Google provider there too; Supabase shows the callback URL to add in your Google OAuth client.
2. Copy the project URL and public anon/publishable key from **Project Settings → API**. The public key belongs in the frontend; never put a `service_role` key in the frontend.
3. Under **Authentication → URL Configuration**, set the site URL to your Vercel production URL. Add that URL (and any preview URLs you use) to the allowed redirect URLs.
4. Decide whether to require email confirmation in the Supabase email provider settings.

### 2. Deploy the API to Railway

1. Create a Railway project from this repository and deploy using the root `Dockerfile`.
2. Add a persistent Railway volume mounted at `/data` and set `DATA_DIR=/data`. Without persistent storage, uploaded documents and the local vector index are lost when the service is replaced.
3. In the **Railway API service** (not Vercel), add the required backend variables from `backend/.env.example`. In particular, set `SUPABASE_URL` to the project URL (`https://<project-ref>.supabase.co`), at least one LLM key (`GROQ_API_KEY` or `GEMINI_API_KEY`), and `CORS_ORIGINS`. Set a strong `APP_SECRET` if enabling LiveKit voice. After changing Railway variables, redeploy/restart the API.
4. Set `CORS_ORIGINS` to the exact Vercel origin, for example `https://your-app.vercel.app` (no trailing slash). Add each preview origin explicitly if needed.
5. For a Supabase project using asymmetric signing keys, leave `SUPABASE_JWT_SECRET` empty; the API fetches and caches Supabase's public JWKS keys. Only set it for a legacy project still using HS256.
6. Generate a Railway domain and check `https://your-api-domain/api/config`. It should return `"auth_required": true`.

Keep one Railway API replica when using local Qdrant storage, and allocate at least 1 GB RAM for the embedding model. The persistent volume holds uploads, the index, and the embedding model cache.

### 3. Deploy the frontend to Vercel

1. Import the same repository into Vercel and set the **Root Directory** to `frontend`.
2. Use the Vite defaults: build command `npm run build`, output directory `dist`.
3. Add these environment variables for Production (and Preview if used):
   - `VITE_API_URL`: the Railway API origin, with no trailing slash.
   - `VITE_SUPABASE_URL`: the same Supabase project URL used on Railway.
   - `VITE_SUPABASE_ANON_KEY`: the public anon/publishable key from Supabase.
4. Deploy, add the final Vercel URL to Supabase's allowed redirect URLs, and set Railway `CORS_ORIGINS` to that exact URL. Restart/redeploy the API after changing CORS.

Vite embeds `VITE_*` values into the public browser bundle. Only the Supabase anon/publishable key belongs there—never an LLM key, JWT signing secret, or Supabase `service_role` key.

For local development, copy `frontend/.env.example` to `frontend/.env.local`, set the Supabase values, and use `VITE_API_URL=http://localhost:8000`. Set the matching `SUPABASE_URL` in `backend/.env`.

The root `Dockerfile` can still deploy a combined frontend/API container if you prefer a single host. Mount persistent storage at `/data` and set the same Supabase/API environment variables. The voice worker also starts automatically when its LiveKit keys are configured.

## Project layout

```
backend/app/
  main.py      API routes (upload, delete, chat, solve, summary, voice token)
  loaders.py   PDF / DOCX / text readers + chunking
  store.py     fastembed embeddings, Qdrant, document registry
  llm.py       Groq -> Gemini fallback chain, streaming
  rag.py       follow-up rewriting, retrieval, prompts, citations, solver
backend/voice_agent/
  agent.py     LiveKit voice tutor with document tools
frontend/src/
  App.jsx, auth.js (Supabase sessions), hooks.js (chats), voice.js (LiveKit call), api.js
  components/  Sidebar, Library, Chat, VoicePanel, Login
```

## Tuning

- Answers miss details: raise `TOP_K` (try 8) or lower `CHUNK_SIZE`.
- Answers wander off topic: raise `MIN_SCORE` (try 0.3).
- Documents in Hindi, Tamil or mixed languages: set `EMBEDDING_MODEL=intfloat/multilingual-e5-large` and re-upload the files.
- Changing the embedding model requires deleting `data/qdrant` and `data/documents.json` and re-uploading, because vector sizes differ.

## Known limits

- Math-heavy PDFs: the text is extracted with `pypdf`, which can drop symbols or fractions. When a problem comes out garbled, Folio says which part is unclear. Type that problem into the Solve box, or swap in Docling in `loaders.py` for better math extraction.
- Chats are saved in your browser (localStorage), so they do not follow you to another device or browser.
- Live captions in the voice panel rely on LiveKit's transcription text stream. If a caption line is missing, the call itself still works.
- Scanned PDFs (images only) are rejected with a clear message. Run OCR first (for example with `ocrmypdf`).
- All authenticated Supabase users share one document library; per-user document isolation is not implemented. Disable public sign-ups in Supabase if only invited users should access it. Chats are stored per account in that browser's local storage.
