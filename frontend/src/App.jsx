import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthError, deleteDocument, getConfig, listDocuments, uploadDocuments } from "./api.js";
import { getSession, signOut, supabase } from "./auth.js";
import { useChat } from "./hooks.js";
import { useVoiceCall } from "./voice.js";
import Chat from "./components/Chat.jsx";
import Login from "./components/Login.jsx";
import Sidebar from "./components/Sidebar.jsx";

export default function App() {
  const [phase, setPhase] = useState("loading"); // loading | login | ready
  const [userId, setUserId] = useState(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [mode, setMode] = useState("ask"); // ask | solve
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [docs, setDocs] = useState([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [selected, setSelected] = useState(new Set()); // empty set = every document
  const [drawer, setDrawer] = useState(false);
  const [fatal, setFatal] = useState("");
  const recoveryRef = useRef(false);

  const requireLogin = useCallback(() => {
    setUserId(null);
    setPhase("login");
    signOut().catch((err) => setFatal(`Could not sign out: ${err.message}`));
  }, []);

  const refreshDocs = useCallback(async () => {
    try {
      const list = await listDocuments();
      setDocs(list);
      setSelected((prev) => new Set([...prev].filter((id) => list.some((d) => d.id === id))));
    } catch (err) {
      if (err instanceof AuthError) requireLogin();
      else setFatal(`Cannot reach the Folio server: ${err.message}`);
    } finally {
      setDocsLoading(false);
    }
  }, [requireLogin]);

  const boot = useCallback(async () => {
    setFatal("");
    try {
      const cfg = await getConfig();
      setVoiceEnabled(Boolean(cfg.voice));
      if (!cfg.auth_configured) {
        setFatal("Supabase is not configured on the backend. Add SUPABASE_URL to your Railway API service variables, then redeploy the backend.");
        setPhase("configuration");
        return;
      }
      if (!supabase) {
        setFatal("The frontend is missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Add both to your Vercel project variables and redeploy the frontend.");
        setPhase("configuration");
        return;
      }
      const session = cfg.auth_required ? await getSession() : null;
      if (recoveryRef.current) {
        setUserId(null);
        setPhase("login");
        return;
      }
      if (cfg.auth_required && !session) {
        setUserId(null);
        setPhase("login");
        return;
      }
      setUserId(session?.user.id || "local");
      setPhase("ready");
      refreshDocs();
    } catch (err) {
      setFatal(`Cannot reach the Folio server: ${err.message}`);
      setPhase("ready");
      setDocsLoading(false);
    }
  }, [refreshDocs]);

  useEffect(() => {
    if (!supabase) return undefined;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        recoveryRef.current = true;
        setPasswordRecovery(true);
        setPhase("login");
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    boot();
  }, [boot]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const chat = useChat({ mode, selectedIds, onAuthError: requireLogin, userId });
  const call = useVoiceCall({ docIds: selectedIds, onFinished: chat.appendTurns });

  async function handleUpload(files) {
    const { results } = await uploadDocuments(files);
    await refreshDocs();
    return results;
  }

  async function handleDelete(doc) {
    await deleteDocument(doc.id);
    await refreshDocs();
  }

  async function handleSignOut() {
    try {
      await signOut();
      setFatal("");
      setDocs([]);
      setSelected(new Set());
      setUserId(null);
      recoveryRef.current = false;
      setPasswordRecovery(false);
      setPhase("login");
    } catch (err) {
      setFatal(`Could not sign out: ${err.message}`);
    }
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev.size === 0 ? docs.map((d) => d.id) : prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next.size === docs.length ? new Set() : next;
    });
  }

  if (phase === "loading") return <main className="center">Loading…</main>;
  if (phase === "configuration") {
    return (
      <main className="center configuration-error">
        <section role="alert">
          <h1>Authentication needs configuration</h1>
          <p>{fatal}</p>
          <button className="btn primary" onClick={boot}>Check again</button>
        </section>
      </main>
    );
  }
  if (phase === "login") {
    return (
      <Login
        onDone={boot}
        initialMode={passwordRecovery ? "update" : "login"}
        onRecoveryComplete={() => {
          recoveryRef.current = false;
          setPasswordRecovery(false);
        }}
      />
    );
  }

  const scope =
    docs.length === 0
      ? "No documents yet"
      : selected.size === 0
        ? `All ${docs.length} ${docs.length === 1 ? "document" : "documents"}`
        : `${selected.size} of ${docs.length} documents`;

  const libraryProps = {
    docs,
    loading: docsLoading,
    selected,
    onToggle: toggle,
    onSelectAll: () => setSelected(new Set()),
    onUpload: handleUpload,
    onDelete: handleDelete,
    onSummarize: (d) => { setDrawer(false); chat.summarize(d); },
    busy: chat.busy,
  };

  return (
    <div className={`app ${drawer ? "drawer-open" : ""}`}>
      <div className="library-wrap">
        <Sidebar
          mode={mode}
          onSignOut={handleSignOut}
          chat={{ ...chat, newChat: () => { chat.newChat(); setDrawer(false); }, select: (id) => { chat.select(id); setDrawer(false); } }}
          busy={chat.busy}
          libraryProps={libraryProps}
        />
        <button className="scrim" aria-label="Close sidebar" onClick={() => setDrawer(false)} />
      </div>
      <main className="main">
        {fatal && <p className="banner error" role="alert">{fatal}</p>}
        <Chat
          mode={mode}
          onMode={setMode}
          messages={chat.messages}
          busy={chat.busy}
          hasDocs={docs.length > 0}
          scope={scope}
          call={call}
          voiceEnabled={voiceEnabled}
          onAsk={(q) => { setDrawer(false); chat.ask(q); }}
          onStop={chat.stop}
          onOpenLibrary={() => setDrawer(true)}
        />
      </main>
    </div>
  );
}
