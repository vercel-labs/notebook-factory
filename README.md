# Notebook Factory

A notebook publishing workspace with Jupyter editing in Vercel Sandbox and an AI assistant.

## How to deploy to your own Vercel team

1. Fork or clone the repo
2. Run `vercel link` and create a new project
3. The project uses Neon and Vercel Blob, install them from Marketplace:

```bash
vercel integration add neon -m region=iad1 -e production -e preview --no-env-pull
vercel blob create-store notebook-factory-rendered --access public --region iad1 --yes -e production -e preview
```

4. Configure Sign in with Vercel from the UI:

    - From `vercel.com/<team-slug>` go: Team Settings > Apps > Create App. Put Client ID in your project's env:

    ```bash
    vercel env add VERCEL_APP_CLIENT_ID production
    vercel env add VERCEL_APP_CLIENT_ID preview
    ```

    - In Authorization Callback URLs choose your project from the dropdown, and set the callback endpoint to `/api/auth/callback`
    - In Authentication tab, generate a new client secret and add it to the env too:

    ```bash
    vercel env add VERCEL_APP_CLIENT_SECRET production --sensitive
    vercel env add VERCEL_APP_CLIENT_SECRET preview --sensitive
    ```

    - In the Permission tab, toggle `openid` and `profile`

5. Set `APP_URL` and `SESSION_SECRET`, both of which are required for the app to run. `APP_URL` is your production domain (Production only; previews use their own URLs). Use a separate secret for Preview:

    ```bash
    vercel env add APP_URL production --value https://<your-production-domain>
    openssl rand -hex 32 | vercel env add SESSION_SECRET production --sensitive
    openssl rand -hex 32 | vercel env add SESSION_SECRET preview --sensitive
    ```

Finally, run `scripts/deploy.sh`, that'll prepare the Sandbox environent and run the deployment.

```bash
./scripts/deploy.sh --prod
```

## Documentation

Project documentation lives in [lat.md/](lat.md/lat.md):

- [Architecture](lat.md/architecture.md)
- [Local development](lat.md/deployment.md#local-development)
- [Environment configuration](lat.md/deployment.md#environment-configuration)
- [Deployment](lat.md/deployment.md#deploy-procedure)
- [Notebook editing and publishing](lat.md/editing.md)
- [AI chat](lat.md/chat.md)
- [Testing and verification](lat.md/verification.md)
