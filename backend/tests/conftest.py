"""Set isolated test configuration before any application module is imported."""
import os
import tempfile

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + tempfile.mktemp(suffix=".db")
os.environ["APP_URL"] = "http://localhost:5173"
os.environ["SESSION_SECRET"] = "test-secret-with-at-least-32-characters"
# One local workflow world per session; its queue subscription is bound at import.
os.environ["WORKFLOW_LOCAL_DATA_DIR"] = tempfile.mkdtemp()
os.environ.pop("VERCEL", None)
os.environ.pop("VERCEL_QUEUE_BASE_URL", None)
