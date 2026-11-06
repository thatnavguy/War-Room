# Mission Hall

A lightweight, local-only web app that tracks Azure DevOps work items you have touched:
currently assigned, previously assigned, created, edited, commented, or mentioned in a comment.

## Setup

On Windows, double-click `start-dashboard.bat` to start the dashboard and open it
in your browser. The first run installs the required packages.
If startup fails, check `data\dashboard-error.log` and `data\dashboard-output.log` for details.

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
| `STALE_DAYS` | 14 | Days without update before an open item assigned to you "needs attention" |
| `LOOKBACK_DAYS` | 365 | How far back the first sync deep-scans for your edits/comments |

## Usage

- Click **Sync** to incrementally fetch new/changed items. The first sync is the
  heaviest; later syncs only fetch what changed since the watermark.
- **Needs attention** only includes open items currently assigned to you with no update for the configured number of days.
  It shows the five oldest items first. Its count and summary count use the same rule.
  Work assigned to someone else stays in the main work list, not this section.
  Each row includes its priority level. Missing priorities appear as a dash.
  Choose **View all** to expand the list in place, or **Show fewer** to return to five items.
  This does not change your work filters.
- Search by ID, title, tag, project, or state — results filter as you type.
  Press `/` to focus search, Esc to clear.
- Filter by project, type, state, priority level, label, and assignment to you.
  Iteration and From/To filters are no longer shown. Older saved views ignore those removed filters.
- The work list shows **Due date** instead of Iteration.
  Dates due today are amber. Overdue dates are red. Both include a text label.
  Future dates use normal text. Items without a due date show a dash.
  Dates are compared using your computer's local calendar day.
  Restart the dashboard and sync once after upgrading to load due dates for existing tracked items.
- Save a set of search and filter settings as a named view, then choose it to use those settings again.
  Saved views stay in this browser. Select a view and choose **Delete view** to remove it.
- Labels (Azure DevOps tags) appear beneath titles in the list and in item details.
  The **Label** filter lists labels from touched or mentioned work and matches a whole label, not part of its name.
  The Project filter only lists values from items you have touched or been mentioned on, including closed items.
  Search and filters stay selected when you return from a work item or reload the page in the same tab.
  Use **Clear filters** to reset them.
- Priority level appears in item details, the work-item list, and its own dashboard filter.
  Azure DevOps uses the custom **Priority Level** field when available, or its standard numeric **Priority** otherwise.
  Sync once after upgrading to fetch priorities for previously tracked items. Missing priorities display as a dash.
- On desktop, the navy table header stays visible as you scroll through the work-item list.
- Open an item to see exactly why it's tracked (assigned / created / edited /
  commented / mentioned) and jump to it in Azure DevOps.
- Actual **@mentions of your identity** bring open items into My work after syncing.
  Plain text containing your name does not count as a mention.
  The first sync after this update scans comments on items changed within the configured lookback period.
  If a scan fails, the sync checkpoint stays unchanged so the next sync retries.
  Your name uses an amber highlight in assignment fields, comment authors, and structured @mentions.
- Screenshots in descriptions and comments appear inline. The local server loads
  them with your saved Azure DevOps token; the token is never sent to the browser.
  PNG, JPEG, GIF, WebP, and BMP images up to 20 MB are supported.
- **Attachments** loads the work item's current files without another sync.
  Image files have inline previews. File links open in Azure DevOps, where you may need to sign in.
  File sizes appear when Azure DevOps supplies them. Upload or remove files in Azure DevOps.
- Select **Comments only** beside **Comments & history** to hide field changes
  and revisions without comments. Clear it to see the full history again.
- Use the section menu at the top of a work item to jump to **Description** or **Comments & history**.
  The menu and **My work** back link stay visible as you scroll. The menu only shows sections that are available.
- **Related links** shows existing linked work items, commits, pull requests, and web links, grouped by type.
  Links load live from Azure DevOps; no sync is needed. Attachments remain in their separate section.
  Azure DevOps Git links open directly. GitHub artifact links use an internal repository ID,
  so they explicitly open the source work item in Azure DevOps instead of guessing a GitHub URL.
  Add or edit links in Azure DevOps; Mission Hall remains read-only.
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
