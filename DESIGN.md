---
name: Mission Hall
description: A precise local board for Azure DevOps work.
colors:
  page: "#f4f6f7"
  surface: "#ffffff"
  ink: "#162636"
  muted: "#647586"
  line: "#d9e0e4"
  line-strong: "#c8d1d8"
  rail: "#10243a"
  rail-hover: "#243d56"
  rail-ink: "#f4f6f7"
  rail-secondary: "#b9c8d6"
  rail-rule: "#40556a"
  rail-mark: "#e6b34a"
  connected: "#3e85b8"
  accent: "#1d5274"
  accent-hover: "#183f5c"
  attention: "#e14c3c"
  attention-surface: "#fae4db"
  signal-amber: "#e6b34a"
  state-surface: "#e7edf1"
  state-ink: "#344f63"
  error: "#a83e30"
  focus: "#3e85b8"
  board-hover: "#1b334b"
  board-rule: "#40556a"
  notice-rule: "#edac97"
  notice-ink: "#68291f"
  notice-support: "#80392f"
  notice-link: "#873528"
  surface-hover: "#edf2f5"
  row-hover: "#e7edf1"
  code-surface: "#edf1f3"
  history-surface: "#e9eff3"
  form-placeholder: "#647586"
typography:
  display:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "27px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.2
  compact-headline:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.2
  section:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 650
  item-section:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 650
  detail-value:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 400
  detail-label:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  item-metadata:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
  section-compact:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 650
  body:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  intro:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  control:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  metadata:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  label:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 600
  caption:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 600
  dense-table:
    fontFamily: "Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "9px"
    fontWeight: 600
rounded:
  subtle: "3px"
  control: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "38px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "38px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 9px"
    height: "36px"
  nav-link-active:
    backgroundColor: "{colors.rail-hover}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "42px"
  state-tag:
    backgroundColor: "{colors.state-surface}"
    textColor: "{colors.state-ink}"
    rounded: "{rounded.subtle}"
    padding: "3px 7px"
---

# Design System: Mission Hall

## Overview

**Creative North Star: "Departure Board"**

Mission Hall helps its owner scan personally relevant Azure DevOps work and spot items that have gone unchanged. The screen keeps familiar navigation, search, filters, and a complete work-item table; the visual direction borrows a departure board's disciplined columns, tabular figures, and clear signal colors without turning the interface into a flight simulator.

The signature move is the dark attention board: age, work item, project, state, and last-changed date line up in a stable row. Amber makes elapsed time easy to find, while a restrained red signal marks stale work. These are real elapsed days and changed dates, never due dates or schedules that the data does not contain.

**Key Characteristics:**
- Deep navy navigation and attention board, framed by a cool, light workspace.
- Crisp aligned columns and tabular figures for quick comparison.
- Red and amber carry attention meaning; blue marks interaction.

## Colors

Deep navy anchors the shell and the attention panel; cool slate neutrals support the wider workspace; signal red and amber are reserved for stale status and age.

### Primary
- **Departure Navy** (`#10243a`): Navigation rail, primary actions, and the attention-board surface.
- **Signal Blue** (`#3e85b8`): Focus treatment and connection indicator.
- **Work Blue** (`#1d5274`): Links and interactive text on light surfaces.

### Secondary
- **Signal Red** (`#e14c3c`): Small stale-work marker and attention count on the board.
- **Elapsed Amber** (`#e6b34a`): Time unchanged and the brand mark.

### Neutral
- **Cool Work Surface** (`#f4f6f7`): Main background.
- **White Surface** (`#ffffff`): Forms, fields, and content surfaces.
- **Slate Ink** (`#162636`): Main text and headings.
- **Muted Slate** (`#647586`): Supporting text and labels.
- **Board Secondary** (`#b9c8d6`): Supporting information on navy.
- **Board Rule** (`#40556a`): Dividers on navy.
- **Fine Rule** (`#d9e0e4`): Rows and section separators.
- **Strong Rule** (`#c8d1d8`): Structural borders and control outlines.

### Named Rules
**The Real Schedule Rule.** Show only recorded work-item facts: elapsed time since last change and its actual date. Never invent due dates, departure times, or workflow order.

## Typography

**Display Font:** Segoe UI (with Helvetica Neue, Arial, sans-serif fallbacks)  
**Body Font:** Segoe UI (with Helvetica Neue, Arial, sans-serif fallbacks)  
**Label/Mono Font:** Segoe UI with tabular numerals; no separate monospace face.

**Character:** A familiar interface sans keeps the board legible as a working product. Tabular figures align counts and elapsed days; compact uppercase labels create clear column landmarks without overwhelming the data.

