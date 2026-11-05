# Mission Hall

A lightweight, local-only web app that tracks Azure DevOps work items you have touched:
currently assigned, previously assigned, created, edited, or commented.

## Setup

1. `npm install`
2. `npm start` → http://localhost:4073
3. Open the **setup page** (linked on the dashboard, or http://localhost:4073/setup.html)
   and enter your organization URL (e.g. `https://dev.azure.com/myorg`) and a
   Personal Access Token with **Work Items (Read)** scope. Save — that's it.

Prefer files? You can also copy `.env.example` to `.env` and fill it in manually.
The setup page writes to the same `.env` file.

## Optional settings (.env)

| Setting | Default | Purpose |
|---|---|---|
| `PROJECTS` | all projects | Comma-separated project names to limit sync scope |
| `PORT` | 4073 | Local server port |
| `STALE_DAYS` | 14 | Days without update before an open item "needs attention" |
| `LOOKBACK_DAYS` | 365 | How far back the first sync deep-scans for your edits/comments |

## Usage

- Click **Sync** to incrementally fetch new/changed items. The first sync is the
  heaviest; later syncs only fetch what changed since the watermark.
- Search by ID, title, tag, project, or state — results filter as you type.
  Press `/` to focus search, Esc to clear.
- Filter by project, type, state, iteration, priority level, and date range.
  The project filter only lists projects with items you have touched, including previously touched closed items.
- Priority level appears in item details, the work-item list, and its own dashboard filter.
  Azure DevOps uses the custom **Priority Level** field when available, or its standard numeric **Priority** otherwise.
  Sync once after upgrading to fetch priorities for previously tracked items. Missing priorities display as a dash.
- On desktop, the navy table header stays visible as you scroll through the work-item list.
- Open an item to see exactly why it's tracked (assigned / created / edited /
  commented) and jump to it in Azure DevOps.
- Screenshots in descriptions and comments appear inline. The local server loads
  them with your saved Azure DevOps token; the token is never sent to the browser.
  PNG, JPEG, GIF, WebP, and BMP images up to 20 MB are supported.
- Select **Comments only** beside **Comments & history** to hide field changes
  and revisions without comments. Clear it to see the full history again.
- Use the section menu at the top of a work item to jump to **Description** or **Comments & history**.
  The menu stays visible as you scroll. It only shows sections that are available.
- Closed and Removed items are hidden everywhere.

Data lives in `data/devops-center.db` (SQLite). Nothing leaves your machine
except read-only calls to your Azure DevOps org.

## Work sources and future GitHub support

Azure DevOps is the only supported connection today. GitHub is not connected or synced yet.
Settings separates the connection from the workspace. Each item's source appears in its details
and controls the **Open in …** link. A source filter appears when multiple providers are implemented.

The app now separates local item IDs from source IDs. An item is unique by provider,
source scope, and external ID. For Azure DevOps, the scope is the organization URL.
For GitHub, use the host and repository together, not the issue number alone.
Existing item links, comments, and saved data keep their local IDs after migration.
Sync checkpoints and profile names are also separate for each provider and scope.

To add a provider, register its adapter in `server/providers.js`. It must supply its ID, display name,
connection check, scope, sync functions, history loader, and safe rich-text renderer.
Keep API calls and source-specific field mapping inside that provider's implementation.
`server/azure-sync.js` is the existing Azure DevOps implementation.

Save normalized items through `server/store.js` with `provider`, `source_scope`,
`external_id`, and an `is_closed` boolean. Use the local ID returned by `saveItem()`
when recording touches. Use external IDs for remote calls and display.
History must return the existing `{ rev, date, by, comment, changes }` entries;
comments must be safe HTML. The authenticated screenshot endpoint remains Azure DevOps-only.
Do not send another provider's URLs or credentials through it.

GitHub authentication, issue and pull-request mapping, Markdown rendering, and screenshot
access still need implementation. Extending the connection forms and sync controls is also required.
Unknown providers fail explicitly rather than returning empty results.
Saving Azure DevOps settings preserves unrelated `.env` entries.

Run the regression checks with `npm test`.
