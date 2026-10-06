import asyncio
import json
from contextlib import asynccontextmanager

import ai
import pytest
import vercel.workflow

import agent
import chat

M = ai.types.messages


@pytest.fixture(autouse=True)
async def workflow_queue():
    async with chat.local_workflow_queue():
        yield


@pytest.fixture
def nb(request):
    # Runs persist in the session's workflow world; each test uses its own notebook hook.
    return request.node.name


def call(call_id, name="read_notebook", args="{}"):
    return M.ToolCallPart(tool_call_id=call_id, tool_name=name, tool_args=args)


def assistant(*parts):
    return M.Message(role="assistant", parts=list(parts))


def model_events(message):
    yield ai.events.StreamStart(message=message)
    for index, part in enumerate(message.parts):
        if isinstance(part, M.TextPart):
            block = f"text-{index}"
            yield ai.events.TextStart(block_id=block, message=message)
            yield ai.events.TextDelta(block_id=block, chunk=part.text, message=message)
            yield ai.events.TextEnd(block_id=block, message=message)
    reason = "tool_call" if message.tool_calls else "stop"
    yield ai.events.StreamEnd(message=message, finish_reason=reason)


class Calls(list):
    """Messages sent on each model call, plus the tool names offered on each call."""

    def __init__(self):
        super().__init__()
        self.tools = []


def script(monkeypatch, *responses):
    """Replace the model with scripted responses: messages, exceptions, or event generators."""
    calls = Calls()

    @asynccontextmanager
    async def stream(model, messages, **kwargs):
        calls.append(messages)
        calls.tools.append({tool.name for tool in kwargs.get("tools") or []})
        response = responses[len(calls) - 1]
        if isinstance(response, Exception):
            raise response

        async def events():
            if callable(response):
                async for event in response():
                    yield event
            else:
                for event in model_events(response):
                    yield event

        yield events()

    monkeypatch.setattr(ai, "stream", stream)
    return calls


def user(text, id="u1"):
    return {"id": id, "role": "user", "parts": [{"type": "text", "text": text}]}


def ui(*messages):
    return [ai.ui.ai_sdk.UIMessage.model_validate(message) for message in messages]


def parse(chunks):
    events = []
    for chunk in chunks:
        payload = chunk.removeprefix("data: ").strip()
        if payload != "[DONE]":
            events.append(json.loads(payload))
    return events


async def collect(stream):
    chunks = [chunk async for chunk in stream]
    assert chunks[-1] == "data: [DONE]\n\n"
    return parse(chunks)


def types(events):
    return [event["type"] for event in events]


async def wait_idle(notebook_id):
    for _ in range(200):
        if await chat.active_run(notebook_id) is None:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("turn did not finish")


# @lat: [[chat#Streaming protocol tests]]
async def test_client_tool_is_dispatched_without_execution(monkeypatch, nb):
    script(monkeypatch, assistant(call("call-1")))
    # A continuation with no parked turn runs from the browser's history and keeps its UI message.
    history = ui(
        user("hello"),
        {
            "id": "existing-assistant",
            "role": "assistant",
            "parts": [
                {
                    "type": "tool-read_notebook",
                    "toolCallId": "old",
                    "state": "output-available",
                    "input": {},
                    "output": {"cells": []},
                }
            ],
        },
    )
    events = await collect(chat.stream(nb, history, editing=False))
    assert events[0] == {"type": "start", "messageId": "existing-assistant"}
    dispatched = [event for event in events if event["type"] == "tool-input-available"]
    assert [(event["toolCallId"], event["toolName"]) for event in dispatched] == [
        ("call-1", "read_notebook")
    ]
    assert "tool-output-available" not in types(events)
    assert await chat.active_run(nb) is not None


