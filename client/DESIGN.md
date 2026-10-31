---
name: QiJuan 栖卷
description: A household library laid out like a reference-work page, used as a working app.
colors:
  ink: "#141210"
  stock: "#f1ebdd"
  stock-raised: "#f7f2e6"
  stock-shade: "#e9e2d2"
  ink-muted: "#665e52"
  hairline: "#b9af9c"
  night-ink: "#ede6d6"
  night-stock: "#16140f"
  night-stock-raised: "#1f1c16"
  night-stock-shade: "#29251d"
  night-ink-muted: "#a79e8e"
  night-hairline: "#4a443a"
  vermilion: "#c23b22"
  vermilion-text: "#b5341d"
  emerald: "#3d7a4e"
  emerald-text: "#356f45"
  ochre: "#b07d25"
  ochre-text: "#8a6216"
  on-vermilion: "#fbf6ec"
  night-vermilion: "#d9553b"
  night-vermilion-text: "#e87a62"
  night-emerald: "#5f9c6f"
  night-emerald-text: "#7fb98e"
  night-ochre: "#c99a45"
  night-ochre-text: "#d8a64c"
  plate-vermilion: "#ba3820"
  plate-ultramarine: "#2f4c8a"
  plate-emerald: "#3a744a"
  plate-ochre: "#8a6216"
  plate-umber: "#5b4433"
  plate-plum: "#6a3550"
  plate-teal: "#2d6468"
  plate-ink: "#f1ebdd"
typography:
  display:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Noto Serif SC, Songti SC, Georgia, serif"
    fontSize: "2.125rem"
    fontWeight: 400
    lineHeight: 1.15
  headline:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Noto Serif SC, Songti SC, Georgia, serif"
    fontSize: "1.375rem"
    fontWeight: 400
    lineHeight: 1.15
  body:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Noto Serif SC, Songti SC, Georgia, serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Noto Serif SC, Songti SC, Georgia, serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.3
  small:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Noto Serif SC, Songti SC, Georgia, serif"
    fontSize: "0.78125rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Noto Serif SC, Songti SC, Georgia, serif"
    fontSize: "0.78125rem"
    fontWeight: 400
    letterSpacing: "0.08em"
    fontFeature: "all-small-caps"
  cjk-mark:
    fontFamily: "Noto Serif SC, Source Han Serif SC, Noto Serif CJK SC, Songti SC, serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1
rounded:
  none: "0px"
  sm: "2px"
spacing:
  xs: "0.3rem"
  sm: "0.6rem"
  md: "1rem"
  lg: "1.6rem"
  xl: "2rem"
  gutter: "clamp(1rem, 2.8vw, 2.5rem)"
  margin-column: "190px"
  thumb-width: "48px"
  bar-height: "58px"
  page-width: "90rem"
  measure: "65ch"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 0.85rem"
    height: "2rem"
  button-hover:
    backgroundColor: "{colors.stock-shade}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 0.85rem"
    height: "2rem"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.vermilion-text}"
    rounded: "{rounded.sm}"
    padding: "0 0.85rem"
    height: "2rem"
  button-danger-hover:
    backgroundColor: "{colors.vermilion}"
    textColor: "{colors.on-vermilion}"
  button-small:
    typography: "{typography.small}"
    padding: "0 0.6rem"
    height: "1.75rem"
  input:
    backgroundColor: "{colors.stock-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 0.6rem"
    height: "2rem"
  segment:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "0 0.75rem"
    height: "2rem"
  segment-checked:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
  plate:
    backgroundColor: "{colors.stock}"
    rounded: "{rounded.none}"
    padding: "4px"
  tag:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.small}"
    rounded: "{rounded.sm}"
    padding: "0 0.4rem"
    height: "1.4rem"
  thumb-tab:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.small}"
    width: "48px"
  thumb-tab-current:
    textColor: "{colors.vermilion-text}"
---

# Design System: QiJuan 栖卷

## Overview

**Creative North Star: "The Lexicon Page"**

