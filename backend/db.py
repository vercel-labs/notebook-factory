import time

from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    text,
)
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from config import DATABASE_URL

# Neon's pooled endpoint owns pooling; serverless workers must not retain idle sessions.
# Psycopg can disable prepared statements entirely for transaction pooling.
engine = create_async_engine(
    DATABASE_URL,
    poolclass=NullPool,
    **({"connect_args": {"prepare_threshold": None}} if DATABASE_URL.startswith("postgresql+") else {}),
)
metadata = MetaData()
users = Table(
    "users", metadata,
    Column("id", Integer, primary_key=True, autoincrement=False),
    Column("vercel_id", String, nullable=False, unique=True),
    Column("login", String, nullable=False, unique=True),
    Column("avatar_url", Text),
    Column("sandbox_name", String, nullable=False, unique=True),
    Column("created_at", Integer, nullable=False),
    CheckConstraint("id >= 1 AND id <= 500", name="users_max_500_slots"),
)

notebooks = Table(
    "notebooks",
    metadata,
    Column("id", String, primary_key=True),
    Column("owner_id", Integer, ForeignKey("users.id"), nullable=False),
    Column("title", String, nullable=False),
    Column("source", Text, nullable=False),
    Column("published", Text, nullable=False),
    Column("published_html", Text),
    Column("render_url", Text),
    Column("created_at", Integer, nullable=False),
    Column("updated_at", Integer, nullable=False),
    Column("revision", Integer, nullable=False, default=1),
    Column("editor", Text),
    Column("chat_history", Text),
    Column("chat_revision", Integer, nullable=False, default=0),
    Column("claim", String),
    Column("claim_until", Integer, default=0),
)


runtimes = Table(
    "shared_runtimes", metadata,
    Column("id", String, primary_key=True),
    Column("state", Text),
    Column("claim", String),
    Column("claim_until", Integer, nullable=False, default=0),
)


async def initialize():
    async with engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            await conn.execute(text("SELECT pg_advisory_xact_lock(734823109)"))
        await conn.run_sync(metadata.create_all)
        if conn.dialect.name == "postgresql":
            from search import SEARCH_SCHEMA
            await conn.execute(text(SEARCH_SCHEMA))
            await conn.execute(text("CREATE INDEX IF NOT EXISTS notebooks_search_idx ON notebooks USING gin(search_vector)"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS notebooks_owner_id_idx ON notebooks(owner_id)"))


def timestamp():
    return int(time.time())
