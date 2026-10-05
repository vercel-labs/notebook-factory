from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
from accounts import enroll
from auth import COOKIE, SESSION_SALT, signer
from render import new_notebook


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main.editor, "check_available", AsyncMock())
    monkeypatch.setattr(main.editor, "keep_alive", AsyncMock())
    with TestClient(main.app) as client:
        client.portal.call(enroll, {"sub": "vercel-1st1", "preferred_username": "1st1"})
        yield client


def authenticate(client, login="1st1"):
    client.portal.call(enroll, {"sub": "vercel-" + login, "preferred_username": login})
    client.cookies.set(COOKIE, signer.dumps({"provider": "vercel", "sub": "vercel-" + login}, salt=SESSION_SALT))
    client.headers["origin"] = "http://localhost:5173"


def create(client):
    authenticate(client)
    response = client.post("/api/notebooks", json={"title": "A notebook"})
    assert response.status_code == 201
    return response.json()["id"]


# @lat: [[architecture#Authorization tests]]
@pytest.mark.parametrize(
    "path,body",
    [
        ("/api/notebooks", {"title": "Forbidden"}),
        ("/api/notebooks/missing/editor", {}),
        ("/api/notebooks/missing/save", {"token": "x"}),
        ("/api/notebooks/missing/close", {"token": "x"}),
        ("/api/notebooks/missing/discard", {"token": "x"}),
        ("/api/notebooks/missing/delete", {}),
        ("/api/notebooks/missing/rename", {"token": "x", "title": "New title"}),
        ("/api/notebooks/missing/chat", {"token": "x", "messages": []}),
    ],
)
def test_mutations_require_owner_and_origin(client, path, body):
    if "/missing/" in path:
        notebook_id = create(client)
        path = path.replace("/missing/", f"/{notebook_id}/")
        client.cookies.clear()
    assert client.post(path, json=body).status_code == 401
    authenticate(client, "someone-else")
    assert client.post(path, json=body).status_code == (201 if path == "/api/notebooks" else 403)
    authenticate(client)
    client.headers["origin"] = "https://attacker.example"
    assert client.post(path, json=body).status_code == 403


def test_invalid_sessions_and_oauth_state(client):
    client.cookies.set(COOKIE, "forged")
    assert client.get("/api/auth/me").json()["can_edit"] is False
    assert client.get("/api/auth/callback?code=stolen&state=forged").status_code == 400


# @lat: [[architecture#Persistence tests]]
def test_drafts_publish_close_and_reopen(client, monkeypatch):
    id = create(client)
    from accounts import sandbox_name
    first = {
        "generation": main.editor.generation(),
        "name": sandbox_name("1st1", 1),
        "url": "https://example.test/secret/doc/tree/notebook.ipynb",
        "token": "secret",
    }
    start = AsyncMock(return_value=first)
    read = AsyncMock(return_value=new_notebook("Unpublished changes"))
    stop = AsyncMock()
    monkeypatch.setattr(main.editor, "start", start)
    monkeypatch.setattr(main.editor, "read", read)
    monkeypatch.setattr(main.editor, "stop", stop)
    assert client.post(f"/api/notebooks/{id}/editor", json={}).json() == first
    assert client.post(f"/api/notebooks/{id}/editor", json={}).json() == first
    assert start.await_count == 1
    assert client.post(f"/api/notebooks/{id}/save", json={"source": new_notebook("Unpublished changes"), "token": "stale"}).status_code == 409
    assert client.post(f"/api/notebooks/{id}/save", json={"source": new_notebook("Unpublished changes"), "token": "secret"}).status_code == 200
    assert "Unpublished changes" not in client.get(f"/api/notebooks/{id}/download").text
    assert (
        client.post(
            f"/api/notebooks/{id}/save", json={"source": new_notebook("Unpublished changes"), "token": "secret", "publish": True}
        ).status_code
        == 200
    )
    assert "Unpublished changes" in client.get(f"/api/notebooks/{id}/download").text
    assert client.post(f"/api/notebooks/{id}/close", json={"source": new_notebook("Unpublished changes"), "token": "secret"}).status_code == 200
    stop.assert_awaited_once()
    assert client.post(f"/api/notebooks/{id}/editor", json={}).status_code == 200
    assert "Unpublished changes" in start.call_args.args[0]
    client.cookies.clear()
    listing = client.get("/api/notebooks").json()
    assert all("editor" not in item and "source" not in item for item in listing)
    html = client.get(f"/api/notebooks/{id}/render")
    assert html.status_code == 200 and "Unpublished changes" in html.text
    assert "sandbox allow-scripts;" in html.headers["content-security-policy"]
    assert "secret" not in html.text


def test_failed_save_does_not_stop_editor(client, monkeypatch):
    id = create(client)
    monkeypatch.setattr(
        main.editor,
        "start",
        AsyncMock(return_value={"name": "a", "token": "t", "url": "https://example.test"}),
    )
    monkeypatch.setattr(main.editor, "read", AsyncMock(return_value="not a notebook"))
    stop = AsyncMock()
    monkeypatch.setattr(main.editor, "stop", stop)
    client.post(f"/api/notebooks/{id}/editor", json={})
    assert client.post(f"/api/notebooks/{id}/close", json={"token": "t"}).status_code == 422
    stop.assert_not_awaited()


def test_startup_failure_releases_lease(client, monkeypatch):
    id = create(client)
    start = AsyncMock(side_effect=RuntimeError("provider unavailable"))
    monkeypatch.setattr(main.editor, "start", start)
    for _ in range(2):
        assert client.post(f"/api/notebooks/{id}/editor", json={}).status_code == 502
    assert start.await_count == 2


