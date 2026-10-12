#!/bin/sh
# Starts the voice worker (when LiveKit is configured) next to the API in one container.
if [ -n "$LIVEKIT_URL" ] && [ -n "$LIVEKIT_API_KEY" ]; then
  python -m voice_agent.agent start &
fi
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
