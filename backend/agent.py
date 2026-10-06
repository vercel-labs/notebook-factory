"""Durable notebook chat: one workflow run per user turn.

Model calls are retried workflow steps that write AI events to the run's stream as they arrive.
Notebook tools still execute in the browser, so after a model step requests tools the run parks
on its notebook hook until the browser resumes it with tool results (or stops it).

The workflow body runs in a re-imported sandbox; keep this module free of app imports. Steps run
on the host and import `chat` lazily for prompts, tools, and model configuration.
"""

import asyncio
from typing import Literal

import ai
import pydantic
import vercel.workflow

workflow = vercel.workflow.Workflows(
    sandbox_policy=vercel.workflow.SandboxPolicy(
        passthrough_modules=frozenset({"ai"}),
        cleanups=vercel.workflow.sandbox.ALL_CLEANUPS,
    )
)

# How long a turn waits for browser tool results before ending.
PARK_SECONDS = 15 * 60


def hook_token(notebook_id: str) -> str:
    # One active turn per notebook; the hook also advertises that run's ID.
    return f"notebook-chat:{notebook_id}"


class TurnInput(pydantic.BaseModel):
    notebook_id: str
    messages: list[ai.messages.Message]
    editing: bool
    park_seconds: float = PARK_SECONDS


class TurnSignal(pydantic.BaseModel, vercel.workflow.BaseHook):
    kind: Literal["tools", "stop"]
    results: list[ai.messages.ToolResultPart] = []
    # The browser may enter editing mode mid-turn (request_editing consent).
    editing: bool = False


class Lifecycle(pydantic.BaseModel):
    kind: Literal["lifecycle"] = "lifecycle"
    type: Literal["parked", "done", "error"]
    tool_call_ids: list[str] = []
    error: str | None = None


# Model events drop their accumulated message on the wire; readers rehydrate them.
type StreamEvent = ai.events.OmitEventMessages[ai.events.AgentEvent] | Lifecycle
Writer = vercel.workflow.WorkflowWritable[StreamEvent]


@workflow.step(cancellable=True)
async def llm_step(
    messages: list[ai.messages.Message], editing: bool, writer: Writer
) -> ai.messages.Message:
    import chat

    if vercel.workflow.get_step_metadata().attempt > 1:
        # The browser drops the partial output of the failed attempt.
        await writer.write(ai.events.Retry())
    return await chat.model_step(messages, editing, writer.write)


@workflow.step
async def write_event(writer: Writer, event: StreamEvent) -> None:
    await writer.write(event)


@workflow.step
async def close_stream(writer: Writer) -> None:
    await writer.close()


async def _loop(turn: TurnInput, writer: Writer, inbox: asyncio.Queue) -> str | None:
    """Run model steps until the reply ends; return a user-facing error, if any."""
    messages = list(turn.messages)
    editing = turn.editing
    while True:
        try:
            message = await llm_step(messages, editing, writer)
        except Exception as error:
            return error_text(error)
        messages.append(message)
        calls = message.tool_calls
        if not calls:
            return None
        # An empty result set makes the UI adapter dispatch the calls to the browser.
        await write_event(writer, ai.events.ToolCallResult(message=message, results=[]))
        await write_event(
            writer, Lifecycle(type="parked", tool_call_ids=[call.tool_call_id for call in calls])
        )
        try:
            signal = await asyncio.wait_for(inbox.get(), turn.park_seconds)
        except TimeoutError:
            return None
        messages.append(ai.tool_message(*signal.results))
        editing = signal.editing
        # Recorded so a reconnecting reader replays tool outputs too.
        await write_event(writer, ai.events.ToolCallResult(message=message, results=signal.results))


@workflow.workflow
@ai.messages.use_random(vercel.workflow.random)
async def run_turn(turn: TurnInput) -> None:
    writer = vercel.workflow.get_writable(type=StreamEvent)
    signals = TurnSignal.wait(token=hook_token(turn.notebook_id))
    inbox: asyncio.Queue[TurnSignal] = asyncio.Queue()
    work = asyncio.create_task(_loop(turn, writer, inbox))

    async def listen() -> None:
        async for signal in signals:
            if signal.kind == "stop":
                work.cancel()
                return
            inbox.put_nowait(signal)

    listener = asyncio.create_task(listen())
    error = None
    try:
        error = await work
    except asyncio.CancelledError:
        pass
    # Release the notebook token before the stream ends, so a reader that sees the end can
    # immediately start the next turn.
    signals.dispose()
    listener.cancel()
    await write_event(
        writer, Lifecycle(type="error", error=error) if error else Lifecycle(type="done")
    )
    await close_stream(writer)


FREE_TIER = "Free tier users do not have access to this model"
REQUEST_FAILED = "AI request failed. Retry, or check Vercel AI Gateway access and credits."
PAID_CREDITS = "This model requires paid Vercel AI Gateway credits. Add credits in your team's AI Gateway dashboard, then retry."


def error_text(error: BaseException) -> str:
    return PAID_CREDITS if FREE_TIER in str(error) else REQUEST_FAILED