def test_blank_title(client):
    authenticate(client)
    assert client.post("/api/notebooks", json={"title": "  "}).status_code == 422


def test_expired_editor_restores_draft(client, monkeypatch):
    id = create(client)
    monkeypatch.setattr(
        main.editor,
        "start",
        AsyncMock(return_value={"name": "old", "token": "old", "url": "https://example.test"}),
    )
    client.post(f"/api/notebooks/{id}/editor", json={})
    monkeypatch.setattr(
        main.editor, "check_available", AsyncMock(side_effect=main.HTTPException(410, "Expired"))
    )
    start = AsyncMock(return_value={"name": "new", "token": "new", "url": "https://example.test"})
    monkeypatch.setattr(main.editor, "start", start)
    response = client.post(f"/api/notebooks/{id}/editor", json={})
    assert response.status_code == 200 and response.json()["token"] == "new"
    assert "A notebook" in start.call_args.args[0]


def test_simultaneous_editor_start_is_serialized(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    import anyio

    id = create(client)
    entered, release = Event(), Event()

    async def start(source, *, notebook_id, owner):
        entered.set()
        await anyio.to_thread.run_sync(lambda: release.wait(5))
        return {"name": "one", "token": "one", "url": "https://example.test"}

    monkeypatch.setattr(main.editor, "start", start)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(client.post, f"/api/notebooks/{id}/editor", json={})
        assert entered.wait(5)
        try:
            assert client.post(f"/api/notebooks/{id}/editor", json={}).status_code == 409
        finally:
            release.set()
        assert first.result().status_code == 200


def test_render_without_system_jupyter_templates(monkeypatch):
    from nbconvert.exporters.templateexporter import TemplateExporter

    from render import render

    monkeypatch.setattr(TemplateExporter, "get_prefix_root_dirs", lambda self: [])
    html = render(new_notebook("Bundled templates"))
    assert "Bundled templates" in html
    assert "Hello, notebook." in html
    assert "jp-Notebook" in html
    assert 'id="notebook-factory-theme"' in html
    assert "color-scheme: dark" in html


def test_launcher_paths_follow_remote_script_location(tmp_path, monkeypatch):
    import runpy
    import sqlite3
    import sys
    from pathlib import Path
    from types import ModuleType

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    launcher = workspace / ".notebook-editor.py"
    launcher.write_text((Path(main.__file__).parent / "assets/jupyter_launcher.py").read_text())
    plot_style = (Path(main.__file__).parent / "assets/matplotlibrc").read_text()
    (workspace / ".notebook-matplotlibrc").write_text(plot_style)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    module = ModuleType("jupyterlab.labapp")
    observed = []
    module.main = lambda: observed.extend(sys.argv) or 0
    monkeypatch.setitem(sys.modules, "pysqlite3", sqlite3)
    monkeypatch.setitem(sys.modules, "jupyterlab.labapp", module)
    monkeypatch.setattr(sys, "argv", [str(launcher), "notebook.ipynb"])
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as result:
        runpy.run_path(str(launcher), run_name="__main__")
    assert result.value.code == 0
    assert f"--LabApp.templates_dir={workspace}/.jupyter/templates" in observed
    assert f"--LabApp.user_settings_dir={workspace}/.jupyter/lab/user-settings" in observed
    assert f"--ServerApp.root_dir={workspace}" in observed
    assert (tmp_path / ".config/matplotlib/matplotlibrc").read_text() == plot_style


def test_setup_stream_progress_ready_and_reuse(client, monkeypatch):
    import json

    id = create(client)
    from accounts import sandbox_name
    result = {
        "generation": main.editor.generation(),
        "name": sandbox_name("1st1", 1),
        "url": "https://example.test/editor",
        "token": "t",
    }

    async def start(source, report, *, notebook_id, owner):
        report("progress", "Installing Python and JupyterLab…")
        report("log", "Installing ipykernel\n")
        return result

    monkeypatch.setattr(main.editor, "start", start)
    response = client.post(f"/api/notebooks/{id}/editor", headers={"Accept": "text/event-stream"})
    assert response.headers["content-type"].startswith("text/event-stream")
    events = [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]
    assert any(e.get("message") == "Installing ipykernel\n" for e in events)
    assert events[-1] == {"type": "ready", "editor": result}
    monkeypatch.setattr(main.editor, "read", AsyncMock(return_value=new_notebook("Saved")))
    response = client.post(f"/api/notebooks/{id}/editor", headers={"Accept": "text/event-stream"})
    assert '"type": "ready"' in response.text


def test_setup_stream_failure_releases_lease(client, monkeypatch):
    id = create(client)
    monkeypatch.setattr(
        main.editor, "start", AsyncMock(side_effect=RuntimeError("private details"))
    )
    for _ in range(2):
        response = client.post(
            f"/api/notebooks/{id}/editor", headers={"Accept": "text/event-stream"}
        )
        assert '"type": "error"' in response.text
        assert "private details" not in response.text
        assert "Could not start Jupyter" in response.text
    client.cookies.clear()
    assert (
        client.post(
            f"/api/notebooks/{id}/editor", headers={"Accept": "text/event-stream"}
        ).status_code
        == 401
    )


def test_close_detaches_before_background_shutdown(client, monkeypatch):
    id = create(client)
    result = {
        "generation": main.editor.generation(),
        "name": "closing",
        "url": "https://example.test/editor",
        "token": "t",
    }
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=result))
    monkeypatch.setattr(main.editor, "read", AsyncMock(return_value=new_notebook("Durable draft")))
    client.post(f"/api/notebooks/{id}/editor")

    async def stop(current):
        row = await main.get_notebook(id)
        assert row["editor"] is None
        assert "Durable draft" in row["source"]
        raise RuntimeError("Shutdown unavailable")

    monkeypatch.setattr(main.editor, "stop", stop)
    assert client.post(f"/api/notebooks/{id}/close", json={"source": new_notebook("Durable draft"), "token": "t"}).json() == {"closed": True}
    main.editor.read.assert_not_awaited()


