import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";

export function useNotebookHistory(notebookId: string, token: string | null, messages: UIMessage[], setMessages: (messages: UIMessage[]) => void, busy: boolean, readOnly = false) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("[]");
  const [error, setError] = useState("");
  const [reloadRequired, setReloadRequired] = useState(false);
  const [reload, setReload] = useState(0);
  const revision = useRef(0);
  const offset = useRef(0);
  const inFlight = useRef(false);
  const active = useRef(true);
  const serialized = useMemo(() => JSON.stringify(messages), [messages]);
  const dirty = loaded && serialized !== saved;
  const savedCount = useMemo(() => (JSON.parse(saved) as unknown[]).length, [saved]);
  // During a reply, checkpoint everything up to the latest user message so a reload keeps the
  // prompt of the running turn. The in-flight assistant message is saved once the turn ends, and
  // a checkpoint never shortens the saved conversation.
  const checkpoint = useMemo(() => {
    if (!busy) return null;
    let end = messages.length;
    while (end > 0 && messages[end - 1].role !== "user") end--;
    return end > savedCount ? JSON.stringify(messages.slice(0, end)) : null;
  }, [busy, messages, savedCount]);
  const endpoint = `/api/notebooks/${notebookId}/chat-history`;

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    setLoading(true);
    setLoaded(false);
    setError("");
    fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, limit: 50 }), signal: controller.signal,
    }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "Could not load chat history.");
      if (controller.signal.aborted) return;
      revision.current = body.revision;
      offset.current = body.offset ?? 0;
      setSaved(JSON.stringify(body.messages));
      setMessages(body.messages);
      setLoaded(true);
      setReloadRequired(false);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { active.current = false; controller.abort(); };
  }, [endpoint, token, reload, setMessages]);

  useEffect(() => {
    const snapshot = busy ? checkpoint : serialized;
    if (readOnly || !loaded || !dirty || !snapshot || snapshot === saved || error || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    const snapshotOffset = snapshot !== "[]" ? offset.current : 0;
    fetch(endpoint, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, revision: revision.current, offset: snapshotOffset, messages: JSON.parse(snapshot) }),
    }).then(async response => {
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409 && active.current) setReloadRequired(true);
        throw new Error(body.detail || "Could not save chat history.");
      }
      if (active.current) { revision.current = body.revision; offset.current = snapshotOffset; setSaved(snapshot); }
    }).catch(error => {
      if (active.current) setError(error.message);
    }).finally(() => {
      inFlight.current = false;
      if (active.current) setSaving(false);
    });
  }, [readOnly, loaded, busy, dirty, error, serialized, checkpoint, saved, endpoint, token, saving]);

  return {
    loaded, loading, saving, error,
    blocking: loading || saving || (dirty && !error),
    // Pending writes protect publication and tab close, but do not block navigation.
    persistenceBlocking: !readOnly && (saving || (dirty && !error)),
    reloadRequired,
    clearError: () => setError(""),
    retry: () => {
      if (!loaded || reloadRequired) setReload(value => value + 1);
      else setError("");
    },
  };
}