# @lat: [[chat#Tool argument streaming]]
async def test_partial_tool_arguments_stream_before_dispatch(monkeypatch, nb):
    write = call(
        "write-1", "insert_cell", '{"source":"print(42)","cell_type":"code","after_id":""}'
    )
    message = assistant(write)
    seen = asyncio.Event()
    live = []

    async def response():
        yield ai.events.StreamStart(message=message)
        yield ai.events.ToolStart(tool_call_id="write-1", tool_name="insert_cell")
        yield ai.events.ToolDelta(tool_call_id="write-1", chunk='{"source":"print(')
        yield ai.events.ToolDelta(
            tool_call_id="write-1", chunk='42)","cell_type":"code","after_id":""}'
        )
        # Hold the model open until the browser-facing stream has relayed the deltas.
        for _ in range(500):
            if seen.is_set():
                break
            await asyncio.sleep(0.01)
        live.append(seen.is_set())
        yield ai.events.ToolEnd(tool_call_id="write-1", tool_call=write)
        yield ai.events.StreamEnd(message=message, finish_reason="tool_call")

    script(monkeypatch, response)
    chunks = []
    async for chunk in chat.stream(nb, ui(user("add a cell")), editing=True):
        chunks.append(chunk)
        if '"type": "tool-input-delta"' in chunk:
            seen.set()
    text = "".join(chunks)
    assert live == [True]
    assert text.count('"type": "tool-input-delta"') == 2
    assert text.index('"tool-input-delta"') < text.index('"tool-input-available"')


# @lat: [[chat#Durable turn tests]]
async def test_tool_results_resume_the_parked_turn(monkeypatch, nb):
    calls = script(monkeypatch, assistant(call("c1")), assistant(M.TextPart(text="Done")))
    first = await collect(chat.stream(nb, ui(user("read it")), editing=False))
    run_id = await chat.active_run(nb)
    assert "tool-input-available" in types(first)

    history = ui(
        user("read it"),
        {
            "id": "a1",
            "role": "assistant",
            "parts": [
                {
                    "type": "tool-read_notebook",
                    "toolCallId": "c1",
                    "state": "output-available",
                    "input": {},
                    "output": {"cells": ["x"]},
                }
            ],
        },
    )
    second = await collect(chat.stream(nb, history, editing=True))
    assert second[0] == {"type": "start", "messageId": "a1"}
    assert "tool-input-available" not in types(second)
    assert "tool-output-available" not in types(second)
    assert any(event.get("delta") == "Done" for event in second)
    # The same run continued; the model saw the browser's tool result.
    assert len(calls) == 2
    results = [
        part for message in calls[1] if message.role == "tool" for part in message.tool_results
    ]
    assert [(part.tool_call_id, part.result) for part in results] == [("c1", {"cells": ["x"]})]
    # Consent arrived with the results: the rest of the turn uses the editing prompt and tools.
    assert calls.tools[0] == {"read_notebook", "request_editing"}
    assert "insert_cell" in calls.tools[1]
    assert calls[0][0].text == agent.VIEW_SYSTEM and calls[1][0].text == agent.SYSTEM
    await wait_idle(nb)
    assert await vercel.workflow.Run(run_id).status() == "completed"


# @lat: [[chat#Durable turn tests]]
async def test_new_message_supersedes_unfinished_turn(monkeypatch, nb):
    calls = script(monkeypatch, assistant(call("c1")), assistant(M.TextPart(text="Fresh answer")))
    await collect(chat.stream(nb, ui(user("first")), editing=False))
    parked = await chat.active_run(nb)

    events = await collect(
        chat.stream(nb, ui(user("first"), user("never mind", "u2")), editing=False)
    )
    assert any(event.get("delta") == "Fresh answer" for event in events)
    assert await vercel.workflow.Run(parked).status() == "completed"
    assert calls[1][-1].text == "never mind"
    await wait_idle(nb)


# @lat: [[chat#Durable turn tests]]
async def test_stop_cancels_an_in_flight_model_step(monkeypatch, nb):
    message = assistant(M.TextPart(text="Thinking"))
    started = asyncio.Event()

    async def slow():
        yield ai.events.StreamStart(message=message)
        started.set()
        await asyncio.sleep(30)
        yield ai.events.StreamEnd(message=message, finish_reason="stop")

    script(monkeypatch, slow)
    reply = asyncio.create_task(collect(chat.stream(nb, ui(user("hi")), editing=False)))
    await asyncio.wait_for(started.wait(), 10)
    await asyncio.wait_for(chat.stop_turn(nb), 10)
    events = await asyncio.wait_for(reply, 10)
    assert "error" not in types(events)
    assert await chat.active_run(nb) is None