def test_render_uses_stored_html_and_backfills_legacy_rows(client, monkeypatch):
    from unittest.mock import Mock

    from sqlalchemy import update

    id = create(client)
    renderer = Mock(wraps=main.render)
    monkeypatch.setattr(main, "render", renderer)
    initial = client.get(f"/api/notebooks/{id}/render")
    assert initial.status_code == 200
    renderer.assert_not_called()

    async def clear_html():
        async with main.engine.begin() as conn:
            await conn.execute(
                update(main.notebooks).where(main.notebooks.c.id == id).values(published_html=None)
            )

    client.portal.call(clear_html)
    first = client.get(f"/api/notebooks/{id}/render")
    second = client.get(f"/api/notebooks/{id}/render")
    assert first.text == second.text == initial.text
    assert renderer.call_count == 1


def test_publish_updates_html_atomically_and_drafts_leave_it_unchanged(client, monkeypatch):
    id = create(client)
    initial = client.get(f"/api/notebooks/{id}/render").text
    session = {"name": "render-test", "token": "t", "url": "https://example.test"}
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=session))
    monkeypatch.setattr(
        main.editor, "read", AsyncMock(return_value=new_notebook("New public content"))
    )
    client.post(f"/api/notebooks/{id}/editor")
    assert client.post(f"/api/notebooks/{id}/save", json={"source": new_notebook("New public content"), "token": "t"}).status_code == 200
    assert client.get(f"/api/notebooks/{id}/render").text == initial
    assert (
        client.post(f"/api/notebooks/{id}/save", json={"source": new_notebook("New public content"), "token": "t", "publish": True}).status_code
        == 200
    )
    published = client.get(f"/api/notebooks/{id}/render").text
    assert "New public content" in published
    revision = client.portal.call(main.get_notebook, id)["revision"]

    def fail_render(source):
        raise RuntimeError("Conversion failed")

    monkeypatch.setattr(main, "render", fail_render)
    monkeypatch.setattr(
        main.editor, "read", AsyncMock(return_value=new_notebook("Must not publish"))
    )
    with pytest.raises(RuntimeError, match="Conversion failed"):
        client.post(f"/api/notebooks/{id}/save", json={"source": new_notebook("New public content"), "token": "t", "publish": True})
    assert client.get(f"/api/notebooks/{id}/render").text == published
    assert "Must not publish" not in client.get(f"/api/notebooks/{id}/download").text
    assert client.portal.call(main.get_notebook, id)["revision"] == revision


def test_legacy_backfill_cannot_overwrite_a_new_publication(client, monkeypatch):
    import asyncio

    from sqlalchemy import update

    id = create(client)

    async def change(**values):
        async with main.engine.begin() as conn:
            await conn.execute(
                update(main.notebooks).where(main.notebooks.c.id == id).values(**values)
            )

    client.portal.call(lambda: change(published_html=None))

    def render_during_publish(source):
        asyncio.run(
            change(published=new_notebook("New revision"), published_html="New HTML", revision=2)
        )
        return "Old HTML"

    monkeypatch.setattr(main, "render", render_during_publish)
    assert client.get(f"/api/notebooks/{id}/render").text == "Old HTML"
    assert client.get(f"/api/notebooks/{id}/render").text == "New HTML"
    assert client.portal.call(main.get_notebook, id)["revision"] == 2


def test_discard_restores_published_draft_without_reading_jupyter(client, monkeypatch):
    id = create(client)
    original = client.get(f"/api/notebooks/{id}/download").text
    session = {"name": "discard-test", "token": "t", "url": "https://example.test"}
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=session))
    monkeypatch.setattr(
        main.editor, "read", AsyncMock(return_value=new_notebook("Discard this draft"))
    )
    monkeypatch.setattr(main.editor, "stop", AsyncMock())
    client.post(f"/api/notebooks/{id}/editor")
    client.post(f"/api/notebooks/{id}/save", json={"source": new_notebook("Discard this draft"), "token": "t"})
    main.editor.read.reset_mock()
    assert client.post(f"/api/notebooks/{id}/discard", json={"token": "wrong"}).status_code == 409
    response = client.post(f"/api/notebooks/{id}/discard", json={"token": "t"})
    assert response.json() == {"closed": True, "discarded": True}
    main.editor.read.assert_not_awaited()
    row = client.portal.call(main.get_notebook, id)
    assert row["source"] == row["published"] == original
    assert row["editor"] is None and row["revision"] == 1
    client.post(f"/api/notebooks/{id}/editor")
    assert main.editor.start.call_args.args[0] == original


def test_save_and_exit_publishes_html_and_closes(client, monkeypatch):
    id = create(client)
    session = {"name": "save-exit-test", "token": "t", "url": "https://example.test"}
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=session))
    monkeypatch.setattr(
        main.editor, "read", AsyncMock(return_value=new_notebook("Saved and closed"))
    )
    monkeypatch.setattr(main.editor, "stop", AsyncMock())
    client.post(f"/api/notebooks/{id}/editor")
    assert (
        client.post(f"/api/notebooks/{id}/close", json={"source": new_notebook("Saved and closed"), "token": "t", "publish": True}).status_code
        == 200
    )
    row = client.portal.call(main.get_notebook, id)
    assert row["editor"] is None and row["revision"] == 2
    assert "Saved and closed" in row["published_html"]


