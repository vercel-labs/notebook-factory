import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolActivity } from "./ToolActivity";
import { useNotebookHistory } from "./useNotebookHistory";
import { Send, Square, X, RotateCcw, LoaderCircle } from "lucide-react";

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
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/notebooks/${notebookId}/chat`,
        body: () => ({ token: currentEditor.current?.token ?? null }),
        // Durable turns keep running server-side; a remount reattaches to the active one.
        prepareReconnectToStreamRequest: () => ({ api: `/api/notebooks/${notebookId}/chat/stream` }),
      }),
    [notebookId],
  );
  const {
    messages,
    sendMessage,
    addToolOutput,
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
      if (readOnly || !userTurn.current) return;
      setPending((n) => n + 1);
      const work = tail.current.then(async () => {
        try {
          if (!active.current) return;
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
    },
  });
  const busy = status === "submitted" || status === "streaming" || pending > 0;
  const history = useNotebookHistory(notebookId, null, messages, setMessages, busy, readOnly);
  const resumed = useRef(false);
  useEffect(() => {
    // After a reload or remount, replay a turn still running on the server. Replayed tool calls
    // are not executed because no user turn is active in this session.
    if (readOnly || resumed.current || !history.loaded || history.error) return;
    resumed.current = true;
    void resumeStream();
  }, [readOnly, history.loaded, history.error, resumeStream]);
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || initialPromptSent.current || !editor || editorStarting || readOnly || busy || disabled || !history.loaded || history.blocking || history.error) return;
    initialPromptSent.current = true;
    userTurn.current = true;
    count.current = 0;
    halted.current = false;
    failures.current = 0;
    setToolError("");
    onInitialPromptSent(notebookId);
    void sendMessage({ text: initialPrompt });
  }, [initialPrompt, editor, editorStarting, readOnly, busy, disabled, history.loaded, history.blocking, history.error, notebookId, onInitialPromptSent, sendMessage]);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      onTurnFinished(notebookId);
      // A reply that ended here (finished, stopped, halted, or out of tool budget) will not send
      // more tool results, so release the server turn instead of leaving it parked.
      if (!readOnly) void fetch(`/api/notebooks/${notebookId}/chat/stop`, { method: "POST" }).catch(() => {});
    }
    wasBusy.current = busy;
  }, [busy, notebookId, onTurnFinished, readOnly]);
  useEffect(() => {
    onBusy(notebookId, busy || history.persistenceBlocking, busy && !consent);
  }, [busy, consent, history.persistenceBlocking, notebookId, onBusy]);
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
          disabled={busy || history.blocking || !history.loaded || history.reloadRequired}
          onClick={() => {
            userTurn.current = false;
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
        {busy && !consent && (
          <p className="chat-hint chat-status" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
            {pending ? (editor ? "Working on notebook…" : "Reading notebook…") : "Thinking…"}
          </p>
        )}
        {count.current >= 24 && !busy && (
          <p className="chat-hint">
            Tool limit reached. Send another message to continue.
          </p>
        )}
        {toolError && <p role="alert" className="chat-error">{toolError}</p>}
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
          if (readOnly || !input.trim() || busy || disabled || history.blocking || !history.loaded || !!history.error) return;
          userTurn.current = true;
          count.current = 0;
          halted.current = false;
          failures.current = 0;
          setToolError("");
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
          disabled={busy || disabled || history.blocking || !history.loaded || !!history.error}
          rows={3}
        />
        <div>
          {!busy && <kbd className="chat-send-shortcut" title="Cmd+Enter or Ctrl+Enter to send">⌘ Enter</kbd>}
          {busy ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                halted.current = true;
                consentRef.current?.resolve(false);
                setConsent(null);
                void stop();
              }}
            >
              <Square size={14} />
              Stop reply
            </button>
          ) : (
            <button
              className="button primary"
              disabled={!input.trim() || disabled || history.blocking || !history.loaded || !!history.error}
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
