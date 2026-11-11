# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the project owner, managing their own DevOps work.

## Product Purpose

War Room helps its user keep track of work items they have touched and manage their DevOps work from one personal workspace. It supports Azure DevOps and GitHub.

## Positioning

The current Azure DevOps view follows items the user created, edited, commented on, or was assigned, including previous assignments—not only items assigned to them now.

## Operating Context

The app runs locally in a web browser. The user syncs Azure DevOps work items, reviews summaries, searches and filters the results, opens an item for its details and activity, and follows a link to the source item when needed.

The dashboard should surface work that needs attention before the wider workload.

## Capabilities and Constraints

- The app makes read-only calls to the user's Azure DevOps organization and GitHub host.
- The app supports organization URL and Personal Access Token setup, optional project scoping, configurable sync lookback and stale-item thresholds, and local SQLite storage.
- The dashboard supports search, project/priority/label filters, saved views, and an assigned-to-me filter. Work-item type remains visible; state remains visible and searchable. Neither is a filter.
- Inspection Room contains tracked GitHub pull requests and Azure DevOps pull requests the user created or was asked to review. Completed and abandoned pull requests appear under Closed items. Azure DevOps pull requests follow configured project scope. Pull requests do not appear in Briefing Room. Inspection Room keeps its filters, saved views, and columns separate.
- Reading Room keeps a locally saved collection of Azure DevOps and GitHub wikis selected by the user. Adding a wiki starts with a project or repository search, never an organization-wide wiki list. It supports a page tree, read-only documents, current/all-saved wiki content search, and local collection management independent of work-item sync scope. Each browser remembers the last wiki, page, and reading position. Editing stays in the source.
- Reading Room renders Mermaid code fences and Azure DevOps Mermaid blocks locally as noninteractive diagram images. Original diagram text remains available, and rendering errors do not hide the rest of a document.
- Preset views filter the work list to attention-worthy work: Daily digest (due today, overdue, or changed today) and Needs attention (stale open work currently assigned to the user). The stale summary count opens the Needs attention preset.
- The work list shows source due dates instead of iteration. Today and overdue dates have distinct colors and text labels.
- Users can hide unrelated items locally and restore them from Hidden items.
  Current assignment or an explicit mention in the latest comment overrides hiding after sync.
- Item details include why the item is tracked, its fields, description, acceptance criteria, repro steps, attachments, comments, and revision history when available.
- Preserve current functionality and data behavior during the visual redesign.

## Brand Commitments

The product name is War Room.

The app supports Azure DevOps and GitHub. It keeps provider adapters, local item IDs,
source IDs, and sync state separate for each source.

## Evidence on Hand

- The existing implementation and product description are in `README.md`, `public/index.html`, `public/item.html`, and `public/setup.html`.
- No testimonials, customer claims, or other marketing proof are established; do not invent them.

## Product Principles

- Keep the user's personally relevant work visible, including work they touched in the past.
- Make stale or otherwise attention-worthy work easy to spot before showing the full workload.
- Make it easy to understand why an item appears and where to continue working on it.
- Keep the current integration read-only and the app's data local.
- Make future integrations possible without implying they already exist.