def test_blob_publication_and_failed_upload_preserve_previous_version(client, monkeypatch):
    upload = AsyncMock(return_value="https://store.public.blob.vercel-storage.com/first.html")
    monkeypatch.setattr(main.publication, "upload", upload)
    id = create(client)
    assert next(row for row in client.get("/api/notebooks").json() if row["id"] == id)[
        "render_url"
    ].endswith("/first.html")
    session = {"name": "blob-test", "token": "t", "url": "https://example.test"}
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=session))
    monkeypatch.setattr(main.editor, "read", AsyncMock(return_value=new_notebook("Private draft")))
    client.post(f"/api/notebooks/{id}/editor")
    client.post(f"/api/notebooks/{id}/save", json={"source": new_notebook("Private draft"), "token": "t"})
    assert upload.await_count == 1
    upload.side_effect = RuntimeError("Blob upload failed")
    with pytest.raises(RuntimeError, match="Blob upload failed"):
        client.post(f"/api/notebooks/{id}/save", json={"source": new_notebook("Private draft"), "token": "t", "publish": True})
    row = client.portal.call(main.get_notebook, id)
    assert row["render_url"].endswith("/first.html") and row["revision"] == 1
    assert "Private draft" not in row["published"]


def test_legacy_html_is_uploaded_and_reused(client, monkeypatch):
    id = create(client)
    upload = AsyncMock(return_value="https://store.public.blob.vercel-storage.com/legacy.html")
    monkeypatch.setattr(main.publication, "enabled", lambda: True)
    monkeypatch.setattr(main.publication, "upload", upload)
    assert client.get(f"/api/notebooks/{id}/render").status_code == 200
    assert client.get(f"/api/notebooks/{id}/render").status_code == 200
    upload.assert_awaited_once()
    assert client.portal.call(main.get_notebook, id)["render_url"].endswith("/legacy.html")


@pytest.mark.asyncio
async def test_blob_upload_has_isolation_policy_and_immutable_url(monkeypatch):
    from types import SimpleNamespace

    import publication

    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "test-token")
    put = AsyncMock(
        return_value=SimpleNamespace(url="https://store.public.blob.vercel-storage.com/test.html")
    )
    monkeypatch.setattr(publication, "put_async", put)
    await publication.upload("id", "<html><head></head><body>Published</body></html>")
    payload = put.call_args.args[1].decode()
    assert 'http-equiv="Content-Security-Policy"' in payload
    assert "connect-src &#x27;none&#x27;" in payload
    assert payload.index("Content-Security-Policy") < payload.index("<body>")
    assert put.call_args.kwargs["add_random_suffix"] is True
    assert put.call_args.kwargs["access"] == "public"


# @lat: [[chat#Chat authorization tests]]
def test_chat_requires_active_editor(client):
    id = create(client)
    response = client.post(
        f"/api/notebooks/{id}/chat",
        json={
            "token": "stale",
            "messages": [
                {"id": "u1", "role": "user", "parts": [{"type": "text", "text": "hello"}]}
            ],
        },
    )
    assert response.status_code == 409
    response = client.post(f"/api/notebooks/{id}/chat", content="x" * 1_000_001)
    assert response.status_code == 413


# @lat: [[editing#Deployment generations]]
def test_deployment_replaces_editor_without_losing_saved_draft(client, monkeypatch):
    id = create(client)
    monkeypatch.setattr(main.editor, "generation", lambda: "deployment-a")
    from accounts import sandbox_name
    start = AsyncMock(return_value={"name": sandbox_name("1st1", 1), "token": "old", "url": "https://example.test"})
    read = AsyncMock(return_value=new_notebook("Stale disk file"))
    stop = AsyncMock()
    monkeypatch.setattr(main.editor, "start", start)
    monkeypatch.setattr(main.editor, "read", read)
    monkeypatch.setattr(main.editor, "stop", stop)
    first = client.post(f"/api/notebooks/{id}/editor", json={}).json()
    assert first["generation"] == "deployment-a"
    assert client.post(f"/api/notebooks/{id}/editor", json={}).json() == first
    assert start.await_count == 1
    assert client.post(f"/api/notebooks/{id}/save", json={"token": "old", "source": new_notebook("Recovered draft")}).status_code == 200
    monkeypatch.setattr(main.editor, "generation", lambda: "deployment-b")
    start.side_effect = RuntimeError("Unavailable")
    assert client.post(f"/api/notebooks/{id}/editor", json={}).status_code == 502
    stop.assert_awaited_once_with(first)
    stop.reset_mock()
    row = client.portal.call(main.get_notebook, id)
    assert "Recovered draft" in row["source"]
    assert "Recovered draft" not in row["published"]
    start.side_effect = None
    start.return_value = {"name": "new", "token": "new", "url": "https://new.test"}
    result = client.post(f"/api/notebooks/{id}/editor", json={}).json()
    read.assert_not_awaited()
    assert result["generation"] == "deployment-b"
    assert "Recovered draft" in start.call_args.args[0]
    stop.assert_awaited_once_with(first)
    assert client.post(f"/api/notebooks/{id}/save", json={"token": "old"}).status_code == 409


# @lat: [[chat#Chat Markdown and model label]]
def test_current_chat_model_tracks_configuration(client, monkeypatch):
    monkeypatch.delenv("AI_MODEL", raising=False)
    assert client.get("/api/auth/me").json()["chat_model"] == "gateway:openai/gpt-6-luna"
    monkeypatch.setenv("AI_MODEL", "gateway:anthropic/claude-sonnet-4.6")
    assert client.get("/api/auth/me").json()["chat_model"] == "gateway:anthropic/claude-sonnet-4.6"


