# Momentum design system

## Overview

Momentum is a one-page Sepolia pool interface for people inspecting a streak before swapping ETH/MOMO or donating accrued hook fees. The implemented character is quiet, editorial and compact: a warm off-white canvas, dark streak panel, lime primary action, large numeric fee readouts and restrained outlines. The page uses real pool data, explicit transaction steps and persistent explanations of PoolSwapTest's limitations.

Source of truth: `web/src/style.css` and the semantic sections in `web/src/App.tsx`. The design was inferred from the task; there was no supplied brand kit. The root-level DESIGN.md requested elsewhere in the task is outside the overriding write scope, so this file is the authorized equivalent.

## Colors

Colors use one sRGB hex notation. Semantic CSS variables in `:root` are reused for surfaces, text and controls.

| Token | Value | Role |
| --- | --- | --- |
| `--page` | `#f5f4ee` | Page and input background |
| `--surface` | `#fffef9` | Swap card and selected direction |
| `--ink` | `#232622` | Body, heading and button text |
| `--muted` | `#62665b` | Secondary text |
| `--line` | `#d6d8cc` | Structural dividers and card borders |
| `--control` | `#858b7a` | Interactive outlines |
| `--accent` | `#c9f36b` | Primary action, streak bars and brand mark |
| `--accent-hover` | `#b9e554` | Primary action hover |
| `--dark` | `#242b23` | Streak panel |
| `--on-dark` | `#f2f3e7` | Primary streak-panel text |
| `--dark-muted` | `#c2cbb8` | Secondary streak-panel text |
| `--warning` / `--warning-ink` | `#fff2d9` / `#784608` | Wrong-network and failed-read notices |
| `--error` | `#a12e27` | Recoverable transaction/form errors |
| `--focus` | `#416711` | Three-pixel keyboard outline |

Donation uses a quieter `#eeeee4` surface. Buy/sell event badges pair text and arrows with muted green/brown backgrounds; meaning never relies on color alone. Inactive streak bars use `#4b5446`. Disabled controls use neutral fills and remain legible, with accompanying reasons for unavailability. This is a single light theme; no dark theme is claimed. The dark streak panel is a component surface, not a separate theme.

Measured rendered contrast: muted/page 5.34:1, secondary streak text/dark panel 8.67:1, primary fee numbers/dark panel 12.98:1, router note/swap surface 5.82:1, donation description/surface 5.04:1. The disconnected disabled primary button measured 4.20:1; inactive controls are exempt from text contrast requirements. Measurement details are in `evidence/live-browser.json`. Enabled controls were also included in the automated desktop/mobile accessibility scans.

## Typography

The system stack is `Arial, Helvetica, sans-serif`; there are no remote or bundled font assets. Actual fallback rendering depends on the operating system. Weights used are 400, 500, 600 and 700; root font smoothing is enabled and synthetic font faces are disabled.

- Root: 16px, unitless 1.55 line-height. Body and instructional text: generally `--text-body: .9375rem` (15px), with 1.5–1.6 line-height.
- Supporting UI: `--text-small: .8125rem` (13px); compact metadata is 12px. Uppercase eyebrow labels have `.13em` tracking and weight 700.
- Main heading: `clamp(2.8rem, 5.2vw, 4.25rem)`, 1.02 line-height, weight 500 and `-.065em` tracking. Responsive rules reduce it to a 2.65rem minimum-screen treatment.
- Section headings: 1.375–2.1rem according to hierarchy; the streak card's section label is 1rem. All remain subordinate to the main h1.
- Streak value: 6.4rem desktop, reduced at narrow breakpoints. Fee values: 2.5rem. Amount fields and estimates: 2rem, reduced to 1.75rem in the narrowest layout.
- Numeric values use `font-variant-numeric: tabular-nums`. IDs use monospace and wrap rather than disappearing. Account shortening is complemented by its full value in deployment details.
- Headings use `text-wrap: balance`, descriptions use `pretty`, and long explanatory copy is constrained to about 65 characters. Form input text remains at least 16px on mobile.

## Layout

`.shell` sets a 1200px maximum width and 32px inline padding. Sections align to that edge. The header separates identity from wallet/network state; the introductory title leads into the live pool panel and swap controls.

`.dashboard` is a two-column grid, `1.35fr / 1fr`, with a 24px gap. The streak and donation occupy the leading column; the swap spans both rows of the trailing column. DOM order is streak, swap, donation, matching the mobile reading and keyboard order. General spacing uses 6/8/12/16/24/28/32px increments, with larger space between sections than within controls.

