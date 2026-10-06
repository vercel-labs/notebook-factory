import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager
from urllib.parse import urlsplit
from uuid import uuid4

import anyio
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select, update
from vercel.headers import HeadersContext
from vercel.oidc.token import get_vercel_oidc_token_from_context

import chat
import editor
import publication
import workspace_events
from auth import require_owner, require_owner_read, require_user
from auth import router as auth_router
from config import APP_URL
from db import engine, initialize, notebooks, timestamp, users
from render import CONTENT_POLICY, new_notebook, render, themed_html, validate

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app):
    try:
        await initialize()
        async with chat.local_workflow_queue():
            yield
    finally:
        await engine.dispose()


app = FastAPI(lifespan=lifespan)
app.include_router(auth_router)


@app.middleware("http")
async def headers(request, call_next):
    with HeadersContext(dict(request.headers)).use():
        # hack: websocket requests come without an oidc token. Store each HTTP request's token
        # in the SDK's process-wide cache so the queue relay started by a socket can use it.
        if workspace_events.queue_enabled() and "x-vercel-oidc-token" in request.headers:
            try:
                get_vercel_oidc_token_from_context()
            except Exception:
                log.warning("Could not cache the OIDC token", exc_info=True)
        response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


class CreateNotebook(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    prompt: str = Field(default="", max_length=10000)


class EditorRequest(BaseModel):
    token: str
    publish: bool = False
    source: str | None = Field(default=None, max_length=10 * 1024 * 1024)


class RenameNotebook(BaseModel):
    token: str = Field(max_length=256)
    title: str = Field(min_length=1, max_length=120)


async def get_notebook(id):
    async with engine.connect() as conn:
        row = (await conn.execute(select(notebooks).where(notebooks.c.id == id))).mappings().first()
    if row is None:
        raise HTTPException(404, "Notebook not found")
    return dict(row)


def public(row):
    return {
        key: row[key]
        for key in ("id", "owner_id", "title", "created_at", "updated_at", "revision", "render_url")
    }


@app.get("/api/search")
async def search_notebooks(q: str = Query(min_length=1, max_length=200)):
    from search import search_notebooks as search
    if not q.strip():
        return []
    async with engine.connect() as conn:
        return await search(conn, q.strip())


@app.get("/api/workspace")
async def workspace():
    return await workspace_events.snapshot()


def same_origin(websocket: WebSocket) -> bool:
    # The socket is public and cookie-free, so it only needs to come from a page served by
    # this host; that covers previews, branch aliases, and custom domains, not just APP_URL.
    origin = websocket.headers.get("origin")
    if not origin:
        return False
    if origin == APP_URL:
        return True
    host = websocket.headers.get("x-forwarded-host") or websocket.headers.get("host") or ""
    return urlsplit(origin).netloc == host.split(",")[0].strip()


@app.websocket("/api/workspace/live")
async def workspace_live(websocket: WebSocket):
    if not same_origin(websocket):
        await websocket.close(code=4403)
        return
    # HTTP middleware skips WebSockets. The upgrade carries no OIDC token, so the relay relies on
    # the token the HTTP middleware cached (see the hack in headers()).
    with HeadersContext(dict(websocket.headers)).use():
        await workspace_events.serve(websocket)


@app.get("/api/notebooks")
async def list_notebooks():
    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                select(
                    notebooks.c.id,
                    notebooks.c.owner_id,
                    notebooks.c.title,
                    notebooks.c.created_at,
                    notebooks.c.updated_at,
                    notebooks.c.revision,
                    notebooks.c.render_url,
                ).order_by(notebooks.c.updated_at.desc())
            )
        ).mappings()
        return [public(row) for row in rows]


@app.post("/api/notebooks", status_code=201)
async def create_notebook(body: CreateNotebook, owner=Depends(require_user)):
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Enter a notebook title")
    source = new_notebook(title, body.prompt)
    id = str(uuid4())
    html = await anyio.to_thread.run_sync(render, source)
    render_url = await publication.upload(id, html)
    row = dict(
        id=id,
        title=title,
        owner_id=owner["id"],
        source=source,
        published=source,
        published_html=html,
        render_url=render_url,
        created_at=timestamp(),
        updated_at=timestamp(),
        revision=1,
    )
    async with engine.begin() as conn:
        await conn.execute(notebooks.insert().values(**row))
    await workspace_events.notify()
    return public(row)


