# Worker validation — Momentum frontend

Status: **Implementation and worker validation complete; Git commit blocked by the environment.** This is a worker report, not independent certification. The only requested artifact location that could not be honored literally is root `DESIGN.md`: the overriding path budget forbids it. Its complete content is delivered as `docs/DESIGN.md`. No protected root configuration, Solidity source, library, original ABI, or deployment was changed.

## Scope and assumptions

One static page: live streak/direction, both next fees, bounded Momentum history, accrued fees and donation, wallet connection, and exact-input swaps through the workflow's PoolSwapTest. React/TypeScript/Vite/wagmi/viem, relative base, no backend. Testnet context is visible. The launch's native-ETH pool is derived from handoff pool fields and deployed token/hook addresses.

The workflow's explicit PoolSwapTest routing overrides the background UniversalRouter recipe. The network block has no PoolSwapTest field, so the manifest carries one documented routing extension; quoter/StateView/PoolManager come from the unchanged supplied network block. No independent compiled deployment map exists. PoolSwapTest cannot enforce minimum output or a deadline, so the UI explicitly describes its pool-price bound, partial fills and fee changes, requires acknowledgment, and never promises a minimum receive amount.

## Commands and results

Executed from repository root on 2026-09-27 with Node 22.23.2 and npm 10.9.8:

| Check | Result |
| --- | --- |
| `npm ci --offline --prefix web --cache "$PWD/test/scratch/npm-cache"` | Passed; lockfile reinstall using populated worker cache, 117 packages, no vendored cache submitted |
| `npm --prefix web run typecheck` | Passed, TypeScript 5.9.3 |
| `npm --prefix web test` | Passed, 7 tests with Vitest 5.0.2 |
| `npm --prefix web run build` | Passed, Vite 7.3.6; regenerated static export and manifest after last source change |
| `npm --prefix web run verify:export` | Passed, 9 complete asset hashes and both implementation ABI hashes |
| `PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" node web/scripts/browser-check.mjs` | Passed, 32 browser checks on Chromium 153.0.8010.12 |
| `PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" node web/scripts/live-browser.mjs` | Passed, actual browser/public-RPC reads, desktop/mobile rendering, no failed requests or uncaught script errors |
| `node web/scripts/live-check.mjs` | Passed, read-only RPC checks pinned at block 11791497, including real V4Quoter simulation |
| `npm --prefix web audit --cache test/scratch/npm-cache` | 0 vulnerabilities after updating wagmi and Vitest |
| Independent Python export inventory against original supplied reads | Passed; exact contract set/identifiers, unchanged network and add-chain parameters, all SHA-256 hashes |

The build emits nonfatal dependency `use client` directive notices and a bundle-size advisory for the main 609,183-byte chunk. The complete export is 666,593 bytes including its manifest; the largest file is 609,183 bytes. Nine assets are far below the 128-file limit, every file is below 8 MiB, and two exported copies fit comfortably inside the HTTP response budget. No source maps, package archives, dependency directories or caches are exported.

Unit coverage: strict decimal parsing/overflow rejection; dust formatting; directional integer square-root bounds; signed packed delta decoding; implementation ABI canonical Keccak; exact unknown-chain add parameters; rejected-switch behavior.

Browser scenarios include disconnected gating, live metric rendering, wallet connection, invalid input and focus, insufficient balance, attested quote/router addresses, buy ETH value, sell exact-amount approval, sell settlement, donation, confirmation/refresh, quote expiry and edit invalidation, simulation failure, rejected wallet request, reverted receipt, missing wallet, unknown-chain fallback, missing code, RPC failure/retry, ABI tampering, zero-liquidity first-buy availability, empty history, bounded event chunking, keyboard buy completion, and responsive/accessibility checks. Transaction signing and receipt scenarios use mocked providers; no test could broadcast a real transaction.

## Better Interface review

The pinned workflow and core principles from all six domains were read before implementation. This consolidated review applies their guidance to the final source/export. Source references use the final implementation.

| Domain | Coverage and evidence | Unperformed / not applicable |
| --- | --- | --- |
| Accessibility — Checked | Native controls, labels, pressed direction state, skip link, heading order, stable status/alert regions, explicit disabled reasons, 44px actions, keyboard buy flow; visible focus screenshot; axe desktop/mobile report 0 A/AA violations | No screen-reader session, physical-device test or full accessibility certification. Native zoom untested; text enlargement tested separately. No modal to test |
| Layout — Checked | Final production export at `/preview/`; 1440/820/390/320px widths have no document overflow. Desktop and mobile screenshots inspected. Mobile DOM order corrected. 200% text enlargement at 820px passes reflow; table overflow stays inside its region | No RTL/localization; English-only assignment. Only named viewports tested |
| Writing — Checked | Action labels name quote/approve/confirm/donate consequences; testnet and gas ownership explicit; recoverable errors, empty history and stale-value warning; no invented metrics or minimum-output claim | Publication names/URLs intentionally absent because publication is a later stage |
| Typography — Checked | System sans stack; descending heading hierarchy, tabular values, wrap-safe IDs, minimum 16px form input text; reviewed actual long address/quote text and 320px reflow | System font fallback depends on OS; no custom-font claim |
| Colors — Checked | Semantic role tokens; actual rendered color/background measurement in live Chromium. Main text pairs 5.04–12.98:1; enabled controls included in axe scan; disabled primary 4.20:1 is exempt. Text/arrows accompany buy/sell states | Single light theme; alternate themes not applicable. No claim that every possible state pair was manually measured |
| UI — Checked | Loading, populated, empty, error, wrong-network, disabled, quote and confirmed states exercised. Outlined secondary controls and lime primary action. Reduced-motion test reports 0s transition; native disclosures; no entrance animation | No physical touch or animation-panel slow-motion review; no autoplay/modal/tooltip flows exist |