- At 60rem and below: 24px page padding, 18px grid gap, tighter card padding and `1.1fr / 1fr` columns.
- At 46rem and below: one dashboard column, order streak → swap → donation; the decorative market motif is hidden, network/account controls wrap, and the rules section becomes one column.
- At 25rem and below: 16px page padding, 20px card padding, smaller display numbers and compact bars.

The history table scrolls within `.table-wrap` instead of widening the document. The region is keyboard-focusable and its accessible name explains horizontal scrolling. Main controls are at least 44px high, and form actions remain inside card padding. There are no sticky overlays.

Reflow was checked at 1440, 820, 390 and 320 CSS pixels, plus 200% text enlargement at 820px. The production app was inspected at desktop/mobile sizes with both mocked and live public reads. Native browser zoom, physical devices and RTL/localized content were not tested.

## Elevation & Depth

The interface is mostly flat. Outlines define control boundaries and grouped sections. The swap card has one subtle shadow, `0 4px 16px #23262206`; the selected direction has `0 1px 2px #23262208`. The streak panel uses a solid dark surface. Do not add glass layers, gradients or floating overlays to imitate hierarchy already supplied by space and type.

## Shapes

The shared card radius is `--radius: 20px`. Input/output panels use 12px, the direction group 10px, buttons 8px, select 6px, and status/event tags 5px. Token labels are small pill shapes. The streak graphic is eighteen narrow, rounded bars, capped visually at eighteen while the exact streak number remains visible. It is decorative and hidden from assistive technology; it is not a historical chart.

## Components

These are implemented patterns within `web/src/App.tsx`, not a separate component library.

- **Wallet bar:** plain outlined connect/disconnect actions, network label and readable connected account. Unknown-chain fallback uses the supplied add-chain metadata. Wrong-network notices expose one switch button.
- **Streak card:** pool direction/count, decorative capped bars, and next buy/sell fee pair. Loading uses em dashes; stale/error states do not invent values.
- **Swap form:** native direction buttons with `aria-pressed`, labelled decimal input, output panel, labelled price-limit select, quote status, acceptance checkbox, approval and confirmation actions. `.primary` marks the quote action; outlined follow-up actions describe their exact consequence.
- **Donation card:** both accrued currency values, a gas-only explanation, and one outlined donate action. Disabled explanations distinguish disconnected wallet, no fees and no active liquidity.
- **History table:** semantic headers and rows, direction text/arrows, fee units and explorer links. Empty/loading/error states are explicit; refresh is always discoverable.
- **Feedback:** a stable `role=status` for pending/confirmed work and `role=alert` for errors. No transient toast hides an actionable failure. Errors focus invalid amount input when parsing fails.
- **Deployment disclosure:** native `details/summary`, full contract addresses, pool ID, connected wallet and runtime manifest link.

Keyboard focus uses a 3px solid outline with a 4px offset. Native controls supply keyboard semantics. Hover styles only apply on hover-capable devices. Under `prefers-reduced-motion: no-preference`, buttons use 120ms background/transform transitions and a `.96` pressed scale. Reduced motion removes these transitions. Forced-colors mode uses system outlines and control borders. There is no animated entrance, autoplay or modal.

## Do's and Don'ts

- Start any added section with the existing `.shell`, `.section-top`, heading and explanatory text patterns. Reuse the spacing and semantic color variables.
- Use a native button for an action and a real link for a destination. Keep full values reachable when using shortened labels.
- Preserve one clearly emphasized primary action and explicit disabled-state explanations. Keep simulation and wallet confirmation separate.
- Preserve the distinction between an estimated output, a pool-price limit and an onchain output guarantee. The approved router only provides the second.
- Keep the DOM and narrow-screen order consistent. Put wide data inside its own keyboard-accessible scroll region.
- Do not replace missing chain data with illustrative metrics. Do not add fonts, themes, gradients or animation unless a product need justifies them.

Design guidance attribution: Jakub Krehel, Better Interface, MIT, pinned commit `267330e1adfc66a718fb65fa6918c1f06d0a689e`. Documentation method: Paul Bakaus, Impeccable, Apache-2.0, pinned commit `9d715cc4f5564a990ca8345abfdd5df6dc9b41c8`. Source links are retained in `web/README.md`; both upstream works retain their original licenses.
