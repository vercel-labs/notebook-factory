"""Deployment database aliases must work without a local dotenv file."""
import runpy
import sys
import types
from pathlib import Path


# @lat: [[deployment#Environment configuration]]
def test_neon_integration_url(monkeypatch):
    monkeypatch.setitem(sys.modules, 'dotenv', types.SimpleNamespace(load_dotenv=lambda *_: None))
    monkeypatch.setenv('VERCEL', '1')
    monkeypatch.setenv('VERCEL_ENV', 'production')
    monkeypatch.setenv('SESSION_SECRET', 'x' * 32)
    monkeypatch.setenv('APP_URL', 'https://example.com')
    monkeypatch.setenv('POSTGRES_URL', 'postgres://user:pass@other.example:5432/app')
    pooled = 'user:pass@ep-x-pooler.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require'
    monkeypatch.setenv('DATABASE_URL', 'postgresql://' + pooled)
    config = runpy.run_path(str(Path(__file__).parents[1] / 'config.py'))
    assert config['DATABASE_URL'] == 'postgresql+psycopg://' + pooled
    monkeypatch.delenv('DATABASE_URL')
    config = runpy.run_path(str(Path(__file__).parents[1] / 'config.py'))
    assert config['DATABASE_URL'] == 'postgresql+psycopg://user:pass@other.example:5432/app'


# @lat: [[deployment#Environment configuration]]
async def test_postgres_releases_connections_and_disables_preparation(monkeypatch):
    import pytest
    from sqlalchemy import event
    from sqlalchemy.pool import NullPool

    monkeypatch.setitem(sys.modules, 'config', types.SimpleNamespace(
        DATABASE_URL='postgresql+psycopg://user:pass@localhost:6543/postgres?sslmode=require',
    ))
    db = runpy.run_path(str(Path(__file__).parents[1] / 'db.py'))
    engine = db['engine']
    assert isinstance(engine.pool, NullPool)
    captured = {}

    @event.listens_for(engine.sync_engine, 'do_connect')
    def capture(dialect, record, args, kwargs):
        captured.update(kwargs)
        raise RuntimeError('connection intercepted')

    with pytest.raises(RuntimeError, match='connection intercepted'):
        async with engine.connect():
            pass
    assert captured['prepare_threshold'] is None
    assert captured['port'] == 6543
    assert captured['sslmode'] == 'require'
    await engine.dispose()


# @lat: [[deployment#Environment configuration]]
async def test_connections_close_on_success_and_error(monkeypatch, tmp_path):
    import pytest
    from sqlalchemy import event, text

    monkeypatch.setitem(sys.modules, 'config', types.SimpleNamespace(
        DATABASE_URL=f"sqlite+aiosqlite:///{tmp_path / 'connections.db'}",
    ))
    engine = runpy.run_path(str(Path(__file__).parents[1] / 'db.py'))['engine']
    closed = []

    @event.listens_for(engine.sync_engine, 'close')
    def record_close(connection, record):
        closed.append(record)

    async with engine.connect() as conn:
        await conn.execute(text('SELECT 1'))
    assert len(closed) == 1
    with pytest.raises(RuntimeError, match='operation failed'):
        async with engine.begin() as conn:
            await conn.execute(text('SELECT 1'))
            raise RuntimeError('operation failed')
    assert len(closed) == 2
    await engine.dispose()


def _deployed_config(monkeypatch, env, **values):
    monkeypatch.setitem(sys.modules, 'dotenv', types.SimpleNamespace(load_dotenv=lambda *_: None))
    for name in ('APP_URL', 'VERCEL_URL', 'VERCEL_BRANCH_URL'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('VERCEL', '1')
    monkeypatch.setenv('VERCEL_ENV', env)
    monkeypatch.setenv('SESSION_SECRET', 'x' * 32)
    monkeypatch.setenv('DATABASE_URL', 'postgresql://user:pass@db.example:5432/app')
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    return runpy.run_path(str(Path(__file__).parents[1] / 'config.py'))


# @lat: [[deployment#Environment configuration#Preview origins]]
def test_preview_origins_come_from_the_deployment(monkeypatch):
    import pytest

    config = _deployed_config(monkeypatch, 'preview', VERCEL_URL='app-abc.vercel.app', VERCEL_BRANCH_URL='app-git-x.vercel.app')
    assert config['APP_URL'] == 'https://app-git-x.vercel.app'
    assert config['ALLOWED_ORIGINS'] == ('https://app-git-x.vercel.app', 'https://app-abc.vercel.app')
    served = config['served_origin']

    def request(**headers):
        return types.SimpleNamespace(headers=headers, url=types.SimpleNamespace(scheme='http'))

    assert served(request(**{'x-forwarded-host': 'app-abc.vercel.app', 'x-forwarded-proto': 'https'})) == 'https://app-abc.vercel.app'
    assert served(request(**{'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https'})) == 'https://app-git-x.vercel.app'
    # Production never trusts deployment URLs; it requires the canonical HTTPS APP_URL.
    config = _deployed_config(monkeypatch, 'production', VERCEL_URL='app-abc.vercel.app', APP_URL='https://example.com')
    assert config['ALLOWED_ORIGINS'] == ('https://example.com',)
    with pytest.raises(RuntimeError, match='HTTPS APP_URL'):
        _deployed_config(monkeypatch, 'production', VERCEL_URL='app-abc.vercel.app')
