"""Jupyter runs in Sandbox; its WebSockets connect directly from the iframe."""

import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import anyio
import httpx
from fastapi import HTTPException
from vercel import sandbox
from vercel.api import session

from config import ALLOWED_ORIGINS, MAX_BYTES
from runtime_registry import load_runtime, runtime_lease, store_runtime
from sandbox_environment import prepared

ASSETS = Path(__file__).with_name("assets")
PORT = 8888


def generation():
    deployment = os.getenv("VERCEL_DEPLOYMENT_ID") or os.getenv("VERCEL_URL")
    if deployment:
        return deployment
    # Local development also invalidates environments when their bundled assets change.
    digest = hashlib.sha256()
    for path in [
        Path(__file__),
        Path(__file__).with_name("pyproject.toml"),
        *sorted(ASSETS.iterdir()),
    ]:
        if path.is_file():
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
    return "local-" + digest.hexdigest()[:16]


def workspace_drive_name(notebook_id: str):
    return "nf-workspace-" + hashlib.sha256(notebook_id.encode()).hexdigest()[:32]


async def _start_runtime(owner, report=lambda kind, message: None):
    token = secrets.token_urlsafe(32)
    name = shared_runtime_name(owner)
    async with session():
        environment = prepared()
        report("progress", "Attaching your notebook workspace…")
        drive = await sandbox.get_or_create_drive(
            name=workspace_drive_name("user:" + name), region=environment["region"],
            max_size_bytes=4 * 1024**3,
        )
        report("progress", "Starting Sandbox VM…")
        for attempt in range(30):
            try:
                instance = await sandbox.create_sandbox(
                    name=name, ports=[PORT], execution_time_limit=900, persistent=False,
                    region=environment["region"],
                    mounts={"/vercel": drive, "/notebook-base": sandbox.DriveMount(environment["drive_name"], mode="snapshot")},
                )
                report("progress", "Sandbox VM ready")
                break
            except sandbox.SandboxApiError as error:
                if error.status_code != 409 or attempt == 29:
                    raise
                report("progress", "Waiting for the previous editor to release its workspace…")
                await anyio.sleep(1)
        try:
            files = {}
            report("progress", "Configuring the notebook editor…")
            for filename, target in {
                "initialize_workspace.py": ".initialize-workspace.py",
                "jupyter_launcher.py": ".notebook-editor.py",
                "patch_jupyter_template.py": ".patch-jupyter-template.py",
                "sitecustomize.py": "sitecustomize.py",
                "focused_editor.css": ".vercel-notebook-focused-editor.css",
                "notebook_theme.css": ".notebook-theme.css",
                "matplotlibrc": ".notebook-matplotlibrc",
                "jupyter_bridge.js": ".vercel-notebook-jupyter-bridge.js",
            }.items():
                content = (
                    (ASSETS / filename)
                    .read_text()
                    .replace("__PARENT_ORIGINS__", json.dumps(list(ALLOWED_ORIGINS)))
                )
                files[target] = content
            settings = {
                "docmanager-extension/plugin": {
                    "autosave": False,
                    "autosaveInterval": 5,
                },
                "application-extension/shell": {"startMode": "single"},
                "application-extension/context-menu": {"disabled": True},
                "apputils-extension/themes": {
                    "adaptive-theme": False,
                    "theme": "JupyterLab Dark",
                },
                "apputils-extension/notification": {
                    "checkForUpdates": False,
                    "fetchNews": "false",
                },
                "statusbar-extension/plugin": {"visible": False},
            }
            for key, value in settings.items():
                directory, filename = key.split("/")
                folder = f".jupyter/lab/user-settings/@jupyterlab/{directory}"
                files[f"{folder}/{filename}.jupyterlab-settings"] = json.dumps(value)
            async with instance.fs.batch() as batch:
                for target, content in files.items():
                    batch.write_text(target, content)
            report("progress", "Preparing workspace dependencies (cached after first use)…")
            initialized = await instance.run_process(
                "python3", [".initialize-workspace.py", environment["fingerprint"]], capture_output=True,
            )
            if initialized.returncode:
                raise RuntimeError("Workspace dependency initialization failed")
            patch = await instance.run_process(
                ".venv/bin/python", [".patch-jupyter-template.py"], capture_output=True
            )
            if patch.returncode:
                raise RuntimeError(f"Jupyter template patch failed: {patch.stderr[-3000:]}")
            report("progress", "Starting JupyterLab…")
            # A random 256-bit base path is the capability protecting all HTTP and WS routes.
            # This avoids third-party cookie dependencies in embedded Jupyter.
            await instance.create_process(
                "sh",
                [
                    "-c",
                    'exec "$@" > .jupyter.log 2>&1',
                    "notebook-factory",
                    ".venv/bin/python",
                    ".notebook-editor.py",
                    "--ip=0.0.0.0",
                    f"--port={PORT}",
                    "--no-browser",
                    "--ServerApp.allow_remote_access=True",
                    "--ServerApp.disable_check_xsrf=True",
                    "--ServerApp.allow_unauthenticated_access=True",
                    "--IdentityProvider.token=",
                    "--ServerApp.password=",
                    "--LabApp.expose_app_in_browser=True",
                    f"--ServerApp.base_url=/{token}/",
                    "--ServerApp.tornado_settings="
                    + json.dumps(
                        {
                            "headers": {
                                "Content-Security-Policy": "frame-ancestors " + " ".join(ALLOWED_ORIGINS),
                                "Referrer-Policy": "no-referrer",
                            }
                        }
                    ),
                ],
            )
            route = next(route.url.rstrip("/") for route in instance.routes if route.port == PORT)
            url = f"{route}/{token}"
            report("progress", "Waiting for JupyterLab to respond…")
            async with httpx.AsyncClient(timeout=3, follow_redirects=True) as client:
                deadline = anyio.current_time() + 45
                while anyio.current_time() < deadline:
                    try:
                        response = await client.get(url + "/api/status")
                        if response.status_code == 200:
                            report("progress", "Jupyter server ready")
                            return {"name": name, "base_url": url, "generation": generation()}
                    except httpx.HTTPError:
                        pass
                    await anyio.sleep(0.5)
            output = await instance.fs.read_text(".jupyter.log")
            raise RuntimeError(
                "Jupyter startup timed out: " + output[-6000:].replace(token, "[redacted]")
            )
        except BaseException:
            with anyio.CancelScope(shield=True):
                await instance.stop()
                await instance.destroy()
            raise


