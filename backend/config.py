import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))
SECRET = os.getenv("SESSION_SECRET", "")
# Any deployed environment (production or preview); `vercel dev` counts as local.
PRODUCTION = bool(os.getenv("VERCEL")) and os.getenv("VERCEL_ENV") != "development"
PREVIEW = PRODUCTION and os.getenv("VERCEL_ENV") == "preview"
# Previews have no fixed domain, so they trust the deployment URL and branch alias that Vercel
# injects at runtime. Production pins the canonical APP_URL; local development defaults to Vite.
_PREVIEW_ORIGINS = [
    "https://" + host for host in (os.getenv("VERCEL_BRANCH_URL"), os.getenv("VERCEL_URL")) if host
] if PREVIEW else []
APP_URL = (os.getenv("APP_URL") or next(iter(_PREVIEW_ORIGINS), "http://localhost:5173")).rstrip("/")
ALLOWED_ORIGINS = tuple(dict.fromkeys([APP_URL, *_PREVIEW_ORIGINS]))
if PRODUCTION and (len(SECRET) < 32 or not all(origin.startswith("https://") for origin in ALLOWED_ORIGINS)):
    raise RuntimeError("Set SESSION_SECRET (32+ characters) and an HTTPS APP_URL")
# A deterministic local-only key keeps sessions stable during reloads.
SECRET = SECRET or "local-development-only-not-for-production"
DATABASE_URL = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL", "")
if not DATABASE_URL:
    if PRODUCTION:
        raise RuntimeError("DATABASE_URL or POSTGRES_URL is required on Vercel")
    DATABASE_URL = "sqlite+aiosqlite:///" + str(Path(__file__).with_name("notebooks.db"))
if DATABASE_URL.startswith(("postgres://", "postgresql://", "postgresql+asyncpg://", "postgresql+psycopg://")):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL.split("://", 1)[1]
    url = urlsplit(DATABASE_URL)
    query = dict(parse_qsl(url.query))
    # Marketplace attribution is not a PostgreSQL connection option.
    query.pop("supa", None)
    DATABASE_URL = urlunsplit(url._replace(query=urlencode(query)))
if PRODUCTION and not DATABASE_URL.startswith("postgresql+psycopg://"):
    raise RuntimeError("Use a durable Postgres DATABASE_URL on Vercel")
MAX_BYTES = 10 * 1024 * 1024


def trusted_origin(origin) -> bool:
    return origin in ALLOWED_ORIGINS


def served_origin(connection) -> str:
    """The allowed origin this HTTP or WebSocket request reached, else the canonical APP_URL.

    Hosts outside ALLOWED_ORIGINS never influence redirects, so a spoofed Host header is inert.
    """
    headers = connection.headers
    host = (headers.get("x-forwarded-host") or headers.get("host") or "").split(",")[0].strip()
    scheme = (headers.get("x-forwarded-proto") or connection.url.scheme).split(",")[0].strip()
    scheme = {"ws": "http", "wss": "https"}.get(scheme, scheme)
    origin = f"{scheme}://{host}"
    return origin if trusted_origin(origin) else APP_URL


def chat_model():
    return os.getenv("AI_MODEL", "gateway:openai/gpt-6-luna")