# @lat: [[chat#Persistent history tests]]
def test_chat_history_survives_discard_and_blocks_stale_writes(client, monkeypatch):
    id = create(client)
    current = {
        "name": "sandbox",
        "url": "https://sandbox.test/token/doc/tree/notebook.ipynb",
        "token": "one",
    }
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=current))
    monkeypatch.setattr(main.editor, "stop", AsyncMock())
    client.post(f"/api/notebooks/{id}/editor")
    path = f"/api/notebooks/{id}/chat-history"
    assert client.post(path, json={"token": "one"}).json() == {"messages": [], "revision": 0}
    messages = [
        {"id": "u1", "role": "user", "parts": [{"type": "text", "text": "Plot a chart"}]},
        {
            "id": "a1",
            "role": "assistant",
            "parts": [
                {
                    "type": "tool-insert_cell",
                    "toolCallId": "c1",
                    "state": "input-available",
                    "input": {"source": "print(42)"},
                }
            ],
        },
    ]
    assert client.put(path, json={"token": "one", "revision": 0, "messages": messages}).json() == {
        "revision": 1
    }
    assert client.put(path, json={"token": "one", "revision": 0, "messages": []}).status_code == 409
    restored = client.post(path, json={"token": "one"}).json()
    assert restored["messages"][1]["parts"][0]["state"] == "output-error"
    assert "Interrupted" in restored["messages"][1]["parts"][0]["errorText"]
    # Historical tools can be sent back as context without executing them.
    main.chat.ai.ui.ai_sdk.to_messages(
        [main.chat.ai.ui.ai_sdk.UIMessage.model_validate(m) for m in restored["messages"]]
    )
    assert "chat_history" not in client.get("/api/notebooks").json()[0]
    assert client.post(f"/api/notebooks/{id}/discard", json={"token": "one"}).status_code == 200
    current["token"] = "two"
    client.post(f"/api/notebooks/{id}/editor")
    assert client.post(path, json={"token": "two"}).json() == restored
    assert client.put(path, json={"token": "one", "revision": 1, "messages": []}).status_code == 409
    assert client.put(path, json={"token": "two", "revision": 1, "messages": []}).status_code == 200
    assert client.post(path, json={"token": "two"}).json()["messages"] == []
    assert client.put(path, content="x" * 1_000_001).status_code == 413
    client.headers["origin"] = "https://evil.test"
    assert client.post(path, json={"token": "two"}).status_code == 200
    authenticate(client, "someone-else")
    assert client.post(path, json={"token": "two"}).status_code == 200
    client.cookies.clear()
    assert client.post(path, json={"token": "two"}).status_code == 200


# @lat: [[editing#Expired Sandbox persistence tests]]
def test_browser_document_survives_dead_sandbox(client, monkeypatch):
    id = create(client)
    current = {"generation": main.editor.generation(), "name": "dead", "token": "secret",
               "url": "https://example.test/secret/doc/tree/notebook.ipynb"}
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=current))
    read = AsyncMock(side_effect=RuntimeError("Sandbox is gone"))
    monkeypatch.setattr(main.editor, "read", read)
    monkeypatch.setattr(main.editor, "keep_alive", AsyncMock(side_effect=RuntimeError("Gone")))
    monkeypatch.setattr(main.editor, "stop", AsyncMock(side_effect=RuntimeError("Gone")))
    assert client.post(f"/api/notebooks/{id}/editor", json={}).status_code == 200
    source = new_notebook("Recovered browser edits")
    body = {"token": "secret", "source": source}
    assert client.post(f"/api/notebooks/{id}/save", json={**body, "token": "stale"}).status_code == 409
    assert client.post(f"/api/notebooks/{id}/save", json={**body, "source": "invalid"}).status_code == 422
    assert client.post(f"/api/notebooks/{id}/save", json=body).status_code == 200
    assert "Recovered browser edits" not in client.get(f"/api/notebooks/{id}/download").text
    assert client.post(f"/api/notebooks/{id}/close", json={**body, "publish": True}).status_code == 200
    assert "Recovered browser edits" in client.get(f"/api/notebooks/{id}/download").text
    read.assert_not_awaited()
    assert client.post(f"/api/notebooks/{id}/save", json=body).status_code == 409


# @lat: [[architecture#Notebook deletion tests]]
def test_delete_removes_notebook_and_stops_editor(client, monkeypatch):
    id = create(client)
    current = {"generation": main.editor.generation(), "name": "sandbox-delete",
               "token": "secret", "url": "https://example.test"}
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=current))
    stop = AsyncMock()
    remove = AsyncMock()
    monkeypatch.setattr(main.editor, "stop", stop)
    monkeypatch.setattr(main.publication, "remove", remove)
    delete_workspace = AsyncMock()
    monkeypatch.setattr(main.editor, "delete_workspace", delete_workspace)
    assert client.post(f"/api/notebooks/{id}/editor", json={}).status_code == 200
    assert client.post(f"/api/notebooks/{id}/delete", json={}).status_code == 200
    stop.assert_awaited_once_with(current)
    remove.assert_awaited_once_with(id)
    assert delete_workspace.await_args.args == (id,)
    assert delete_workspace.await_args.kwargs["owner"]["id"] == 1
    assert all(item["id"] != id for item in client.get("/api/notebooks").json())
    for suffix in ("render", "download"):
        assert client.get(f"/api/notebooks/{id}/{suffix}").status_code == 404
    assert client.post(f"/api/notebooks/{id}/delete", json={}).status_code == 404