def shared_runtime_name(owner):
    return owner["sandbox_name"]


async def _alive(current):
    try:
        instance = await sandbox.get_sandbox(name=current["name"])
    except sandbox.SandboxApiError as error:
        if error.status_code == 404:
            return False
        raise
    if not instance.current_session or instance.current_session.status != sandbox.SandboxStatus.RUNNING:
        return False
    # Stable Sandbox names survive VM replacement; their public routes do not.
    route = next((route for route in instance.routes if route.port == PORT), None)
    if route and urlsplit(route.url).netloc != urlsplit(current["base_url"]).netloc:
        return False
    async with httpx.AsyncClient(timeout=5) as client:
        try:
            response = await client.get(current["base_url"] + "/api/status")
        except httpx.HTTPError as error:
            raise HTTPException(502, "Could not reach the shared runtime. Retry without closing other tabs.") from error
    if response.status_code >= 500:
        raise HTTPException(502, "The shared runtime is temporarily unavailable; retry shortly.")
    return response.status_code == 200


async def _extend(instance):
    current = instance.current_session
    if current is None or current.status != sandbox.SandboxStatus.RUNNING:
        return
    started = current.started_at
    duration = current.execution_time_limit
    if started and duration:
        started_seconds = started / 1000 if started > 100_000_000_000 else started
        remaining = started_seconds + duration.total_seconds() - time.time()
        if remaining < 600:
            await current.extend_execution_time_limit(max(30, int(900 - remaining)))


async def start(source: str, report=lambda kind, message: None, *, notebook_id: str, owner):
    key = shared_runtime_name(owner)
    async with runtime_lease(key) as claim, session():
        report("progress", "Connecting to the shared Python runtime…")
        current = await load_runtime(key)
        pending = (current or {}).get("pending_deletions", [])
        if current and current.get("generation") == generation() and await _alive(current):
            instance = await sandbox.get_sandbox(name=current["name"])
            await _extend(instance)
            report("progress", "Reusing running Jupyter server")
        else:
            # The stable name also recovers a runtime created before an interrupted DB write.
            await _destroy_runtime({"name": key})
            current = await _start_runtime(owner, report)
            current["pending_deletions"] = pending
            await store_runtime(key, claim, current)
            instance = await sandbox.get_sandbox(name=current["name"])
        for folder_to_delete in pending:
            await instance.fs.remove(folder_to_delete, recursive=True, missing_ok=True)
        if pending:
            current["pending_deletions"] = []
            await store_runtime(key, claim, current)
        token = secrets.token_urlsafe(32)
        folder = "notebooks/" + hashlib.sha256(notebook_id.encode()).hexdigest()
        path = folder + "/notebook-" + token + ".ipynb"
        await instance.fs.write_text(path, source)
        report("progress", "Notebook file ready")
        return {
            "name": current["name"], "shared": True, "base_url": current["base_url"],
            "path": path, "token": token,
            "url": current["base_url"] + "/doc/workspaces/nf-" + token + "/tree/" + quote(path, safe="/") + "?nf_editor_token=" + token,
        }