The library is a 19th-century reference-work page used as a modern working app: engraving ink on uncoated stock, ranked by rules and hanging heads instead of boxes and size. Every section is an *entry*: a heavy ink rule across the page, a head hanging in a 190px margin column, and the body set to the right. A double head rule carries guide words (the first and last title in view) the way a dictionary's running head does. A thumb index of title initials sits on the right shoulder.

Colour lives in the books. Cover plates are the only saturated surfaces, and the chrome around them stays ink, stock, hairline and muted ink. The three state colours are typographic signals, not fills. Vermilion is the scarcest of them: errors, destructive actions and the current-state marker. The world is a reference *page*, not a costume. It has no fleurons, no ornament and no faux-antique Chinese styling, and CJK and Latin titles sit side by side as equals.

Night inverts the page to stock-on-ink (`prefers-color-scheme: dark`) and keeps the same rules, plates and grammar.

**Key Characteristics:**
- Ink on stock, flat, with no shadows, cards or pills
- Hairline (0.5px), standard (1px) and heavy (1.5px) rules; double head rules on page heads
- Hanging-head entries in a 190px margin column
- Bordered cover plates are the only saturated colour
- One serif family at three sizes plus display, with small caps for apparatus
- Ink-outline controls with 2px corners
- Status carried by the *form* of a rule, not by colour

## Colors

Uncoated stock and engraving ink, with a muted ink for apparatus and a warm hairline for minor rules. Colour is reserved for plates and for three state signals.

### Primary
- **Engraving Ink** (`ink`): text, all 1px and heavy rules, control outlines, the primary button fill, the selected segment and the focus ring. In the night scheme it becomes the light `night-ink`.

### Neutral
- **Uncoated Stock** (`stock`): the page ground, the app bar, the thumb-index shoulder and the plate mat.
- **Raised Stock** (`stock-raised`): the field ground inside inputs, selects and textareas.
- **Stock Shade** (`stock-shade`): the hover fill for outline buttons, segments, thumb tabs and the active file drop.
- **Muted Ink** (`ink-muted`): bylines, meta, hints, small-caps labels, unselected thumb tabs, and the want-to-read and on-hold status marks.
- **Hairline** (`hairline`): 0.5px minor rules between rows, list separators, tag borders, the app bar's bottom rule and the progress track.
- **Night pairs** (`night-stock`, `night-stock-raised`, `night-stock-shade`, `night-ink`, `night-ink-muted`, `night-hairline`): the same roles with stock and ink swapped.

### State
Each state has a base hue for rules and marks and a deeper `-text` tone that keeps contrast on stock.
- **Vermilion** (`vermilion`, `vermilion-text`): error alerts, the destructive button (outline and text, filled only on hover, with `on-vermilion` text), the failed progress fill, and the current-state marker (the 2px rule under the active nav item and the current thumb tab).
- **Emerald** (`emerald`, `emerald-text`): success alerts, success state tags and the succeeded progress fill.
- **Ochre** (`ochre`, `ochre-text`): warning alerts, running and duplicate job states, and the running progress fill. A 30% ochre mix into stock is the text-selection colour (34% at night).

### Plates
Seven fallback cover fills (`plate-vermilion`, `plate-ultramarine`, `plate-emerald`, `plate-ochre`, `plate-umber`, `plate-plum`, `plate-teal`) carry `plate-ink` lettering. A book without a cover image gets one of them. They never appear outside a plate. Plate fills do not change at night.

### Named Rules
**The Colour-in-the-Covers Rule.** Saturated colour appears only inside cover plates. Chrome, controls and section furniture are ink, stock, hairline and muted ink.

**The Scarce Vermilion Rule.** Vermilion marks only errors, destructive actions and the current state (the active nav item and the current thumb band). It never decorates.

**The Tone-for-Text Rule.** State colour on text uses the `-text` tone. The base hue is for rules, fills and borders.

## Typography

**Display, Body and Label Font:** Source Serif 4 Variable (optical sizing on), self-hosted via `@fontsource-variable/source-serif-4`
**CJK Font:** Noto Serif SC at 400 and 600, self-hosted via `@fontsource/noto-serif-sc`, with Source Han Serif SC, Noto Serif CJK SC and Songti SC as fallbacks

**Character:** A single bookish serif in both scripts. Rank comes from rules, weight and hanging position rather than from a large scale.

