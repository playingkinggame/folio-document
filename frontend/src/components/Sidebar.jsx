import Library from "./Library.jsx";

function ago(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function Sidebar({ mode, chat, busy, libraryProps, onSignOut }) {
  return (
    <aside className="library" aria-label="Sidebar">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <h1>Folio</h1>
        <button className="btn ghost sign-out" onClick={onSignOut}>Sign out</button>
      </header>

      <button className="btn primary wide" onClick={chat.newChat} disabled={chat.activeId === null && chat.messages.length === 0}>
        New {mode === "solve" ? "problem chat" : "chat"}
      </button>

      <section className="history" aria-label="Saved chats">
        <h2>{mode === "solve" ? "Saved solutions" : "Saved chats"}</h2>
        {chat.conversations.length === 0 ? (
          <p className="empty">Your chats are saved here, so you can come back to them.</p>
        ) : (
          <ul>
            {chat.conversations.map((c) => (
              <li key={c.id} className={c.id === chat.activeId ? "convo active" : "convo"}>
                <button className="convo-open" onClick={() => chat.select(c.id)} title={c.title}>
                  <span className="convo-title">{c.title}</span>
                  <span className="convo-time">{ago(c.updatedAt)}</span>
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Delete chat ${c.title}`}
                  disabled={busy && c.id === chat.activeId}
                  onClick={() => { if (window.confirm("Delete this chat?")) chat.remove(c.id); }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Library {...libraryProps} />
    </aside>
  );
}
