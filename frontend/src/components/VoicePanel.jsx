import { useEffect, useRef } from "react";
import { IconMic } from "./icons.jsx";

export function VoiceButton({ call, enabled }) {
  if (call.state !== "idle") return null;
  return (
    <button
      className="btn ghost"
      onClick={call.start}
      disabled={!enabled}
      title={enabled ? "Talk to Folio out loud" : "Voice is not set up yet. Add your LiveKit keys (see the README)."}
    >
      <IconMic width={16} height={16} /> Talk it through
    </button>
  );
}

export default function VoicePanel({ call }) {
  const end = useRef(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [call.lines]);

  if (call.state === "idle") {
    return call.error ? <p className="error voice-error" role="alert">{call.error}</p> : null;
  }

  const status =
    call.state === "connecting" ? "Connecting…" : call.muted ? "Mic is muted" : call.agentSpeaking ? "Folio is speaking" : "Listening to you";

  return (
    <section className="voice-panel" aria-label="Voice call">
      <div className="voice-bar">
        <span className={`dot ${call.state === "live" && !call.muted ? "on" : ""} ${call.agentSpeaking ? "talk" : ""}`} aria-hidden="true" />
        <p className="voice-status" aria-live="polite">{status}</p>
        <button className="btn ghost" onClick={call.toggleMute} disabled={call.state !== "live"}>
          {call.muted ? "Unmute" : "Mute"}
        </button>
        <button className="btn danger" onClick={call.end}>End call</button>
      </div>
      <div className="captions" role="log" aria-live="off">
        {call.lines.length === 0 ? (
          <p className="hint">Say something like “Explain problem 2 from my tutorial sheet.”</p>
        ) : (
          call.lines.slice(-6).map((l) => (
            <p key={l.id} className={`cap ${l.role}`}>
              <b>{l.role === "user" ? "You" : "Folio"}</b> {l.text}
            </p>
          ))
        )}
        <div ref={end} />
      </div>
    </section>
  );
}
