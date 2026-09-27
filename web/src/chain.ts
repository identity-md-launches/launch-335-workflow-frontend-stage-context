import {
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
  type EIP1193Provider,
} from "viem";
import type { Runtime, Manifest } from "./config";
export function errorText(error: unknown): string {
  const e = error as {
    shortMessage?: string;
    message?: string;
    code?: number;
    cause?: unknown;
  };
  if (e?.code === 4001 || /rejected|denied/i.test(e?.message ?? ""))
    return "Request declined in your wallet. You can try again.";
  return (
    e?.shortMessage ??
    e?.message ??
    "The request failed. Check your connection and try again."
  ).slice(0, 380);
}
export async function switchNetwork(
  provider: EIP1193Provider,
  manifest: Manifest,
) {
  const params: [{ chainId: Hex }] = [
    { chainId: manifest.walletAddChain.chainId },
  ];
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params });
  } catch (error) {
    const e = error as { code?: number; message?: string };
    if (
      e.code !== 4902 &&
      !/unknown chain|unrecognized chain|not added/i.test(e.message ?? "")
    )
      throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [manifest.walletAddChain],
    });
    await provider.request({ method: "wallet_switchEthereumChain", params });
  }
}
export function amountUnits(value: string, decimals: number) {
  if (!/^(\d+)(\.\d*)?$/.test(value) || value.split(".")[1]?.length > decimals)
    throw Error(
      `Enter a positive amount with at most ${decimals} decimal places.`,
    );
  const amount = parseUnits(value, decimals);
  if (amount <= 0n || amount >= 1n << 127n)
    throw Error("Enter a positive amount below the pool’s maximum.");
  return amount;
}
export const displayAmount = (value: bigint, decimals: number, digits = 6) => {
  const [whole, fraction] = formatUnits(value, decimals).split(".");
  const tail = fraction?.slice(0, digits).replace(/0+$/, "");
  return whole === "0" && value > 0n && !tail
    ? `<0.${"0".repeat(digits - 1)}1`
    : whole + (tail ? "." + tail : "");
};
export function sqrt(value: bigint) {
  if (value < 0n) throw Error("Negative square root");
  if (value < 2n) return value;
  let x = value,
    y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}
