import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  fallback,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
export interface Manifest {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: {
    name: string;
    address: Address;
    abiHash: string;
    abiPath: string;
  }[];
  assets: { path: string; sha256: string }[];
  network: {
    chainId: number;
    name: string;
    testnet: boolean;
    rpcUrls: string[];
    explorer: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    faucets: string[];
    uniswapV4: Record<
      | "poolManager"
      | "universalRouter"
      | "quoter"
      | "stateView"
      | "positionManager"
      | "permit2",
      Address
    >;
  };
  walletAddChain: {
    chainId: Hex;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
  };
  pool: { fee: number; tickSpacing: number; pairedCurrency: Address };
  token: { name: string; symbol: string; decimals: number; contract: string };
  deploymentBlock: number;
  routing: { kind: "PoolSwapTest"; poolSwapTest: Address };
  protocolAbis: Record<string, { path: string; abiHash: string }>;
}
export const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
export const abiHash = (abi: Abi) =>
  keccak256(toHex(JSON.stringify(canonical(abi)))).slice(2);
const localPath = (path: string) => {
  if (
    !/^[a-zA-Z0-9_./-]+$/.test(path) ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  )
    throw Error("Unsafe deployment asset path");
  return new URL(path, new URL("./", location.href));
};
export async function loadDeployment() {
  const response = await fetch(
    new URL("./imd-deployment.json", location.href),
    { cache: "no-cache" },
  );
  if (!response.ok)
    throw Error(
      "Deployment configuration could not be loaded. Reload to try again.",
    );
  const manifest: Manifest = await response.json();
  if (
    manifest.version !== 1 ||
    manifest.chainId !== manifest.network?.chainId ||
    Number(manifest.walletAddChain?.chainId) !== manifest.chainId ||
    manifest.routing.kind !== "PoolSwapTest"
  )
    throw Error("Invalid deployment configuration. Transactions are disabled.");
  const abis: Record<string, Abi> = {};
  await Promise.all(
    [
      ...manifest.contracts.map((c) => ({
        name: c.name,
        path: c.abiPath,
        hash: c.abiHash,
      })),
      ...Object.entries(manifest.protocolAbis).map(([name, v]) => ({
        name,
        path: v.path,
        hash: v.abiHash,
      })),
    ].map(async (c) => {
      const res = await fetch(localPath(c.path));
      if (!res.ok) throw Error(`Cannot load ${c.name} ABI`);
      const abi: Abi = await res.json();
      if (!Array.isArray(abi) || abiHash(abi) !== c.hash)
        throw Error(`${c.name} ABI integrity check failed`);
      abis[c.name] = abi;
    }),
  );
  return makeRuntime(manifest, abis);
}
export function makeRuntime(manifest: Manifest, abis: Record<string, Abi>) {
  const chain = defineChain({
    id: manifest.chainId,
    name: manifest.network.name,
    nativeCurrency: manifest.network.nativeCurrency,
    rpcUrls: { default: { http: manifest.network.rpcUrls } },
    blockExplorers: {
      default: { name: "Explorer", url: manifest.network.explorer },
    },
    testnet: manifest.network.testnet,
  });
  const transport = () =>
    fallback(
      manifest.network.rpcUrls.map((url) =>
        http(url, { timeout: 10000, retryCount: 1 }),
      ),
      { rank: false, retryCount: 0 },
    );
  const client = createPublicClient({ chain, transport: transport() });
  const walletConfig = createConfig({
    chains: [chain],
    connectors: [injected()],
    transports: { [chain.id]: transport() },
    multiInjectedProviderDiscovery: true,
  });
  const contract = (name: string) => {
    const c = manifest.contracts.find((c) => c.name === name);
    if (!c || !abis[name]) throw Error(`Missing ${name} contract`);
    return { ...c, abi: abis[name] };
  };
  const token = contract(manifest.token.contract),
    hook = contract("MomentumFeeHook");
  const currencies = [manifest.pool.pairedCurrency, token.address].sort(
    (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  if (BigInt(currencies[0]) !== 0n)
    throw Error("This interface requires the attested native ETH pool.");
  const poolKey = {
    currency0: currencies[0],
    currency1: currencies[1],
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
      [
        poolKey.currency0,
        poolKey.currency1,
        poolKey.fee,
        poolKey.tickSpacing,
        poolKey.hooks,
      ],
    ),
  );
  return {
    manifest,
    abis,
    chain,
    client,
    walletConfig,
    token,
    hook,
    poolKey,
    poolId,
  };
}
export type Runtime = ReturnType<typeof makeRuntime>;
