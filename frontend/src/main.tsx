import { About } from "./About";
import { Chat } from "./Chat";
import publishedNotebookLayout from "../../backend/assets/published_notebook.css?raw";
import notebookTheme from "../../backend/assets/notebook_theme.css?raw";
import notebookDarkTheme from "../../backend/templates/lab/static/theme-dark.css?raw";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Wrench,
  CirclePlus,
  GitFork,
  Download,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import "./style.css";

type Notebook = {
  id: string;
  owner_id: number;
  title: string;
  updated_at: number;
  revision: number;
  render_url?: string | null;
};
type WorkspaceUser = { id: number; login: string; avatar_url?: string };
type Workspace = { users: WorkspaceUser[]; notebooks: Notebook[] };
type Auth = {
  user: { login: string; user_id: number; avatar_url?: string } | null;
  can_edit: boolean;
  configured: boolean;
  chat_model?: string;
};
type Editor = { name: string; url: string; token: string; notebookId?: string };
type LiveEditor = Editor & { notebookId: string; ready: boolean; connected: boolean; expired?: boolean };
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(
    "/api" + path,
    body === undefined
      ? { signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : `Request failed (${response.status})`,
    );
  }
  return response.json();
}

async function startEditor(
  id: string,
  report: (kind: string, message: string) => void,
): Promise<Editor> {
  const response = await fetch(`/api/notebooks/${id}/editor`, {
    method: "POST",
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error("Setup stream is unavailable. Please retry.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Setup connection ended before the editor was ready. Please retry.");
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (!block.startsWith("data: ")) continue;
        const event = JSON.parse(block.slice(6));
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "ready") return event.editor;
        report(event.type, event.message);
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function PublishedNotebook({ notebook, version }: { notebook: Notebook; version: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  useEffect(() => {
    setHtml(null);
    setFailed(false);
    setFrameLoaded(false);
    if (!notebook.render_url) return;
    const controller = new AbortController();
    fetch(notebook.render_url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" })
      .then(response => {
        if (!response.ok) throw new Error("Notebook unavailable");
        return response.text();
      })
      .then(value => value.replace("</head>", `<style>${publishedNotebookLayout}</style></head>`))
      .then(value => setHtml(value.includes('id="notebook-factory-theme"') ? value : value.replace("</head>", `<style id="notebook-factory-theme">${notebookDarkTheme}\n${notebookTheme}\n${publishedNotebookLayout}</style></head>`)))
      .catch(error => { if (error.name !== "AbortError") setFailed(true); });
    return () => controller.abort();
  }, [notebook.render_url]);
  const useBlob = notebook.render_url && !failed;
  if (useBlob && html === null) return <div className="empty" role="status">Loading notebook…</div>;
  return <div className="published-notebook" aria-busy={!frameLoaded}>
    {!frameLoaded && <div className="notebook-loading" role="status"><LoaderCircle size={16} className="spin" />Loading notebook…</div>}
    <iframe
    title="Rendered notebook"
    style={{ visibility: frameLoaded ? "visible" : "hidden" }}
    onLoad={() => setFrameLoaded(true)}
    sandbox="allow-scripts allow-downloads"
    srcDoc={useBlob ? html! : undefined}
    src={useBlob ? undefined : `/api/notebooks/${notebook.id}/render?v=${version}`}
    referrerPolicy="no-referrer"
  /></div>;
}

const WORKSPACE_CACHE = "notebook-factory:public-workspace:v2";
function cachedNotebooks(): Notebook[] | null {
  try {
    const cached = JSON.parse(sessionStorage.getItem(WORKSPACE_CACHE) || "null");
    if (cached && Date.now() - cached.saved < 300000 && Array.isArray(cached.notebooks) &&
      cached.notebooks.every((n: Notebook) => typeof n.id === "string" && typeof n.title === "string"))
      return cached.notebooks;
  } catch { /* Storage can be unavailable. */ }
  return null;
}

function ChatLoading({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <aside className="chat-panel" hidden={!open} aria-label="Notebook chat" aria-busy="true">
    <header className="surface-toolbar">
      <span><span className="green-dot" />CHAT</span>
      <span className="chat-header-actions"><button className="icon-button" aria-label="Close chat" onClick={onClose}><X size={18} /></button></span>
    </header>
    <div className="chat-messages"><p className="chat-hint chat-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />Loading conversation…</p></div>
    <form><textarea aria-label="Message" placeholder="Loading conversation…" disabled rows={3} /></form>
  </aside>;
}

function App() {
  const [auth, setAuth] = useState<Auth>({
    user: null,
    can_edit: false,
    configured: false,
  });
  const [about, setAbout] = useState(location.pathname.replace(/\/$/, "") === "/about");
  const [authLoaded, setAuthLoaded] = useState(false);
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [expandedUsers, setExpandedUsers] = useState<Record<number, boolean>>({});
  const [cached] = useState(cachedNotebooks);
  const [notebooks, setNotebooks] = useState<Notebook[]>(cached || []);
  const [selected, setSelected] = useState<string | null>(
    new URLSearchParams(location.search).get("notebook") || null,
  );
  const [loading, setLoading] = useState(cached === null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  type SetupProgress = { stage: string; log: string; started: number; finished?: number; error?: string };
  const [setups, setSetups] = useState<Record<string, SetupProgress>>({});
  const setup = selected ? setups[selected] : undefined;
  const setupStage = setup?.stage ?? "";
  const setupLog = setup?.log ?? "";
  const setupStarted = setup && !setup.finished ? setup.started : null;
  const setupSeconds = setup ? Math.floor(((setup.finished ?? Date.now()) - setup.started) / 1000) : 0;
  const [, tickSetup] = useState(0);
  const setupOutput = useRef<HTMLPreElement>(null);
  const [setupPanels, setSetupPanels] = useState<Record<string, boolean>>({});
  const setupPanelOpen = selected ? !!setupPanels[selected] : false;
  useEffect(() => {
    const output = setupOutput.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [selected, setupLog, setupPanelOpen]);
  function updateSetup(id: string, update: (current: SetupProgress) => SetupProgress) {
    setSetups(items => items[id] ? { ...items, [id]: update(items[id]) } : items);
  }
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{ query: string; items: Notebook[] } | null>(null);
  const [searchError, setSearchError] = useState("");
  const searchQuery = query.trim();
  const searching = !!searchQuery && searchResult?.query !== searchQuery && !searchError;
  const sidebarNotebooks = searchQuery ? (searchResult?.query === searchQuery ? searchResult.items : []) : notebooks;
  useEffect(() => {
    setSearchError("");
    if (!searchQuery) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<Notebook[]>(`/search?q=${encodeURIComponent(searchQuery)}`, undefined, controller.signal)
        .then(items => {
          if (controller.signal.aborted) return;
          setSearchResult({ query: searchQuery, items });
          setNotebooks(existing => {
            const byId = new Map(existing.map(item => [item.id, item]));
            items.forEach(item => byId.set(item.id, item));
            return [...byId.values()];
          });
        }).catch(() => { if (!controller.signal.aborted) setSearchError("Search failed. Try again."); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searchQuery]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [queuedPrompts, setQueuedPrompts] = useState<Record<string, string>>({});
  const consumeInitialPrompt = useCallback((id: string) => {
    setQueuedPrompts(items => { const next = { ...items }; delete next[id]; return next; });
  }, []);
  const [editors, setEditors] = useState<Record<string, LiveEditor>>({});
  const editorsRef = useRef(editors);
  const editor = selected ? editors[selected] ?? null : null;
  const [chatPanel, setChatPanel] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  const chatOpen = chatPanel.id === selected ? chatPanel.open : !window.matchMedia("(max-width: 650px)").matches;
  const setChatOpen = (open: boolean) => setChatPanel({ id: selected, open });
  const [chatStates, setChatStates] = useState<Record<string, { busy: boolean; working: boolean }>>({});
  const chatBusy = !!selected && !!chatStates[selected]?.busy;
  const [visitedChats, setVisitedChats] = useState<string[]>([]);
  const chatIds = [...new Set([...visitedChats, ...(selected ? [selected] : [])])].filter(id => notebooks.some(n => n.id === id));
  useEffect(() => { if (selected) setVisitedChats(ids => ids.includes(selected) ? ids : [...ids, selected]); }, [selected]);
  const reportChatBusy = useCallback((id: string, busy: boolean, working: boolean) => {
    setChatStates(states => ({ ...states, [id]: { busy, working } }));
  }, []);
  const startingEditors = useRef(new Map<string, Promise<void>>());
  const [startingIds, setStartingIds] = useState<Set<string>>(new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const recoveries = useRef(new Set<string>());
  const savingEditors = useRef(new Map<string, Promise<void>>());
  const saveAgain = useRef(new Set<string>());
  const closingTokens = useRef(new Set<string>());
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const [saved, setSaved] = useState("");
  const [saveNotice, setSaveNotice] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!saveNotice) return;
    const timer = setTimeout(() => setSaveNotice(null), 3600);
    return () => clearTimeout(timer);
  }, [saveNotice]);
  const [mobile, setMobile] = useState(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const activeEditor = editor?.connected ? editor : null;
  const editorReady = !!activeEditor?.ready;
  const notebook = notebooks.find((n) => n.id === selected);
  useEffect(() => {
    if (setupStarted === null) return;
    const timer = setInterval(() => tickSetup(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [setupStarted]);


  const ownsNotebook = !!notebook && !!auth.user && notebook.owner_id === auth.user.user_id;
  const workspaceUsers = auth.user
    ? [...users.filter(u => u.id !== auth.user!.user_id), { id: auth.user.user_id, login: auth.user.login, avatar_url: auth.user.avatar_url }] : users;
  const sortedUsers = [...workspaceUsers].sort((a, b) =>
    a.id === auth.user?.user_id ? -1 : b.id === auth.user?.user_id ? 1 : a.login.localeCompare(b.login),
  );

  function putEditor(id: string, value: LiveEditor | null) {
    const next = { ...editorsRef.current };
    if (value) next[id] = value;
    else delete next[id];
    editorsRef.current = next;
    setEditors(next);
  }

  function patchEditor(id: string, token: string, patch: Partial<LiveEditor>) {
    const current = editorsRef.current[id];
    if (current?.token === token) putEditor(id, { ...current, ...patch });
  }

  const saveAfterTurn = useCallback((id: string) => {
    const current = editorsRef.current[id];
    if (current) void saveEditor(current).catch(() => setError("Notebook could not be saved. Autosave will retry."));
  }, []);

  const renameNotebook = useCallback((id: string, title: string) => {
    setNotebooks(items => {
      const renamed = items.map(item => item.id === id ? { ...item, title } : item);
      try { sessionStorage.setItem(WORKSPACE_CACHE, JSON.stringify({ saved: Date.now(), notebooks: renamed })); } catch { /* Storage is optional. */ }
      return renamed;
    });
  }, []);

  const applyWorkspace = useCallback(({ users, notebooks: list }: Workspace) => {
    setUsers(users);
    setNotebooks(list);
    setLoading(false);
    setSelected(current => list.some(n => n.id === current) ? current : null);
    try {
      sessionStorage.setItem(WORKSPACE_CACHE, JSON.stringify({ saved: Date.now(), notebooks: list }));
    } catch { /* Rendering must not depend on browser storage. */ }
  }, []);
  const sidebarRequest = useRef<Promise<void> | null>(null);
  const refreshSidebar = useCallback(() => {
    if (sidebarRequest.current) return sidebarRequest.current;
    const request = api<Workspace>("/workspace")
      .then(applyWorkspace)
      .finally(() => { sidebarRequest.current = null; });
    sidebarRequest.current = request;
    return request;
  }, [applyWorkspace]);
  const refresh = useCallback(async () => {
    await Promise.all([
      refreshSidebar(),
      api<Auth>("/auth/me").then(setAuth).finally(() => setAuthLoaded(true)),
    ]);
  }, [refreshSidebar]);
  useEffect(() => {
    refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [refresh]);
  // @lat: [[architecture#Live sidebar updates]]
  useEffect(() => {
    // The server pushes a full workspace snapshot on connect and after every change.
    let socket: WebSocket | null = null;
    let attempts = 0;
    let retry = 0;
    let stopped = false;
    const connect = () => {
      const url = new URL("/api/workspace/live", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onopen = () => { attempts = 0; };
      socket.onmessage = event => {
        try { applyWorkspace(JSON.parse(event.data)); } catch { /* Ignore malformed frames. */ }
      };
      socket.onclose = () => {
        socket = null;
        // Sockets close at the function duration limit; reconnect with backoff.
        if (!stopped) retry = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts++));
      };
    };
    // Each reconnect receives a fresh snapshot, so no HTTP refresh is needed while disconnected.
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [applyWorkspace]);
  useEffect(() => {
    const url = new URL(location.href);
    url.pathname = about ? "/about" : "/";
    if (selected && !about) url.searchParams.set("notebook", selected);
    else url.searchParams.delete("notebook");
    history.replaceState({}, "", url);
  }, [selected, about]);

  useEffect(() => {
    document.title = about ? "About — Python Notebooks" : notebook
      ? `${notebook.title} — Python Notebooks`
      : "Python Notebooks";
  }, [about, notebook?.title]);
  useEffect(() => {
    const navigate = () => {
      const isAbout = location.pathname.replace(/\/$/, "") === "/about";
      setAbout(isAbout);
      if (!isAbout) setSelected(new URLSearchParams(location.search).get("notebook"));
      setMobile(false);
    };
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);

  const saveBridge = useCallback(async (current: Editor) => {
    if (!frames.current.get(current.token)?.contentWindow)
      throw new Error("The editor is not ready yet.");
    const target = frames.current.get(current.token)!.contentWindow!;
    const origin = new URL(current.url).origin;
    const id = crypto.randomUUID();
    return await new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "Could not recover the live document. Keep this tab open; this editor may need the latest recovery bridge.",
          ),
        );
      }, 20000);
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
      };
      const receive = (event: MessageEvent) => {
        if (
          event.source !== target ||
          event.origin !== origin ||
          event.data?.id !== id
        )
          return;
        if (event.data.type === "vercel-notebook-saved") {
          cleanup();
          if (typeof event.data.source !== "string") reject(new Error("Editor did not return a notebook."));
          else resolve(event.data.source);
        }
        if (event.data.type === "vercel-notebook-save-error") {
          cleanup();
          reject(new Error(event.data.message));
        }
      };
      window.addEventListener("message", receive);
      target.postMessage(
        { type: "vercel-notebook-export", id, token: current.token },
        origin,
      );
    });
  }, []);

  function saveEditor(current: LiveEditor): Promise<void> {
    if (!current.ready || closingTokens.current.has(current.token)) return Promise.resolve();
    const existing = savingEditors.current.get(current.token);
    if (existing) { saveAgain.current.add(current.token); return existing; }
    const work = (async () => {
      do {
        saveAgain.current.delete(current.token);
        const source = await saveBridge(current);
        if (closingTokens.current.has(current.token) || editorsRef.current[current.notebookId]?.token !== current.token) return;
        const result = await api<{ changed: boolean; render_url?: string | null; revision: number; updated_at: number }>(
          `/notebooks/${current.notebookId}/save`, { token: current.token, source, publish: true }, AbortSignal.timeout(60000),
        );
        if (result.changed) {
          setNotebooks(items => {
            const updated = items.map(item => item.id === current.notebookId ? { ...item, render_url: result.render_url, revision: result.revision, updated_at: result.updated_at } : item);
            try { sessionStorage.setItem(WORKSPACE_CACHE, JSON.stringify({ saved: Date.now(), notebooks: updated })); } catch { /* Storage is optional. */ }
            return updated;
          });
          if (selectedRef.current === current.notebookId) {
            setRenderVersion(value => value + 1);
            setSaveNotice({ id: current.notebookId, at: Date.now() });
            setSaved("Saved at " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
          }
        }
      } while (saveAgain.current.has(current.token));
    })().catch(error => {
      if (closingTokens.current.has(current.token) || editorsRef.current[current.notebookId]?.token !== current.token) return;
      throw error;
    }).finally(() => savingEditors.current.delete(current.token));
    savingEditors.current.set(current.token, work);
    return work;
  }

  function openEditor(id: string): Promise<void> {
    const existing = startingEditors.current.get(id);
    if (existing) return existing;
    if (editorsRef.current[id]?.connected && editorsRef.current[id]?.ready) return Promise.resolve();
    setStartingIds(ids => new Set(ids).add(id));
    const promise = loadEditor(id).finally(() => {
      startingEditors.current.delete(id);
      setStartingIds(ids => { const next = new Set(ids); next.delete(id); return next; });
    });
    startingEditors.current.set(id, promise);
    return promise;
  }

  async function loadEditor(id: string) {
    setSetups(items => ({ ...items, [id]: { stage: "Connecting…", log: "", started: Date.now() } }));
    const observed = new Set<string>();
    const milestone = (message: string) => {
      if (observed.has(message)) return;
      observed.add(message);
      const now = Date.now();
      updateSetup(id, current => ({ ...current, stage: message,
        log: (current.log + `[${new Date(now).toLocaleTimeString()} · +${((now - current.started) / 1000).toFixed(1)}s] ${message}\n`).slice(-20000),
      }));
    };
    milestone("Editor requested");
    const previous = editorsRef.current[id];
    try {
      if (previous?.ready) {
        closingTokens.current.add(previous.token);
        const source = await saveBridge(previous);
        await api(`/notebooks/${id}/close`, { token: previous.token, source, publish: false });
      }
      const result = await startEditor(id, (kind, message) => {
        if (kind === "progress") milestone(message);
        if (kind === "log") updateSetup(id, current => ({ ...current, log: (current.log + message).slice(-20000) }));
      });
      putEditor(id, { ...result, notebookId: id, ready: false, connected: false });
      milestone("Loading Jupyter in the browser…");
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const origin = new URL(result.url).origin;
        const cleanup = () => { clearInterval(poll); clearTimeout(timeout); window.removeEventListener("message", receive); };
        const receive = (event: MessageEvent) => {
          if (event.source !== frames.current.get(result.token)?.contentWindow || event.origin !== origin || event.data?.id !== requestId) return;
          if (event.data.result?.ready) milestone("Notebook loaded; waiting for Python kernel…");
          if (event.data.result?.kernel_started) milestone("Python kernel started; connecting…");
          if (event.data.result?.ready && event.data.result?.connected !== false) {
            milestone("Python kernel connected — editor ready");
            cleanup(); patchEditor(id, result.token, { ready: true, connected: true });
            updateSetup(id, current => ({ ...current, stage: "" }));
            resolve();
          }
        };
        const poll = setInterval(() => {
          frames.current.get(result.token)?.contentWindow?.postMessage({ type: "vercel-notebook-capabilities", id: requestId, token: result.token }, origin);
        }, 250);
        const timeout = setTimeout(() => { cleanup(); reject(new Error("The editor is still loading. Try the request again shortly.")); }, 60000);
        window.addEventListener("message", receive);
      });
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Editor setup failed";
      milestone(message);
      updateSetup(id, current => ({ ...current, error: message }));
      throw error;
    } finally {
      if (previous) closingTokens.current.delete(previous.token);
      updateSetup(id, current => ({ ...current, finished: Date.now() }));
    }
  }

  function editorConnected(current: LiveEditor): Promise<boolean> {
    const target = frames.current.get(current.token)?.contentWindow;
    if (!target) return Promise.resolve(false);
    const origin = new URL(current.url).origin;
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const finish = (connected: boolean) => { clearTimeout(timer); window.removeEventListener("message", receive); resolve(connected); };
      const receive = (event: MessageEvent) => {
        if (event.source === target && event.origin === origin && event.data?.id === id && event.data.type === "vercel-notebook-tool-result") {
          finish(!!event.data.result?.ready && event.data.result?.connected !== false);
        }
      };
      const timer = setTimeout(() => finish(false), 5000);
      window.addEventListener("message", receive);
      target.postMessage({ type: "vercel-notebook-capabilities", id, token: current.token }, origin);
    });
  }

  useEffect(() => {
    let cancelled = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        await Promise.all(Object.values(editorsRef.current).filter(current => current.ready).map(async current => {
          if (closingTokens.current.has(current.token)) return;
          try {
            const [response, connected] = await Promise.all([fetch(`/api/notebooks/${current.notebookId}/editor-status`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: current.token }), signal: AbortSignal.timeout(5000),
            }), editorConnected(current)]);
            if (cancelled || closingTokens.current.has(current.token) || editorsRef.current[current.notebookId]?.token !== current.token) return;
            patchEditor(current.notebookId, current.token, { connected: response.ok && connected, expired: response.status === 410 || response.status === 409 });
            // Background editors stay disconnected; only recover the currently displayed one.
            if (response.status === 410 && current.connected && selectedRef.current === current.notebookId && !recoveries.current.has(current.token)) {
              recoveries.current.add(current.token);
              try { await openEditor(current.notebookId); }
              catch (error) { setError(error instanceof Error ? error.message : "Automatic editor recovery failed."); }
              finally { recoveries.current.delete(current.token); }
            }
          } catch {
            if (!cancelled) patchEditor(current.notebookId, current.token, { connected: false });
          }
        }));
      } finally { checking = false; }
    };
    const timer = setInterval(() => { void check(); }, 15000);
    const online = () => { void check(); };
    const offline = () => {
      for (const current of Object.values(editorsRef.current)) patchEditor(current.notebookId, current.token, { connected: false });
    };
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, []);

  useEffect(() => {
    const saveAll = () => {
      for (const current of Object.values(editorsRef.current)) {
        void saveEditor(current).catch(() => setError("A notebook could not be saved. Keep this tab open; autosave will retry."));
      }
    };
    const interval = setInterval(saveAll, 30000);
    const hidden = () => { if (document.visibilityState === "hidden") saveAll(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", saveAll);
    const unload = (event: BeforeUnloadEvent) => {
      if (Object.keys(editorsRef.current).length) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => { clearInterval(interval); window.removeEventListener("beforeunload", unload); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("blur", saveAll); };
  }, []);

  async function action(label: string, operation: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy("");
    }
  }
  function choose(id: string | null) {
    if (about) {
      history.pushState({}, "", id ? `/?notebook=${encodeURIComponent(id)}` : "/");
      setAbout(false);
      setMobile(false);
    }
    if (id === selected) return;
    setChatPanel({ id, open: !window.matchMedia("(max-width: 650px)").matches });
    if (editor?.ready) void saveEditor(editor).catch(() => setError("A notebook draft could not be saved. Keep this tab open; autosave will retry."));
    selectedRef.current = id;
    setSaveNotice(null); setSelected(id); setMobile(false); setError(""); setSaved("");
  }
  const date = notebook
    ? new Date(notebook.updated_at * 1000).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";
  return (
    <div className="app">
      {mobile && (
        <button
          className="scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={mobile ? "sidebar open" : "sidebar"}>
        <div className="brand-row">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              void choose(null);
            }}
          >
            <svg className="brand-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2L24 22H0Z" fill="currentColor" />
            </svg>
            <span>Python Notebooks</span>
          </a>

        </div>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search notebooks"
            placeholder="Find a notebook…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
          <a className="about-link" href="/about" aria-current={about ? "page" : undefined} onClick={event => {
            if (event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            if (editor?.ready) void saveEditor(editor).catch(() => setError("Could not save the notebook draft; autosave will retry."));
            if (!about) history.pushState({}, "", "/about");
            setAbout(true); setMobile(false);
          }}><Wrench size={17} aria-hidden="true" /><span>How it’s built</span><ArrowUpRight className="about-link-arrow" size={13} aria-hidden="true" /></a>
        <button
          className="new-button"
          disabled={!!busy || (!!auth.user && !auth.can_edit)}
          onClick={() =>
            auth.can_edit
              ? setCreating(true)
              : location.assign("/api/auth/login")
          }
        >
          <CirclePlus size={17} aria-hidden="true" /> New notebook
        </button>
        <nav aria-label="Notebooks">
          {sortedUsers.map(owner => {
            const mine = owner.id === auth.user?.user_id;
            const matches = sidebarNotebooks.filter(n => n.owner_id === owner.id);
            if (searchQuery && !matches.length) return null;
            const expanded = query ? true : expandedUsers[owner.id] ?? mine;
            return <section className="notebook-owner" key={owner.id}>
              <button className="owner-toggle" aria-expanded={expanded} onClick={() => setExpandedUsers(items => ({ ...items, [owner.id]: !expanded }))}>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {owner.avatar_url ? <img src={owner.avatar_url} alt="" referrerPolicy="no-referrer" /> : <span className="owner-initial">{owner.login[0].toUpperCase()}</span>}
                <strong>{owner.login}</strong>{mine && <small>You</small>}<span className="owner-count">{notebooks.filter(n => n.owner_id === owner.id).length}</span>
              </button>
              {expanded && <div className="owner-notebooks">{matches.map(n => <button
                key={n.id} className={"notebook-link " + (n.id === selected ? "active" : "")}
                disabled={!!busy} onClick={() => choose(n.id)}
              >
                <BookOpen size={16} /><span>{n.title}</span>
                {startingIds.has(n.id) ? <span className="running-editor-dot starting-editor-dot" aria-label="Editor starting" title="Starting Python environment…" /> : chatStates[n.id]?.working ? <span className="agent-working-dots" aria-label="Agent working" title="Agent working"><i /><i /><i /></span> : editors[n.id]?.ready && editors[n.id]?.connected && <span className="running-editor-dot" aria-label="Editor connected" title="Editor running" />}
              </button>)}{!matches.length && <p className="list-empty">{mine ? "Create your first notebook." : "No notebooks yet."}</p>}</div>}
            </section>;
          })}
          {searching && <p className="list-empty" role="status"><LoaderCircle size={14} className="spin" /> Searching…</p>}
          {searchError && <p className="list-empty" role="alert">{searchError}</p>}
          {searchQuery && !searching && !searchError && !sidebarNotebooks.length && <p className="list-empty">No matching notebooks.</p>}

        </nav>
        <div className="sidebar-bottom">

          {auth.user ? (
            <div className="account">
              <span className="avatar" aria-hidden="true">
                {auth.user.login[0].toUpperCase()}
                {auth.user.avatar_url && <img
                  key={auth.user.avatar_url}
                  src={auth.user.avatar_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={event => { event.currentTarget.style.display = "none"; }}
                />}
              </span>
              <span>
                <strong>{auth.user.login}</strong>
                <small>{"Signed in with Vercel"}</small>
              </span>
              <form action="/api/auth/logout" method="post">
                <button
                  className="icon-button"
                  title="Sign out"
                  disabled={Object.keys(editors).length > 0 || Object.values(chatStates).some(state => state.busy)}
                >
                  <LogOut size={16} />
                </button>
              </form>
            </div>
          ) : (
            <a className="login" href="/api/auth/login">
              <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 24 23H0Z" fill="currentColor" /></svg> Sign in with Vercel{" "}
              <ArrowUpRight size={15} />
            </a>
          )}
        </div>
      </aside>
      <main>
        {(about || !notebook) && <button className="button mobile-toggle welcome-menu" aria-label="Open navigation" onClick={() => setMobile(true)}>
          <Menu size={14} /> Menu
        </button>}
        {about ? <About onBack={() => choose(selected)} /> : loading ? (
          <div className="empty">
            <LoaderCircle className="spin" />
            <p>Opening your workspace…</p>
          </div>
        ) : notebook ? (
          <>
            {busy && !setupStage && (
              <div className="progress" role="status">
                <LoaderCircle size={16} className="spin" />
                {busy}
                {busy.startsWith("Starting") && (
                  <small>First startup can take a few minutes.</small>
                )}
              </div>
            )}


          </>
        ) : notebooks.length > 0 ? (
          <section className="empty welcome" aria-labelledby="welcome-title">
            <div className="welcome-art" aria-hidden="true">
              <div className="welcome-page welcome-page-back" />
              <div className="welcome-page welcome-page-front"><BookOpen size={32} strokeWidth={1.25} /><span /><span /><span /></div>
            </div>
            <h1 id="welcome-title">Choose a notebook</h1>
            <p>Open a notebook from the sidebar<br />to explore its code, charts, and ideas</p>
            <button className="button welcome-browse" onClick={() => setMobile(true)}><Menu size={16} /> Browse notebooks</button>
          </section>
        ) : (
          <div className="empty">
            <div className="empty-art">
              <BookOpen size={38} strokeWidth={1} />
            </div>
            <div className="eyebrow">A FRESH PAGE</div>
            <h1>Good ideas start here.</h1>
            <p>
              A home for experiments, discoveries, and Python notebooks.
              <br />
              Create a notebook, follow your curiosity, share what you find.
            </p>
            <button
              className="button primary"
              onClick={() =>
                auth.can_edit
                  ? setCreating(true)
                  : location.assign("/api/auth/login")
              }
            >
              <Plus size={16} />
              {auth.can_edit
                ? "Create your first notebook"
                : "Sign in to get started"}
            </button>
            {!auth.can_edit && (
              <small>
                Everyone can read. Sign in to create your own notebooks.
              </small>
            )}
          </div>
        )}
            <div className="notebook-workspace" style={notebook && !about ? undefined : { display: "none" }}>
            <div className={"notebook-surface " + (activeEditor ? "editing" : "")}>
              <header className="surface-toolbar notebook-toolbar">
                <button className="button mobile-toggle notebook-menu" aria-label="Open navigation" onClick={() => setMobile(true)}>
                  <Menu size={14} /> Menu
                </button>
                <div className="notebook-panel-title" title={activeEditor ? saved || "Changes save automatically" : `Updated ${date} · Revision ${notebook?.revision}`}>
                  <span
                    className={selected && startingIds.has(selected) ? "green-dot starting-editor-dot" : editorReady ? "green-dot" : "gray-dot"}
                    aria-label={selected && startingIds.has(selected) ? "Editor starting" : editorReady ? "Editor connected" : "Read-only notebook"}
                  />
                  <h1 aria-label={notebook?.title} title={notebook?.title}>NOTEBOOK</h1>
                  {editorReady && saveNotice?.id === selected && <span key={saveNotice.at} className="saved-pill" role="status">Saved</span>}
                  {!editorReady && (setupStage || setupLog) && <button
                    className="setup-status" aria-label="Editor startup status" aria-expanded={setupPanelOpen}
                    aria-controls="startup-events-panel"
                    title={`${setupStage} · ${setupSeconds}s elapsed`}
                    onClick={() => selected && setSetupPanels(items => ({ ...items, [selected]: !setupPanelOpen }))}
                  >
                    <span role="status">{setupStage}</span>
                    {!editorReady && <small>{setupSeconds}s</small>}
                  </button>}

                </div>
                {notebook && (
                <div className="actions notebook-header-actions">
                  <a
                    className="button download"
                    aria-label="Download notebook"
                    title="Download .ipynb"
                    href={`/api/notebooks/${selected}/download`}
                  >
                    <Download size={16} />
                  </a>
                  {ownsNotebook && (
                    <button
                      className="button delete-notebook"
                      aria-label="Delete notebook"
                      title="Delete notebook"
                      disabled={!!busy || chatBusy}
                      onClick={() => {
                        if (!window.confirm(`Delete “${notebook.title}”? This permanently deletes its published notebook, draft, and chat history.`)) return;
                        void action("Deleting notebook…", async () => {
                          await api(`/notebooks/${notebook.id}/delete`, {});
                          putEditor(notebook.id, null);
                          setSelected(null);
                          setSaved("");
                          setNotebooks(items => {
                            const remaining = items.filter(item => item.id !== notebook.id);
                            try { sessionStorage.setItem(WORKSPACE_CACHE, JSON.stringify({ saved: Date.now(), notebooks: remaining })); } catch { /* Storage is optional. */ }
                            return remaining;
                          });
                          await refresh();
                        });
                      }}
                    ><Trash2 size={16} strokeWidth={1.5} /></button>
                  )}
                  {!chatOpen && <button className="button" aria-expanded={false} onClick={() => setChatOpen(true)}><MessageSquare size={16}/>Chat</button>}
                  {notebook && !ownsNotebook && <button className="button primary" disabled={!!busy} onClick={() => {
                    if (!auth.user) { location.assign("/api/auth/login"); return; }
                    void action("Forking notebook…", async () => {
                      const fork = await api<Notebook>(`/notebooks/${notebook.id}/fork`, {});
                      await refresh(); setSelected(fork.id);
                      setExpandedUsers(items => ({ ...items, [auth.user!.user_id]: true }));
                    });
                  }}><GitFork size={16} />Fork</button>}
                  {ownsNotebook && editor?.ready && <button
                    className="button"
                    disabled={!!busy || chatBusy || setupStarted !== null}
                    onClick={() => {
                      const current = editor;
                      void action("Saving and quitting editor…", async () => {
                        closingTokens.current.add(current.token);
                        try {
                          const source = await saveBridge(current);
                          await api(`/notebooks/${current.notebookId}/close`, { token: current.token, source, publish: true }, AbortSignal.timeout(60000));
                          if (editorsRef.current[current.notebookId]?.token === current.token) putEditor(current.notebookId, null);
                          setSetups(items => { const next = { ...items }; delete next[current.notebookId]; return next; });
                          if (selectedRef.current === current.notebookId) {
                            setSaveNotice(null);
                            setRenderVersion(value => value + 1);
                          }
                          await refreshSidebar();
                        } finally {
                          closingTokens.current.delete(current.token);
                        }
                      });
                    }}
                  ><LogOut size={14} />Quit editor</button>}
                  {ownsNotebook && !activeEditor && (
                    <button className="button primary" disabled={!!busy || setupStarted !== null} onClick={() => { void openEditor(selected!).catch(() => { /* Stored with this notebook by loadEditor. */ }); }}>
                      <Pencil size={15} /> Edit notebook
                    </button>
                  )}
                </div>
                )}
              </header>
              {setupPanelOpen && (setupStage || setupLog) && <section className="setup-progress" id="startup-events-panel" aria-label="Environment setup">
                <button className="setup-close" aria-label="Close startup events" onClick={() => selected && setSetupPanels(items => ({ ...items, [selected]: false }))}><X size={14} /></button>
                <pre ref={setupOutput} className="setup-output" aria-label="Startup events">{setupLog}</pre>
              </section>}
              {Object.values(editors).map(current => <iframe
                key={current.token} ref={node => {
                  if (node) frames.current.set(current.token, node); else frames.current.delete(current.token);
                }} title={`Jupyter editor: ${notebooks.find(item => item.id === current.notebookId)?.title || current.notebookId}`} src={current.url}
                style={editorReady && current.notebookId === selected ? undefined : { display: "none" }} referrerPolicy="no-referrer"
                allow="clipboard-read; clipboard-write"
              />)}
              {notebook && !editorReady && <PublishedNotebook
                key={`${selected}-${renderVersion}-${notebook.render_url || "local"}`}
                notebook={notebook} version={renderVersion}
              />}
            </div>
            {notebook && !authLoaded && <ChatLoading open={chatOpen} onClose={() => setChatOpen(false)} />}
            {authLoaded && chatIds.map(id => <Chat key={id}
              initialPrompt={queuedPrompts[id]} onInitialPromptSent={consumeInitialPrompt}
              username={workspaceUsers.find(user => user.id === notebooks.find(n => n.id === id)?.owner_id)?.login || "User"}
              model={auth.chat_model} notebookId={id} editorStarting={startingIds.has(id)} readOnly={!auth.user || notebooks.find(n => n.id === id)?.owner_id !== auth.user.user_id}
              editor={editors[id]?.connected ? editors[id] : null}
              getFrame={() => { const current = editorsRef.current[id]; return current ? frames.current.get(current.token) ?? null : null; }}
              disabled={selected === id && !!busy} open={!about && selected === id && chatOpen}
              onClose={() => setChatPanel({ id, open: false })} onTurnFinished={saveAfterTurn}
              onBusy={reportChatBusy} onRename={renameNotebook} onEnterEditing={() => openEditor(id)}
            />)}
            </div>
        {(error || setup?.error) && (
          <div className="error" role="alert">
            <span>{error || setup?.error}</span>
            <button aria-label="Dismiss error" onClick={() => {
              if (error) setError("");
              else if (selected) updateSetup(selected, current => ({ ...current, error: undefined }));
            }}>
              <X size={16} />
            </button>
          </div>
        )}
      </main>
      {creating && (
        <div
          className="modal-backdrop"
          onClick={() => !busy && setCreating(false)}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-notebook-title"
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); if (!busy) setCreating(false); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!busy && title.trim()) e.currentTarget.requestSubmit();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || !title.trim()) return;
              const prompt = initialPrompt.trim();
              action("Creating notebook…", async () => {
                const item = await api<Notebook>("/notebooks", { title, prompt });
                await refresh();
                choose(item.id);
                setExpandedUsers(items => ({ ...items, [item.owner_id]: true }));
                setCreating(false);
                setTitle("");
                setInitialPrompt("");
                if (prompt) {
                  setQueuedPrompts(items => ({ ...items, [item.id]: prompt }));
                  void openEditor(item.id).catch(() => { /* Stored with this notebook by loadEditor. */ });
                }
              });
            }}
          >
            <div className="eyebrow" id="create-notebook-title">NEW NOTEBOOK</div>
            <label htmlFor="title">Notebook title</label>
            <input
              id="title"
              autoFocus
              required
              maxLength={120}
              placeholder="An interesting experiment"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <label htmlFor="initial-prompt">Initial prompt <span className="optional-label">(optional)</span></label>
            <textarea
              id="initial-prompt" rows={3} maxLength={10000}
              placeholder="What should the agent create in this notebook?"
              value={initialPrompt} onChange={e => setInitialPrompt(e.target.value)}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => setCreating(false)}
                disabled={!!busy || chatBusy}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={!!busy || !title.trim()}
              >
                {busy ? "Creating…" : "Create notebook"}
                <Plus size={16} />
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
