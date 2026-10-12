// Thin wrapper around the Folio API. Adds the current Supabase token and handles SSE streaming.
import { getSession } from "./auth.js";

const BASE = import.meta.env.VITE_API_URL || "";

export class AuthError extends Error {}

async function headers(extra = {}) {
  const h = { ...extra };
  const session = await getSession();
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  return h;
}

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: await headers(options.headers),
  });
  if (res.status === 401) throw new AuthError("Not signed in");
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const getConfig = () => request("/api/config");

export const listDocuments = () => request("/api/documents");

export const deleteDocument = (id) => request(`/api/documents/${id}`, { method: "DELETE" });

export function uploadDocuments(files) {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  return request("/api/documents", { method: "POST", body: form });
}

// POST a request and yield each server-sent event as a parsed object.
export async function* stream(path, body, signal) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 401) throw new AuthError("Not signed in");
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6));
    }
  }
}

export const voiceToken = (docIds) =>
  request("/api/voice/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc_ids: docIds }),
  });