### Hierarchy
- **Display** (400, 2.125rem, line-height 1.15): page titles, the book title, the auth panel heading and the empty-page heading. Drops to 1.75rem at 760px and below.
- **Headline** (400, 1.375rem, line-height 1.15): entry heads in the margin column and panel heads. The brand mark 栖卷 uses this size in Noto Serif SC at 600.
- **Body** (400, 0.9375rem, line-height 1.5): all running text and controls. Prose is capped at 65ch.
- **Body strong** (600, 0.9375rem, line-height 1.3): book titles in plate captions, rows and continue-reading items, guide words and the active nav item. 600 is the only other weight.
- **Small** (400, 0.78125rem): bylines, meta, hints, counts, the folio and the thumb index.
- **Label** (0.78125rem, `all-small-caps`, 0.08em tracking): apparatus such as field labels, format names (EPUB, PDF), status-mark labels, guide-band meta, toolbar labels, list headings and the account role.

### Named Rules
**The Three Sizes Rule.** Text sizes are small (0.78125rem), body (0.9375rem) and head (1.375rem), plus display (2.125rem) for page titles. Rank comes from rules, hanging heads and weight 600, not from more sizes.

**The Small-Caps Apparatus Rule.** Labels, formats and meta words are small caps at the small size with 0.08em tracking. Values, options and titles keep their case.

**The CJK Equality Rule.** CJK runs get zero letter- and word-spacing, and vertical `vertical-rl` titles on CJK fallback plates. Latin and CJK titles share one sort and one grid.

## Layout