# @lat: [[chat#Durable turn tests]]
async def test_reconnect_replays_turn_until_current_wait(monkeypatch, nb):
    script(monkeypatch, assistant(M.TextPart(text="Reading"), call("c1")), assistant(call("c2")))
    assert await chat.reconnect(nb) is None
    first = await collect(chat.stream(nb, ui(user("go")), editing=False))
    message_id = first[0]["messageId"]
    history = ui(
        user("go"),
        {
            "id": message_id,
            "role": "assistant",
            "parts": [
                {"type": "text", "text": "Reading", "state": "done"},
                {
                    "type": "tool-read_notebook",
                    "toolCallId": "c1",
                    "state": "output-available",
                    "input": {},
                    "output": {"cells": 1},
                },
            ],
        },
    )
    await collect(chat.stream(nb, history, editing=False))

    replay = await collect(await chat.reconnect(nb))
    assert replay[0] == {"type": "start", "messageId": message_id}
    inputs = [event["toolCallId"] for event in replay if event["type"] == "tool-input-available"]
    outputs = [
        (event["toolCallId"], event["output"])
        for event in replay
        if event["type"] == "tool-output-available"
    ]
    assert inputs == ["c1", "c2"]
    assert outputs == [("c1", {"cells": 1})]
    assert any(event.get("delta") == "Reading" for event in replay)

    await chat.stop_turn(nb)
    assert await chat.reconnect(nb) is None


# @lat: [[chat#Durable turn tests]]
async def test_failed_model_step_retries_and_resets_partial_output(monkeypatch, nb):
    partial = assistant(M.TextPart(text="Half"))

    async def fails():
        yield ai.events.StreamStart(message=partial)
        yield ai.events.TextStart(block_id="t", message=partial)
        yield ai.events.TextDelta(block_id="t", chunk="Half", message=partial)
        raise ConnectionError("gateway dropped")

    calls = script(monkeypatch, fails, assistant(M.TextPart(text="Whole answer")))
    events = await collect(chat.stream(nb, ui(user("hi")), editing=False))
    assert len(calls) == 2
    kinds = types(events)
    assert kinds.index("reset-step") > kinds.index("text-delta")
    assert events[-1]["type"] == "finish"
    assert [event["delta"] for event in events if event["type"] == "text-delta"] == [
        "Half",
        "Whole answer",
    ]


def test_tool_schemas_come_from_decorated_stubs():
    schemas = {tool.name: tool.tool.spec.params for tool in agent.TOOLS + agent.VIEW_TOOLS}
    assert {name: schema.get("required", []) for name, schema in schemas.items()} == {
        "rename_notebook": ["title"],
        "scroll_notebook": ["direction"],
        "read_notebook": [],
        "replace_cell": ["cell_id", "expected_source", "source"],
        "insert_cell": ["after_id", "cell_type", "source"],
        "run_cell": ["cell_id", "expected_source"],
        "request_editing": ["reason"],
    }
    title = schemas["rename_notebook"]["properties"]["title"]
    assert (title["minLength"], title["maxLength"]) == (1, 120)
    assert schemas["insert_cell"]["properties"]["cell_type"]["enum"] == ["code", "markdown"]
    assert agent.read_notebook.tool.spec.description.startswith("Read the currently open notebook")


# @lat: [[chat#Durable turn tests]]
async def test_turn_that_never_starts_fails_instead_of_hanging(monkeypatch, nb):
    from unittest.mock import AsyncMock, Mock

    run = Mock(run_id="wrun_never", terminate=AsyncMock())
    monkeypatch.setattr(chat.vercel.workflow, "start", AsyncMock(return_value=run))

    async def never(*args, **kwargs):
        return False

    monkeypatch.setattr(chat, "_wait_started", never)
    events = await asyncio.wait_for(collect(chat.stream(nb, ui(user("hi")), editing=False)), 10)
    assert events == [{"type": "error", "errorText": agent.REQUEST_FAILED}]
    run.terminate.assert_awaited_once()


# @lat: [[chat#Durable turn tests]]
async def test_free_tier_error_is_reported_without_retry(monkeypatch, nb):
    calls = script(monkeypatch, RuntimeError(agent.FREE_TIER))
    events = await collect(chat.stream(nb, ui(user("hi")), editing=False))
    assert events[-1] == {"type": "error", "errorText": agent.PAID_CREDITS}
    assert len(calls) == 1
    await wait_idle(nb)
