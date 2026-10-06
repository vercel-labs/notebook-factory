import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolActivity } from "./ToolActivity";
import { useNotebookHistory } from "./useNotebookHistory";
import { Send, Square, X, RotateCcw, LoaderCircle } from "lucide-react";

// Why the server ended a response (the transient data-turn marker). No marker means the
// connection dropped while the turn may still be running.
type TurnEnd = { state: "parked" | "done" | "stopped" | "error"; toolCallIds?: string[]; editing?: boolean };
type ToolCall = { toolName: string; toolCallId: string; input: unknown };

// Tools whose effects may already have happened when a reload interrupted them. After a reload
// they report an interruption instead of running twice; the rest are safe to repeat.
const UNSAFE_AFTER_RELOAD = new Set(["run_cell", "insert_cell", "replace_cell"]);
const INTERRUPTED = "Interrupted by a page reload; the action may or may not have happened. Read the notebook before continuing.";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The server replays a turn from its start, so a dropped stream must not leave the SDK resuming
// its partial response state (it would append the replay to it). The SDK keeps that state only
// for network-type errors; report interruptions as plain errors, preserving aborts.
const interrupted = (error: unknown, signal?: AbortSignal | null) =>
  signal?.aborted || (error instanceof Error && error.name === "AbortError") ? error : new Error("The reply stream was interrupted.");
const replayableFetch: typeof fetch = async (input, init) => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw interrupted(error, init?.signal);
  }
  if (!response.body || response.status === 204) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(interrupted(error, init?.signal));
      }
    },
    cancel: reason => reader.cancel(reason),
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

function markInterrupted(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: message.parts.map(part =>
      isToolUIPart(part) && !part.state.startsWith("output-")
        ? ({ ...part, state: "output-error", input: part.input ?? {}, output: undefined, errorText: INTERRUPTED } as typeof part)
        : part,
    ),
  };
}

