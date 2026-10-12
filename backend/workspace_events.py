"""Live sidebar: queue-signalled workspace snapshots pushed over WebSockets."""
import asyncio
import logging
import os
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import select
from vercel.queue import ALL_DEPLOYMENTS, QueueClient

from config import PRODUCTION
from db import engine, notebooks, users

log = logging.getLogger(__name__)

QUEUE_REGION = os.getenv("QUEUE_REGION", "iad1")
TOPIC = "workspace-events-" + os.getenv("VERCEL_ENV", "development")
# One consumer group per process, so every instance receives every signal.
GROUP = "workspace-relay-" + uuid4().hex
IDLE_POLL_SECONDS = 1.0

sockets: set[WebSocket] = set()
_lock = asyncio.Lock()
_relay: asyncio.Task | None = None


def queue_enabled():
    return PRODUCTION or bool(os.getenv("VERCEL_QUEUE_BASE_URL"))


def queue_client():
    return QueueClient(region=QUEUE_REGION, deployment=ALL_DEPLOYMENTS)


async def snapshot():
    # One metadata-only join; never load notebook documents, HTML, or chat history.
    async with engine.connect() as conn:
        rows = (await conn.execute(select(
            users.c.id.label("user_id"), users.c.login, users.c.avatar_url,
            notebooks.c.id, notebooks.c.title, notebooks.c.updated_at,
            notebooks.c.revision, notebooks.c.render_url,
        ).select_from(users.outerjoin(notebooks, notebooks.c.owner_id == users.c.id))
            .order_by(users.c.login, notebooks.c.updated_at.desc(), notebooks.c.id))).mappings()
        owners, items = {}, []
        for row in rows:
            owner_id = row["user_id"]
            if owner_id not in owners:
                owners[owner_id] = {"id": owner_id, "login": row["login"], "avatar_url": row["avatar_url"]}
            if row["id"] is not None:
                items.append({"owner_id": owner_id, **{key: row[key] for key in (
                    "id", "title", "updated_at", "revision", "render_url",
                )}})
        return {"users": list(owners.values()), "notebooks": items}


async def _send(targets):
    # The lock keeps snapshots ordered: a later read is never sent before an earlier one.
    async with _lock:
        data = await snapshot()
        for websocket in list(targets):
            try:
                await asyncio.wait_for(websocket.send_json(data), 5)
            except Exception:
                sockets.discard(websocket)


async def broadcast():
    if sockets:
        await _send(sockets)


# @lat: [[architecture#Live sidebar updates]]
async def notify():
    """Signal that sidebar metadata changed. Never raises: the write already committed."""
    try:
        if queue_enabled():
            await asyncio.wait_for(queue_client().send(TOPIC, {"changed": True}, retention=60), 2)
        else:
            await broadcast()
    except Exception:
        log.warning("Could not publish workspace change", exc_info=True)


async def _relay_loop():
    client = queue_client()
    while sockets:
        try:
            received = False
            async for delivery in client.poll(TOPIC, GROUP, limit=10):
                async with delivery:  # Clean exit acknowledges; messages are only signals.
                    received = True
            if received:
                await broadcast()
            else:
                await asyncio.sleep(IDLE_POLL_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("Workspace relay poll failed", exc_info=True)
            await asyncio.sleep(5)


async def serve(websocket: WebSocket):
    global _relay
    await websocket.accept()
    sockets.add(websocket)
    try:
        await _send([websocket])
        if queue_enabled() and (_relay is None or _relay.done()):
            _relay = asyncio.create_task(_relay_loop())
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sockets.discard(websocket)
