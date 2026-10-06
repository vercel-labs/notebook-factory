# Verification

Automated tests cover application invariants with a temporary database and mocked Sandbox calls. Browser and live-service checks cover boundaries that those tests cannot exercise.

## Automated checks

[[backend/tests/test_app.py]] tests the FastAPI API with TestClient, temporary SQLite, and mocked Sandbox operations. It does not require production credentials.

Run from the repository root:

```sh
uv run --project backend pytest backend/tests -q
uv run --project backend ruff check backend
uv run --project backend ruff format --check backend
npm run build --prefix frontend
node --test backend/tests/test_save_bridge.cjs
lat check
```

The current suite produces 101 passing test cases, including parameterized authorization cases. Chat tests run durable turns on the real local workflow world with a scripted model; see [[chat#Durable turn tests]]. [[architecture#Authorization tests]] and [[architecture#Persistence tests]] remain stable anchors for existing test annotations.

Coverage includes owner/origin enforcement, invalid sessions and OAuth state, draft/public separation, stale capabilities, close/reopen, failed saves, startup failure cleanup, expiry recovery, and concurrent startup serialization. Rendering tests check stored HTML reads, one-time legacy backfill, concurrent publication during backfill, atomic publication failures, and upgrading an existing database. They also simulate absent system templates; launcher tests check location-relative paths.

Progress tests check installer events, final editor delivery, reuse, failure messages, lease release, and anonymous rejection. The close test verifies that the draft is durable and the editor record cleared before shutdown, including a shutdown failure that must not undo the saved result.

[Save bridge tests](../backend/tests/test_save_bridge.cjs) checks that native and parent save requests share a queue, acknowledgements follow completion, and a rejected save does not block later saves.

## Browser checks

The frontend has been smoke-tested with Playwright and temporary mock services. Those scripts are outside the repository and are not a checked-in browser test suite.

Checks exercised incremental and split stream frames, logs visible before setup completes, elapsed time, ready/error transitions, editor handoff, and close behavior. Earlier close checks verified iframe removal during shutdown and restoration after a failed close.

A mocked browser run does not prove Vercel's deployed streaming behavior or Vercel authentication. The frontend build checks TypeScript and bundling, not runtime behavior against live infrastructure.

## Live checks

Live Sandbox smoke checks verified SDK provisioning, incremental installer output, notebook reads, Python execution, document saving, and cleanup. Temporary test Sandboxes were stopped afterward.

Use an owner session and a disposable notebook to check a deployment end to end:

1. Confirm public navigation and `/api/health`; confirm notebook listing separately to exercise Postgres.
2. Sign in through Vercel and create a notebook.
3. Open Edit; confirm setup stages and installation output appear before readiness.
4. Execute a Python cell and verify its output, not merely that the Jupyter page loaded.
5. Save or wait for autosave; verify signed-out readers still see the previous published version.
6. Save & exit and verify the public rendering and download contain the saved output.
7. Reopen and make a draft change, then Exit; verify the change is discarded on reopening and exiting does not wait for Sandbox shutdown.
8. Confirm signed-out and non-owner sessions cannot access mutation endpoints or editor capabilities.

The direct live kernel smoke test executed `6 * 7` and returned `42`. A prior browser run-all automation stalled, so that check is not evidence that every Jupyter command works. Existing production OAuth and Postgres were exercised during setup; repeat the full flow after changes to those integrations.

## Documentation maintenance

[[lat#Notebook Factory knowledge graph]] indexes the knowledge graph. Keep these files aligned with implemented behavior and validate links and section structure with `lat check` after edits.

Preserve existing architecture test anchors when reorganizing documentation. Do not store secrets, raw Sandbox capability URLs, temporary check scripts, or deployment-by-deployment journals in this graph.

Blob tests cover upload failure preserving the prior publication, drafts avoiding uploads, migration of existing HTML, and embedding a restrictive CSP in the uploaded artifact.