async def check_available(editor):
    async with session():
        current = {**editor, "base_url": editor.get("base_url") or editor["url"].split("/doc/", 1)[0]}
        if editor.get("shared"):
            registered = await load_runtime(editor["name"])
            if registered and registered.get("base_url") and registered["base_url"] != current["base_url"]:
                raise HTTPException(410, "Editor belongs to a replaced runtime. Reopen the saved draft.")
        if not await _alive(current):
            raise HTTPException(410, "Editor expired. Reopen the saved draft.")


async def read(editor: dict, *, extend=True):
    async with session():
        try:
            instance = await sandbox.get_sandbox(name=editor["name"])
        except sandbox.SandboxApiError as error:
            if error.status_code == 404:
                raise HTTPException(410, "Editor expired. Reopen the saved draft.") from None
            raise
        current = instance.current_session
        if current is None or current.status != sandbox.SandboxStatus.RUNNING:
            raise HTTPException(410, "Editor expired. Reopen it to restore the last saved draft.")
        # A bounded HTTP read avoids loading an unbounded notebook into the function.
        base = editor.get("base_url") or editor["url"].split("/doc/", 1)[0]
        async with httpx.AsyncClient(timeout=20) as client:
            async with client.stream("GET", base + "/files/" + quote(editor.get("path", "notebook.ipynb"), safe="/")) as response:
                if response.status_code != 200:
                    raise HTTPException(410, "Editor unavailable. Reopen the saved draft.")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_BYTES:
                        raise HTTPException(413, "Notebook exceeds 10 MB")
        if extend:
            await keep_alive(editor)
        return body.decode()


async def _destroy_runtime(editor: dict):
    async with session():
        try:
            instance = await sandbox.get_sandbox(name=editor["name"])
        except sandbox.SandboxApiError as error:
            if error.status_code == 404:
                return
            raise
        await instance.stop()
        await instance.destroy()


async def stop(editor: dict):
    if not editor.get("shared"):
        await _destroy_runtime(editor)
        return
    # Only retire this editing session; other notebooks keep their kernels and server.
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(editor["base_url"] + "/api/sessions")
        if response.status_code in (404, 410):
            return
        response.raise_for_status()
        for item in response.json():
            if item.get("path") == editor["path"]:
                deleted = await client.delete(editor["base_url"] + "/api/sessions/" + item["id"])
                if deleted.status_code not in (204, 404, 410):
                    deleted.raise_for_status()
        deleted = await client.delete(editor["base_url"] + "/api/contents/" + quote(editor["path"], safe="/"))
        if deleted.status_code not in (204, 404, 410):
            deleted.raise_for_status()


async def delete_workspace(notebook_id: str, *, owner):
    # Record deletion first, so an expired VM cannot leave abandoned notebook files.
    key = shared_runtime_name(owner)
    folder = "notebooks/" + hashlib.sha256(notebook_id.encode()).hexdigest()
    async with runtime_lease(key) as claim, session():
        current = await load_runtime(key) or {}
        pending = list(dict.fromkeys([*current.get("pending_deletions", []), folder]))
        current["pending_deletions"] = pending
        await store_runtime(key, claim, current)
        if current.get("base_url") and await _alive(current):
            instance = await sandbox.get_sandbox(name=current["name"])
            await instance.fs.remove(folder, recursive=True, missing_ok=True)
            current["pending_deletions"].remove(folder)
            await store_runtime(key, claim, current)


async def keep_alive(editor: dict):
    async with runtime_lease(editor["name"]), session():
        instance = await sandbox.get_sandbox(name=editor["name"])
        await _extend(instance)
