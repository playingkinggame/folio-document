# ---- build the React app ----
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- API + built frontend in one image ----
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8000
COPY backend/requirements.txt backend/requirements-voice.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-voice.txt
COPY backend/ .
COPY start.sh ./start.sh
# Pre-download the voice activity and turn-detection models (skipped quietly if it fails).
RUN python -m voice_agent.agent download-files || true
COPY --from=web /web/dist ./static
# Persistent storage: add a Railway Volume mounted at /data (Railway rejects the VOLUME keyword).
EXPOSE 8000
# One worker on purpose: local Qdrant storage allows a single process.
CMD ["sh", "./start.sh"]