## Findings and corrections

| Severity | Location | Finding, fix, and recheck |
| --- | --- | --- |
| High | `web/src/App.tsx:178`, `web/src/App.tsx:273`, `web/src/App.tsx:598` | A generic “slippage/minimum received” presentation would misstate PoolSwapTest's protection. Implemented a correctly named price-movement bound, net estimate, expiring previews, explicit acknowledgment, and final simulation. Buy/sell calldata and failure behavior pass browser checks; contract limitation remains disclosed |
| High | `web/src/chain.ts:93`, `web/src/config.ts:80` | Transaction controls must not run against unchecked deployment data. Added runtime ABI hash checks, RPC/code/manager validation, and fail-closed prerequisites. Tampered ABI, missing code and RPC failure all pass negative tests |
| Medium | `web/src/App.tsx:431`, `web/src/style.css:237`, `web/src/style.css:908` | First mobile layout visually moved swap ahead of donation while DOM order stayed different. Reordered DOM to streak/swap/donation and used explicit desktop grid placement. Rechecked keyboard flow, mobile screenshot and all four widths |
| Medium | `web/src/App.tsx:180`, `web/src/App.tsx:249` | A fresh quote attempt or approval must not leave an old executable preview. Clear preview/acceptance at request start, clear after approval/receipt and invalidate on context changes. Expiry, edit invalidation, approval/requote and failed simulation tests pass |
| Medium | `web/src/App.tsx:801`, `web/src/style.css:633` | Wide transaction table must remain reachable on narrow screens. Kept scroll local, added a focusable named region and transaction links. 320px document-overflow and mobile axe checks pass |
| Low | `web/src/style.css:1`, narrow responsive rules | Initial compact captions were below the guide's usual 12px floor; raised them and preserved wrapping. Rechecked screenshots and text enlargement |
| Medium | `web/package.json` | Initial wagmi 2 and Vitest 3 dependency trees had known advisories. Updated to wagmi 3.7.7 and Vitest 5.0.2; removed unused test libraries. Offline reinstall, typecheck, tests, browser interactions and audit pass |

An early test tried to press Tab while the deployment-loading shell was still rendering. The test now waits for the real skip link; the final keyboard checks pass. This was a fixture timing correction, not a claim that the loading shell had the completed page's focus order.

## Live observations and limitations

At block **11791497**, real public RPC returned chain **11155111**, nonempty code for all six required contracts, correct router/hook PoolManager bindings, token decimals 18, streak 0, buy/sell hook fees 30 bps, accrued balances 0, and zero active liquidity. The real quoter returned a nonzero output for a 0.003 ETH buy. `evidence/live-rpc.json` records exact block, code hashes, state, quote and RPC endpoint; `web/scripts/live-check.mjs` is the reproducible recipe.

The live StateView price was **50,000,000 MOMO per ETH**, different from the handoff notes' illustrative source-rehearsal price. The frontend correctly reads the deployed pool's StateView price and does not substitute the handoff's `initialPrice` or simulated test values. The deployed contract scope was preserved. Browser live reads also passed, with an empty post-deployment event window at inspection time.

No real wallet transaction, approval, swap or donation was broadcast. Real wallet extension interoperability, actual receipt/MEV behavior, partial-fill execution under changing state, Safari/Firefox, screen readers, native browser zoom and physical mobile devices remain untested. The mocked suite is not evidence of live funded execution. Read-only live code checks establish nonempty code and manager bindings, not a full runtime-bytecode attestation; the later control-plane checks remain authoritative for publication binding.

The supplied browser MCP transport closed on navigation before it could inspect the export. A permitted local Playwright installation was used instead, in foreground scripts that start and stop their own preview server. Real screenshots and measured observations come from this Chromium session, not fabricated or inferred from source.

No publishing, pinning, naming, contract deployment or control-plane publication checks were performed. Those are downstream tasks. No claims about hosted URLs or CIDs are made.

## Evidence

- `evidence/browser-results.json`: all 32 mocked-production-browser checks and browser version.
- `evidence/axe-desktop.json`, `evidence/axe-mobile.json`: checked rule IDs, zero violations and any rules requiring manual inspection.
- `evidence/mocked-1440.png`, `evidence/mocked-390.png`: connected fixture state with actual rendered quote and populated history; values are explicitly mocked.
- `evidence/live-desktop.png`, `evidence/live-mobile.png`: production export with actual public RPC reads while disconnected.
- `evidence/keyboard-focus.png`: visibly focused connect control.
- `evidence/live-browser.json`: rendered color measurements, actual live read result and request failures.
- `evidence/live-rpc.json`: independent read-only onchain snapshot and quote.
- `evidence/export-check.json`: export inventory, byte counts and handoff comparison.

The attempt to stage the completed files failed: Git could not create `.git/index.lock` because `.git` is mounted read-only. No commit or staging is claimed, and no permission bypass was attempted. Source, lockfile, export and evidence remain in their assigned paths for the contributor network to collect. A final bundle containing these changes cannot be produced in this environment; the existing Git bundle plus the uncompressed delivery files and a conservative metadata allowance is checked against 8,388,608 bytes instead. See `evidence/submission-check.json`. Only `web/`, `dist/`, and new documentation under `docs/` are proposed changes. `web/.gitignore` uses the task's explicit allowance to exclude dependency/cache/test-output directories at every nesting level. No submodule or vendored npm registry is included.