@app.get("/api/users")
async def list_users():
    async with engine.connect() as conn:
        rows = (await conn.execute(select(
            users.c.id, users.c.login, users.c.avatar_url,
        ).order_by(users.c.login))).mappings()
        return [dict(row) for row in rows]


@app.post("/api/notebooks/{id}/fork", status_code=201)
async def fork_notebook(id: str, owner=Depends(require_user)):
    original = await get_notebook(id)
    source = original["published"]
    fork_id = str(uuid4())
    html = await anyio.to_thread.run_sync(render, source)
    row = dict(
        id=fork_id, owner_id=owner["id"], title=f"fork of {original['title']}",
        source=source, published=source, published_html=html,
        render_url=await publication.upload(fork_id, html),
        created_at=timestamp(), updated_at=timestamp(), revision=1,
        chat_history=None, chat_revision=0, editor=None,
    )
    async with engine.begin() as conn:
        await conn.execute(notebooks.insert().values(**row))
    await workspace_events.notify()
    return public(row)


@app.get("/api/notebooks/{id}/render")
async def rendered(id: str):
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                select(
                    notebooks.c.published_html, notebooks.c.render_url, notebooks.c.revision
                ).where(notebooks.c.id == id)
            )
        ).first()
    if row is None:
        raise HTTPException(404, "Notebook not found")
    row = dict(row._mapping)
    html = row["published_html"]
    if html is None:
        # Legacy rows are rendered once. Never attach an old render to a newer publication.
        row = await get_notebook(id)
        html = await anyio.to_thread.run_sync(render, row["published"])
        async with engine.begin() as conn:
            await conn.execute(
                update(notebooks)
                .where(
                    notebooks.c.id == id,
                    notebooks.c.revision == row["revision"],
                    notebooks.c.published_html.is_(None),
                )
                .values(published_html=html)
            )
    if publication.enabled() and not row["render_url"]:
        url = await publication.upload(id, html)
        async with engine.begin() as conn:
            await conn.execute(
                update(notebooks)
                .where(
                    notebooks.c.id == id,
                    notebooks.c.revision == row["revision"],
                    notebooks.c.render_url.is_(None),
                )
                .values(render_url=url)
            )
        await workspace_events.notify()
    return HTMLResponse(
        themed_html(html),
        headers={"Content-Security-Policy": "sandbox allow-scripts; " + CONTENT_POLICY},
    )


@app.get("/api/notebooks/{id}/download")
async def download(id: str):
    row = await get_notebook(id)
    return Response(
        row["published"],
        media_type="application/x-ipynb+json",
        headers={"Content-Disposition": f'attachment; filename="{id}.ipynb"'},
    )


@asynccontextmanager
async def editor_lease(id):
    await get_notebook(id)
    # Atomic lease serializes mutations across Vercel function instances.
    claim = secrets.token_hex(16)
    async with engine.begin() as conn:
        result = await conn.execute(
            update(notebooks)
            .where(
                notebooks.c.id == id,
                or_(
                    notebooks.c.claim_until < timestamp(),
                    notebooks.c.claim_until.is_(None),
                ),
            )
            .values(claim=claim, claim_until=timestamp() + 300)
        )
        if result.rowcount != 1:
            raise HTTPException(409, "An editor operation is in progress; try again shortly")
    try:
        yield claim
    finally:
        with anyio.CancelScope(shield=True):
            async with engine.begin() as conn:
                await conn.execute(
                    update(notebooks)
                    .where(notebooks.c.id == id, notebooks.c.claim == claim)
                    .values(claim=None, claim_until=0)
                )


