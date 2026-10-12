"""Vercel identity enrollment and admission limits."""

import hashlib
import re
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlalchemy import select, text, update

from config import APP_URL
from db import engine, timestamp, users
from workspace_events import notify

USER_LIMIT = 300


def sandbox_name(login: str, slot: int):
    slug = re.sub(r"[^a-z0-9-]", "-", login.lower())[:24]
    suffix = hashlib.sha256(f"{APP_URL}:{slot}".encode()).hexdigest()[:16]
    return f"nf-{slug}-{suffix}"


async def enroll(profile):
    account, changed = await _enroll(profile)
    if changed:
        await notify()
    return account


async def _enroll(profile):
    subject = profile.get("sub")
    if not isinstance(subject, str) or not subject or len(subject) > 256:
        raise HTTPException(401, "Invalid Vercel identity; sign in again")
    suffix = hashlib.sha256(subject.encode()).hexdigest()[:10]
    username = profile.get("preferred_username")
    login = re.sub(r"[^a-z0-9._-]", "-", username.lower()).strip("-")[:64] if isinstance(username, str) else ""
    login = login or "user-" + suffix
    picture = profile.get("picture")
    avatar = picture if isinstance(picture, str) and len(picture) <= 2048 and urlsplit(picture).scheme == "https" else None
    async with engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            await conn.execute(text("SELECT pg_advisory_xact_lock(734823110)"))
        else:
            await conn.execute(text("BEGIN IMMEDIATE"))
        rows = (await conn.execute(select(users))).mappings().all()
        existing = next((row for row in rows if row["vercel_id"] == subject), None)
        used = {row["login"] for row in rows if not existing or row["id"] != existing["id"]}
        if login in used:
            base = login + "-" + suffix
            login = base
            counter = 1
            while login in used:
                login = f"{base}-{counter}"
                counter += 1
        if existing is not None:
            await conn.execute(update(users).where(users.c.id == existing["id"]).values(
                vercel_id=subject, login=login, avatar_url=avatar,
            ))
            changed = (existing["login"], existing["avatar_url"]) != (login, avatar)
            return {**dict(existing), "vercel_id": subject, "login": login, "avatar_url": avatar}, changed
        if len(rows) >= USER_LIMIT:
            raise HTTPException(403, "Notebook Factory has reached its 300-user signup limit. Existing users can still sign in.")
        slots = {row["id"] for row in rows}
        slot = next(i for i in range(1, 501) if i not in slots)
        account = dict(id=slot, vercel_id=subject, login=login, avatar_url=avatar,
                       sandbox_name=sandbox_name(login, slot), created_at=timestamp())
        await conn.execute(users.insert().values(**account))
        return account, True


async def from_session(profile):
    """Resolve registered Vercel identity without taking the enrollment lock."""
    subject = profile.get("sub")
    if profile.get("provider") != "vercel" or not isinstance(subject, str) or not subject:
        raise HTTPException(401, "Sign in with Vercel first")
    async with engine.connect() as conn:
        row = (await conn.execute(select(users).where(users.c.vercel_id == subject))).mappings().first()
    if row is None:
        raise HTTPException(401, "Account no longer exists; sign in with Vercel again")
    return dict(row)