export function Chat({
  notebookId,
  initialPrompt,
  onInitialPromptSent,
  username,
  model,
  editor,
  getFrame,
  editorStarting,
  readOnly,
  open,
  onClose,
  onTurnFinished,
  onBusy,
  onRename,
  onEnterEditing,
  disabled,
}: {
  notebookId: string;
  initialPrompt?: string;
  onInitialPromptSent: (id: string) => void;
  username: string;
  model?: string;
  editor: { url: string; token: string } | null;
  onEnterEditing: () => Promise<void>;
  getFrame: () => HTMLIFrameElement | null;
  editorStarting: boolean;
  readOnly: boolean;
  open: boolean;
  disabled: boolean;
  onClose: () => void;
  onTurnFinished: (notebookId: string) => void;
  onBusy: (notebookId: string, busy: boolean, working: boolean) => void;
  onRename: (id: string, title: string) => void;
}) {
  const currentEditor = useRef(editor);
  currentEditor.current = editor;
  const starting = useRef(editorStarting);
  starting.current = editorStarting;
  const [consent, setConsent] = useState<{ reason: string; resolve: (yes: boolean) => void } | null>(null);
  const consentRef = useRef<typeof consent>(null);
  consentRef.current = consent;
  useEffect(() => {
    // A manual startup or recovery may finish while a viewing-mode tool waits.
    if (consent && editor) {
      consent.resolve(true);
      setConsent(null);
    }
  }, [consent, editor]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(0);
  const active = useRef(true);
  const userTurn = useRef(false);
  const count = useRef(0);
  const halted = useRef(false);
  const compatible = useRef(false);
  const failures = useRef(0);
  const [toolError, setToolError] = useState("");
  const tail = useRef(Promise.resolve());
  const bottom = useRef<HTMLDivElement>(null);
  // Durable-turn reattachment: whether the response in flight is a replay, the marker it ended
  // with, and the held Web Lock that makes this tab the one executing the turn's tools.
  const resuming = useRef(false);
  const turnEnd = useRef<TurnEnd | null>(null);
  const lastEnd = useRef<TurnEnd | null>(null);
  const recovering = useRef(false);
  const lockRelease = useRef<(() => void) | null>(null);
  // Owners start "attaching" until the server says whether a turn is live, so a reload never
  // shows an idle composer that could supersede the running reply.
  const [attach, setAttach] = useState<"checking" | "reconnecting" | null>(readOnly ? null : "checking");
  const abandoned = useRef(false);
  const claim = useRef<Promise<boolean> | null>(null);
  // Calls this page already started, and their results, so a replay after a dropped stream
  // neither runs them twice nor loses an output the replaced message no longer holds.
  const dispatched = useRef(new Set<string>());
  const results = useRef(new Map<string, unknown>());
  const [connectionError, setConnectionError] = useState("");
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/notebooks/${notebookId}/chat`,
        fetch: replayableFetch,
        body: () => ({ token: currentEditor.current?.token ?? null }),
        // Durable turns keep running server-side; a remount reattaches to the active one.
        prepareReconnectToStreamRequest: () => ({ api: `/api/notebooks/${notebookId}/chat/stream` }),
      }),
    [notebookId],
  );
  const {
    messages,
    sendMessage,
    addToolOutput: chatAddToolOutput,
    status,
    error,
    stop,
    setMessages,
    clearError,
    resumeStream,
  } = useChat({
    transport,
    sendAutomaticallyWhen: (options) =>
      userTurn.current &&
      !halted.current &&
      count.current < 24 &&
      lastAssistantMessageIsCompleteWithToolCalls(options),
    onToolCall({ toolCall }) {
      // Replayed calls are not executed as they stream; adoption runs only the parked ones.
      if (readOnly || !userTurn.current || resuming.current) return;
      runTool(toolCall);
    },
    onData(part) {
      if (part.type === "data-turn") turnEnd.current = part.data as TurnEnd;
    },
    onFinish({ message, isAbort }) {
      const end = turnEnd.current;
      const wasResume = resuming.current;
      turnEnd.current = null;
      resuming.current = false;
      lastEnd.current = end;
      // Let the SDK finish this request before acting on how it ended.
      setTimeout(() => settle(end, message, isAbort, wasResume), 0);
    },
  });

  function runTool(toolCall: ToolCall, afterReload = false, turnEditing = false) {
    dispatched.current.add(toolCall.toolCallId);
    const addToolOutput = (args: Parameters<typeof chatAddToolOutput>[0]) => {
      if ("output" in args) results.current.set(args.toolCallId, args.output);
      return chatAddToolOutput(args);
    };
    setPending((n) => n + 1);
    const work = tail.current.then(async () => {
      try {
        if (!active.current) return;
        if (afterReload && UNSAFE_AFTER_RELOAD.has(toolCall.toolName)) {
          await addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: { error: INTERRUPTED } });
          return;
        }
        // A restored editor may still be starting; tools need it rather than published content.
        await waitForEditor(afterReload && turnEditing ? 15000 : 0);
        if (disabled) throw new Error("The editor is closing.");
        if (halted.current) throw new Error("Tool execution is paused.");
        if (++count.current > 24)
          throw new Error(
            "Tool limit reached. Send another message to continue.",
          );
        if (toolCall.toolName === "request_editing") {
          let accepted = !!currentEditor.current || starting.current;
          if (!accepted) accepted = await new Promise<boolean>(resolve => setConsent({ reason: String((toolCall.input as { reason?: string })?.reason || "Enter editing mode to make these changes?"), resolve }));
          setConsent(null);
          if (!active.current) return;
          if (accepted && !currentEditor.current) await onEnterEditing();
          await addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: { editing: accepted, user_declined: !accepted } });
          return;
        }
        const editor = currentEditor.current;
        if (!editor) {
          if (toolCall.toolName !== "read_notebook") throw new Error("Ask permission with request_editing before editing or running cells.");
          const response = await fetch(`/api/notebooks/${notebookId}/download`);
          if (!response.ok) throw new Error("Could not read the published notebook.");
          const notebook = await response.json();
          const text = (value: unknown) => Array.isArray(value) ? value.join("") : String(value ?? "");
          const cells = notebook.cells.map((cell: { id?: string; cell_type: string; source: unknown; outputs?: { text?: unknown; data?: Record<string, unknown>; evalue?: string }[] }, index: number) => ({
            id: cell.id || `published-${index}`, cell_type: cell.cell_type, source: text(cell.source),
            outputs: (cell.outputs || []).slice(-10).map(output => ({ text: text(output.text ?? output.data?.["text/plain"]).slice(-8000), error: output.evalue, has_image: !!output.data?.["image/png"] })),
          }));
          if (JSON.stringify(cells).length > 150000) throw new Error("Notebook is too large for chat (150 KB text limit).");
          await addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: { version: "published", cells } });
          return;
        }
        if (toolCall.toolName === "rename_notebook") {
          const args = toolCall.input as { title?: unknown };
          const response = await fetch(`/api/notebooks/${notebookId}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: editor.token, title: args?.title }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Could not rename notebook.");
          onRename(result.id, result.title);
          failures.current = 0;
          if (active.current) await addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: result });
          return;
        }
        const target = getFrame()?.contentWindow;
        if (!target) throw new Error("Editor is unavailable.");
        const origin = new URL(editor.url).origin;
        const request = (type: string, timeout: number) => {
          const id = crypto.randomUUID();
          return new Promise<unknown>((resolve, reject) => {
            const timer = window.setTimeout(() => {
              cleanup();
              reject(
                new Error(
                  type === "vercel-notebook-capabilities"
                    ? "This editor is running an older or unresponsive bridge. The editor may be recovering; wait briefly and retry."
                    : "Jupyter timed out. A running cell may still be executing; inspect it before retrying.",
                ),
              );
            }, timeout);
            function cleanup() {
              clearTimeout(timer);
              window.removeEventListener("message", receive);
            }
            function receive(event: MessageEvent) {
              if (
                event.source !== target ||
                event.origin !== origin ||
                event.data?.id !== id ||
                event.data.type !== "vercel-notebook-tool-result"
              )
                return;
              cleanup();
              if (event.data.error) reject(new Error(event.data.error));
              else resolve(event.data.result);
            }
            window.addEventListener("message", receive);
            target.postMessage(
              {
                type,
                token: editor.token,
                id,
                tool: toolCall.toolName,
                args: toolCall.input,
              },
              origin,
            );
          });
        };
        if (!compatible.current) {
          try {
            let capabilities = await request("vercel-notebook-capabilities", 5000) as { protocol?: number; ready?: boolean };
            const deadline = Date.now() + 60000;
            while (capabilities.ready === false && active.current && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 250));
              capabilities = await request("vercel-notebook-capabilities", 5000) as { protocol?: number; ready?: boolean };
            }
            if (capabilities.ready === false) throw new Error("The notebook is still loading. Please retry shortly.");
            if (capabilities.protocol !== 2) throw new Error("The editor needs updated notebook tools. Automatic recovery will retry.");
            compatible.current = true;
          } catch (error) {
            halted.current = true;
            throw error;
          }
        }
        const output = await request("vercel-notebook-tool", 120000);
        if (output && typeof output === "object" && "error" in output) {
          failures.current++;
          if (failures.current >= 3) {
            halted.current = true;
            setToolError("Paused after repeated tool failures. Review the errors before continuing.");
          }
        } else failures.current = 0;
        if (active.current)
          await addToolOutput({
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            output,
          });
      } catch (error) {
        if (++failures.current >= 3) halted.current = true;
        if (halted.current && active.current)
          setToolError(previous => previous || (error instanceof Error ? error.message : "Notebook tools failed. The editor will recover if its runtime is unavailable."));
        if (active.current)
          await addToolOutput({
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            output: {
              error: error instanceof Error ? error.message : "Tool failed",
            },
          });
      } finally {
        if (active.current) setPending((n) => n - 1);
      }
    });
    tail.current = work.catch(() => {});
  }
  const busy = status === "submitted" || status === "streaming" || pending > 0;
  const history = useNotebookHistory(notebookId, null, messages, setMessages, busy, readOnly);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const stopServerTurn = () => {
    if (!readOnly) void fetch(`/api/notebooks/${notebookId}/chat/stop`, { method: "POST" }).catch(() => {});
  };

  // One tab per browser executes a turn's tools; other tabs only watch the replay.
  function claimTurn(): Promise<boolean> {
    if (claim.current) return claim.current;
    if (!navigator.locks) return Promise.resolve(true);
    const request = new Promise<boolean>(resolve => {
      navigator.locks.request(`notebook-chat-turn:${notebookId}`, { ifAvailable: true }, lock => {
        if (!lock) { resolve(false); return; }
        resolve(true);
        return new Promise<void>(release => { lockRelease.current = release; });
      }).catch(() => resolve(true));
    });
    claim.current = request;
    void request.then(held => { if (!held && claim.current === request) claim.current = null; });
    return request;
  }
  function releaseTurn() {
    lockRelease.current?.();
    lockRelease.current = null;
    claim.current = null;
  }

  async function waitForEditor(graceMs: number) {
    const deadline = Date.now() + 120000;
    const graceEnd = Date.now() + graceMs;
    while (active.current && !currentEditor.current && (starting.current || Date.now() < graceEnd) && Date.now() < deadline)
      await sleep(250);
  }

  // The server is authoritative: true for a live turn, false when none is running (stale), and
  // null when it cannot be reached.
  async function turnState(): Promise<boolean | null> {
    try {
      const response = await fetch(`/api/notebooks/${notebookId}/chat/state`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return response.status >= 500 ? null : false;
      return !!(await response.json()).active;
    } catch {
      return null;
    }
  }

  // No turn is running: release it locally so unfinished tool cards do not look in progress.
  function stale() {
    releaseTurn();
    setMessages(current => {
      const last = current.at(-1);
      if (last?.role !== "assistant") return current;
      const marked = markInterrupted(last);
      return JSON.stringify(marked) === JSON.stringify(last) ? current : [...current.slice(0, -1), marked];
    });
  }

  function settle(end: TurnEnd | null, message: UIMessage, isAbort: boolean, wasResume: boolean) {
    if (!active.current || readOnly) return;
    if (end?.state === "parked") {
      // Live responses already dispatched their calls; a replay hands them to this tab.
      if (wasResume) void adopt(end, message);
      return;
    }
    if (end) releaseTurn();
    else if (!isAbort && !abandoned.current && !recovering.current && (wasResume || userTurn.current)) void recover(false);
  }

  // Take over a replayed turn that waits for browser tools, running only its parked calls.
  async function adopt(end: TurnEnd, message: UIMessage) {
    if (!(await claimTurn()) || !active.current) return;
    const parts = message.parts.filter(isToolUIPart);
    userTurn.current = true;
    halted.current = false;
    failures.current = 0;
    setToolError("");
    count.current = parts.filter(part => part.state.startsWith("output-")).length;
    for (const id of end.toolCallIds ?? []) {
      const part = parts.find(item => item.toolCallId === id);
      if (!part || part.state.startsWith("output-")) continue;
      if (results.current.has(id)) {
        void chatAddToolOutput({ tool: getToolName(part), toolCallId: id, output: results.current.get(id) });
        continue;
      }
      // Still running in this page; it reports its result when done.
      if (dispatched.current.has(id)) continue;
      runTool({ toolName: getToolName(part), toolCallId: id, input: part.input }, true, !!end.editing);
    }
  }

  // Reattach to the server turn after a reload (initial) or a dropped stream, with backoff.
  async function recover(initial: boolean) {
    recovering.current = true;
    abandoned.current = false;
    setAttach(initial ? "checking" : "reconnecting");
    setConnectionError("");
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await sleep(1000 * 2 ** (attempt - 1));
        if (!active.current || abandoned.current) return;
        const live = await turnState();
        if (!active.current || abandoned.current) return;
        if (live === false) { stale(); return; }
        if (live === null) continue;
        setAttach("reconnecting");
        clearError();
        resuming.current = true;
        lastEnd.current = null;
        await resumeStream();
        // A 204 (turn just ended) finishes without a response; the next check reports it stale.
        resuming.current = false;
        if (lastEnd.current) return;
      }
      if (active.current && !abandoned.current)
        setConnectionError("Lost connection to the assistant. The reply may still be running; reload to reconnect.");
    } finally {
      recovering.current = false;
      if (active.current) setAttach(null);
    }
  }

  const resumed = useRef(false);
  useEffect(() => {
    // After a reload or remount, ask the server whether a turn is live and replay it.
    if (readOnly || resumed.current) return;
    if (history.error && !history.loaded) { setAttach(null); return; }
    if (!history.loaded) return;
    resumed.current = true;
    void recover(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, history.loaded, history.error]);
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || initialPromptSent.current || !editor || editorStarting || readOnly || busy || attach || disabled || !history.loaded || history.blocking || history.error) return;
    initialPromptSent.current = true;
    userTurn.current = true;
    count.current = 0;
    halted.current = false;
    failures.current = 0;
    setToolError("");
    onInitialPromptSent(notebookId);
    lastEnd.current = null;
    abandoned.current = false;
    void claimTurn();
    void sendMessage({ text: initialPrompt });
  }, [initialPrompt, editor, editorStarting, readOnly, busy, attach, disabled, history.loaded, history.blocking, history.error, notebookId, onInitialPromptSent, sendMessage]);
  const wasBusy = useRef(false);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended) return;
    onTurnFinished(notebookId);
    // Only a turn parked on this tab's tools needs releasing (halted or out of tool budget).
    // Finished turns already ended, and a dropped stream reconnects instead. The grace period
    // covers the gap before an automatic continuation.
    if (readOnly || !userTurn.current || lastEnd.current?.state !== "parked") return;
    const timer = setTimeout(() => {
      if (busyRef.current || recovering.current) return;
      stopServerTurn();
      releaseTurn();
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, notebookId, onTurnFinished, readOnly]);
  const reconnecting = attach === "reconnecting";
  useEffect(() => {
    onBusy(notebookId, busy || !!attach || history.persistenceBlocking, (busy || reconnecting) && !consent);
  }, [busy, attach, reconnecting, consent, history.persistenceBlocking, notebookId, onBusy]);
  useEffect(() => {
    if (!busy && !history.persistenceBlocking) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [busy, history.persistenceBlocking]);
  useEffect(() => { compatible.current = false; }, [editor?.token]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      consentRef.current?.resolve(false);
      void stop();
      releaseTurn();
      onBusy(notebookId, false, false);
    };
  }, [stop, notebookId, onBusy]);
  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, pending, open]);
  return (
    <aside className="chat-panel" hidden={!open} aria-label="Notebook chat">
      <header className="surface-toolbar">
        <span><span className="green-dot" />CHAT</span>
        <span className="chat-header-actions">
        {!readOnly && <button
          className="icon-button new-chat-button"
          aria-label="New chat"
          title="New chat"
          disabled={busy || !!attach || history.blocking || !history.loaded || history.reloadRequired}
          onClick={() => {
            userTurn.current = false;
            releaseTurn();
            history.clearError();
            setMessages([]);
            clearError();
            count.current = 0;
          }}
        >
          <RotateCcw size={14} /><span>New chat</span>
        </button>}
        <button
          className="icon-button"
          aria-label="Close chat"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        </span>
      </header>
      {model && <div className="chat-model" title={model}>Model: {model.replace(/^gateway:/, "")}</div>}
      <div className="chat-messages" aria-live="polite">
        {initialPrompt && <p className="chat-hint" role="status">Your initial prompt will be sent when the editor is ready: {initialPrompt}</p>}
        {history.loading && <p className="chat-hint chat-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />Loading conversation…</p>}
        {history.saving && <p className="chat-hint">Saving conversation…</p>}
        {history.error && <div role="alert" className="chat-error">
          <p>{history.loaded ? "Chat history is not saved. " : ""}{history.error}</p>
          <button className="button" onClick={() => { if (history.reloadRequired || !history.loaded) userTurn.current = false; history.retry(); }}>{history.reloadRequired ? "Reload saved chat" : "Retry"}</button>
        </div>}
        {history.loaded && !messages.length && (
          <p className="chat-hint">
            {readOnly ? "No conversation yet." : editor ? "Ask me to fix a bug, explain a cell, or plot a chart. Changes save and publish automatically." : "Ask about this notebook. I can read its published cells and outputs without starting an editor."}
          </p>
        )}
        {messages.map((message) => (
          <div className={`chat-message ${message.role}`} key={message.id}>
            <small>{message.role === "user" ? username : "Assistant"}</small>
            {message.parts.map((part, index) =>
              part.type === "text" ? (
                <Markdown remarkPlugins={[remarkGfm]} components={{ table: ({ children }) => <div className="chat-table"><table>{children}</table></div> }} key={index}>{part.text}</Markdown>
              ) : part.type === "reasoning" ? (
                <details className="chat-reasoning" key={index} open={part.state === "streaming"}>
                  <summary>{part.state === "streaming" ? "Thinking…" : "Thoughts"}</summary>
                  <Markdown remarkPlugins={[remarkGfm]} components={{ table: ({ children }) => <div className="chat-table"><table>{children}</table></div> }}>{part.text}</Markdown>
                </details>
              ) : part.type.startsWith("tool-") ||
                part.type === "dynamic-tool" ? (
                <ToolActivity
                  key={index}
                  name={"toolName" in part ? String(part.toolName) : part.type.slice(5)}
                  state={"state" in part ? String(part.state) : ""}
                  input={"input" in part ? part.input : undefined}
                  output={"output" in part ? part.output : undefined}
                  errorText={"errorText" in part && typeof part.errorText === "string" ? part.errorText : undefined}
                />
              ) : null,
            )}
          </div>
        ))}
        {consent && <div className="chat-consent" role="group" aria-label="Enter editing mode?">
          <p>{consent.reason}</p><p>Enter editing mode?</p>
          <button className="button primary" onClick={() => { consent.resolve(true); setConsent(null); }}>Yes</button>{" "}
          <button className="button" onClick={() => { consent.resolve(false); setConsent(null); }}>No</button>
        </div>}
        {(busy || reconnecting) && !consent && (
          <p className="chat-hint chat-status" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
            {pending ? (editor ? "Working on notebook…" : "Reading notebook…") : busy ? "Thinking…" : "Reconnecting to the assistant…"}
          </p>
        )}
        {count.current >= 24 && !busy && !attach && (
          <p className="chat-hint">
            Tool limit reached. Send another message to continue.
          </p>
        )}
        {toolError && <p role="alert" className="chat-error">{toolError}</p>}
        {connectionError && <p role="alert" className="chat-error">{connectionError}</p>}
        {error && (
          <p role="alert" className="chat-error">
            {error.message}
          </p>
        )}
        <div ref={bottom} />
      </div>
      {readOnly ? <div className="chat-readonly">Read-only conversation · Fork this notebook to start your own.</div> : <form
        onSubmit={(event) => {
          event.preventDefault();
          if (readOnly || !input.trim() || busy || attach || disabled || history.blocking || !history.loaded || !!history.error) return;
          userTurn.current = true;
          count.current = 0;
          halted.current = false;
          failures.current = 0;
          setToolError("");
          setConnectionError("");
          lastEnd.current = null;
          abandoned.current = false;
          void claimTurn();
          void sendMessage({ text: input });
          setInput("");
        }}
      >
        <textarea
          aria-label="Message"
          placeholder="Ask about this notebook…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!event.repeat) event.currentTarget.form?.requestSubmit();
            }
          }}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          disabled={busy || !!attach || disabled || history.blocking || !history.loaded || !!history.error}
          rows={3}
        />
        <div>
          {!busy && !reconnecting && <kbd className="chat-send-shortcut" title="Cmd+Enter or Ctrl+Enter to send">⌘ Enter</kbd>}
          {busy || reconnecting ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                halted.current = true;
                abandoned.current = true;
                consentRef.current?.resolve(false);
                setConsent(null);
                void stop();
                stopServerTurn();
                releaseTurn();
              }}
            >
              <Square size={14} />
              Stop reply
            </button>
          ) : (
            <button
              className="button primary"
              disabled={!input.trim() || !!attach || disabled || history.blocking || !history.loaded || !!history.error}
            >
              <Send size={14} />
              Send
            </button>
          )}
        </div>
        {pending > 0 && (
          <small>
            A started cell keeps running even if you stop the reply.
          </small>
        )}
      </form>}
    </aside>
  );
}
