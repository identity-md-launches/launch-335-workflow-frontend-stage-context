import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useWalletClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type EIP1193Provider, type Hex } from "viem";
import type { Runtime } from "./config";
import {
  amountUnits,
  decodeDelta,
  displayAmount,
  errorText,
  priceLimit,
  readHistory,
  readState,
  swapCall,
  switchNetwork,
  verifyChain,
} from "./chain";
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const percent = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
type Quote = {
  amount: bigint;
  out: bigint;
  spent: bigint;
  limit: bigint;
  buy: boolean;
  expires: number;
  key: string;
  routerSimulated: boolean;
};
export function App({ rt }: { rt: Runtime }) {
  const { address, chainId, connector } = useAccount(),
    { connectAsync, connectors } = useConnect(),
    { disconnect } = useDisconnect(),
    { data: wallet } = useWalletClient();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [tx, setTx] = useState<Hex>(),
    [buy, setBuy] = useState(true),
    [amount, setAmount] = useState(""),
    [bps, setBps] = useState(100),
    [accepted, setAccepted] = useState(false),
    [quote, setQuote] = useState<Quote>(),
    [now, setNow] = useState(Date.now());
  const lock = useRef(false),
    generation = useRef(0),
    amountRef = useRef<HTMLInputElement>(null);
  const verified = useQuery({
    queryKey: ["verified", rt.poolId],
    queryFn: () => verifyChain(rt).then(() => true),
    staleTime: 60000,
    retry: 1,
    refetchInterval: 60000,
  });
  const state = useQuery({
    queryKey: ["pool", rt.poolId, address],
    queryFn: () => readState(rt, address),
    enabled: verified.data === true,
    refetchInterval: 15000,
    retry: 1,
  });
  const history = useQuery({
    queryKey: ["history", rt.poolId],
    queryFn: async () => readHistory(rt, await rt.client.getBlockNumber()),
    enabled: verified.data === true,
    refetchInterval: 30000,
    retry: 1,
  });
  const s = state.data,
    wrongChain = !!address && chainId !== rt.chain.id;
  const ready =
    !!address &&
    !wrongChain &&
    !!wallet &&
    verified.data === true &&
    !verified.isError &&
    !!s &&
    !state.isError &&
    now - s.updatedAt < 45000;
  const context = `${address}:${chainId}:${buy}:${amount}:${bps}`;
  const latestContext = useRef(context);
  latestContext.current = context;
  const currentQuote =
    quote?.key === context && quote.expires > now ? quote : undefined;
  let parsed = 0n;
  try {
    parsed = amountUnits(
      amount,
      buy
        ? rt.chain.nativeCurrency.decimals
        : (s?.decimals ?? rt.manifest.token.decimals),
    );
  } catch {
    /* validated on request */
  }
  const needsApproval =
    !buy && parsed > 0n && s !== undefined && s.allowance < parsed;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    generation.current++;
    setQuote(undefined);
    setAccepted(false);
    setError("");
    setTx(undefined);
    setMessage("");
  }, [context]);
  const refresh = async () => {
    await Promise.all([verified.refetch(), state.refetch(), history.refetch()]);
  };
  async function run(label: string, fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  function assertContext(key: string) {
    if (latestContext.current !== key)
      throw Error("Wallet or form changed. Review a new quote.");
  }
  async function assertWallet(key: string) {
    assertContext(key);
    if (!wallet || !address || !ready)
      throw Error(
        "Connect on the verified network and refresh pool state first.",
      );
    if ((await wallet.getChainId()) !== rt.chain.id)
      throw Error(`Switch your wallet to ${rt.chain.name}.`);
    const accounts = await wallet.getAddresses();
    if (accounts[0]?.toLowerCase() !== address.toLowerCase())
      throw Error("Wallet account changed. Reconnect and review a new quote.");
    assertContext(key);
  }
  async function waitFor(hash: Hex) {
    setTx(hash);
    setMessage("Transaction submitted. Waiting for confirmation…");
    const receipt = await rt.client.waitForTransactionReceipt({
      hash,
      timeout: 120000,
    });
    if (receipt.status !== "success")
      throw Error(
        "The transaction reverted. Refresh the pool before trying again.",
      );
    setQuote(undefined);
    setAccepted(false);
    setMessage("Transaction confirmed. Pool state refreshed.");
    await refresh();
  }
  async function connect() {
    await run("Connecting", async () => {
      const c = connectors.find((c) => c.id !== "injected") ?? connectors[0];
      if (!c || !(await c.getProvider()))
        throw Error(
          "No browser wallet found. Open this page in an Ethereum wallet browser or enable a wallet extension, then try again.",
        );
      await connectAsync({ connector: c });
    });
  }
  async function switchChain() {
    await run("Switching network", async () => {
      if (!connector) throw Error("Connect your wallet first.");
      const provider = (await connector.getProvider()) as EIP1193Provider;
      await switchNetwork(provider, rt.manifest);
    });
  }
  async function getQuote() {
    await run("Getting quote", async () => {
      setQuote(undefined);
      setAccepted(false);
      const key = context,
        revision = generation.current;
      let units: bigint;
      try {
        units = amountUnits(
          amount,
          buy ? rt.chain.nativeCurrency.decimals : s!.decimals,
        );
      } catch (e) {
        amountRef.current?.focus();
        throw e;
      }
      await assertWallet(key);
      if (units > (buy ? s!.ethBalance : s!.balance))
        throw Error(
          `Insufficient ${buy ? "ETH" : "MOMO"} balance. Enter a smaller amount.`,
        );
      const fresh = await readState(rt, address),
        limit = priceLimit(fresh.sqrtPrice, buy, bps);
      const result = await rt.client.simulateContract({
        address: rt.manifest.network.uniswapV4.quoter,
        abi: rt.abis.V4Quoter,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: rt.poolKey,
            zeroForOne: buy,
            exactAmount: units,
            hookData: "0x",
          },
        ],
        account: address,
      });
      let out = (result.result as [bigint, bigint])[0],
        spent = units,
        routerSimulated = false;
      if (buy || fresh.allowance >= units) {
        const sim = await rt.client.simulateContract(
          swapCall(rt, address!, buy, units, limit),
        );
        const delta = decodeDelta(sim.result as bigint, buy);
        out = delta.received;
        spent = delta.spent;
        routerSimulated = true;
      }
      if (out <= 0n || spent <= 0n)
        throw Error(
          "No output at this price limit. Try a smaller amount or a wider price limit.",
        );
      assertContext(key);
      if (revision !== generation.current) return;
      setQuote({
        amount: units,
        out,
        spent,
        limit,
        buy,
        expires: Date.now() + 45000,
        key,
        routerSimulated,
      });
      setAccepted(false);
      setMessage(
        routerSimulated
          ? "Quote ready. Review the simulated amounts and price limit."
          : "Quote ready. Approve MOMO, then quote again to simulate the router.",
      );
    });
  }
  async function approve() {
    await run("Approving MOMO", async () => {
      const key = context;
      await assertWallet(key);
      const units = amountUnits(amount, s!.decimals);
      if (!currentQuote) throw Error("Get a fresh quote before approving.");
      const sim = await rt.client.simulateContract({
        address: rt.token.address,
        abi: rt.token.abi,
        functionName: "approve",
        args: [rt.manifest.routing.poolSwapTest, units],
        account: address,
      });
      await assertWallet(key);
      setMessage("Confirm the exact MOMO spending limit in your wallet.");
      await waitFor(
        await wallet!.writeContract({
          ...sim.request,
          chain: rt.chain,
          account: address!,
        }),
      );
    });
  }
  async function swap() {
    await run("Swapping", async () => {
      const key = context;
      await assertWallet(key);
      const q = currentQuote;
      if (!q || !q.routerSimulated || !accepted)
        throw Error(
          "Get a fresh quote and accept the router limitations first.",
        );
      await verifyChain(rt);
      const sim = await rt.client.simulateContract(
          swapCall(rt, address!, q.buy, q.amount, q.limit),
        ),
        delta = decodeDelta(sim.result as bigint, q.buy);
      if (
        delta.received <= 0n ||
        delta.spent <= 0n ||
        delta.spent > q.amount ||
        delta.received < (q.out * BigInt(10000 - bps)) / 10000n
      )
        throw Error(
          "The output changed beyond your preview tolerance. Get a new quote.",
        );
      await assertWallet(key);
      if (Date.now() >= q.expires)
        throw Error("The quote expired. Get a new quote.");
      setMessage(
        "Confirm the swap in your wallet. The pool can change before execution.",
      );
      await waitFor(
        await wallet!.writeContract({
          ...sim.request,
          chain: rt.chain,
          account: address!,
        }),
      );
    });
  }
  async function donate() {
    await run("Donating fees", async () => {
      const key = context;
      await assertWallet(key);
      await verifyChain(rt);
      const sim = await rt.client.simulateContract({
        address: rt.hook.address,
        abi: rt.hook.abi,
        functionName: "donateFees",
        args: [rt.poolKey],
        account: address,
      });
      await assertWallet(key);
      setMessage(
        "Confirm the donation in your wallet. You pay gas; the hook supplies the accrued fees.",
      );
      await waitFor(
        await wallet!.writeContract({
          ...sim.request,
          chain: rt.chain,
          account: address!,
        }),
      );
    });
  }
  const disconnected = !address,
    fee = s ? (buy ? s.buyFee : s.sellFee) : undefined;
  const poolError = verified.error ?? state.error;
  const price = s
    ? (Number(s.sqrtPrice) ** 2 / 2 ** 192) *
      10 ** (rt.chain.nativeCurrency.decimals - s.decimals)
    : undefined;
  const explorer = rt.manifest.network.explorer;
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="header shell">
        <a className="brand" href="#main" aria-label="Momentum home">
          <span className="mark" aria-hidden="true">
            M
          </span>
          momentum<span className="brand-period">.</span>
        </a>
        <div className="wallet-bar">
          <span className="network-tag">
            <span aria-hidden="true">◇</span> {rt.chain.name} testnet
          </span>
          {address ? (
            <>
              <span className="account" title={address}>
                {short(address)}
              </span>
              <button
                className="small"
                onClick={() => disconnect()}
                disabled={!!busy}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button onClick={connect} disabled={!!busy}>
              Connect wallet <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      </header>
      <main id="main" className="shell">
        <div className="intro">
          <div>
            <p className="eyebrow">An experiment in market rhythm</p>
            <h1>
              Every swap
              <br />
              changes the rhythm<span>.</span>
            </h1>
            <p className="lede">
              Follow the streak. See your next fee.
              <br className="desktop-break" /> Move with Momentum.
            </p>
          </div>
          <div className="intro-note">
            <span className="mini-mark" aria-hidden="true">
              ↗↗↘
            </span>
            <p>ETH / MOMO</p>
            <span>Uniswap v4 · {rt.manifest.pool.fee / 10000}% LP fee</span>
          </div>
        </div>
        {wrongChain && (
          <div className="notice warning" role="status">
            <div>
              <strong>Your wallet is on another network.</strong>
              <p>Switch to {rt.chain.name} to quote, swap or donate.</p>
            </div>
            <button onClick={switchChain} disabled={!!busy}>
              Switch to {rt.chain.name}
            </button>
          </div>
        )}
        {poolError && (
          <div className="notice warning" role="alert">
            <div>
              <strong>Live pool data is unavailable.</strong>
              <p>
                {errorText(poolError)} Cached values, if shown, may be out of
                date.
              </p>
            </div>
            <button
              onClick={() => void refresh()}
              disabled={state.isFetching || verified.isFetching}
            >
              Retry connection
            </button>
          </div>
        )}
        <div className="dashboard">
          <section className="streak-card" aria-labelledby="streak-title">
            <div className="section-top">
              <h2 id="streak-title">Current streak</h2>
              <span className="status-dot">
                {s && !poolError ? "Live pool" : "Connecting to pool"}
              </span>
            </div>
            <div className="streak-line">
              <span className="streak-number">
                {s ? s.streak[1].toString() : "—"}
              </span>
              <div>
                <strong>
                  {s
                    ? s.streak[1] === 0n
                      ? "No direction yet"
                      : `${s.streak[0] ? "Buy" : "Sell"} streak`
                    : "Reading streak"}
                </strong>
                <p>qualifying swaps in a row</p>
              </div>
              <span className="streak-arrow" aria-hidden="true">
                {s?.streak[1] ? (s.streak[0] ? "↗" : "↘") : "↗"}
              </span>
            </div>
            <div className="rhythm" aria-hidden="true">
              {Array.from({ length: 18 }, (_, i) => (
                <i
                  key={i}
                  className={s && BigInt(i) < s.streak[1] ? "filled" : ""}
                  style={{ height: `${20 + i * 2}px` }}
                />
              ))}
            </div>
            <div className="streak-caption">
              <span>Each qualifying swap adds 0.10%</span>
              <span>2.00% cap</span>
            </div>
            <div className="fees">
              <div>
                <span>
                  Next buy fee <span aria-hidden="true">↗</span>
                </span>
                <strong>{s ? percent(s.buyFee) : "—"}</strong>
                <small>ETH → MOMO</small>
              </div>
              <div>
                <span>
                  Next sell fee <span aria-hidden="true">↘</span>
                </span>
                <strong>{s ? percent(s.sellFee) : "—"}</strong>
                <small>MOMO → ETH</small>
              </div>
            </div>
            <p className="fine">
              Hook fees come off swap output. The pool also charges its{" "}
              {rt.manifest.pool.fee / 10000}% LP fee.
            </p>
          </section>
          <section className="swap-card" aria-labelledby="swap-title">
            <div className="section-top">
              <h2 id="swap-title">Make your move</h2>
              <span className="pill">Swap</span>
            </div>
            <div className="direction" role="group" aria-label="Swap direction">
              <button
                aria-pressed={buy}
                onClick={() => setBuy(true)}
                disabled={!!busy}
              >
                Buy MOMO <span aria-hidden="true">↗</span>
              </button>
              <button
                aria-pressed={!buy}
                onClick={() => setBuy(false)}
                disabled={!!busy}
              >
                Sell MOMO <span aria-hidden="true">↘</span>
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void getQuote();
              }}
            >
              <label className="amount-box" htmlFor="amount">
                <span>You pay, up to</span>
                <div>
                  <input
                    ref={amountRef}
                    id="amount"
                    name="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={!!busy}
                    aria-describedby="balance amount-error"
                    aria-invalid={
                      !!error && /amount|decimal|balance/i.test(error)
                    }
                  />
                  <strong>{buy ? "ETH" : "MOMO"}</strong>
                </div>
                <small id="balance">
                  {address && s
                    ? `Balance: ${displayAmount(buy ? s.ethBalance : s.balance, buy ? rt.chain.nativeCurrency.decimals : s.decimals)} ${buy ? "ETH" : "MOMO"}`
                    : "Connect to see your balance"}
                </small>
              </label>
              <div className="flow-arrow" aria-hidden="true">
                ↓
              </div>
              <div className="output-box">
                <span>Estimated receive</span>
                <div>
                  <strong>
                    {currentQuote
                      ? displayAmount(
                          currentQuote.out,
                          buy ? s!.decimals : rt.chain.nativeCurrency.decimals,
                        )
                      : "—"}
                  </strong>
                  <b>{buy ? "MOMO" : "ETH"}</b>
                </div>
                <small>
                  {currentQuote
                    ? currentQuote.routerSimulated
                      ? "PoolSwapTest simulation · after fees"
                      : "Quoter estimate · approval needed"
                    : "Get a quote to preview your swap"}
                </small>
              </div>
              <div className="swap-details">
                <div>
                  <span>Current pool price</span>
                  <strong>
                    {price
                      ? `1 ETH ≈ ${price.toLocaleString("en-US", { maximumFractionDigits: 3 })} MOMO`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Next hook fee</span>
                  <strong>{fee !== undefined ? percent(fee) : "—"}</strong>
                </div>
                <div>
                  <label htmlFor="price-limit">Max pool price movement</label>
                  <select
                    id="price-limit"
                    value={bps}
                    disabled={!!busy}
                    onChange={(e) => setBps(Number(e.target.value))}
                  >
                    <option value={50}>0.5%</option>
                    <option value={100}>1.0%</option>
                    <option value={200}>2.0%</option>
                    <option value={500}>5.0%</option>
                  </select>
                </div>
              </div>
              <p className="router-note">
                PoolSwapTest enforces a pool price limit, not a minimum received
                amount or deadline. Swaps can partially fill; hook fees can
                change before execution.
              </p>
              <p id="amount-error" className="field-error">
                {error && /amount|decimal|balance/i.test(error) ? error : ""}
              </p>
              <button
                className="primary wide"
                type="submit"
                disabled={!ready || !!busy}
              >
                {busy === "Getting quote" ? "Getting quote…" : "Get quote"}{" "}
                <span aria-hidden="true">↗</span>
              </button>
              {disconnected && (
                <p className="fine center">
                  Connect your wallet above to start. Testnet assets only.
                </p>
              )}
              {currentQuote && (
                <div className="quote-review">
                  <p>
                    <strong>Preview ready</strong> · expires in{" "}
                    {Math.max(
                      0,
                      Math.ceil((currentQuote.expires - now) / 1000),
                    )}
                    s
                  </p>
                  <p>
                    Estimated spend:{" "}
                    {displayAmount(
                      currentQuote.spent,
                      buy ? rt.chain.nativeCurrency.decimals : s!.decimals,
                    )}{" "}
                    {buy ? "ETH" : "MOMO"}
                    {currentQuote.spent < currentQuote.amount
                      ? " · partial fill"
                      : ""}
                  </p>
                  {needsApproval ? (
                    <>
                      <p>
                        Approve exactly {amount} MOMO for PoolSwapTest. Then
                        request a new quote.
                      </p>
                      <button
                        type="button"
                        onClick={approve}
                        disabled={!ready || !!busy}
                      >
                        Approve MOMO
                      </button>
                    </>
                  ) : (
                    <>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={accepted}
                          onChange={(e) => setAccepted(e.target.checked)}
                          disabled={!!busy}
                        />
                        I accept partial fills and that the received amount is
                        not guaranteed.
                      </label>
                      <button
                        type="button"
                        onClick={swap}
                        disabled={
                          !ready ||
                          !!busy ||
                          !accepted ||
                          !currentQuote.routerSimulated
                        }
                      >
                        Confirm {buy ? "buy" : "sell"} in wallet
                      </button>
                    </>
                  )}
                </div>
              )}
              {quote && !currentQuote && quote.key === context && (
                <p className="fine">
                  Quote expired. Get a new quote to continue.
                </p>
              )}
            </form>
            <div className="feedback" role="status">
              {busy && <strong>{busy}… </strong>}
              {message}
              {tx && (
                <p>
                  <a
                    href={`${explorer}/tx/${tx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction {short(tx)} ↗
                  </a>
                </p>
              )}
            </div>
            <div role="alert" className="error">
              {error}
            </div>
          </section>{" "}
          <section className="donation-card" aria-labelledby="donate-title">
            <div className="section-top">
              <div>
                <p className="eyebrow">Back to the pool</p>
                <h2 id="donate-title">Put accrued fees to work.</h2>
              </div>
              <span className="donate-icon" aria-hidden="true">
                ↺
              </span>
            </div>
            <p>
              Anyone can return the hook’s accrued fees to active liquidity
              providers. You only pay network gas.
            </p>
            <div className="accrued">
              <span>
                <strong>
                  {s
                    ? displayAmount(
                        s.accrued[0],
                        rt.chain.nativeCurrency.decimals,
                      )
                    : "—"}
                </strong>{" "}
                ETH
              </span>
              <span>
                <strong>
                  {s ? displayAmount(s.accrued[1], s.decimals) : "—"}
                </strong>{" "}
                MOMO
              </span>
            </div>
            <button
              onClick={donate}
              disabled={
                !ready ||
                !!busy ||
                !s ||
                s.liquidity === 0n ||
                s.accrued.every((a) => a === 0n)
              }
            >
              Donate accrued fees <span aria-hidden="true">↗</span>
            </button>
            <p className="fine">
              {disconnected
                ? "Connect your wallet to donate."
                : s?.liquidity === 0n
                  ? "No active liquidity: fees wait safely in the hook until liquidity returns."
                  : s?.accrued.every((a) => a === 0n)
                    ? "No accrued fees to donate yet."
                    : wrongChain
                      ? "Switch networks to donate."
                      : "Donations go to in-range liquidity providers, not your wallet."}
            </p>
          </section>
        </div>
        <section className="history" aria-labelledby="history-title">
          <div className="section-top">
            <div>
              <p className="eyebrow">Onchain activity</p>
              <h2 id="history-title">Momentum history</h2>
            </div>
            <button
              className="small"
              disabled={history.isFetching || state.isFetching}
              onClick={() => void refresh()}
            >
              Refresh <span aria-hidden="true">↻</span>
            </button>
          </div>
          <p className="fine">
            {history.data
              ? `Latest 20 events in blocks ${history.data.fromBlock.toString()}–${history.data.toBlock.toString()}.`
              : "Recent activity from the latest 2,000 blocks."}{" "}
            Dust swaps appear here but do not advance the streak.
          </p>
          {history.isError ? (
            <p className="error" role="alert">
              History could not be loaded. Use Refresh to retry.{" "}
              {errorText(history.error)}
            </p>
          ) : history.isPending ? (
            <p className="empty">Waiting for verified pool activity…</p>
          ) : history.data.rows.length === 0 ? (
            <div className="empty">
              <span aria-hidden="true">↗ ↘</span>
              <h3>No swaps in this window.</h3>
              <p>
                The next swap will leave its mark here. Refresh to check again.
              </p>
            </div>
          ) : (
            <div
              className="table-wrap"
              tabIndex={0}
              role="region"
              aria-label="Momentum events; scroll horizontally for transaction links"
            >
              <table>
                <caption className="sr-only">
                  Recent Momentum swap events
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Direction</th>
                    <th scope="col">Streak after</th>
                    <th scope="col">Hook fee</th>
                    <th scope="col">Accrued</th>
                    <th scope="col">Block / transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.rows.map((row) => (
                    <tr key={`${row.transactionHash}:${row.logIndex}`}>
                      <td>
                        <span
                          className={`event-direction ${row.args.buy ? "buy" : "sell"}`}
                        >
                          {row.args.buy ? "↗ Buy" : "↘ Sell"}
                        </span>
                      </td>
                      <td>{row.args.streak.toString()}</td>
                      <td>{percent(row.args.feeBps)}</td>
                      <td>
                        {displayAmount(
                          row.args.fee,
                          row.args.currency.toLowerCase() ===
                            rt.token.address.toLowerCase()
                            ? rt.manifest.token.decimals
                            : rt.chain.nativeCurrency.decimals,
                        )}{" "}
                        {row.args.currency.toLowerCase() ===
                        rt.token.address.toLowerCase()
                          ? "MOMO"
                          : "ETH"}
                      </td>
                      <td>
                        <a
                          href={`${explorer}/tx/${row.transactionHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {row.blockNumber.toString()} ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="rules" aria-labelledby="rules-title">
          <div>
            <p className="eyebrow">The rhythm, explained</p>
            <h2 id="rules-title">A streak has a price.</h2>
          </div>
          <div>
            <p>
              A swap with at least <strong>0.001 ETH</strong> on its pool delta
              advances the streak. The next swap in that direction pays 0.10%
              more, from a 0.30% base up to 2.00%.
            </p>
            <p>
              A qualifying swap in the opposite direction starts a new streak.
              Smaller swaps pay the directional fee but leave the streak
              unchanged. Resetting with a counter-swap costs two hook fees plus
              LP fees for the round trip.
            </p>
            <details>
              <summary>View contracts and deployment</summary>
              <ul>
                {rt.manifest.contracts.map((c) => (
                  <li key={c.name}>
                    <span>{c.name}</span>
                    <a
                      href={`${explorer}/address/${c.address}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {c.address} ↗
                    </a>
                  </li>
                ))}
                <li>
                  <span>PoolSwapTest</span>
                  <a
                    href={`${explorer}/address/${rt.manifest.routing.poolSwapTest}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {rt.manifest.routing.poolSwapTest} ↗
                  </a>
                </li>
                {Object.entries(rt.manifest.network.uniswapV4).map(
                  ([name, contractAddress]) => (
                    <li key={name}>
                      <span>{name}</span>
                      <a
                        href={`${explorer}/address/${contractAddress}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {contractAddress} ↗
                      </a>
                    </li>
                  ),
                )}
              </ul>
              {address && <p className="mono">Connected wallet: {address}</p>}
              <p className="mono">Pool ID: {rt.poolId}</p>
              <a href="./imd-deployment.json">View deployment manifest ↗</a>
              <p className="fine">
                No owner or admin. The hook ignores hookData and credits no
                swapper. Source {short(rt.manifest.sourceCommit)}.{" "}
                {verified.data && !verified.isError
                  ? "RPC network and deployed code checked."
                  : "Deployment checks pending."}
              </p>
            </details>
          </div>
        </section>
      </main>
      <footer className="footer shell">
        <span className="brand">momentum.</span>
        <p>Small moves. Visible consequences.</p>
        <a
          href={rt.manifest.network.faucets[0]}
          target="_blank"
          rel="noreferrer"
        >
          Get testnet ETH ↗
        </a>
        <span>
          {s ? `Read at block ${s.blockNumber}` : "Connecting to Sepolia"}
        </span>
      </footer>
    </>
  );
}
