# Notebook editing

A notebook's durable document lives in Postgres. JupyterLab provides temporary execution and editing in a Sandbox, coordinated by the app's save bridge and database lease.

## Provisioning

[[backend/main.py#provision_editor]] reuses a reachable editor or creates a replacement from the durable draft. Expired routes and capabilities are recovered from the saved draft; genuine transient provider failures preserve the existing session instead of silently replacing it.

[[backend/editor.py#start]] connects notebooks to one VM and Jupyter server per user within an app origin. [[backend/runtime_registry.py#runtime_lease]] serializes creation across serverless requests through a database lease. Concurrent opens reuse the same runtime; each editing session gets a unique document path and bridge token, and each notebook has its own Python kernel. Only that user’s kernels share installed packages and a writable filesystem. Other users receive different VMs, capability URLs, writable drives, and database runtime leases. The prepared dependency drive remains read-only and shared.

The runtime mounts its user’s writable workspace drive at `/vercel` and the dependency drive read-only at `/notebook-base`. A new VM starts with a 15-minute execution limit. Active editor heartbeats renew a roughly 10–15 minute remaining lifetime, without adding time independently for every tab. It does not run forever: platform session limits still apply. After expiry a new VM attaches the durable workspace and starts Jupyter again; kernel memory is lost.

Editor Sandboxes use `persistent=False`, so stop does not snapshot them. Postgres remains authoritative for notebook documents. Opening writes a fresh session-specific file under the notebook's directory; stale tabs cannot overwrite a replacement session's file. Every account receives its own writable workspace drive; no legacy drives or runtimes are imported.

Users and the assistant can run `%pip install numpy matplotlib` in a code cell to install packages into the active kernel environment. The assistant prompt recommends this notebook-native syntax.

The dependency drive already includes Python 3.13, pip, pinned JupyterLab, NumPy, pandas, SciPy, Matplotlib, Seaborn, and prepared fonts. There is no interactive dependency installation. After configuration, the backend starts Jupyter and polls its public route for up to 45 seconds before declaring failure.

Files in [backend/assets](https://github.com/vercel-labs/notebook-factory/tree/main/backend/assets) supply focused editor CSS, the message bridge, a SQLite compatibility shim, a launcher, and a template patch. These were adapted from `/Users/yury/dev/vercel/vercel-py`, branch `nb_next`, commit `8296336`; the upstream license is retained in [backend/assets/LICENSE](../backend/assets/LICENSE).

[[backend/assets/patch_jupyter_template.py]] patches the installed Jupyter application HTML while preserving its bundle references. [[backend/assets/jupyter_launcher.py]] derives root, settings, and template paths from its own location instead of assuming `/vercel/sandbox` is the workspace.

## Editor isolation

[[backend/editor.py#start]] protects Jupyter routes with a random 256-bit capability path. The editor URL is returned only to the authorized owner and stored with the notebook's session record.

Jupyter's own token/password authentication and XSRF checks are disabled for this capability-based integration. Anyone holding the editor URL can use that running environment. The URL must not be included in public notebook responses or documentation.

The Jupyter response restricts framing to the configured app origin. [[backend/assets/jupyter_bridge.js]] separately checks parent window, origin, request ID, and capability token before accepting save messages. This avoids relying on third-party cookies for the embedded editor.

## Live setup progress

[[backend/main.py#open_editor]] supports a streamed POST response when Accept includes `text/event-stream`. [[frontend/src/main.tsx#startEditor]] consumes the stream with fetch, including messages split across network chunks.

Each event is a JSON object inside an SSE `data:` frame:

| Type | Payload and behavior |
| --- | --- |
| `progress` | `message` names the current provisioning stage |
| `log` | `message` contains incremental installer output |
| `ready` | `editor` contains the session name, URL, and token; ends setup |
| `error` | `message` explains failure; ends setup |

The server sends heartbeat comments every ten seconds while waiting and disables proxy buffering with `X-Accel-Buffering: no`. Authentication and missing-notebook errors happen before streaming; subsequent errors use the event contract.

Prepared environments report restore, configuration, Jupyter startup, and readiness stages instead of installation logs. The browser shows elapsed seconds and retains errors for inspection. The log event remains supported; its browser buffer is bounded to 20,000 characters and long lines wrap within the notebook surface's margins.

The notebook title bar shows the latest startup milestone and elapsed seconds. Clicking the status opens a closable panel directly below the header with the latest five visible log lines and scrolling. Logs include timestamped milestones for VM creation, Jupyter readiness, notebook file preparation, browser loading, and observed kernel startup/connection; they remain available after readiness.

Startup stage, bounded logs, and the original start timestamp are tracked per notebook, including progress received while hidden. Navigation restores that notebook’s current progress without resetting its elapsed timer.

The stream owns the provisioning task and cancels it on disconnect. Provisioning and lease cleanup have cancellation handling. Ordinary callers without the streaming Accept header retain the JSON endpoint behavior.

## Saving and publication

[[frontend/src/main.tsx]] exports the live browser document through the authenticated bridge before calling the backend. Export does not depend on a running Sandbox or completion of Jupyter save dialogs.

A bridge response must arrive within 20 seconds. Every 30 seconds, the frontend saves the live document; overlapping triggers queue a fresh export. The backend validates the exported notebook and commits it to Postgres. Save and close require an exported document; calls without one are rejected rather than reading a stale Sandbox file.

[[backend/editor.py#check_available]] probes runtime availability without reading notebook files. App autosaves refresh the shared runtime idle horizon in the background. [[backend/main.py#save_draft]] stores the document and outputs; it never executes cells.

Autosaves request publication while keeping the editor open. The backend persists source first, compares parsed notebook content with the published version, and only renders/uploads changed content. A changed publication atomically updates source, fallback HTML, Blob URL, revision, and timestamp. The browser updates its metadata cache immediately. After an actual changed save, the active notebook header briefly shows a blue Saved pill: a 300ms fade in, three seconds visible, then a 300ms fade out. Unchanged autosaves and opening a notebook do not show it; navigation clears it. Reduced-motion preferences disable fading. Render/upload failure leaves the document saved and the prior publication intact; the next autosave retries. Conditional writes reject publication if source or revision changed during rendering.

## Closing and recovery

Notebook navigation saves and publishes changes while keeping its editor running in the background. Quit editor in the notebook header publishes the current browser document before closing only that notebook’s session.

Quit editor is disabled during agent work and other mutations. Failed export or persistence keeps the iframe mounted for retry; success returns to the published view while other notebooks keep running. The discard API remains available for legacy clients.

[[backend/main.py#close]] saves the exported draft and clears the current editor record in a single conditional database update before returning success. [[backend/main.py#stop_closed_editor]] retires only the detached Jupyter session and its document as a response background task. The VM and other kernels stay running.

App autosaves export the full in-memory Jupyter model, including outputs, without invoking its server save or waiting on dialogs. The authenticated save endpoint validates the document and active session before persisting it. The iframe remains mounted until persistence succeeds. Sandbox keepalive is best effort after draft persistence and is skipped on close.

Automatic recovery first persists the browser document and detaches the old session, then opens a fresh document session from the durable draft, reusing the shared runtime when healthy. A dead Sandbox does not prevent recovery while the loaded browser model and current session token remain available. Already-open editors running an older bridge cannot export this way; do not reload them expecting to recover unsaved changes.

Background shutdown errors are logged; the Sandbox execution limit bounds its remaining lifetime. This background task is not a durable job queue. Reopening before expiry reuses the running Jupyter server and starts a new kernel for the stored document.

Notebook documents and their saved outputs persist in Postgres. Uploaded side files and extra installed dependencies persist on the shared workspace drive; kernel memory does not. Navigation preserves edits, packages, and side files. Closing the browser stops app autosaves/heartbeats, so changes since the last successful durable save can be lost. A before-unload warning is advisory, not persistence.

## Editing mode across reloads

A reload reopens the editor a tab was using, so editing mode stays on. The server stays authoritative: it reuses the live session or recovers an expired one from the durable draft.

When an editor becomes ready, [[frontend/src/main.tsx#rememberEditing]] records its notebook under [[frontend/src/main.tsx#EDITING_KEY]] in sessionStorage. The flag survives reloads but not new tabs, so other tabs never start a Sandbox. Quit editor, deletion, and a 409 editor-status response (session replaced elsewhere) clear it.

After a reload, an owner viewing a flagged notebook calls the normal open path once. [[backend/main.py#provision_editor]] returns the reachable same-generation session without a new Sandbox, or provisions one with the usual setup progress. A held editor lease is retried a few times with backoff; any other failure clears the flag and shows the setup error. Other flagged notebooks restore when visited. Edits made after the last autosave may still be lost, because the before-unload warning is advisory.

## Save serialization

Jupyter disk autosave is disabled and its toolbar Save button is hidden; application autosave remains active.

The bridge still serializes explicit Jupyter toolbar and legacy parent saves: each disk write and metadata refresh finishes before another starts. Application persistence exports memory and bypasses this queue.

JupyterLab 4.4.10 can otherwise overlap these operations: a second save reads a new disk hash before the first save updates the context hash, producing a false File Changed dialog. This was reproduced with one page and no external writer in a disposable Sandbox.

The queue preserves errors for the requesting caller and continues after a rejected save. It does not disable Jupyter's conflict checks or automatically overwrite external changes. The bridge is installed during Sandbox startup, so existing editors need to leave editing and reopen to receive it. Navigation and periodic autosaves export the live document and publish changed content automatically.

## Upstream integration comparison

The reference is `vercel-py` branch `nb_next`, commit `8296336`, under `src/vercel-notebook/vercel/_notebook`. Its Jupyter assets informed this integration, but its persistence and publication models differ.

The focused CSS, shell panel hiding, resize/refit scheduling, HTML template injection, and SQLite compatibility shim are carried over. Notebook Factory uses a light theme, pins JupyterLab in a virtual environment, and resolves launcher paths relative to the uploaded script.

The reference bridge synthesizes Cmd/Ctrl+S and polls the dirty-tab CSS marker for completion. It has no save serialization or conflict-check override. Notebook Factory instead awaits the document save API, queues saves, and verifies the parent origin as well as the window and token.

The reference requests a named persistent Sandbox with snapshot retention and only uploads the notebook when creating it. It checks for an existing Jupyter process, streams startup process output, and detects early process exit while polling readiness. Notebook Factory uses temporary non-persistent Sandboxes with durable workspace drives and restores documents from database drafts; Jupyter logs are retained for startup diagnostics.

Reference publishing verifies hashes of prepared notebook/HTML files and creates a Vercel deployment. Notebook Factory publishes by copying the durable draft to the database's public document. The reference's wildcard origin/frame allowances, hardcoded workspace paths, and keyboard-driven save bridge are not used here.

## Deployment generations

Editor environments belong to the deployment that created them. Opening or reconnecting after a deployment replaces an older environment instead of reusing its embedded Jupyter bridge.

[[backend/editor.py#generation]] uses Vercel's deployment ID (deployment URL fallback); local development hashes bundled editor assets, provisioning code, and Python dependency declarations. Legacy sessions without a generation are stale. This policy governs live editor reuse. The shared dependency drive contains no notebook, bridge, app origin, or editor token, so it can be reused while each deployment injects fresh app assets.

[[backend/main.py#provision_editor]] checks runtime availability without reading its notebook file. A replacement always receives the Postgres draft, because manual disk saves can lag behind browser edits. Automatic recovery exports the current browser document first. Opening from another tab can recover only the last acknowledged database draft; it cannot recover unexported edits from a different browser.

The next open on a new deployment replaces the shared runtime, interrupting kernels still using the previous generation. Their browser documents remain exportable for recovery. Regression coverage verifies same-deployment reuse, failed replacement, preservation of a database draft that differs from the Sandbox file, and stale-token rejection.

## Plot font fallback

New Sandboxes install Noto Emoji and Noto Sans JP alongside Matplotlib's default DejaVu Sans fallback, covering emoji and Japanese chart labels without hiding missing-glyph warnings.

[[scripts/prepare_fonts.py#prepare]] builds static regular and bold faces once from pinned, checksum-verified Google Fonts sources, retains OFL licenses, and publishes an immutable ZIP to Blob. The committed [font manifest](../backend/assets/fonts.json) pins its URL and SHA-256 digest.

[[backend/assets/install_fonts.py#install]] downloads, verifies, and unpacks that bundle during dependency drive preparation before configuring Matplotlib. Interactive Sandboxes inherit installed fonts and do not download or convert them. Setup logs report download/install duration. Existing environments require reconnecting after deployment; existing plot outputs must be rerun.

## Font bundle verification

Installer tests cover verified extraction, removal of legacy variable faces, Matplotlib configuration, corrupt downloads, and unexpected archive paths. Untrusted or incomplete bundles fail before installing fonts.

Live Sandbox checks render normal and bold emoji/Japanese labels, rejecting both missing-glyph and font-weight lookup warnings.

## Prepared dependency environment

[[backend/sandbox_environment.py]] defines a versioned dependency drive, built and verified by [[scripts/prepare_sandbox.py#prepare]] before deployment. The committed manifest pins the drive name and region.

The builder installs Python, locked dependencies, and fonts once in a clean Sandbox, then copies the runtime directories to the dependency drive, excluding uv's installation cache. It stops gracefully to flush the drive before a separate read-only mount verifies a seeded environment. The manifest is written only after verification. Previous dependency drives remain available for deployments that reference them.

[[backend/assets/initialize_workspace.py]] seeds the shared workspace drive on first use or when the dependency fingerprint changes. Subsequent opens skip the copy and preserve additional pip packages. A dependency change replaces managed environment directories but preserves other user files. Every open writes a unique document from Postgres. Runtime creation injects current editor assets and a fresh server capability.

[[backend/editor.py#workspace_drive_name]] identifies the shared drive from the app origin. Runtime replacement gracefully stops the old non-persistent VM to flush and detach its drive before destroying its metadata. Closing a notebook only shuts down its matching Jupyter kernel and deletes its temporary document. [[backend/editor.py#delete_workspace]] removes that notebook's directory without removing the shared drive; deletion while offline is recorded in the runtime registry and applied on next startup. Legacy per-notebook drives are deleted only when their notebook is deleted.

## Prepared environment tests

Regressions verify private writable and shared read-only drives, fresh notebook assets, non-persistent sessions, and dependency fingerprint invalidation. Shutdown must flush the drive before destroying the Sandbox.

Live checks additionally verify Drive seeding, kernel execution, preserved files and installed modules across stop/reopen, authoritative notebook replacement, and startup timing.


## Browser recovery tests

The bridge exports complete unsaved cells and outputs without awaiting Jupyter readiness or server saves, and rejects untrusted origins and tokens.

## Expired Sandbox persistence tests

An owner can save and publish a browser document after Sandbox failure. Invalid documents and stale tokens are rejected; explicit private API saves remain private and cleanup or keepalive failure cannot undo persistence.


## Template discovery tests

The template patcher locates the top-level JupyterLab package without executing its initializer, avoiding a heavyweight import during editor setup.

[[backend/assets/patch_jupyter_template.py]] uses importlib spec discovery to find the static HTML template. The regression supplies a package whose initializer raises and verifies CSS and bridge injection succeed without importing it.

## Shared runtime tests

Concurrent notebook opens create one VM with distinct document paths and tokens. Tests verify closing one kernel leaves others alone, heartbeats do not multiply the idle timeout, and offline deletions survive until startup.

A disposable live Sandbox check opens two browser tabs, verifies separate kernel variables, closes one kernel while executing in the other, measures warm reopen, and restores a file after replacing the VM.

## Shared document bridge tests

The bridge locates a nested session-specific notebook path and authenticates the per-editor token, rejecting the server capability as a bridge token.

## Close autosave race tests

Close and discard must finish while an older autosave is still in flight. A conditional write rejects the late save after the editing session has been atomically invalidated, preserving the final document or discarded state.

Legacy close/discard API calls can race with autosaves. [[backend/main.py#save_draft]] conditions its database write on the same active editor record. Close stores the final document and clears that record together. App autosaves do not acquire the editor-operation lease, so they cannot block close. Metadata refresh after publication runs without holding the editor open.

API regressions cover close/discard races. Browser checks cover automatic save triggers and retained editors. Rendering and Blob upload still precede publication acknowledgement.

## Automatic recovery tests

The owner-only editor-status endpoint reports expiry without reading stale notebook files. A browser health check detects an expired runtime, exports the live document, saves it, and opens a replacement automatically.

[[backend/main.py#editor_status]] distinguishes expired runtimes from transient failures. [[frontend/src/main.tsx]] checks all ready editor sessions every 15 seconds, excluding sessions being closed. Only the selected expired editor automatically restarts; disconnected background editors lose their dot and wait for explicit reopening. Recovery never blindly reruns code; kernel variables are lost. Failure to export leaves the original browser document intact and reports an error rather than silently replacing unsaved work.

## Immediate navigation

Switching notebooks selects the destination immediately. It opens read-only unless this browser already has a connected editor for that notebook; returning to a live editor reuses its mounted iframe instantly.

[[frontend/src/main.tsx]] retains a pool of editor iframes keyed by session token. Hiding an editor, selecting another notebook, or visiting the logo's welcome screen does not reload its document or close its kernel. Multiple editors can remain open, sharing the Sandbox VM while retaining separate kernels. Navigation exports a background draft save without blocking selection or closing the session. All ready editors continue autosaving every 30 seconds, including hidden ones. Browser visibility/focus changes trigger saves, as does completion of an agent turn. A save requested during another save queues a fresh live export after that write rather than dropping the newer trigger.

The notebook title dot pulses green during startup/recovery, becomes solid green when its editor is ready and connected, and stays gray otherwise. Reduced-motion preferences disable the pulse. The sidebar shows a blinking green dot as soon as editor startup or recovery begins, including while another notebook is selected. It clears on failure and becomes a solid green dot when the editor is ready and its server and kernel connection are healthy. Health polling combines the backend status endpoint with the authenticated bridge's kernel connection status. Browser offline events clear dots immediately; health checks restore them on reconnection. An expired background editor is not restarted just because it exists. Clicking it displays the publication; Edit notebook explicitly recovers its retained browser document before opening a replacement.

Each editor opens a distinct named Jupyter workspace on the shared server. The bridge resolves the exact document from both plain and named-workspace routes, including Jupyter’s automatic redirects when another window already uses a workspace. This prevents second-editor readiness checks from looking for the wrong notebook. The iframe pool remains mounted even on the welcome screen. Automatic saves retain the notebook’s editor until Quit editor explicitly closes it. Tab close/reload loses browser state; durable drafts remain in Postgres, and an unload warning reminds the owner about open sessions. Chat sessions also stay mounted, so navigation remains available during assistant work and history saves. Active agents show three animated green dots instead of the connected-editor dot; tools keep targeting their original notebook.

[Browser flow regression](../frontend/tests/notebook_flows.cjs) verifies read-only navigation without startup, retained iframe state and load count across notebooks and the welcome screen, multiple live dots, dot removal after kernel disconnection, and selected-editor recovery. Run after the frontend build with Playwright installed, optionally setting PLAYWRIGHT_MODULE to its module path.

## Retained editor connection tests

The bridge reports document readiness separately from kernel connectivity. A loaded document without a connected kernel must not qualify for a green running-editor dot.

## Dark notebook styling

The editor starts with JupyterLab Dark and shared neutral surface overrides. Matplotlib defaults to dark figures and axes with light labels, ticks, and a contrasting series palette.

[[backend/assets/jupyter_launcher.py]] writes the bundled [Matplotlib configuration](../backend/assets/matplotlibrc) after dependency restoration and before launching Jupyter. This updates both new and cached workspaces without importing Matplotlib at startup or rebuilding the dependency drive. DejaVu Sans and Noto fallback fonts remain configured. Users can override plot styles explicitly; saved plot images need rerunning to change their appearance. The agent preserves dark defaults and uses Plotly's dark template when generating charts.

## Stale runtime recovery tests

A stable Sandbox name must not make an old notebook endpoint appear current after VM replacement. Obsolete editor routes and capabilities expire safely; real server failures stay transient.

Availability checks compare the notebook capability with the runtime registry and the current VM's public route before requesting Jupyter status. A mismatch returns expiry so provisioning can reopen the saved draft on the current shared runtime without destroying another notebook's kernel. Regression tests cover route changes, capability changes on the same host, warm reuse, and current-route server errors.

Startup errors live with their notebook's progress state. Switching notebooks during startup never displays that error on the newly selected notebook. Returning shows the failure and permits retry; retry clears the old error. Browser regression holds startup open, switches away, fails it, and verifies scoped error display and successful retry.
