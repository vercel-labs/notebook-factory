"""Python AI SDK streaming through durable turns; notebook tools run against the browser's live model."""

import asyncio
import contextlib
import json
import logging

import ai
import vercel.workflow
from pydantic import BaseModel, Field

import agent
from config import PRODUCTION, chat_model

log = logging.getLogger(__name__)


class ChatRequestToken(BaseModel):
    token: str | None = Field(default=None, max_length=256)


class HistoryLoadRequest(ChatRequestToken):
    limit: int | None = Field(default=None, ge=1, le=50)


class ChatRequest(BaseModel):
    token: str | None = Field(default=None, max_length=256)
    messages: list[ai.ui.ai_sdk.UIMessage] = Field(min_length=1, max_length=160)


class HistoryRequest(BaseModel):
    token: str | None = Field(default=None, max_length=256)
    revision: int = Field(ge=0)
    offset: int = Field(default=0, ge=0)
    messages: list[ai.ui.ai_sdk.UIMessage] = Field(max_length=160)


def history_messages(messages):
    result = []
    for message in messages:
        value = message.model_dump(by_alias=True, exclude_none=True)
        for part in value["parts"]:
            if part["type"] in ("text", "reasoning"):
                part["state"] = "done"
            elif part["type"].startswith("tool-") or part["type"] == "dynamic-tool":
                if part.get("state") not in ("output-available", "output-error", "output-denied"):
                    part.update(
                        state="output-error",
                        errorText="Interrupted in an earlier turn. Read the current notebook before continuing; execution may have occurred.",
                    )
                    part.setdefault("input", {})
        result.append(value)
    return result


# Durable turn bridge: HTTP requests start, resume, stop, or reattach to a notebook's turn run
# and relay its stream in the AI SDK UI protocol.


@contextlib.asynccontextmanager
async def local_workflow_queue():
    """Host the local workflow world's embedded queue for plain `uvicorn` and tests.

    The embedded queue binds an anyio task group to whichever task first enqueues, so starting it
    lazily inside a streaming request breaks once that request ends. A dedicated task owns it
    instead. Deployments and `vercel dev` use an external queue and skip this.
    """
    from vercel.queue import embedded
    from vercel.workflow._internal import world as workflow_world

    current = None if PRODUCTION else workflow_world.get_world()
    if getattr(current, "_queue_mode", None) != "embedded" or current._queue_client is not None:
        yield
        return
    ready, done = asyncio.Event(), asyncio.Event()

    async def host():
        try:
            # The world keeps its queue subscription; each host gets a fresh in-memory service
            # (a closed one cannot restart, e.g. across test event loops).
            current._embedded_queue_service_cm = embedded.embedded_queue_service()
            await current._get_queue_client()
        finally:
            ready.set()
        await done.wait()
        await current.aclose()

    task = asyncio.create_task(host())
    await ready.wait()
    if task.done():
        task.result()  # Surface a queue startup failure.
    try:
        yield
    finally:
        done.set()
        await task


async def active_run(notebook_id):
    """The run that holds this notebook's turn hook, if a turn is in progress."""
    try:
        return (await vercel.workflow.get_hook_by_token(agent.hook_token(notebook_id))).run_id
    except vercel.workflow.HookNotFoundError:
        return None


