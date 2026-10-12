import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { speak, stopSpeaking, useSpeech } from "../hooks.js";
import { IconMic, IconSend, IconStop } from "./icons.jsx";
import VoicePanel, { VoiceButton } from "./VoicePanel.jsx";

const COPY = {
  ask: {
    title: "Ask anything about your documents.",
    body: "Answers come only from your files, and every claim points back to the passage it came from.",
    placeholder: "Ask about your documents…",
    suggestions: [
      "Give me the key points of these documents",
      "What dates, deadlines or numbers are mentioned?",
      "List the skills and experience in my resume",
    ],
  },
  solve: {
    title: "Pick a problem and I'll solve it.",
    body: "I read the problem from your document, then work it out step by step. Tick one document in the library to keep it focused.",
    placeholder: "Which problem? For example “Solve problem 2(i)”",
    suggestions: [
      "Solve problem 1 step by step",
      "Solve every problem in this sheet",
      "Explain the method for problem 2, then give the answer",
    ],
  },
};

// Models sometimes write \( \) and \[ \]; the renderer expects $ and $$.
function normalizeMath(text) {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$${m}$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);
}

const MATH = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;
const CITE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g;

// Turn [1] or [2, 3] into links the renderer shows as citation buttons (never inside math).
function linkCitations(text, count) {
  return text
    .split(MATH)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(CITE, (_, nums) =>
            nums
              .split(",")
              .map((s) => s.trim())
              .map((n) => (Number(n) >= 1 && Number(n) <= count ? `[${n}](#cite-${n})` : `[${n}]`))
              .join("")
          )
    )
    .join("");
}

function SourceCard({ source }) {
  return (
    <div className="source-card">
      <div className="source-title">
        {source.doc_name}
        {source.page ? `, page ${source.page}` : ""}
        {source.score < 1 && <span className="source-score">match {Math.round(source.score * 100)}%</span>}
      </div>
      <blockquote><mark>{source.excerpt}</mark></blockquote>
    </div>
  );
}

function Message({ message, mode }) {
  const [open, setOpen] = useState(null);
  const [copied, setCopied] = useState(false);
  const sources = message.sources || [];

  if (message.role === "user") {
    return (
      <div className="msg user">
        <p>{message.voice && <span className="voice-tag">Voice</span>}{message.content}</p>
      </div>
    );
  }

  const components = {
    a: ({ href, children }) => {
      if (href && href.startsWith("#cite-")) {
        const n = Number(href.slice(6));
        return (
          <button
            className={`cite ${open === n ? "active" : ""}`}
            onClick={() => setOpen(open === n ? null : n)}
            aria-label={`Show source ${n}`}
          >
            {n}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
  };

  let md = normalizeMath(message.content || "");
  if (mode === "ask") md = linkCitations(md, sources.length);
  const openSource = sources.find((s) => s.n === open);

  return (
    <div className="msg assistant">
      <div className="prose">
        {message.content ? (
          <ReactMarkdown
            components={components}
            remarkPlugins={[remarkMath]}
            rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
          >
            {md}
          </ReactMarkdown>
        ) : message.streaming && !message.error ? (
          <p className="thinking">{mode === "solve" ? "Working it out…" : "Reading your documents…"}</p>
        ) : null}
        {message.error && <p className="error" role="alert">{message.error}</p>}
      </div>

      {sources.length > 0 && (
        <div className="sources">
          <span className="sources-label">{mode === "solve" ? "Read from" : "Sources"}</span>
          {sources.map((s) => (
            <button
              key={s.n}
              className={`chip ${open === s.n ? "active" : ""}`}
              onClick={() => setOpen(open === s.n ? null : s.n)}
              title={s.doc_name}
            >
              <b>{s.n}</b> {s.doc_name}{s.page ? `, p.${s.page}` : ""}
            </button>
          ))}
        </div>
      )}
      {openSource && <SourceCard source={openSource} />}

      {!message.streaming && message.content && (
        <div className="msg-actions">
          <button
            className="link"
            onClick={async () => {
              await navigator.clipboard?.writeText(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="link" onClick={() => speak(message.content)}>Read aloud</button>
          <button className="link" onClick={stopSpeaking}>Stop reading</button>
        </div>
      )}
    </div>
  );
}

function Composer({ busy, disabled, placeholder, onSend, onStop }) {
  const [text, setText] = useState("");
  const area = useRef(null);
  const speech = useSpeech(setText);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [text]);

  function send() {
    const q = text.trim();
    if (!q || busy || disabled) return;
    onSend(q);
    setText("");
  }

  return (
    <div className="composer">
      <textarea
        ref={area}
        rows={1}
        value={text}
        placeholder={disabled ? "Add a document to start asking questions" : placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        aria-label="Your question"
      />
      {speech.supported && (
        <button
          className={`icon-btn round ${speech.listening ? "live" : ""}`}
          onClick={speech.toggle}
          aria-label={speech.listening ? "Stop dictation" : "Dictate your question"}
          disabled={disabled}
        >
          <IconMic />
        </button>
      )}
      {busy ? (
        <button className="icon-btn round solid" onClick={onStop} aria-label="Stop answering">
          <IconStop />
        </button>
      ) : (
        <button className="icon-btn round solid" onClick={send} disabled={!text.trim() || disabled} aria-label="Send question">
          <IconSend />
        </button>
      )}
    </div>
  );
}

export default function Chat({ mode, onMode, messages, busy, hasDocs, scope, call, voiceEnabled, onAsk, onStop, onOpenLibrary }) {
  const end = useRef(null);
  const copy = COPY[mode];

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <section className="chat">
      <header className="chat-head">
        <button className="btn ghost only-mobile" onClick={onOpenLibrary}>Library</button>
        <div className="tabs" role="tablist" aria-label="Mode">
          {[["ask", "Ask"], ["solve", "Solve"]].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={mode === id} className={mode === id ? "tab on" : "tab"} onClick={() => onMode(id)}>
              {label}
            </button>
          ))}
        </div>
        <p className="scope">{scope}</p>
        <VoiceButton call={call} enabled={voiceEnabled} />
      </header>

      <div className="thread" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="welcome">
            <h2>{hasDocs ? copy.title : "Add a document to begin."}</h2>
            <p>{hasDocs ? copy.body : "Upload a PDF, Word file or note on the left. It stays on your own server."}</p>
            {hasDocs && (
              <div className="suggest">
                {copy.suggestions.map((s) => (
                  <button key={s} className="chip big" onClick={() => onAsk(s)}>{s}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} message={m} mode={mode} />)
        )}
        <div ref={end} />
      </div>

      <VoicePanel call={call} />
      <Composer busy={busy} disabled={!hasDocs} placeholder={copy.placeholder} onSend={onAsk} onStop={onStop} />
    </section>
  );
}
