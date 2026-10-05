# Deployment and operation

The app deploys from the repository root as two Vercel Services, with Supabase Postgres for persistence and Vercel Sandbox for notebook execution.

## Production project

The configured production application is [notebooks.sh](https://notebooks.sh), under the Vercel team `vercel-internal-playground` (Vercel Internal Playground).

| Setting | Project value |
| --- | --- |
| Git repository | `https://github.com/vercel-labs/notebook-factory` |
| Local Git remote | `up` |
| Vercel project | `notebook-factory` |
| Project ID | `prj_46j0HKfLl1LIgBGdDMaXXEpTUpFh` |
| Team ID | `team_TtmJZYmD3tcLBLqWOhoVawd1` |
| Database | Connected Supabase Marketplace integration |
| User enrollment | Any Vercel account, up to 300 admitted users |

These are the project details verified from the new project linkage on October 2, 2026. Local linkage lives in the ignored `.vercel/project.json`. Production has been deployed directly from the working tree with the CLI; a successful deployment does not imply those changes have been committed or pushed.

The production alias is public. Unique deployment URLs have Vercel deployment protection, so use the canonical alias for public checks and OAuth. See [[architecture#Services]] for routing and function configuration.

## Environment configuration

[[backend/config.py]] validates deployment settings, and `backend/.env.example` lists backend variables. Secrets belong in Vercel environment settings or ignored local environment files.

| Variable | Purpose |
| --- | --- |
| `AI_MODEL` | Optional chat model; defaults to gateway:openai/gpt-6-luna |
| `AI_GATEWAY_API_KEY` | Optional AI Gateway key; deployments use Vercel OIDC by default |
| `APP_URL` | Canonical app origin; required in Production (`https://notebooks.sh`), leave unset for Preview |
| `BLOB_READ_WRITE_TOKEN` | Backend upload credential for the public rendered-notebook Blob store |
| `SESSION_SECRET` | Random signing secret, at least 32 characters in every deployed environment; use a separate value for Preview |
| `DATABASE_URL` / `POSTGRES_URL` | Postgres connection URL; explicit DATABASE_URL takes precedence over the Supabase integration alias |
| `VERCEL_APP_CLIENT_ID` | OAuth application client ID, scoped to Production and Preview |
| `VERCEL_APP_CLIENT_SECRET` | OAuth application secret, scoped to Production and Preview |
| `VERCEL_OIDC_TOKEN` | Request-scoped Sandbox identity in deployment, or an explicitly loaded local token |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | Alternative backend-only Sandbox credentials for local use |

The Sign in with Vercel app's callback is configured by selecting this Vercel project, which accepts `/api/auth/callback` on any of its deployment domains. Origin checks, the OAuth redirect_uri, the editor bridge, and its `frame-ancestors` policy all use [[backend/config.py#ALLOWED_ORIGINS]].

[[backend/main.py#headers]] installs the incoming request headers in the Vercel HeadersContext so the SDK can use deployment OIDC. The project needs Sandbox access and OIDC support. No static Vercel token is required in the deployed app.

The backend loads `backend/.env`; it does not automatically load a root `.env.local` produced by CLI environment commands. Load or export that file explicitly when using its credentials locally. Never put backend secrets in `VITE_*` variables, which are client-visible.

Marketplace connection supplies the database variables. The application reads DATABASE_URL, falling back to the Supabase integration’s POSTGRES_URL. The integration's transaction-pooler URL is preserved. SQLAlchemy uses async Psycopg with prepared statements disabled and NullPool: connections close after each operation rather than occupying Supabase session slots across idle serverless instances. Database context managers close connections on both success and exceptions; lifespan cleanup also disposes the engine in a finally block. Only the FastAPI backend connects to the application database; sandbox provisioning does not pass database credentials into the VM. Provider-only `supa` attribution is stripped; standard PostgreSQL TLS options are retained, with STARTTLS negotiation explicitly selected for Supavisor compatibility. Required environment changes take effect in a new deployment. Startup creates the schema in a fresh database. It does not migrate the old GitHub schema; use a new DATABASE_URL. Future schema changes need an explicit migration strategy.

### Preview origins

Previews have no fixed domain, so [[backend/config.py]] trusts the runtime `VERCEL_BRANCH_URL` and `VERCEL_URL` hosts; APP_URL defaults to the branch alias. Production trusts only its HTTPS APP_URL.

Unknown Host headers never steer redirects. Previews share Production's database integration, so preview sign-ins and edits act on production data and Sandbox names.

## Local development

[[frontend/vite.config.ts]] proxies browser `/api` requests to FastAPI on port 8000. The standard local app origin is `http://localhost:5173`.

From the repository root:

```sh
cp backend/.env.example backend/.env
uv sync --project backend
npm ci --prefix frontend
```

Configure a Sign in with Vercel application with callback `http://localhost:5173/api/auth/callback`, then run these in separate terminals:

```sh
cd backend
uv run uvicorn main:app --reload --port 8000
```

```sh
npm run dev --prefix frontend
```

Local SQLite needs no service provisioning. Live editing still requires Sandbox credentials. The Python package supports 3.12+, while the checked-in version file selects 3.13. Vite requires a compatible Node runtime; setup used Node 24.

For the Vercel local gateway, use the verified published CLI and match OAuth to port 3000:

```sh
APP_URL=http://localhost:3000 VERCEL_ENV=development npx vercel@62.1.0 dev -L
```

## Deploy procedure

[vercel.json](../vercel.json) is the deployable Services definition. Published Vercel CLI 62.1.0 was verified; the previously installed custom 50.37.2 build rejected this Services configuration.

Run from the repository root, retaining the existing project link:

```sh
npx vercel@62.1.0 link
npx vercel@62.1.0 env ls production
sh scripts/deploy.sh --prod --yes
```

Linking is only needed on an unlinked checkout. Set or connect required environment variables before deploying. Use the root as the Vercel project directory, not the frontend or backend subdirectory. Dependency lockfiles and bundled templates must be included in the deployment.

After deployment, confirm the production alias serves the updated frontend and `/api/health` returns 200. Follow [[verification#Live checks]] to validate database, OAuth, streaming, and actual notebook execution; liveness alone does not cover them.

## Troubleshooting

Use production request logs to distinguish function initialization, rendering, Sandbox provisioning, and browser bridge failures. [[editing]] describes the boundaries between those operations.

```sh
npx vercel@62.1.0 logs --environment production --since 10m --limit 100 --json
```

| Symptom | Checks grounded in the implementation |
| --- | --- |
| Root page is a Vercel 404 | Repository root selected; both Services present; frontend catch-all is `/(.*)` |
| API initialization fails | SESSION_SECRET, HTTPS APP_URL (Production), and durable DATABASE_URL scoped to that environment |
| Render endpoint returns 500 | Bundled templates deployed and explicit nbconvert template paths intact |
| OAuth/origin rejection | Project callback configured, client credentials in that environment, browser origin in ALLOWED_ORIGINS, session, and owner login agree |
| Setup stops or errors | Live stage/output, OIDC/Sandbox access, install deadline, Jupyter readiness logs |
| Editor operation returns 409 | Another operation owns the lease or the editor token is stale |
| Editor returns 410 | Sandbox expired/unavailable; reopen from the last durable draft |
| Close feels slow | Browser export, rendering/Blob publication, and database persistence precede Save & exit; kernel cleanup runs afterward |

Jupyter output is redirected to `.jupyter.log` inside the Sandbox. Startup failures retain a bounded excerpt and redact the capability token there. General SDK HTTP logs can still contain sensitive capability URLs; redact them before sharing. Do not restart or stop an active user Sandbox merely to inspect it.


## Published HTML in Blob

[[backend/publication.py]] uploads published HTML to the public `notebook-factory-rendered` store (`store_tQonYaLi3LNwbxCH`, iad1), connected to production. Drafts and notebook source remain in Postgres.

Each publication gets a unique URL with a long cache lifetime. Metadata includes the URL, letting the browser fetch directly from Blob without an additional database render request. HTML is served as a download by Blob, so the frontend fetches it and uses iframe srcdoc. A CSP meta tag inside the artifact preserves content restrictions alongside the iframe sandbox.

The database retains rendered HTML as a fallback. Without Blob credentials, local development uses the original render endpoint. A failed CDN fetch falls back to that endpoint. Existing rows upload their stored HTML once when the render endpoint is visited, guarded by publication revision. Upload failure prevents switching the published database record.

Previously published Blob URLs remain public; this implementation does not garbage-collect old versions or uploads left behind by failed database commits. Automatic browser saves publish changed documents to Blob; unchanged content does not create new artifacts. Source persistence precedes rendering and uploading so a Blob failure does not lose edits.

## Prepared font assets

[scripts/deploy.sh](../scripts/deploy.sh) runs [[scripts/prepare_fonts.py#prepare]] before the Vercel deploy. Unchanged recipes reuse the committed immutable Blob manifest without rebuilding or requiring Blob credentials locally.

When changing the preparation script, run `uv run scripts/prepare_fonts.py` with BLOB_READ_WRITE_TOKEN set, or pass `--env-file` pointing to a private environment file. Commit the resulting [manifest](../backend/assets/fonts.json) alongside the script. The builder pins fontTools and upstream font checksums; the recipe hash invalidates prepared assets when its source changes. Git-based deployments use the committed manifest directly. Blob credentials remain outside the Sandbox, which only receives a public asset URL and checksum.

## Preparing dependency drives

The deploy helper runs `uv run --project backend python scripts/prepare_sandbox.py` after preparing fonts. Vercel credentials must access the linked project; local execution can use its scoped OIDC credentials.

Dependency drives are project-local: preparation rebuilds when the manifest names a drive missing from the current project, including after a team move.

[[scripts/prepare_sandbox.py#prepare]] validates the committed dependency drive or builds and verifies a replacement before deployment. Commit [backend/assets/sandbox-environment.json](../backend/assets/sandbox-environment.json) after rebuilding. Git-based deployments use this manifest directly. Keep previous dependency drives while deployments referencing them are retained. A missing pinned drive triggers a rebuild in the authenticated project. Retired drives and legacy Sandbox snapshots can be removed through Vercel separately.

Update [direct dependencies](../backend/assets/sandbox-requirements.in), then regenerate [the lock](../backend/assets/sandbox-requirements.lock) with `uv pip compile backend/assets/sandbox-requirements.in --python-version 3.13 --python-platform x86_64-manylinux_2_28 --output-file backend/assets/sandbox-requirements.lock` before preparation. No local Docker engine is required.


## Vercel sign-in setup

This implementation requires a fresh database and a Sign in with Vercel application. The repository is linked to the new project in Vercel Internal Playground.

In the target team's Settings → Apps, create an app with Sign-In Access set to **Anyone with a Vercel account**. Enable openid/profile scopes, select client_secret_post authentication, and add an authorization callback by selecting this Vercel project so production and preview domains both work. Store the client ID and secret in VERCEL_APP_CLIENT_ID and VERCEL_APP_CLIENT_SECRET for Production and Preview. Local development can register `http://localhost:5173/api/auth/callback` as well. See [Vercel app configuration](https://vercel.com/docs/sign-in-with-vercel/manage-from-dashboard).

Use a new Supabase database and SESSION_SECRET for the new deployment. No old accounts, notebooks, or GitHub sessions are imported. Startup creates empty tables, enrollment admits the first 300 users, and the database independently caps users at 500. Runtime names and writable drives are user-scoped. Saved notebooks and chats remain publicly readable; mutations require ownership. Deploy frontend and backend together. This application login is separate from Vercel deployment protection.

## Static project documentation

The read-only Lat UI is built with each frontend deployment and served at `/lat/`, including direct document, graph, and linked source-code routes. The About page links to it with “See lat.md project docs”.

[scripts/build_lat_ui.mjs](../scripts/build_lat_ui.mjs) builds the unreleased UI from the main branch of `vercel-labs/lat.md`, logging the resolved commit. It uses Lat’s prebuilt embedding packages, then runs `lat ui build static` with the `/lat/` base path and Lat’s default logo. Only the generated `lat` subtree is copied into the frontend’s public assets; the application’s root page is preserved. Generated output is ignored by Git. Lat’s publication policy excludes ignored files from the exported source views.

The `.github/workflows/static-docs.yml` workflow checks out Lat’s main branch explicitly, runs the shared frontend build on pushes and pull requests, validates static routes with [scripts/check_lat_ui.mjs](../scripts/check_lat_ui.mjs), and uploads the static UI as an artifact. Vercel runs the same build through [frontend/package.json](../frontend/package.json) and serves its output through the existing web service. No runtime Lat server, database, or model credentials are needed. Main is intentionally tracked until the UI is released; an upstream build failure fails deployment instead of silently omitting docs.