### Hierarchy
- **Display** (650, 27px, 1.2): Dashboard title.
- **Headline** (650, 21–24px, 1.2): Item and settings page titles, including compact screens.
- **Section heading** (650, 20px on item details, 16–17px elsewhere): Separates content sections.
- **Body** (400, 17px, 1.5–1.65): Work-item descriptions, comments, and general reading; rich text uses the available content width.
- **Field value** (400, 19px, 1.5): Work-item detail values.
- **Field label** (600, 14px): Labels in the work-item detail grid.
- **Metadata** (400, 15px): Touch reasons, revision details, and supporting item information.
- **Compact label** (600, 9–13px): Board headings, form labels, and other dense interface labels.

## Layout

The wide layout uses a fixed 224px navigation rail and a centered content region. At medium desktop widths the rail narrows to 196px. At 960px and below, navigation becomes a horizontal top strip, the dashboard table becomes labeled work-item rows, and filters wrap to available space. At 420px and below, horizontal padding and navigation gaps tighten further.

The dashboard order is heading and sync action, the needs-attention board, compact workload counts, then search, filters, and all touched work. The attention board aligns age, item, project, state, and last-changed date. On narrow screens each row becomes a readable stacked record while retaining elapsed time as its own signal. Optional breakdowns remain collapsed.

Work-item details use the full workspace width for field values, descriptions, acceptance criteria, repro steps, and revision history. Rich text wraps within that space without a separate narrow-column limit.

Work-item pages have a sticky section menu for quick jumps to available sections and an Open in Azure DevOps link. Section dividers separate long descriptions from activity. Every section uses the same navy heading bar, including Details and Why it’s in your work list. The Comments only filter sits inside the Comments & history heading bar.

The workspace uses Work sources and Connections as shared labels. Provider-specific forms keep their actual provider names.
Item details identify the source, and the sticky menu uses Open in followed by that source's name.
Only implemented providers appear; the source filter stays hidden when there is a single provider.

Priority level is a text value in Details, a work-item list column, and a dashboard filter. On narrow screens it sits beside the item ID. Show the source's actual label without invented severity colors. Touch type is not a dashboard filter; touch activity remains available in item details.
The project filter lists only projects with recorded touch activity.

The desktop work-item table uses navy column headers with light text, matching section heading bars.
Column headers stay below the workspace toolbar while scrolling through the list.
Narrow screens retain the labeled item layout rather than a sticky table header.

Related links uses the shared navy section heading and a sticky-menu shortcut. Group links by their actual relation type,
with link text, supplied update dates, and comments. Unresolved artifact links clearly point back to Azure DevOps.

## Elevation & Depth

The system is flat by default. Fine borders and the navy board surface establish hierarchy; shadows are limited to the expanded breakdown panel.

### Shadow Vocabulary
- **Breakdown panel** (`0 8px 20px rgb(16 36 58 / 12%)`): Separates the open summary panel from nearby content.

## Shapes

Controls and surfaces use restrained 3–4px corners. Thin rules define structure; avoid pill-shaped containers and heavy outlines. The attention board is a continuous panel, not a stack of floating cards.

## Components

### Buttons
- **Shape:** Compact, lightly rounded (`4px`).
- **Primary:** Departure navy fill with light text, 38px minimum height.
- **Secondary:** White surface with slate text and a strong neutral outline.
- **Hover / Focus:** Darken the navy fill on hover; show a distinct 3px blue focus outline for keyboard use.

### Chips
- **Style:** State labels use a cool slate surface and dark slate text with a subtle 3px corner.
- **State:** Stale state uses a pale red surface and dark red text; preserve the distinction semantically.

### Cards / Containers
- **Corner Style:** 3–4px.
- **Background:** White against the cool work surface; navy for the attention board.
- **Shadow Strategy:** Flat at rest; use the breakdown-panel shadow only while that panel is open.
- **Border:** Thin neutral rule.
- **Internal Padding:** 13–22px according to component density.

### Inputs / Fields
- **Style:** White surface, slate text, 1px strong neutral border, 4px corners.
- **Focus:** Signal-blue border or a visible 3px blue focus outline.
- **Error / Disabled:** Use clear text status and preserve a visible disabled state.

### Navigation
- **Style:** A deep navy desktop rail with light labels and a quiet filled active state. At 960px and below it becomes a horizontal top strip. Keep the product mark and navigation icons as inline SVG.

### Attention Board
- **Signature:** A continuous navy panel with stable columns for elapsed days, item, project, state, and last-changed date. Amber highlights age; a small red signal denotes stale work. Use actual item data only.

## Do's and Don'ts

### Do:
- **Do** show items needing attention before the full work list.
- **Do** keep data dense but readable with aligned columns and ruled separators.
- **Do** use tabular figures for counts, dates, and elapsed time.
- **Do** keep Azure DevOps read-only and local-storage language factual.
- **Do** preserve visible keyboard focus and the labeled mobile table rows.

### Don't:
- **Don't** invent due dates, departures, schedules, or workflow sequences.
- **Don't** use red or amber as general navigation and action colors.
- **Don't** bury the work list beneath large metric panels.
- **Don't** imply that GitHub integration is already available.
- **Don't** add decorative shadows, gradients, or heavily rounded card grids.