@app.post("/api/notebooks/{id}/editor", dependencies=[Depends(require_owner)])
async def open_editor(id: str, request: Request):
    if "text/event-stream" not in request.headers.get("accept", ""):
        async with editor_lease(id) as claim:
            return await provision_editor(id, claim)
    await get_notebook(id)

    async def stream():
        events = asyncio.Queue()

        def report(kind, message):
            events.put_nowait({"type": kind, "message": message})

        async def provision():
            try:
                report("progress", "Checking your saved environment…")
                async with editor_lease(id) as claim:
                    result = await provision_editor(id, claim, report)
                events.put_nowait({"type": "ready", "editor": result})
            except HTTPException as error:
                report("error", error.detail)
            except Exception:
                log.exception("Editor setup stream failed")
                report("error", "Could not start the editor. Please retry.")

        task = asyncio.create_task(provision())
        try:
            while True:
                try:
                    event = await asyncio.wait_for(events.get(), timeout=10)
                except TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                yield "data: " + json.dumps(event) + "\n\n"
                if event["type"] in {"ready", "error"}:
                    break
        finally:
            task.cancel()
            with anyio.CancelScope(shield=True):
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
    )


async def provision_editor(id, claim, report=None):
    created = None
    retired = None
    generation = editor.generation()
    try:
        row = await get_notebook(id)
        async with engine.connect() as conn:
            owner = dict((await conn.execute(select(users).where(users.c.id == row["owner_id"]))).mappings().one())
        if row["editor"]:
            old = json.loads(row["editor"])
            try:
                await editor.check_available(old)
                if old.get("generation") == generation and old.get("name") == editor.shared_runtime_name(owner):
                    return old
                if report:
                    report("progress", "Updating the environment for this deployment…")
                # Postgres is authoritative; the Sandbox file may never have been saved.
                retired = old
            except HTTPException as error:
                if error.status_code != 410:
                    raise
            except Exception:
                # Preserve the previous session on transient provider errors.
                raise HTTPException(502, "Could not reach the editor. Try again shortly.") from None
        if retired:
            await editor.stop(retired)
            retired = None
        created = (
            await editor.start(row["source"], report, notebook_id=id, owner=owner)
            if report
            else await editor.start(row["source"], notebook_id=id, owner=owner)
        )
        created = {**created, "generation": generation}
        async with engine.begin() as conn:
            result = await conn.execute(
                update(notebooks)
                .where(notebooks.c.id == id, notebooks.c.claim == claim)
                .values(editor=json.dumps(created))
            )
            if result.rowcount != 1:
                raise RuntimeError("Editor provisioning lease expired")
        if retired:
            await stop_closed_editor(retired)
        return created
    except HTTPException:
        raise
    except BaseException as error:
        log.exception("Could not start editor")
        if created:
            with anyio.CancelScope(shield=True):
                await editor.stop(created)
        if isinstance(error, asyncio.CancelledError):
            raise
        raise HTTPException(
            502, "Could not start Jupyter. Check Sandbox configuration and retry."
        ) from None


async def checked_editor(id, token):
    row = await get_notebook(id)
    current = json.loads(row["editor"]) if row["editor"] else None
    if not current or not secrets.compare_digest(current["token"], token):
        raise HTTPException(409, "This editor session is no longer active. Reopen the editor.")
    return row, current


@app.post("/api/notebooks/{id}/editor-status", dependencies=[Depends(require_owner)])
async def editor_status(id: str, body: EditorRequest):
    _, current = await checked_editor(id, body.token)
    await editor.check_available(current)
    return {"available": True}


@app.post("/api/notebooks/{id}/save", dependencies=[Depends(require_owner)])
async def save(id: str, body: EditorRequest, background_tasks: BackgroundTasks):
    _, current = await checked_editor(id, body.token)
    # Persist the live document even if rendering or Blob is temporarily unavailable.
    if body.publish:
        await save_draft(id, body.model_copy(update={"publish": False}))
    result = await save_draft(id, body, require_saved_source=body.publish)
    background_tasks.add_task(keep_editor_alive, current)
    return result


async def keep_editor_alive(current):
    try:
        await editor.keep_alive(current)
    except Exception:
        log.info("Sandbox unavailable after durable draft save", exc_info=True)