# @lat: [[chat#Notebook rename tests]]
def test_rename_notebook_requires_current_editor_and_valid_title(client, monkeypatch):
    id = create(client)
    original = client.get(f"/api/notebooks/{id}/download").text
    current = {"name": "rename", "token": "secret", "url": "https://example.test"}
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=current))
    assert client.post(f"/api/notebooks/{id}/editor", json={}).status_code == 200
    route = f"/api/notebooks/{id}/rename"
    assert client.post(route, json={"token": "stale", "title": "No"}).status_code == 409
    for title in (" ", "x" * 121):
        assert client.post(route, json={"token": "secret", "title": title}).status_code == 422
    response = client.post(route, json={"token": "secret", "title": "  Better title  "})
    assert response.json() == {"id": id, "title": "Better title"}
    item = next(row for row in client.get("/api/notebooks").json() if row["id"] == id)
    assert item["title"] == "Better title"
    assert item["revision"] == 1
    assert client.get(f"/api/notebooks/{id}/download").text == original


# @lat: [[editing#Close autosave race tests]]
@pytest.mark.parametrize("operation", ["close", "discard"])
def test_late_autosave_cannot_overwrite_atomic_close(client, monkeypatch, operation):
    import asyncio

    from fastapi import BackgroundTasks

    id = create(client)
    initial = client.portal.call(main.get_notebook, id)["published"]
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value={"name": "race", "token": "t", "url": "https://example.test"}))
    client.post(f"/api/notebooks/{id}/editor")
    original = main.checked_editor

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()

        async def checked(id, token):
            result = await original(id, token)
            if asyncio.current_task().get_name() == "late-save":
                entered.set()
                await release.wait()
            return result

        monkeypatch.setattr(main, "checked_editor", checked)
        pending = asyncio.create_task(main.save_draft(id, main.EditorRequest(token="t", source=new_notebook("Old autosave"))), name="late-save")
        await asyncio.wait_for(entered.wait(), 2)
        try:
            body = main.EditorRequest(token="t", source=new_notebook("Latest browser document"))
            await asyncio.wait_for(getattr(main, operation)(id, body, BackgroundTasks()), 2)
        finally:
            release.set()
        with pytest.raises(main.HTTPException) as error:
            await pending
        assert error.value.status_code == 409
        row = await main.get_notebook(id)
        assert row["editor"] is None
        if operation == "close":
            assert "Latest browser document" in row["source"]
        else:
            assert row["source"] == initial
        assert "Old autosave" not in row["source"]

    client.portal.call(scenario)


# @lat: [[chat#Viewing mode tests]]
def test_view_chat_and_history_do_not_require_or_start_editor(client, monkeypatch):
    id = create(client)
    modes = []

    async def stream(messages, message_id=None, *, editing):
        modes.append(editing)
        yield 'data: [DONE]\n\n'

    monkeypatch.setattr(main.chat, "stream", stream)
    start = AsyncMock()
    monkeypatch.setattr(main.editor, "start", start)
    messages = [{"id": "u1", "role": "user", "parts": [{"type": "text", "text": "Explain this notebook"}]}]
    assert client.post(f"/api/notebooks/{id}/chat", json={"messages": messages}).status_code == 200
    assert modes == [False]
    assert client.post(f"/api/notebooks/{id}/chat-history", json={}).json() == {"messages": [], "revision": 0}
    assert client.put(f"/api/notebooks/{id}/chat-history", json={"messages": messages, "revision": 0}).status_code == 200
    assert client.post(f"/api/notebooks/{id}/chat-history", json={}).json()["messages"][0]["parts"][0]["text"] == "Explain this notebook"
    assert client.put(f"/api/notebooks/{id}/chat-history", json={"messages": [], "revision": 0}).status_code == 409
    assert {tool.name for tool in main.chat.VIEW_TOOLS} == {"read_notebook", "request_editing"}
    start.assert_not_awaited()
    client.cookies.clear()
    assert client.post(f"/api/notebooks/{id}/chat", json={"messages": messages}).status_code == 401
    assert client.post(f"/api/notebooks/{id}/chat-history", json={}).status_code == 200


# @lat: [[editing#Automatic recovery tests]]
def test_editor_status_distinguishes_expiry_without_reading_disk(client, monkeypatch):
    id = create(client)
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value={"name": "health", "token": "t", "url": "https://example.test"}))
    monkeypatch.setattr(main.editor, "read", AsyncMock(side_effect=AssertionError("Must not read disk")))
    client.post(f"/api/notebooks/{id}/editor")
    route = f"/api/notebooks/{id}/editor-status"
    assert client.post(route, json={"token": "stale"}).status_code == 409
    assert client.post(route, json={"token": "t"}).json() == {"available": True}
    monkeypatch.setattr(main.editor, "check_available", AsyncMock(side_effect=main.HTTPException(410, "Expired")))
    assert client.post(route, json={"token": "t"}).status_code == 410
    main.editor.read.assert_not_awaited()


def test_navigation_close_can_retry_lost_acknowledgement(client, monkeypatch):
    id = create(client)
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value={"name": "retry", "token": "t", "url": "https://example.test"}))
    monkeypatch.setattr(main.editor, "stop", AsyncMock())
    client.post(f"/api/notebooks/{id}/editor")
    body = {"token": "t", "source": new_notebook("Navigation draft")}
    assert client.post(f"/api/notebooks/{id}/close", json=body).status_code == 200
    assert client.post(f"/api/notebooks/{id}/close", json=body).status_code == 200
    assert client.post(f"/api/notebooks/{id}/close", json={**body, "source": new_notebook("Different draft")}).status_code == 409
    assert "Navigation draft" in client.portal.call(main.get_notebook, id)["source"]


