# Momentum frontend

A single-page React, TypeScript, Vite, wagmi and viem interface for the deployed Momentum ETH/MOMO pool on Sepolia. The generated `../dist/` is the complete static site prepared for submission; no backend, keys, environment secrets, WalletConnect project ID, or server rewrites are needed.

## Reproduce

Use Node 22 and npm. From the repository root:

```sh
npm ci --prefix web
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
npm --prefix web run verify:export
npm --prefix web run preview
```

Installation may use the network. With installed dependencies, typecheck, tests and build run without network access. An existing npm cache also supports `npm ci --offline --prefix web --cache <cache-directory>`. The lockfile is delivered; dependencies, caches and browser downloads are not shipped. The worker verified an offline lockfile install with its populated cache. The publisher is expected to commit and host `dist/` without rebuilding it. This worker could not create a Git commit because repository metadata is read-only; see `../docs/VALIDATION.md`.

Vite uses `base: './'`. Serve the export over HTTP(S), including a gateway subpath such as `/preview/`; opening `index.html` with `file://` cannot load JSON reliably. Runtime JSON and ABI URLs are relative to the page directory. Development should use a built preview because the final manifest is generated into `dist/`, not a duplicate under source.

## Configuration and provenance

`config/handoff.json` and `config/network.json` are preserved copies of the supplied inputs. `scripts/export.mjs` reads the ABI JSON at deployed source commit `0332a5e33d84dc25d8a762efe1db06ded58dcb4f`, compares it to `docs/abi/`, checks recursively key-sorted JSON canonical Keccak-256 against each handoff `abiHash`, and copies those exact ABI bytes. No contract source or original ABI was modified.

The build then creates `dist/imd-deployment.json` with the exact attested identifiers and contract set, unchanged network object, supplied wallet-add parameters, pool definition, deployment block, and routing/ABI references. All other exported files are inventoried with lowercase SHA-256. The generator enforces 128 assets and 8 MiB per asset; `verify:export` independently walks the current files and compares the inventory and configuration. Never hand-edit a built asset or the manifest: rebuild them together.

`src/config.ts` loads that single manifest at runtime, loads its ABI paths, validates ABI hashes and constructs both public clients and wallet configuration from it. There is no compiled address/chain/RPC map. The two deployed ABIs are implementation-derived. The three protocol ABIs are explicitly minimal external interfaces; their hashes and paths are also in the manifest. No third-party protocol interface is misrepresented as an attested project contract.

The approved workflow explicitly requires **PoolSwapTest**, so `routing.poolSwapTest` is the one workflow-derived routing extension. Network JSON does not contain this test-router address. Quoting and price reads use `network.uniswapV4.quoter` and `stateView`; the router and hook are checked against `network.uniswapV4.poolManager`. Sells approve **PoolSwapTest directly**, with the exact input amount. UniversalRouter and Permit2 in the unchanged network block are unused because that route would contradict the assignment. All configured contract explorer links are available under “View contracts and deployment.”

## Behavior

- Browser wallets use the injected/EIP-6963 wagmi connector. Missing-wallet errors explain how to connect. Wallet account and chain changes invalidate quotes. A wrong chain presents one switch action; unknown-chain error 4902 triggers the exact supplied `wallet_addEthereumChain` parameters, followed by another switch.
- Public RPCs are tried in the supplied order. Reads work while disconnected and refresh every 15 seconds, with balances/allowance added after connecting. Each state snapshot uses one block. History refreshes every 30 seconds: at most 20 latest events in the last 2,000 blocks, fetched in non-overlapping 500-block chunks and clipped to deployment. This is a bounded recent history, not an all-time index.
- Before enabling transactions the app checks chain ID, nonempty code for the token, hook, PoolManager, StateView, quoter and PoolSwapTest, and both manager bindings. Token decimals must match the handoff. Failed or stale reads gate controls; unavailable data is never filled with demo values.
- Buys send native ETH. Sells first show an explicit exact-amount approval, wait for a successful receipt, and require a new preview. `quoteExactInputSingle` is only simulated. After approval, or for buys, a second `eth_call` simulates the actual PoolSwapTest route and decodes the signed balance delta. `amountSpecified` is negative, both claim settings are false, and `hookData` is `0x` (ignored by this hook).
- A 0.5%, 1%, 2% or 5% maximum pool-price movement is converted with integer square-root arithmetic into `sqrtPriceLimitX96`. Quotes expire after 45 seconds. The exact route is re-simulated before signing; a worse output beyond the selected tolerance requires another quote. The wallet network/account are rechecked after asynchronous work.
- **PoolSwapTest has no onchain minimum-output parameter and no deadline.** Its square-root price bound limits pool-price movement. It can partially fill, and changing hook fees affect net output. A preflight check is not an execution guarantee. The form states this and requires explicit acknowledgment. The displayed estimate already includes fees; it is never called “minimum received.” An enforceable minimum-output route would require changing the approved routing/contract scope.
- Donations call the hook's `donateFees(poolKey)`, never transfer a visitor's token balance. The visitor pays gas; accrued claims go to in-range LPs. Donations are disabled for no fees or zero active liquidity. Zero active liquidity does **not** block buy previews because the first buy may enter the one-sided seeded range.
- Pending hashes link to the chain explorer. Rejected signatures, simulation errors and reverted receipts remain visible with retry guidance. Confirmed receipts refresh all reads. No transactions were broadcast during worker validation.

A qualifying counter-swap resets a streak at the cost of **two hook fees plus LP fees** for the round trip. Dust under 0.001 ETH on the pool delta does not reset it. Fees accrue as ERC-6909 claims; no owner/admin actions exist. Hook data is unauthenticated and this hook ignores it, crediting no swapper.

## Browser and RPC validation

```sh
# Browser download is test-only. This path is outside the submitted frontend.
PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" node web/node_modules/@playwright/test/cli.js install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" npm --prefix web run test:browser
PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" node web/scripts/live-browser.mjs
npm --prefix web run check:live
```

Each browser script creates and closes a temporary local server in one bounded foreground process. Interaction tests intercept all wallet/RPC calls and never broadcast. The live browser script makes actual public read requests while disconnected; `check:live` uses curl-backed read-only RPC at a pinned block and records the exact block and responses. Evidence lives under `docs/evidence/`. These are worker checks, not independent certification or publication checks.

See `../docs/VALIDATION.md` for coverage and limitations, and `../docs/DESIGN.md` for the implemented design system. The task also requested root `DESIGN.md`, but its overriding path budget permits only `web/`, `dist/`, `docs/` and `web/.gitignore`; the design document is therefore delivered under `docs/`.

## References

Protocol signatures were checked against local pinned `lib/v4-core/src/test/PoolSwapTest.sol` and the [Uniswap IV4Quoter interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol). Wallet hooks follow [wagmi's official documentation](https://wagmi.sh/react/api/hooks/useConnect). The package lock fixes the installed versions; runtime does not fetch these references.

Design review uses the supplied Better Interface reference, adapted from [Jakub Krehel's Better Interface](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-interface), MIT, commit `267330e1adfc66a718fb65fa6918c1f06d0a689e`. Documentation method is adapted from [Paul Bakaus's Impeccable](https://github.com/pbakaus/impeccable/blob/9d715cc4f5564a990ca8345abfdd5df6dc9b41c8/skill/reference/document.md), Apache-2.0, commit `9d715cc4f5564a990ca8345abfdd5df6dc9b41c8`. Those works retain their original licenses.