async def save_draft(id: str, body: EditorRequest, *, closing=False, require_saved_source=False):
    row, current = await checked_editor(id, body.token)
    source = body.source
    if source is None:
        raise HTTPException(422, "Export the live notebook document before saving.")
    validate(source)
    if require_saved_source and row["source"] != source:
        raise HTTPException(409, "Notebook changed while publishing; autosave will retry.")
    values = {"source": source}
    if closing:
        values["editor"] = None
    changed = body.publish and (json.loads(source) != json.loads(row["published"]) or not row["published_html"])
    if changed:
        html = await anyio.to_thread.run_sync(render, source)
        values.update(
            published=source,
            published_html=html,
            render_url=await publication.upload(id, html),
            updated_at=timestamp(),
            revision=notebooks.c.revision + 1,
        )
    async with engine.begin() as conn:
        result = await conn.execute(
            update(notebooks)
            .where(
                notebooks.c.id == id,
                notebooks.c.editor == row["editor"],
                notebooks.c.source == row["source"],
                notebooks.c.revision == row["revision"],
            )
            .values(**values)
        )
        if result.rowcount != 1:
            raise HTTPException(409, "Editor changed while saving; retry")
    if changed:
        await workspace_events.notify()
    return {
        "saved_at": timestamp(), "published": body.publish, "changed": bool(changed),
        "render_url": values.get("render_url", row["render_url"]),
        "revision": row["revision"] + int(bool(changed)),
        "updated_at": values.get("updated_at", row["updated_at"]),
    }


@app.post("/api/notebooks/{id}/close", dependencies=[Depends(require_owner)])
async def close(id: str, body: EditorRequest, background_tasks: BackgroundTasks):
    async with editor_lease(id):
        row = await get_notebook(id)
        # A navigation save may have committed before its acknowledgement was lost.
        if not row["editor"] and not body.publish and body.source is not None and row["source"] == body.source:
            return {"closed": True}
        row, current = await checked_editor(id, body.token)
        # Saving first means a failed persistence operation never destroys the draft.
        await save_draft(id, body, closing=True)
        background_tasks.add_task(stop_closed_editor, current)
        return {"closed": True}


@app.post("/api/notebooks/{id}/rename", dependencies=[Depends(require_owner)])
async def rename_notebook(id: str, body: RenameNotebook):
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "Enter a notebook title")
    async with editor_lease(id):
        await checked_editor(id, body.token)
        async with engine.begin() as conn:
            await conn.execute(update(notebooks).where(notebooks.c.id == id).values(title=title))
    await workspace_events.notify()
    return {"id": id, "title": title}


@app.post("/api/notebooks/{id}/delete", dependencies=[Depends(require_owner)])
async def delete_notebook(id: str, background_tasks: BackgroundTasks):
    async with editor_lease(id):
        row = await get_notebook(id)
        async with engine.begin() as conn:
            await conn.execute(delete(notebooks).where(notebooks.c.id == id))
        await workspace_events.notify()
        if row["editor"]:
            background_tasks.add_task(stop_closed_editor, json.loads(row["editor"]))
        async with engine.connect() as conn:
            owner = dict((await conn.execute(select(users).where(users.c.id == row["owner_id"]))).mappings().one())
        background_tasks.add_task(delete_notebook_artifacts, id, owner)
    return {"deleted": True}


async def delete_notebook_artifacts(id: str, owner):
    try:
        await editor.delete_workspace(id, owner=owner)
    except Exception:
        log.exception("Could not remove notebook workspace drive for %s", id)
    try:
        await publication.remove(id)
    except Exception:
        log.exception("Could not remove published notebook artifacts for %s", id)


@app.post("/api/notebooks/{id}/discard", dependencies=[Depends(require_owner)])
async def discard(id: str, body: EditorRequest, background_tasks: BackgroundTasks):
    async with editor_lease(id):
        row, current = await checked_editor(id, body.token)
        async with engine.begin() as conn:
            await conn.execute(
                update(notebooks)
                .where(notebooks.c.id == id, notebooks.c.editor == row["editor"])
                .values(source=notebooks.c.published, editor=None)
            )
        background_tasks.add_task(stop_closed_editor, current)
        return {"closed": True, "discarded": True}