- **Page:** max width 90rem, centred, with a fluid gutter of `clamp(1rem, 2.8vw, 2.5rem)` and 3rem of bottom padding. The 58px sticky app bar has a hairline bottom rule.
- **Entries:** each section is a two-column grid of a 190px margin column (hanging head, meta, and on the catalogue the shelf list) and a fluid body, separated by a 1px ink top rule. At 760px and below the head stacks above the body as one wrapped line.
- **Guide band:** a three-column band (first guide word | library and count meta in small caps | last guide word) over a 1.5px ink rule with a 0.5px ink rule 5px below, forming a double head rule. At 760px the meta drops to a second row.
- **Plate grid:** `auto-fill` columns at a 8.5rem minimum (7rem for Recently added) with gaps of 1.6rem by 1.4rem. At 760px the grid is three columns and Recently added becomes one horizontally snapping row that bleeds off the right edge. At 420px the grid is two columns.
- **Continue reading:** three columns divided by 0.5px hairline verticals, two at 1180px and one at 760px, where items are divided by hairline rows.
- **List view:** ruled rows (cover, title and author, formats, status, rating, action) on 0.5px hairlines. At 760px the language and rating columns drop and the row wraps.
- **Thumb index:** on desktop, a 48px fixed right shoulder below the app bar with a 1px ink left rule, one band per initial (#, A–Z) and a CJK band after Z set off by an ink rule. The page container and folio reserve its width. At 1023px and below it becomes a horizontally scrolling letter row under the guide band with a hairline below, a right-edge fade mask, and the CJK band set off by a 0.5px ink vertical.
- **App bar:** at 1023px and below the navigation collapses into a sheet below the bar (a 1px ink bottom rule over a `scrim`), with hairline-ruled rows and an em dash marking the active item.
- **Folio:** a 0.5px ink rule over the tagline (in the CJK face) and the build id.
- **Breakpoints:** 1180px, 1023.98px, 760px, 480px and 420px, plus a `pointer: coarse` query that raises controls, segments, thumb tabs and shelf buttons to 2.75rem.

**The Hanging Head Rule.** A section's name hangs in the 190px margin column, never as a centred banner above its content.

## Elevation & Depth

The system is flat. No `box-shadow` is used anywhere, and surfaces never lift. Depth and grouping come from rules: a 0.5px hairline for minor separation, a 1px ink rule for entries and controls, and a heavy 1.5px plus 0.5px double rule for page and guide heads. The only layered surfaces are the sticky app bar, the fixed thumb shoulder and the mobile nav sheet. All three are opaque `stock` with an ink or hairline edge, and the sheet sits over a `scrim` (ink at 32% by day, black at 50% at night).

### Named Rules
**The Rules-Not-Boxes Rule.** Group with a horizontal rule and a hanging head. Never wrap content in a filled card or nest one box inside another.

**The No-Shadow Rule.** Nothing casts a shadow. Hover on a plate doubles its ink border with a 1px outline instead of lifting it.

## Shapes

Corners are 2px (`rounded.sm`) on buttons, inputs, tags, keycaps, the account initial and the file drop. Segmented and two-button groups round only their outer corners and overlap shared borders by 1px. Plates and progress tracks are square (`rounded.none`). Rule weights are 0.5px, 1px, 1.5px and a 3px double. Dashed borders mean "not yet", as on the empty file-drop zone and the want-to-read status mark.

**The No-Pill Rule.** Nothing is fully rounded. Tags are 2px-cornered hairline boxes, and counts are plain small-text numerals.

## Components

### Buttons
Ink-outline and typographic.
- **Shape:** 2px corners, 1px ink border, 2rem high (1.75rem for small, 2.75rem on coarse pointers), 0.85rem side padding, body size.
- **Default:** transparent ground with ink text. Hover fills `stock-shade`.
- **Primary:** an ink fill with stock text, at most one per toolbar (for example "Add books"). Hover mixes 86% ink into stock.
- **Ghost:** a transparent border, used for icon buttons in the bar.
- **Danger:** a vermilion border with `vermilion-text`, filled vermilion with `on-vermilion` text only on hover. When disabled it falls back to the ink outline.
- **Pressed / on:** the same ink fill as primary.
- **Disabled:** 45% opacity.
- **Transitions:** background and colour over 120ms ease-out.

### Segmented control
Native radios inside an ink outline. Each segment is a small-caps label in a 2rem ink-outlined cell, with neighbours overlapping by 1px and only the outer corners rounded. The checked segment fills with ink and stock text. Below its fit width the control scrolls as one row and never wraps. The grid/list view switch is the same object built from two icon buttons with `aria-pressed`.

### Inputs / Fields
- **Style:** a 1px ink border on a `stock-raised` ground, 2px corners, 2rem high, body size, and a `ink-muted` placeholder. Selects use a custom ink caret drawn in SVG.
- **Labels:** small caps above the field. Checkboxes and radios use `accent-color: ink`.
- **Search:** a leading icon at the left and a `/` keycap hint at the right.
- **File drop:** a 1px dashed muted-ink box that turns solid ink on a `stock-shade` ground when a file is dragged over it.
- **Disabled:** 55% opacity.

### Focus
Every focusable element gets a 2px solid ink outline at a 2px offset (`:focus-visible` only). Thumb tabs inset the ring by -3px so it stays inside the shoulder.

### Navigation
The app bar holds the 栖卷 brand mark (CJK headline at 600) with the muted "QiJuan" beside it, then the Library and Import items. Admin items (Settings, Backup) are muted and sit after a hairline divider. Items span the bar's full height with a 2px bottom border: hairline on hover, vermilion plus weight 600 on the active item. Search, language select and account (an ink-outlined initial box, the name, and the role in small caps) sit at the end.

### Entry (signature)
The structural unit of every page: a 1px ink top rule, a hanging head (headline size, 400) with small meta below in the 190px margin column, and the body to the right. The first entry after a page header drops its top rule.

### Guide band (signature)
The library's running head: the first and last titles in view, each in weight 600 with its author in the small size, either side of centred small-caps meta (library names and count separated by middots), all over the double head rule.

### Cover plate (signature)
A cover image or fallback inside a square 1px ink border with a 4px stock mat at a 2:3 ratio. A fallback plate takes one plate fill, with the title at body 600 (clamped to six lines) at the top and the author in small text at the bottom, both in `plate-ink`. CJK titles set vertically in Noto Serif SC at the top right. Captions below give the title (600, two lines), the author with small-caps formats, then the status mark, favourite and rating. Hover underlines the title and doubles the plate border.

### Status mark (signature)
The reading status is a 0.9rem leading rule plus a small-caps label, and the *form* of the rule carries the state:
- **Reading:** a solid 1.5px ink rule
- **Want to read:** a dashed rule in muted ink
- **Finished:** a solid ink rule struck through by a short slanted stroke
- **On hold:** a 3px double rule in muted ink

On the book page the reader sets the status with a stepper, not a menu or a segmented control. It spans the left column with no box, only a hairline rule above and below, and stays about 3.5rem tall. The centre names the current state in full, at body size in ink at 600 and in normal case ("Want to read", "Reading", "On hold", "Finished"), after its status mark with a slightly longer 1.1rem rule. With no status it shows "No status" in muted ink at the same size and weight 400. Under the name a three-stage progress line spans the centre: three equal segments for Want, Reading and Done, 3px apart, each over its short name in small caps (CJK names are not tracked). The current stage's name is ink and the others are muted. A stage not reached is a 1px hairline, and each reached stage is a 2px ink rule, so the line fills from one segment (want to read) to two (reading) to all three (finished). On hold draws the first two segments as a dashed 2px ink rule and leaves the third a hairline; the name above says it is on hold. The line repeats the name, so it is hidden from assistive technology. The sequence is none, want to read, reading, on hold, finished. A bare muted chevron at each side steps back or forward. Chevrons darken to ink on hover and fade to 30% at the ends, because the sequence does not wrap. The name slides 6px in the direction of travel and fades in over 140ms. Each step shows at once. The save waits until the steps stop, about half a second, and sends only the final state.

### Thumb index (signature)
The bands are #, A–Z and a CJK band (labelled 中文 or CJK). Each band jumps to the catalogue page holding its first title and does not filter. Bands are small text in muted ink. Bands in view are ink, and empty bands are disabled at 55% muted ink. The current band is `vermilion-text` at 600 over a centred 0.9rem by 2px vermilion rule, the same current-state marker as the active nav item. It is a right shoulder on desktop and a letter row at 1023px and below.

### Alerts and state tags
Alerts are rule-bounded text bands: a top and bottom border in the state's base hue with text in its `-text` tone, and no fill. Info alerts are muted. State tags are small-caps text in the state tone. Progress is a 1px hairline track with a 3px fill in ink, emerald, ochre or vermilion that animates its width over 240ms ease-out.

### Tags
Small muted text in a 1px hairline box with 2px corners. They are used for metadata values, never as filled chips.

### Empty and loading states
An empty state is an italic title with a muted description at the small size, laid out flush left. Loading skeletons are hairline plate outlines and underline-only lines that fade between 45% and 100% opacity (`settle`, 1.1s ease-out, alternating).

### Motion
Motion is minimal and functional: button colour over 120ms, the batch-panel chevron rotating over 160ms, the status stepper label sliding in over 140ms, progress width over 240ms, the skeleton fade and a 900ms linear spinner. Under `prefers-reduced-motion: reduce`, durations collapse to 0.01ms and smooth scrolling is off.

## Do's and Don'ts

### Do:
- **Do** rank sections with an ink rule and a hanging head in the 190px margin column.
- **Do** use the double head rule (1.5px ink with 0.5px ink 5px below) for page and guide heads.
- **Do** keep saturated colour inside cover plates and use vermilion only for errors, destructive actions and the current-state marker.
- **Do** set apparatus (labels, formats, meta) in small caps at 0.78125rem with 0.08em tracking.
- **Do** carry state with the form of a rule (solid, dashed, struck, double) before reaching for colour.
- **Do** use 1px ink-outline controls with 2px corners, the ink-filled primary, and the 2px ink focus ring at a 2px offset.
- **Do** treat CJK and Latin titles as equals in the same grid, sort and type sizes.

### Don't:
- **Don't** add fleurons, dingbats, ornamental borders or any fake-antique Chinese costume. The page is a reference work, not a period piece.
- **Don't** invent pinyin. CJK titles form one band until a real pinyin sort key exists.
- **Don't** use SaaS stat cards, pills, badges or cards nested in cards.
- **Don't** add box-shadows or lift surfaces on hover.
- **Don't** introduce new text sizes beyond small, body, head and display, or weights beyond 400 and 600.
- **Don't** use plate colours or state colours as decorative fills in the chrome.
