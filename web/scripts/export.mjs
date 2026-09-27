import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { keccak256, toHex, parseAbi } from "viem";
const root = new URL("../../", import.meta.url),
  out = new URL("dist/", root);
const read = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));
const handoff = await read("web/config/handoff.json"),
  chain = await read("web/config/network.json");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const hash = (abi) => keccak256(toHex(JSON.stringify(canonical(abi)))).slice(2);
const checking = process.argv.includes("--check");
if (handoff.chainId !== chain.network.chainId)
  throw Error("Handoff network mismatch");
const contracts = [];
for (const c of handoff.contracts) {
  const file = `docs/abi/${c.name}.json`;
  const bytes = execFileSync(
    "git",
    ["show", `${handoff.sourceCommit}:${file}`],
    { cwd: root },
  );
  const abi = JSON.parse(bytes);
  if (!Array.isArray(abi) || hash(abi) !== c.abiHash)
    throw Error(`ABI mismatch: ${c.name}`);
  if (!bytes.equals(await readFile(new URL(file, root))))
    throw Error(`Source ABI differs from pinned commit: ${c.name}`);
  const abiPath = `abi/${c.name}.json`;
  if (!checking) {
    await mkdir(new URL("abi/", out), { recursive: true });
    await writeFile(new URL(abiPath, out), bytes);
  } else if (!bytes.equals(await readFile(new URL(abiPath, out))))
    throw Error(`Export ABI mismatch: ${c.name}`);
  contracts.push({
    name: c.name,
    address: c.address,
    abiHash: c.abiHash,
    abiPath,
  });
}
const protocol = {
  PoolSwapTest: parseAbi([
    "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
    "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
    "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
    "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256 delta)",
    "function manager() view returns (address)",
  ]),
  StateView: parseAbi([
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  ]),
  V4Quoter: parseAbi([
    "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
    "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
    "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
  ]),
};
const protocolAbis = {};
for (const [name, abi] of Object.entries(protocol)) {
  const path = `abi/${name}.json`;
  protocolAbis[name] = { path, abiHash: hash(abi) };
  if (!checking)
    await writeFile(new URL(path, out), JSON.stringify(abi, null, 2) + "\n");
}
const assets = [];
async function walk(dir, prefix = "") {
  for (const name of (await readdir(dir)).sort()) {
    const path = prefix + name,
      url = new URL(name, dir),
      info = await stat(url);
    if (info.isDirectory()) await walk(new URL(name + "/", dir), path + "/");
    else if (path !== "imd-deployment.json") {
      if (info.size > 8388608) throw Error("Asset exceeds 8 MiB");
      assets.push({
        path,
        sha256: createHash("sha256")
          .update(await readFile(url))
          .digest("hex"),
      });
    }
  }
}
await walk(out);
if (assets.length > 128) throw Error("Too many assets");
const manifest = {
  version: 1,
  launchId: handoff.launchId,
  chainId: handoff.chainId,
  sourceCommit: handoff.sourceCommit,
  attestationHash: handoff.attestationHash,
  contracts,
  assets,
  network: chain.network,
  walletAddChain: chain.walletAddChain,
  pool: handoff.manifest.pool,
  token: handoff.manifest.token,
  deploymentBlock: Math.min(...handoff.contracts.map((c) => c.blockNumber)),
  routing: {
    kind: "PoolSwapTest",
    poolSwapTest: "0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe",
    source:
      "Approved workflow: PoolSwapTest route; approvals go directly to this router.",
  },
  protocolAbis,
};
if (checking) {
  if (
    JSON.stringify(await read("dist/imd-deployment.json")) !==
    JSON.stringify(manifest)
  )
    throw Error("Export manifest mismatch");
} else
  await writeFile(
    new URL("imd-deployment.json", out),
    JSON.stringify(manifest, null, 2) + "\n",
  );
console.log(
  `${checking ? "Verified" : "Exported"} handoff, canonical ABI hashes and ${assets.length} asset hashes.`,
);