def test_recent_chat_history_preserves_older_messages(client):
    id = create(client)
    path = f"/api/notebooks/{id}/chat-history"
    messages = [
        {"id": f"u{i}", "role": "user", "parts": [{"type": "text", "text": str(i)}]}
        for i in range(60)
    ]
    assert client.put(path, json={"revision": 0, "messages": messages}).status_code == 200
    recent = client.post(path, json={"limit": 50}).json()
    assert recent["offset"] == 10
    assert [m["id"] for m in recent["messages"]] == [m["id"] for m in messages[10:]]
    added = {"id": "new", "role": "user", "parts": [{"type": "text", "text": "Continue"}]}
    body = {"revision": 1, "offset": 10, "messages": recent["messages"] + [added]}
    assert client.put(path, json=body).status_code == 200
    assert client.put(path, json=body).status_code == 409
    restored = client.post(path, json={}).json()
    assert len(restored["messages"]) == 61
    assert [m["id"] for m in restored["messages"][:10]] == [m["id"] for m in messages[:10]]
    assert client.put(path, json={"revision": 2, "messages": []}).status_code == 200
    assert client.post(path, json={"limit": 50}).json()["messages"] == []


def test_autopublish_skips_unchanged_documents_and_retries_blob(client, monkeypatch):
    import json

    id = create(client)
    session = {"name": "auto", "token": "auto", "url": "https://example.test"}
    monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=session))
    client.post(f"/api/notebooks/{id}/editor")
    upload = AsyncMock(return_value="https://blob.test/rendered.html")
    monkeypatch.setattr(main.publication, "upload", upload)
    original = client.portal.call(main.get_notebook, id)
    unchanged = client.post(f"/api/notebooks/{id}/save", json={
        "token": "auto", "publish": True,
        "source": json.dumps(json.loads(original["published"]), indent=3),
    })
    assert unchanged.status_code == 200
    assert unchanged.json()["changed"] is False
    upload.assert_not_awaited()

    source = new_notebook("Automatically published")
    body = {"token": "auto", "publish": True, "source": source}
    result = client.post(f"/api/notebooks/{id}/save", json=body)
    assert result.status_code == 200
    assert result.json()["changed"] is True
    assert result.json()["render_url"] == "https://blob.test/rendered.html"
    assert result.json()["revision"] == original["revision"] + 1
    row = client.portal.call(main.get_notebook, id)
    assert row["published"] == row["source"] == source
    assert row["editor"]
    assert client.post(f"/api/notebooks/{id}/save", json=body).json()["changed"] is False
    assert upload.await_count == 1

    newer = new_notebook("Saved despite failed upload")
    upload.side_effect = RuntimeError("Blob unavailable")
    with pytest.raises(RuntimeError, match="Blob unavailable"):
        client.post(f"/api/notebooks/{id}/save", json={**body, "source": newer})
    row = client.portal.call(main.get_notebook, id)
    assert row["source"] == newer
    assert row["published"] == source
    upload.side_effect = None
    assert client.post(f"/api/notebooks/{id}/save", json={**body, "source": newer}).json()["changed"]
    assert client.portal.call(main.get_notebook, id)["published"] == newer


def test_multiuser_ownership_readonly_history_and_fork_without_chat(client, monkeypatch):
    import json

    from sqlalchemy import update

    original_id = create(client)
    owner = client.get("/api/auth/me").json()["user"]
    messages = [{"id": "u", "role": "user", "parts": [{"type": "text", "text": "Original conversation"}]}]
    assert client.put(f"/api/notebooks/{original_id}/chat-history", json={"revision": 0, "messages": messages}).status_code == 200
    original = client.portal.call(main.get_notebook, original_id)

    async def put_private_source():
        async with main.engine.begin() as conn:
            await conn.execute(update(main.notebooks).where(main.notebooks.c.id == original_id).values(
                source=new_notebook("Unpublished draft"),
                editor=json.dumps({"name": "private", "token": "known-token", "url": "https://secret.test"}),
            ))
    client.portal.call(put_private_source)
    authenticate(client, "new-person")
    account = client.get("/api/auth/me").json()
    assert account["can_edit"] is True
    assert account["user"]["user_id"] != owner["user_id"]
    mine = client.post("/api/notebooks", json={"title": "Mine"}).json()
    assert mine["owner_id"] == account["user"]["user_id"]
    for action, body in [
        ("editor", {}), ("editor-status", {"token": "known-token"}),
        ("save", {"token": "known-token", "source": original["source"]}),
        ("close", {"token": "known-token"}), ("delete", {}), ("discard", {"token": "known-token"}),
        ("rename", {"token": "known-token", "title": "Hijacked"}),
        ("chat", {"token": "known-token", "messages": messages}),
    ]:
        assert client.post(f"/api/notebooks/{original_id}/{action}", json=body).status_code == 403
    assert client.put(f"/api/notebooks/{original_id}/chat-history", json={"revision": 1, "messages": []}).status_code == 403
    assert client.post(f"/api/notebooks/{original_id}/chat-history", json={"limit": 50}).json()["messages"][0]["id"] == "u"
    assert client.get(f"/api/notebooks/{original_id}/download").text == original["published"]
    fork = client.post(f"/api/notebooks/{original_id}/fork").json()
    row = client.portal.call(main.get_notebook, fork["id"])
    assert fork["title"] == row["title"] == f"fork of {original['title']}"
    assert row["owner_id"] == account["user"]["user_id"]
    assert row["source"] == row["published"] == original["published"]
    assert row["chat_history"] is None and row["chat_revision"] == 0 and row["editor"] is None
    listing = client.get("/api/users").json()
    assert [u["login"] for u in listing] == sorted(u["login"] for u in listing)
    assert all(set(u) == {"id", "login", "avatar_url"} for u in listing)
    client.cookies.clear()
    assert client.post(f"/api/notebooks/{original_id}/fork").status_code == 401
    assert client.post(f"/api/notebooks/{original_id}/chat-history", json={}).status_code == 200


