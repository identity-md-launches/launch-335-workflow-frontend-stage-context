// Read-only validation. Uses curl through the sandbox proxy; never sends a transaction.
import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseEther,
} from "viem";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const root = new URL("../../", import.meta.url),
  manifest = JSON.parse(
    await readFile(new URL("dist/imd-deployment.json", root), "utf8"),
  );
const abis = {};
for (const c of manifest.contracts)
  abis[c.name] = JSON.parse(
    await readFile(new URL("dist/" + c.abiPath, root), "utf8"),
  );
for (const [name, a] of Object.entries(manifest.protocolAbis))
  abis[name] = JSON.parse(
    await readFile(new URL("dist/" + a.path, root), "utf8"),
  );
const rpcUrl = manifest.network.rpcUrls[0];
const client = createPublicClient({
  transport: http(rpcUrl, {
    retryCount: 0,
    fetchFn: async (url, options) =>
      new Response(
        execFileSync(
          "curl",
          [
            "--silent",
            "--show-error",
            "--max-time",
            "25",
            String(url),
            "-H",
            "content-type: application/json",
            "--data-binary",
            "@-",
          ],
          { input: options.body, encoding: "utf8" },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  }),
});
const evidence = {
  checkedAt: new Date().toISOString(),
  rpcUrl,
  mode: "Read-only RPC calls and eth_call simulations; no transaction broadcast",
  results: {},
};
try {
  const chainId = await client.getChainId();
  if (chainId !== manifest.chainId) throw Error("Wrong chain");
  evidence.results.chainId = chainId;
  const blockNumber = await client.getBlockNumber();
  evidence.results.blockNumber = blockNumber;
  const codes = [];
  for (const c of [
    ...manifest.contracts,
    ...["poolManager", "stateView", "quoter"].map((name) => ({
      name,
      address: manifest.network.uniswapV4[name],
    })),
    { name: "PoolSwapTest", address: manifest.routing.poolSwapTest },
  ]) {
    const code = await client.getCode({ address: c.address, blockNumber });
    if (!code || code === "0x") throw Error(`No code: ${c.name}`);
    codes.push({
      name: c.name,
      address: c.address,
      bytes: (code.length - 2) / 2,
      codeKeccak: keccak256(code),
    });
  }
  evidence.results.code = codes;
  const token = manifest.contracts.find(
      (c) => c.name === manifest.token.contract,
    ),
    hook = manifest.contracts.find((c) => c.name === "MomentumFeeHook");
  const key = {
    currency0: manifest.pool.pairedCurrency,
    currency1: token.address,
    fee: manifest.pool.fee,
    tickSpacing: manifest.pool.tickSpacing,
    hooks: hook.address,
  };
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      Object.values(key),
    ),
  );
  evidence.results.poolId = poolId;
  const read = (address, abi, functionName, args = []) =>
    client.readContract({ address, abi, functionName, args, blockNumber });
  evidence.results.routerManager = await read(
    manifest.routing.poolSwapTest,
    abis.PoolSwapTest,
    "manager",
  );
  evidence.results.hookManager = await read(
    hook.address,
    abis.MomentumFeeHook,
    "poolManager",
  );
  for (const name of ["routerManager", "hookManager"])
    if (
      evidence.results[name].toLowerCase() !==
      manifest.network.uniswapV4.poolManager
    )
      throw Error("Manager mismatch");
  evidence.results.decimals = await read(
    token.address,
    abis.Momentum,
    "decimals",
  );
  evidence.results.streak = await read(
    hook.address,
    abis.MomentumFeeHook,
    "streak",
    [poolId],
  );
  evidence.results.buyFee = await read(
    hook.address,
    abis.MomentumFeeHook,
    "nextFeeBps",
    [poolId, true],
  );
  evidence.results.sellFee = await read(
    hook.address,
    abis.MomentumFeeHook,
    "nextFeeBps",
    [poolId, false],
  );
  evidence.results.accrued = await read(
    hook.address,
    abis.MomentumFeeHook,
    "accrued",
    [poolId],
  );
  evidence.results.slot0 = await read(
    manifest.network.uniswapV4.stateView,
    abis.StateView,
    "getSlot0",
    [poolId],
  );
  evidence.results.liquidity = await read(
    manifest.network.uniswapV4.stateView,
    abis.StateView,
    "getLiquidity",
    [poolId],
  );
  try {
    const quote = await client.simulateContract({
      address: manifest.network.uniswapV4.quoter,
      abi: abis.V4Quoter,
      functionName: "quoteExactInputSingle",
      args: [
        {
          poolKey: key,
          zeroForOne: true,
          exactAmount: parseEther("0.003"),
          hookData: "0x",
        },
      ],
      blockNumber,
    });
    evidence.results.buyQuote = {
      inputWei: parseEther("0.003"),
      output: quote.result,
    };
  } catch (e) {
    evidence.results.buyQuote = { error: e.shortMessage ?? e.message };
  }
  evidence.status = "read checks passed";
} catch (e) {
  evidence.status = "incomplete";
  evidence.error = e.shortMessage ?? e.message;
  process.exitCode = 1;
}
await writeFile(
  new URL("docs/evidence/live-rpc.json", root),
  JSON.stringify(
    evidence,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    evidence,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ),
);