async def stop_closed_editor(current):
    try:
        await editor.stop(current)
    except Exception:
        # The draft is durable and the session detached; its timeout bounds cleanup failures.
        log.exception("Could not stop closed editor")


@app.get("/api/health")
async def health():
    return JSONResponse({"ok": True})


@app.post("/api/notebooks/{id}/chat", dependencies=[Depends(require_owner)])
async def notebook_chat(id: str, request: Request):
    raw = await request.body()
    if len(raw) > 1_000_000:
        raise HTTPException(413, "Chat history is too large. Start a new chat.")
    try:
        body = chat.ChatRequest.model_validate_json(raw)
        chat.ai.ui.ai_sdk.to_messages(body.messages)
    except ValueError:
        raise HTTPException(422, "Invalid chat messages") from None
    if body.token:
        await checked_editor(id, body.token)
    else:
        await get_notebook(id)
    return StreamingResponse(
        chat.stream(id, body.messages, editing=bool(body.token)),
        headers=chat.ai.ui.ai_sdk.UI_MESSAGE_STREAM_HEADERS,
    )


@app.get("/api/notebooks/{id}/chat/stream", dependencies=[Depends(require_owner_read)])
async def resume_notebook_chat(id: str):
    """Reattach to an in-progress turn after a reload or dropped connection."""
    replay = await chat.reconnect(id)
    if replay is None:
        return Response(status_code=204)
    return StreamingResponse(replay, headers=chat.ai.ui.ai_sdk.UI_MESSAGE_STREAM_HEADERS)


@app.get("/api/notebooks/{id}/chat/state", dependencies=[Depends(require_owner_read)])
async def notebook_chat_state(id: str):
    """Authoritative turn state, so a reloaded page only shows streaming for a live turn."""
    await get_notebook(id)
    return await chat.turn_state(id)


@app.post("/api/notebooks/{id}/chat/stop", dependencies=[Depends(require_owner)])
async def stop_notebook_chat(id: str):
    await chat.stop_turn(id)
    return Response(status_code=204)


@app.post("/api/notebooks/{id}/chat-history")
async def load_chat_history(id: str, body: chat.HistoryLoadRequest):
    row = await get_notebook(id)
    messages = json.loads(row["chat_history"] or "[]")
    if body.limit is not None:
        offset = max(0, len(messages) - body.limit)
        return {"messages": messages[offset:], "revision": row["chat_revision"], "offset": offset}
    return {"messages": messages, "revision": row["chat_revision"]}


@app.put("/api/notebooks/{id}/chat-history", dependencies=[Depends(require_owner)])
async def save_chat_history(id: str, request: Request):
    raw = await request.body()
    if len(raw) > 1_000_000:
        raise HTTPException(413, "Chat history is too large. Start a new chat.")
    try:
        body = chat.HistoryRequest.model_validate_json(raw)
    except ValueError:
        raise HTTPException(422, "Invalid chat history") from None
    row = (await checked_editor(id, body.token))[0] if body.token else await get_notebook(id)
    previous = json.loads(row["chat_history"] or "[]")
    if body.offset > len(previous):
        raise HTTPException(409, "Chat changed. Reload saved chat before continuing.")
    history = json.dumps(previous[:body.offset] + chat.history_messages(body.messages))
    if len(history.encode()) > 1_000_000:
        raise HTTPException(413, "Chat history is too large. Start a new chat.")
    async with engine.begin() as conn:
        result = await conn.execute(
            update(notebooks)
            .where(
                notebooks.c.id == id,
                (notebooks.c.editor == row["editor"]) if body.token else True,
                notebooks.c.chat_revision == body.revision,
            )
            .values(chat_history=history, chat_revision=body.revision + 1)
        )
        if result.rowcount != 1:
            raise HTTPException(
                409, "Chat changed in another session. Reload saved chat before continuing."
            )
    return {"revision": body.revision + 1}
