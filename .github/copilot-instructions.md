# Copilot instructions

Use this guide to make changes that fit War Room's local-first design and existing server and browser code.

## Commands

- Install dependencies: `npm install`
- Start the app: `npm start` (opens the server at `http://localhost:4073`)
- Run all tests: `npm test`
- Run one test file: `node --test server/config.test.js`
- Run a named test: `node --test --test-name-pattern="project settings" server/config.test.js`
- Build the Windows launcher: `dotnet publish release/Launcher.csproj --configuration Release --output release/publish`

The app has no separate frontend build step or lint script. The Windows release workflow assembles the launcher, server, static files, and production dependencies.

## Architecture

- `server/index.js` starts the Express server, mounts the work-item API at `/api`, mounts Reading Room at `/api/reading`, and serves the static files in `public/`. Browser code is plain HTML, CSS, and JavaScript; there is no frontend bundler.
- `server/api.js` handles work-item, settings, sync, and detail routes. The main browser pages are Briefing/Discovery/Inspection (`public/index.html`, `public/app.js`), item details (`public/item.html`, `public/item.js`), settings (`public/setup.html`, `public/setup.js`), and Reading Room (`public/reading.html`, `public/reading.js`).
- `server/providers.js` registers the Azure DevOps and GitHub work providers. Their sync and API logic lives in provider-specific modules such as `server/azure-sync.js`, `server/github-sync.js`, `server/ado.js`, and `server/github.js`; `server/sync.js` runs configured providers and combines their results.
- Work items use the shared SQLite store in `server/store.js` (`data/devops-center.db`). A local item ID is distinct from its source ID. Source identity is the combination of `provider`, `source_scope`, and `external_id`; sync state is also kept per provider and scope.
- Reading Room is a separate read-only feature. Its API, source adapters, renderer, and store are in `server/reading.js`, `server/reading-providers.js`, `server/reading-markdown.js`, and `server/reading-store.js`. It keeps its wiki collection and fetched-content cache in `data/reading-room.db`, separate from work-item sync.

## Repository-specific conventions

- Server modules use CommonJS and strict mode. Keep browser code in the existing static files; do not introduce a build step without a requirement.
- A work provider must supply its ID, label, configuration check, scope, sync function and status, history loader, related-links and attachment loaders, and rich-text renderer. Normalize saved items with `provider`, `source_scope`, `external_id`, and a boolean `is_closed`; use the local ID returned by `saveItem()` when recording touches. Unsupported providers should fail explicitly.
- Keep provider state isolated by provider and source scope. Preserve the stable local item ID when updating a source item, and keep Reading Room data in its own store.
- Source access is read-only. Keep credentials and authenticated requests on the server; do not expose tokens to browser code. Render source-provided rich text through the existing Markdown or sanitization helpers.
- Configuration is stored in the repository's `.env`. `server/config.js` gives that file priority over inherited environment variables, and its save path preserves settings it did not receive.
- Tests use Node's built-in test runner (`node:test`). Keep tests with the related server modules as `*.test.js`; use a file path or `--test-name-pattern` to run a focused test.