# @lat: [[architecture#Sidebar refresh tests]]
def test_workspace_fetches_all_sidebar_metadata_in_one_join(client):
    from sqlalchemy import event
    notebook_id = create(client)
    empty = client.portal.call(enroll, {"sub": "sidebar-empty", "preferred_username": "sidebar-empty"})
    statements = []
    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    event.listen(main.engine.sync_engine, "before_cursor_execute", record)
    try:
        client.cookies.clear()
        response = client.get("/api/workspace")
    finally:
        event.remove(main.engine.sync_engine, "before_cursor_execute", record)
    assert response.status_code == 200
    assert len(statements) == 1
    assert statements[0].upper().count("JOIN") == 1
    for private in ("source", "published", "chat_history", "editor", "claim"):
        assert private not in statements[0]
    data = response.json()
    assert any(user["id"] == empty["id"] for user in data["users"])
    assert len({user["id"] for user in data["users"]}) == len(data["users"])
    notebook = next(item for item in data["notebooks"] if item["id"] == notebook_id)
    assert set(notebook) == {"id", "owner_id", "title", "updated_at", "revision", "render_url"}


# @lat: [[architecture#Live sidebar tests]]
def test_workspace_socket_pushes_snapshots_after_changes(client, monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    notebook_id = create(client)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/workspace/live", headers={"origin": "https://evil.example"}):
            pass
    with pytest.raises(WebSocketDisconnect):
        # A spoofed host must still match the Origin the browser sent.
        with client.websocket_connect("/api/workspace/live", headers={
            "origin": "https://evil.example", "x-forwarded-host": "preview.vercel.app",
        }):
            pass
    # Preview and branch URLs differ from APP_URL but are same-origin with the request host.
    for headers in ({"origin": "https://preview.vercel.app", "x-forwarded-host": "preview.vercel.app"},
                    {"origin": "http://testserver"}):
        with client.websocket_connect("/api/workspace/live", headers=headers) as socket:
            assert socket.receive_json() == client.get("/api/workspace").json()
    with client.websocket_connect("/api/workspace/live", headers={"origin": "http://localhost:5173"}) as socket:
        assert socket.receive_json() == client.get("/api/workspace").json()
        current = {"name": "live", "token": "secret", "url": "https://example.test"}
        monkeypatch.setattr(main.editor, "start", AsyncMock(return_value=current))
        # Opening an editor does not change sidebar metadata, so nothing is pushed for it.
        assert client.post(f"/api/notebooks/{notebook_id}/editor", json={}).status_code == 200
        response = client.post(f"/api/notebooks/{notebook_id}/rename",
                               json={"token": "secret", "title": "Renamed live"})
        assert response.status_code == 200
        renamed = socket.receive_json()
        assert next(n for n in renamed["notebooks"] if n["id"] == notebook_id)["title"] == "Renamed live"
        created = client.post("/api/notebooks", json={"title": "Second live"}).json()
        assert any(n["id"] == created["id"] for n in socket.receive_json()["notebooks"])
        assert client.post(f"/api/notebooks/{created['id']}/delete").status_code == 200
        assert all(n["id"] != created["id"] for n in socket.receive_json()["notebooks"])


def test_queue_relay_delivers_changes_to_sockets(client, monkeypatch):
    from vercel.queue.devserver import embedded_queue_dev_server
    with embedded_queue_dev_server() as server:
        monkeypatch.setenv("VERCEL_QUEUE_BASE_URL", server.base_url)
        monkeypatch.setenv("VERCEL_QUEUE_TOKEN", "vc-dev-token")
        monkeypatch.setattr(main.workspace_events, "IDLE_POLL_SECONDS", 0.05)
        authenticate(client)
        with client.websocket_connect("/api/workspace/live") as socket:
            socket.receive_json()
            created = client.post("/api/notebooks", json={"title": "Via queue"}).json()
            assert any(n["id"] == created["id"] for n in socket.receive_json()["notebooks"])


def test_queue_publish_failure_does_not_fail_writes(client, monkeypatch):
    class FailingClient:
        async def send(self, *args, **kwargs):
            raise RuntimeError("queue unavailable")
    monkeypatch.setattr(main.workspace_events, "queue_enabled", lambda: True)
    monkeypatch.setattr(main.workspace_events, "queue_client", FailingClient)
    authenticate(client)
    assert client.post("/api/notebooks", json={"title": "Still saved"}).status_code == 201


# @lat: [[chat#Initial notebook prompt tests]]
@pytest.mark.parametrize("prompt", ["  Plot a sine wave.\n\nExplain the axes.  ", "   "])
def test_creation_prompt_is_notebook_introduction(client, prompt):
    authenticate(client)
    response = client.post("/api/notebooks", json={"title": "Experiment", "prompt": prompt})
    assert response.status_code == 201
    notebook = client.get(f"/api/notebooks/{response.json()['id']}/download").json()
    opening = notebook["cells"][0]
    assert opening["cell_type"] == "markdown"
    text = "".join(opening["source"])
    assert text.startswith("# Experiment\n\n")
    if prompt.strip():
        assert len(notebook["cells"]) == 1
        assert text == "# Experiment\n\n" + prompt.strip()
        assert "Start with a question" not in text
    else:
        assert len(notebook["cells"]) == 2
        assert notebook["cells"][1]["cell_type"] == "code"
        assert "Hello, notebook." in "".join(notebook["cells"][1]["source"])
        assert "Start with a question" in text
