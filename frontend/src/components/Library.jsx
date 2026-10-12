import { useRef, useState } from "react";
import { IconTrash, IconUpload } from "./icons.jsx";

const ACCEPT = ".pdf,.docx,.txt,.md";

function meta(doc) {
  const parts = [doc.ext.toUpperCase()];
  if (doc.pages) parts.push(`${doc.pages} ${doc.pages === 1 ? "page" : "pages"}`);
  parts.push(`${doc.chunks} passages`);
  return parts.join(", ");
}

export default function Library({ docs, loading, selected, onToggle, onSelectAll, onUpload, onDelete, onSummarize, busy }) {
  const input = useRef(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [problems, setProblems] = useState([]);

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    setProblems([]);
    try {
      const results = await onUpload(files);
      setProblems(results.filter((r) => !r.ok));
    } catch (err) {
      setProblems([{ name: "Upload", error: err.message }]);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  const allOn = selected.size === 0;

  return (
    <section className="docs-section" aria-label="Document library">
      <div
        className={`drop ${drag ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
      >
        <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => handleFiles(e.target.files)} />
        <button className="btn primary wide" onClick={() => input.current?.click()} disabled={uploading}>
          <IconUpload /> {uploading ? "Reading and indexing…" : "Add documents"}
        </button>
        <p className="hint">Drop PDF, Word, text or Markdown files here.</p>
      </div>

      {problems.length > 0 && (
        <ul className="problems" role="alert">
          {problems.map((p, i) => (
            <li key={i}><strong>{p.name}</strong> {p.error}</li>
          ))}
        </ul>
      )}

      <div className="lib-head">
        <h2>Your documents</h2>
        {docs.length > 1 && (
          <button className="link" onClick={onSelectAll} disabled={allOn}>
            Search all
          </button>
        )}
      </div>

      {loading ? (
        <p className="hint">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="empty">Nothing here yet. Add a resume, a paper or your notes and ask questions about them.</p>
      ) : (
        <ul className="docs">
          {docs.map((d) => {
            const on = allOn || selected.has(d.id);
            return (
              <li key={d.id} className={on ? "doc on" : "doc"}>
                <label className="doc-main">
                  <input type="checkbox" checked={on} onChange={() => onToggle(d.id)} />
                  <span className="doc-text">
                    <span className="doc-name" title={d.name}>{d.name}</span>
                    <span className="doc-meta">{meta(d)}</span>
                  </span>
                </label>
                <div className="doc-actions">
                  <button className="link" onClick={() => onSummarize(d)} disabled={busy}>Summarize</button>
                  <button
                    className="icon-btn"
                    aria-label={`Delete ${d.name}`}
                    onClick={() => { if (window.confirm(`Remove ${d.name} from your library?`)) onDelete(d); }}
                  >
                    <IconTrash width={16} height={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