export function priceLimit(price: bigint, buy: boolean, bps: number) {
  if (!Number.isInteger(bps) || bps < 10 || bps > 500)
    throw Error("Choose a price limit between 0.1% and 5%.");
  const limit = sqrt(
    (price * price * BigInt(10000 + (buy ? -bps : bps))) / 10000n,
  );
  if (
    limit <= 4295128739n ||
    limit >= 1461446703485210103287273052203988822378723970342n
  )
    throw Error("Price limit is outside the pool range.");
  return limit;
}
export function decodeDelta(delta: bigint, buy: boolean) {
  const d0 = BigInt.asIntN(128, delta >> 128n),
    d1 = BigInt.asIntN(128, delta);
  return { spent: -(buy ? d0 : d1), received: buy ? d1 : d0 };
}
export async function verifyChain(rt: Runtime) {
  const { client, manifest } = rt;
  if ((await client.getChainId()) !== manifest.chainId)
    throw Error(
      "The public RPC returned the wrong network. Transactions are disabled.",
    );
  const addresses = [
    ...manifest.contracts.map((c) => c.address),
    manifest.network.uniswapV4.poolManager,
    manifest.network.uniswapV4.stateView,
    manifest.network.uniswapV4.quoter,
    manifest.routing.poolSwapTest,
  ];
  await Promise.all(
    addresses.map(async (address) => {
      const code = await client.getCode({ address });
      if (!code || code === "0x")
        throw Error(
          `No contract code at ${address}. Transactions are disabled.`,
        );
    }),
  );
  const manager = (await client.readContract({
    address: manifest.routing.poolSwapTest,
    abi: rt.abis.PoolSwapTest,
    functionName: "manager",
  })) as Address;
  const hookManager = (await client.readContract({
    address: rt.hook.address,
    abi: rt.hook.abi,
    functionName: "poolManager",
  })) as Address;
  if (
    [manager, hookManager].some(
      (a) =>
        a.toLowerCase() !==
        manifest.network.uniswapV4.poolManager.toLowerCase(),
    )
  )
    throw Error("PoolManager binding mismatch. Transactions are disabled.");
}
export async function readState(rt: Runtime, account?: Address) {
  const { client, hook, token, poolId, manifest } = rt,
    blockNumber = await client.getBlockNumber();
  const read = (
    address: Address,
    abi: typeof hook.abi,
    functionName: string,
    args: readonly unknown[] = [],
  ) => client.readContract({ address, abi, functionName, args, blockNumber });
  const [
    streak,
    buyFee,
    sellFee,
    accrued,
    slot,
    liquidity,
    decimals,
    balance,
    ethBalance,
    allowance,
  ] = await Promise.all([
    read(hook.address, hook.abi, "streak", [poolId]),
    read(hook.address, hook.abi, "nextFeeBps", [poolId, true]),
    read(hook.address, hook.abi, "nextFeeBps", [poolId, false]),
    read(hook.address, hook.abi, "accrued", [poolId]),
    read(manifest.network.uniswapV4.stateView, rt.abis.StateView, "getSlot0", [
      poolId,
    ]),
    read(
      manifest.network.uniswapV4.stateView,
      rt.abis.StateView,
      "getLiquidity",
      [poolId],
    ),
    read(token.address, token.abi, "decimals"),
    account ? read(token.address, token.abi, "balanceOf", [account]) : 0n,
    account ? client.getBalance({ address: account, blockNumber }) : 0n,
    account
      ? read(token.address, token.abi, "allowance", [
          account,
          manifest.routing.poolSwapTest,
        ])
      : 0n,
  ]);
  if (Number(decimals) !== manifest.token.decimals)
    throw Error("Token decimals do not match the deployment.");
  const price = (slot as [bigint, number, number, number])[0];
  if (price === 0n) throw Error("The pool has not been initialized.");
  return {
    blockNumber,
    streak: streak as [boolean, bigint],
    buyFee: buyFee as bigint,
    sellFee: sellFee as bigint,
    accrued: accrued as [bigint, bigint],
    sqrtPrice: price,
    liquidity: liquidity as bigint,
    decimals: Number(decimals),
    balance: balance as bigint,
    ethBalance: ethBalance as bigint,
    allowance: allowance as bigint,
    updatedAt: Date.now(),
  };
}
export type PoolState = Awaited<ReturnType<typeof readState>>;
export type EventRow = {
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  args: {
    buy: boolean;
    streak: bigint;
    feeBps: bigint;
    currency: Address;
    fee: bigint;
  };
};
export async function readHistory(rt: Runtime, toBlock: bigint) {
  const start = BigInt(rt.manifest.deploymentBlock),
    fromBlock = toBlock - 1999n > start ? toBlock - 1999n : start;
  const chunks: EventRow[][] = [];
  // Small bounded windows avoid common public-RPC eth_getLogs range limits.
  for (let from = fromBlock; from <= toBlock; from += 500n) {
    const end = from + 499n < toBlock ? from + 499n : toBlock;
    const logs = await rt.client.getContractEvents({
      address: rt.hook.address,
      abi: rt.hook.abi,
      eventName: "Momentum",
      args: { poolId: rt.poolId },
      fromBlock: from,
      toBlock: end,
      strict: true,
    });
    chunks.push(logs as unknown as EventRow[]);
  }
  return {
    fromBlock,
    toBlock,
    rows: chunks
      .flat()
      .sort(
        (a, b) =>
          Number(b.blockNumber - a.blockNumber) || b.logIndex - a.logIndex,
      )
      .slice(0, 20),
  };
}
export const swapCall = (
  rt: Runtime,
  account: Address,
  buy: boolean,
  amount: bigint,
  limit: bigint,
) => ({
  address: rt.manifest.routing.poolSwapTest,
  abi: rt.abis.PoolSwapTest,
  functionName: "swap",
  args: [
    rt.poolKey,
    { zeroForOne: buy, amountSpecified: -amount, sqrtPriceLimitX96: limit },
    { takeClaims: false, settleUsingBurn: false },
    "0x",
  ],
  value: buy ? amount : 0n,
  account,
});
