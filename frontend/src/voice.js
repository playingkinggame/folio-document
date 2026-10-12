// LiveKit call to the Folio voice tutor, wrapped as a React hook.
import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import { voiceToken } from "./api.js";

const TRANSCRIPTION_TOPIC = "lk.transcription";

export function useVoiceCall({ docIds, onFinished }) {
  const [state, setState] = useState("idle"); // idle | connecting | live
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [lines, setLines] = useState([]); // [{id, role, text}]
  const roomRef = useRef(null);
  const linesRef = useRef([]);
  linesRef.current = lines;

  const setLine = (id, role, text) =>
    setLines((prev) => {
      const i = prev.findIndex((l) => l.id === id);
      if (i === -1) return [...prev, { id, role, text }];
      const copy = [...prev];
      copy[i] = { ...copy[i], text };
      return copy;
    });

  const cleanup = useCallback(() => {
    document.querySelectorAll("audio[data-folio-agent]").forEach((el) => el.remove());
    roomRef.current = null;
    setAgentSpeaking(false);
    setMuted(false);
  }, []);

  const end = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null; // so the Disconnected handler below does not report the call twice
    if (room) await room.disconnect();
    cleanup();
    setState("idle");
    const turns = linesRef.current.filter((l) => l.text.trim()).map((l) => ({ role: l.role, text: l.text.trim() }));
    setLines([]);
    onFinished?.(turns);
  }, [cleanup, onFinished]);

  const start = useCallback(async () => {
    setError("");
    setLines([]);
    setState("connecting");
    try {
      const { url, token } = await voiceToken(docIds);
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.dataset.folioAgent = "1";
          document.body.appendChild(el);
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => setAgentSpeaking(speakers.some((s) => !s.isLocal)));
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current) {
          cleanup();
          setState("idle");
          const turns = linesRef.current.filter((l) => l.text.trim()).map((l) => ({ role: l.role, text: l.text.trim() }));
          setLines([]);
          onFinished?.(turns);
        }
      });

      // Live captions: the agent publishes what it hears and what it says on this text-stream topic.
      room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader) => {
        const attrs = reader.info?.attributes || {};
        const role = attrs["lk.transcribed_track_id"] ? "user" : "assistant";
        const id = attrs["lk.segment_id"] || reader.info?.id;
        let text = "";
        try {
          for await (const chunk of reader) {
            text += chunk;
            setLine(id, role, text);
          }
        } catch {
          /* stream closed early */
        }
      });

      await room.connect(url, token);
      await room.startAudio();
      await room.localParticipant.setMicrophoneEnabled(true);
      setState("live");
    } catch (err) {
      const failed = roomRef.current;
      roomRef.current = null;
      failed?.disconnect();
      cleanup();
      setState("idle");
      setError(
        err.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in your browser and try again."
          : err.message || "Could not start the call."
      );
    }
  }, [docIds, cleanup, onFinished]);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }, [muted]);

  useEffect(() => () => { roomRef.current?.disconnect(); }, []);

  return { state, error, muted, agentSpeaking, lines, start, end, toggleMute };
}