async def _wait_for_hook(notebook_id, run_id, present, timeout=10.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while ((await active_run(notebook_id)) == run_id) != present:
        if loop.time() > deadline:
            return False
        await asyncio.sleep(0.05)
    return True


async def start_turn(notebook_id, messages, editing):
    run = await vercel.workflow.start(
        agent.run_turn,
        agent.TurnInput(
            notebook_id=notebook_id, model_id=chat_model(), messages=messages, editing=editing
        ),
    )
    # Reconnects, continuations, and stops find the run through its hook. A run that never
    # creates it is not executing (for example, no workflow consumer is deployed); fail instead
    # of tailing an empty stream forever.
    if not await _wait_started(notebook_id, run):
        await run.terminate(reason="Chat turn did not start")
        raise RuntimeError(f"Chat turn {run.run_id} did not start within 30 seconds")
    return run.run_id


async def _wait_started(notebook_id, run, timeout=30.0):
    """True once the run holds the notebook hook, or already finished (and released it)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if await active_run(notebook_id) == run.run_id:
            return True
        if await run.status() in ("completed", "failed", "cancelled"):
            return True
        await asyncio.sleep(0.05)
    return False


async def stop_turn(notebook_id):
    """Stop the notebook's active turn and wait until its hook is released."""
    run_id = await active_run(notebook_id)
    if run_id is None:
        return
    try:
        await agent.TurnSignal(kind="stop").resume(agent.hook_token(notebook_id))
    except vercel.workflow.HookNotFoundError:
        return
    if not await _wait_for_hook(notebook_id, run_id, present=False):
        log.warning("Chat turn %s did not stop; terminating it", run_id)
        await vercel.workflow.Run(run_id).terminate(reason="Superseded chat turn")
        await _wait_for_hook(notebook_id, run_id, present=False)


async def _tail(run_id):
    """Index and value of the last event written to a run's stream."""
    run = vercel.workflow.Run(run_id)
    index = (await run.stream_info()).tail_index
    if index < 0:
        return index, None
    source = run.readable(type=agent.StreamEvent, start_index=index)
    async with contextlib.aclosing(source):
        async for event in source:
            return index, event
    return index, None


def _tool_results(messages, tool_call_ids):
    """The browser's results for exactly the parked calls, or None if any are missing."""
    found = {
        part.tool_call_id: part
        for message in messages
        if message.role == "tool"
        for part in message.tool_results
    }
    if not all(call_id in found for call_id in tool_call_ids):
        return None
    return [found[call_id] for call_id in tool_call_ids]


def _sse(event):
    return "data: " + json.dumps(event) + "\n\n"


async def relay(run_id, start_index=0, message_id=None, *, replay=False):
    """Relay one response's worth of a turn stream: until it parks for tools or ends."""
    error = None
    hydrator = ai.events.MessageHydrator()

    async def events():
        nonlocal error
        run = vercel.workflow.Run(run_id)
        source = run.readable(type=agent.StreamEvent, start_index=start_index)
        index = start_index - 1
        async with contextlib.aclosing(source):
            async for event in source:
                index += 1
                if isinstance(event, agent.Lifecycle):
                    # A replay passes earlier tool rounds and stops where the turn waits now.
                    if replay and event.type == "parked":
                        if (await run.stream_info()).tail_index > index:
                            continue
                    error = event.error
                    return
                event = hydrator.feed(event)
                # Live continuations already hold these outputs; re-emitting their calls would
                # dispatch the tools again.
                if not replay and isinstance(event, ai.events.ToolCallResult) and event.results:
                    continue
                yield event

    try:
        async for chunk in ai.ui.ai_sdk.to_sse(events()):
            if chunk == "data: [DONE]\n\n":
                break
            if message_id and chunk.startswith("data: ") and '"type": "start"' in chunk:
                # Continuations keep the existing assistant UI message.
                event = json.loads(chunk[6:])
                event["messageId"] = message_id
                chunk = _sse(event)
            yield chunk
    except Exception:
        log.exception("Notebook chat stream failed")
        error = agent.REQUEST_FAILED
    if error:
        yield _sse({"type": "error", "errorText": error})
    yield "data: [DONE]\n\n"


async def stream(notebook_id, ui_messages, *, editing):
    """Start a turn for a new user message, or continue the parked turn with tool results."""
    message_id = ui_messages[-1].id if ui_messages[-1].role == "assistant" else None
    try:
        messages, _ = ai.ui.ai_sdk.to_messages(ui_messages)
        run_id = await active_run(notebook_id)
        if message_id and run_id:
            index, tail = await _tail(run_id)
            if isinstance(tail, agent.Lifecycle) and tail.type == "parked":
                results = _tool_results(messages, tail.tool_call_ids)
                if results is not None:
                    await agent.TurnSignal(kind="tools", results=results, editing=editing).resume(
                        agent.hook_token(notebook_id)
                    )
                    async for chunk in relay(run_id, index + 1, message_id):
                        yield chunk
                    return
        # A new message supersedes any unfinished turn. A continuation without a matching parked
        # turn (stopped, expired, or superseded) runs from the browser's history instead.
        if run_id:
            await stop_turn(notebook_id)
        run_id = await start_turn(notebook_id, messages, editing)
    except Exception:
        log.exception("Notebook chat failed")
        yield _sse({"type": "error", "errorText": agent.REQUEST_FAILED})
        yield "data: [DONE]\n\n"
        return
    async for chunk in relay(run_id, 0, message_id):
        yield chunk


async def reconnect(notebook_id):
    """Replay the in-progress turn from its start, or None when no turn is active."""
    run_id = await active_run(notebook_id)
    if run_id is None:
        return None
    return relay(run_id, replay=True)
