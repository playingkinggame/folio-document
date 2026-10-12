import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError, stream } from "./api.js";

const STORE_KEY = "folio.convos.v2";
const OLD_KEY = "folio.chat";
const newId = () => Math.random().toString(36).slice(2, 10);

function loadConvos(userId) {
  if (!userId) return [];
  const key = userId === "local" ? STORE_KEY : `${STORE_KEY}.${userId}`;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (Array.isArray(saved)) return saved.map(clean);
    if (userId !== "local") return [];
    // one-time migration of the single chat from the first version
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || "[]");
    if (old.length) {
      const firstUser = old.find((m) => m.role === "user");
      return [
        clean({
          id: newId(),
          mode: "ask",
          title: (firstUser?.content || "Earlier chat").slice(0, 48),
          updatedAt: Date.now(),
          messages: old,
        }),
      ];
    }
  } catch {
    /* ignore corrupt storage */
  }
  return [];
}

const clean = (c) => ({ ...c, messages: (c.messages || []).map((m) => ({ ...m, streaming: false })) });

// Owns all conversations (saved in the browser), streams answers into the active one.
export function useChat({ mode, selectedIds, onAuthError, userId }) {
  const [convos, setConvos] = useState(() => loadConvos(userId));
  const [loadedUserId, setLoadedUserId] = useState(userId);
  const [activeId, setActiveId] = useState(null); // null = a fresh, unsaved chat
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);
  const activeRef = useRef(null);
  const skipStoreWrite = useRef(false);
  activeRef.current = activeId;

  useEffect(() => {
    if (loadedUserId === userId) return;
    const nextConvos = loadConvos(userId);
    const latest = nextConvos.filter((c) => c.mode === mode).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    skipStoreWrite.current = true;
    setConvos(nextConvos);
    setActiveId(latest ? latest.id : null);
    setLoadedUserId(userId);
  }, [userId, loadedUserId, mode]);

  useEffect(() => {
    if (loadedUserId !== userId) return;
    if (skipStoreWrite.current) {
      skipStoreWrite.current = false;
      return;
    }
    if (!userId) return;
    try {
      const trimmed = convos
        .slice(0, 60)
        .map((c) => ({ ...c, messages: c.messages.slice(-80) }));
      const key = userId === "local" ? STORE_KEY : `${STORE_KEY}.${userId}`;
      localStorage.setItem(key, JSON.stringify(trimmed));
    } catch {
      /* storage full: keep working in memory */
    }
  }, [convos, userId, loadedUserId]);

  // When switching tab, open that tab's most recent chat (or a blank one).
  useEffect(() => {
    if (loadedUserId !== userId) return;
    const latest = convos.filter((c) => c.mode === mode).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    setActiveId(latest ? latest.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, userId, loadedUserId]);

  const patchConvo = (id, fn) =>
    setConvos((prev) => prev.map((c) => (c.id === id ? { ...fn(c), updatedAt: Date.now() } : c)));

  const patchLast = (id, fn) =>
    patchConvo(id, (c) => {
      const messages = [...c.messages];
      messages[messages.length - 1] = fn(messages[messages.length - 1]);
      return { ...c, messages };
    });

  const ensureConvo = (title) => {
    let id = activeRef.current;
    if (!id) {
      id = newId();
      setConvos((prev) => [{ id, mode, title: title.slice(0, 48), updatedAt: Date.now(), messages: [] }, ...prev]);
      setActiveId(id);
      activeRef.current = id;
    }
    return id;
  };

  const active = convos.find((c) => c.id === activeId);
  const messages = active?.messages || [];

  const run = useCallback(
    async (userText, path, body) => {
      const cid = ensureConvo(userText);
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      patchConvo(cid, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          { id: newId(), role: "user", content: userText },
          { id: newId(), role: "assistant", content: "", sources: [], streaming: true },
        ],
      }));
      try {
        for await (const ev of stream(path, body, controller.signal)) {
          if (ev.type === "sources") patchLast(cid, (m) => ({ ...m, sources: ev.sources }));
          else if (ev.type === "token") patchLast(cid, (m) => ({ ...m, content: m.content + ev.text }));
          else if (ev.type === "error") patchLast(cid, (m) => ({ ...m, error: ev.message }));
        }
      } catch (err) {
        if (err instanceof AuthError) onAuthError?.();
        else if (err.name !== "AbortError") patchLast(cid, (m) => ({ ...m, error: err.message }));
      } finally {
        patchLast(cid, (m) => ({ ...m, streaming: false }));
        setBusy(false);
        abortRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, onAuthError]
  );

  const ask = useCallback(
    (question) => {
      const history = messages
        .filter((m) => m.content && !m.error)
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }));
      const path = mode === "solve" ? "/api/solve" : "/api/chat";
      return run(question, path, { question, history, doc_ids: selectedIds });
    },
    [messages, selectedIds, run, mode]
  );

  const summarize = useCallback(
    (doc) => run(`Summarize ${doc.name}`, `/api/documents/${doc.id}/summary`, null),
    [run]
  );

  // Voice calls drop their transcript into the current chat.
  const appendTurns = useCallback(
    (turns) => {
      if (!turns.length) return;
      const cid = ensureConvo("Voice session");
      patchConvo(cid, (c) => ({
        ...c,
        messages: [...c.messages, ...turns.map((t) => ({ id: newId(), role: t.role, content: t.text, voice: true }))],
      }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const newChat = useCallback(() => setActiveId(null), []);
  const select = useCallback((id) => setActiveId(id), []);
  const remove = useCallback((id) => {
    setConvos((prev) => prev.filter((c) => c.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  const list = convos.filter((c) => c.mode === mode).sort((a, b) => b.updatedAt - a.updatedAt);

  return { conversations: list, activeId, messages, busy, ask, summarize, appendTurns, stop, newChat, select, remove };
}

// Browser speech: dictation (mic) and read-aloud. Falls back gracefully if unsupported.
export function useSpeech(onText) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const Rec = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

  const toggle = useCallback(() => {
    if (!Rec) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Rec();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.onresult = (e) => onText(Array.from(e.results).map((r) => r[0].transcript).join(""));
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }, [Rec, listening, onText]);

  return { supported: Boolean(Rec), listening, toggle };
}

export function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const clean = text.replace(/\[\d+\]/g, "").replace(/\$+/g, " ").replace(/[*_#`>\\]/g, "");
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(clean));
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
