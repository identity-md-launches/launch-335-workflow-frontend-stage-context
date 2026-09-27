import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeFunctionResult,
  encodeEventTopics,
  encodeAbiParameters,
  parseEther,
} from "viem";
const root = new URL("../../", import.meta.url),
  dist = new URL("dist/", root),
  evidence = new URL("docs/evidence/", root);
await mkdir(evidence, { recursive: true });
const manifest = JSON.parse(
  await readFile(new URL("imd-deployment.json", dist), "utf8"),
);
const abis = {};
for (const c of manifest.contracts)
  abis[c.name] = JSON.parse(await readFile(new URL(c.abiPath, dist), "utf8"));
for (const [name, a] of Object.entries(manifest.protocolAbis))
  abis[name] = JSON.parse(await readFile(new URL(a.path, dist), "utf8"));
const all = Object.values(abis).flat(),
  account = "0x1234567890123456789012345678901234567890",
  hash = "0x" + "ab".repeat(32),
  blockHash = "0x" + "cd".repeat(32),
  block = BigInt(manifest.deploymentBlock) + 2100n;
const token = manifest.contracts.find((c) => c.name === "Momentum").address,
  hook = manifest.contracts.find((c) => c.name === "MomentumFeeHook").address;
const tests = [],
  consoleErrors = [],
  resourceErrors = [];
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith("/preview/") || path.includes(".."))
      throw Error("Invalid path");
    const rel = path.slice(9) || "index.html";
    const bytes = await readFile(new URL(rel, dist));
    res.setHeader(
      "Content-Type",
      rel.endsWith(".js")
        ? "text/javascript"
        : rel.endsWith(".css")
          ? "text/css"
          : rel.endsWith(".json")
            ? "application/json"
            : rel.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html",
    );
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/preview/`;
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
let page;
async function record(name, fn) {
  await fn();
  tests.push({ name, status: "passed" });
  console.log(`PASS ${name}`);
}
const pack = (a, b) =>
  BigInt.asIntN(256, (BigInt.asUintN(128, a) << 128n) | BigInt.asUintN(128, b));
async function setup({
  wallet = true,
  wrong = false,
  unknown = false,
  failReads = false,
  noCode = false,
  zeroLiquidity = false,
  emptyHistory = false,
  tamperAbi = false,
} = {}) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
    }),
    page = await context.newPage();
  const fixture = {
    allowance: 0n,
    donated: false,
    revert: false,
    revertReceipt: false,
    reject: false,
    calls: [],
    sent: [],
    logs: [],
  };
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("response", (r) => {
    if (r.url().startsWith(url) && r.status() >= 400)
      resourceErrors.push(`${r.status()} ${r.url()}`);
  });
  await page.route(/^https:\/\//, async (route) => {
    if (route.request().method() !== "POST") {
      await route.abort();
      return;
    }
    const payload = route.request().postDataJSON();
    async function rpc(req) {
      fixture.calls.push(req);
      const { method, params = [] } = req;
      let result;
      if (failReads && method === "eth_call")
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "Fixture RPC unavailable" },
        };
      if (method === "eth_chainId") result = manifest.walletAddChain.chainId;
      else if (method === "eth_blockNumber") result = "0x" + block.toString(16);
      else if (method === "eth_getCode")
        result = noCode ? "0x" : "0x6001600055";
      else if (method === "eth_getBalance")
        result = "0x" + parseEther("10").toString(16);
      else if (method === "eth_getTransactionReceipt")
        result = {
          transactionHash: hash,
          transactionIndex: "0x0",
          blockHash,
          blockNumber: "0x" + block.toString(16),
          from: account,
          to: hook,
          cumulativeGasUsed: "0x186a0",
          gasUsed: "0x186a0",
          effectiveGasPrice: "0x3b9aca00",
          contractAddress: null,
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          status: fixture.revertReceipt ? "0x0" : "0x1",
          type: "0x2",
        };
      else if (method === "eth_getLogs") {
        const filter = params[0];
        fixture.logs.push(filter);
        const bn = block - 10n;
        result =
          emptyHistory ||
          BigInt(filter.fromBlock) > bn ||
          BigInt(filter.toBlock) < bn
            ? []
            : [
                {
                  address: hook,
                  topics: encodeEventTopics({
                    abi: abis.MomentumFeeHook,
                    eventName: "Momentum",
                    args: { poolId: filter.topics[1] },
                  }),
                  data: encodeAbiParameters(
                    [
                      { type: "bool" },
                      { type: "uint256" },
                      { type: "uint256" },
                      { type: "address" },
                      { type: "uint256" },
                    ],
                    [true, 7n, 90n, token, parseEther("0.027")],
                  ),
                  blockNumber: "0x" + bn.toString(16),
                  transactionHash: hash,
                  transactionIndex: "0x0",
                  blockHash,
                  logIndex: "0x0",
                  removed: false,
                },
              ];
      } else if (method === "eth_call") {
        const { functionName, args = [] } = decodeFunctionData({
          abi: all,
          data: params[0].data,
        });
        fixture.calls.at(-1).decoded = { functionName, args };
        let value;
        if (
          fixture.revert &&
          ["swap", "donateFees", "quoteExactInputSingle"].includes(functionName)
        )
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: 3,
              message: "execution reverted: Fixture simulation failure",
              data: "0x",
            },
          };
        switch (functionName) {
          case "manager":
          case "poolManager":
            value = manifest.network.uniswapV4.poolManager;
            break;
          case "decimals":
            value = 18;
            break;
          case "streak":
            value = [true, 7n];
            break;
          case "nextFeeBps":
            value = args[1] ? 100n : 30n;
            break;
          case "accrued":
            value = fixture.donated
              ? [0n, 0n]
              : [parseEther("0.0042"), parseEther("18.64")];
            break;
          case "getSlot0":
            value = [2506541289228028214046281103513n, 69090, 0, 3000];
            break;
          case "getLiquidity":
            value = zeroLiquidity ? 0n : 10n ** 20n;
            break;
          case "balanceOf":
            value = parseEther("2500");
            break;
          case "allowance":
            value = fixture.allowance;
            break;
          case "quoteExactInputSingle":
            value = [
              args[0].zeroForOne
                ? args[0].exactAmount * 990n
                : args[0].exactAmount / 1010n,
              150000n,
            ];
            break;
          case "swap": {
            const p = args[1],
              amount = -p.amountSpecified;
            value = p.zeroForOne
              ? pack(-amount, amount * 990n)
              : pack(amount / 1010n, -amount);
            break;
          }
          case "approve":
            value = true;
            break;
          case "donateFees":
            value = [parseEther("0.0042"), parseEther("18.64")];
            break;
          default:
            throw Error(`Unmocked call: ${functionName}`);
        }
        result = encodeFunctionResult({
          abi: all,
          functionName,
          result: value,
        });
      } else throw Error(`Unmocked RPC ${method}`);
      return { jsonrpc: "2.0", id: req.id, result };
    }
    try {
      const response = Array.isArray(payload)
        ? await Promise.all(payload.map(rpc))
        : await rpc(payload);
      await route.fulfill({
        json: response,
        headers: { "access-control-allow-origin": "*" },
      });
    } catch (e) {
      consoleErrors.push(e.message);
      await route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: -32000, message: e.message },
        },
      });
    }
  });
  if (wallet) {
    await page.exposeFunction("mockSend", async (transaction) => {
      if (fixture.reject) throw Error("User rejected the request.");
      fixture.sent.push(transaction);
      const call = decodeFunctionData({ abi: all, data: transaction.data });
      if (call.functionName === "approve") fixture.allowance = call.args[1];
      if (call.functionName === "donateFees") fixture.donated = true;
      return hash;
    });
    await page.addInitScript(
      ({ account, chainId, wrong, unknown }) => {
        const listeners = {};
        let connected = false,
          current = wrong ? "0x1" : chainId,
          missing = unknown;
        window.walletCalls = [];
        window.ethereum = {
          isMetaMask: true,
          on: (event, fn) => {
            (listeners[event] ??= []).push(fn);
          },
          removeListener: (event, fn) => {
            listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
          },
          request: async ({ method, params }) => {
            window.walletCalls.push({ method, params });
            if (method === "eth_accounts") return connected ? [account] : [];
            if (method === "eth_requestAccounts") {
              connected = true;
              return [account];
            }
            if (method === "eth_chainId") return current;
            if (method === "wallet_switchEthereumChain") {
              if (missing) throw { code: 4902, message: "Unknown chain" };
              current = params[0].chainId;
              (listeners.chainChanged ?? []).forEach((f) => f(current));
              return null;
            }
            if (method === "wallet_addEthereumChain") {
              missing = false;
              return null;
            }
            if (method === "eth_sendTransaction")
              return window.mockSend(params[0]);
            if (method === "wallet_requestPermissions")
              return [{ parentCapability: "eth_accounts" }];
            if (method === "wallet_getPermissions")
              return [{ parentCapability: "eth_accounts" }];
            if (method === "wallet_revokePermissions") {
              connected = false;
              return null;
            }
            throw Error(`Unmocked wallet ${method}`);
          },
        };
      },
      { account, chainId: manifest.walletAddChain.chainId, wrong, unknown },
    );
  }
  if (tamperAbi)
    await page.route("**/abi/Momentum.json", (route) =>
      route.fulfill({ json: [] }),
    );
  await page.goto(url);
  await page
    .getByRole("heading", {
      name: tamperAbi ? "Pool unavailable" : "Every swap changes the rhythm.",
    })
    .waitFor();
  return { context, page, fixture };
}
const waitReady = async (page) => {
  await page.getByText("7", { exact: true }).first().waitFor();
};
const connect = async (page) => {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
};
const quote = async (page, value) => {
  await page.getByLabel("You pay, up to").fill(value);
  await page.getByRole("button", { name: "Get quote", exact: false }).click();
  await page.getByText("Preview ready", { exact: true }).waitFor();
};
try {
  let env = await setup();
  page = env.page;
  await waitReady(page);
  await record(
    "Disconnected state shows live metrics and gates transaction controls",
    async () => {
      assert.equal(
        await page.getByRole("button", { name: "Get quote" }).isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Donate accrued fees" })
          .isDisabled(),
        true,
      );
      assert.equal(await page.getByText("1.00%", { exact: true }).count(), 2);
    },
  );
  await record("Wallet connects and enables quoting", async () => {
    await connect(page);
    await page.getByLabel("You pay, up to").fill("0.003");
    assert.equal(
      await page.getByRole("button", { name: "Get quote" }).isEnabled(),
      true,
    );
  });
  await record("Invalid amount is announced and focused", async () => {
    await page.getByLabel("You pay, up to").fill("0");
    await page.getByRole("button", { name: "Get quote" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "positive amount" })
      .waitFor();
    assert.equal(
      await page
        .locator("#amount")
        .evaluate((e) => e === document.activeElement),
      true,
    );
  });
  await record(
    "Buy quote uses attested quoter and PoolSwapTest simulation with price limit",
    async () => {
      await quote(page, "0.003");
      const calls = env.fixture.calls.filter(
        (c) => c.decoded?.functionName === "quoteExactInputSingle",
      );
      assert.equal(
        calls.at(-1).params[0].to.toLowerCase(),
        manifest.network.uniswapV4.quoter,
      );
      const swap = env.fixture.calls.findLast(
        (c) => c.decoded?.functionName === "swap",
      );
      assert.equal(
        swap.params[0].to.toLowerCase(),
        manifest.routing.poolSwapTest.toLowerCase(),
      );
      assert.equal(swap.decoded.args[1].amountSpecified, -parseEther("0.003"));
      assert.equal(swap.decoded.args[3], "0x");
      assert.equal(swap.decoded.args[2].takeClaims, false);
      assert(
        swap.decoded.args[1].sqrtPriceLimitX96 <
          2506541289228028214046281103513n,
      );
    },
  );
  await record("Quote expires and requires a fresh preview", async () => {
    await page.clock.install();
    await page.clock.fastForward(46000);
    await page
      .getByText("Quote expired. Get a new quote to continue.")
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Confirm buy in wallet" }).count(),
      0,
    );
    await page.clock.resume();
  });
  await record(
    "Editing amount invalidates quote and confirmation",
    async () => {
      await quote(page, "0.004");
      await page.getByLabel("You pay, up to").fill("0.005");
      assert.equal(
        await page
          .getByRole("button", { name: "Confirm buy in wallet" })
          .count(),
        0,
      );
    },
  );
  await quote(page, "0.003");
  await record(
    "Successful mocked buy sends native value, waits for receipt and refreshes",
    async () => {
      await page.getByLabel("I accept partial fills").check();
      await page.getByRole("button", { name: "Confirm buy in wallet" }).click();
      await page
        .getByText("Transaction confirmed. Pool state refreshed.", {
          exact: false,
        })
        .waitFor();
      const sent = env.fixture.sent.at(-1);
      assert.equal(BigInt(sent.value), parseEther("0.003"));
      assert.equal(
        sent.to.toLowerCase(),
        manifest.routing.poolSwapTest.toLowerCase(),
      );
      assert.equal(env.fixture.sent.length, 1);
    },
  );
  await record(
    "Sell approval is exact and goes directly to workflow PoolSwapTest",
    async () => {
      await page.getByRole("button", { name: "Sell MOMO" }).click();
      await quote(page, "2");
      await page
        .getByRole("button", { name: "Approve MOMO", exact: true })
        .click();
      await page
        .getByText("Transaction confirmed. Pool state refreshed.", {
          exact: false,
        })
        .waitFor();
      const sent = env.fixture.sent.at(-1),
        call = decodeFunctionData({ abi: abis.Momentum, data: sent.data });
      assert.equal(sent.to.toLowerCase(), token);
      assert.equal(call.functionName, "approve");
      assert.equal(
        call.args[0].toLowerCase(),
        manifest.routing.poolSwapTest.toLowerCase(),
      );
      assert.equal(call.args[1], parseEther("2"));
    },
  );
  await record(
    "Sell simulation and transaction use negative exact input and zero native value",
    async () => {
      await page.getByRole("button", { name: "Get quote" }).click();
      await page.getByText("Preview ready", { exact: true }).waitFor();
      await page.getByLabel("I accept partial fills").check();
      await page
        .getByRole("button", { name: "Confirm sell in wallet" })
        .click();
      await page
        .getByText("Transaction confirmed. Pool state refreshed.", {
          exact: false,
        })
        .waitFor();
      const sent = env.fixture.sent.at(-1),
        call = decodeFunctionData({ abi: abis.PoolSwapTest, data: sent.data });
      assert.equal(BigInt(sent.value ?? "0x0"), 0n);
      assert.equal(call.args[1].amountSpecified, -parseEther("2"));
      assert.equal(call.args[1].zeroForOne, false);
      assert(call.args[1].sqrtPriceLimitX96 > 2506541289228028214046281103513n);
    },
  );
  await record(
    "Donation uses hook donateFees and refreshes accrued balances",
    async () => {
      await page.getByRole("button", { name: "Donate accrued fees" }).click();
      await page
        .getByText("Transaction confirmed. Pool state refreshed.", {
          exact: false,
        })
        .waitFor();
      assert.equal(env.fixture.sent.at(-1).to.toLowerCase(), hook);
      assert.equal(
        decodeFunctionData({
          abi: abis.MomentumFeeHook,
          data: env.fixture.sent.at(-1).data,
        }).functionName,
        "donateFees",
      );
      await page.getByText("No accrued fees to donate yet.").waitFor();
    },
  );
  await record(
    "Simulation failure is recoverable and never sends a transaction",
    async () => {
      env.fixture.revert = true;
      const count = env.fixture.sent.length;
      await page.getByRole("button", { name: "Get quote" }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: /revert|failure/i })
        .waitFor();
      assert.equal(env.fixture.sent.length, count);
      env.fixture.revert = false;
    },
  );
  await record("Wallet rejection leaves form usable", async () => {
    await page.getByRole("button", { name: "Get quote" }).click();
    await page.getByText("Preview ready", { exact: true }).waitFor();
    await page.getByLabel("I accept partial fills").check();
    env.fixture.reject = true;
    await page.getByRole("button", { name: "Confirm sell in wallet" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Request declined" })
      .waitFor();
    env.fixture.reject = false;
    assert.equal(
      await page.getByRole("button", { name: "Get quote" }).isEnabled(),
      true,
    );
  });
  await record(
    "History covers the bounded window in non-overlapping 500-block chunks",
    async () => {
      const logs = env.fixture.logs.slice(0, 4);
      assert.equal(logs.length, 4);
      assert.equal(BigInt(logs[0].fromBlock), block - 1999n);
      assert.equal(BigInt(logs[3].toBlock), block);
      for (let i = 1; i < 4; i++)
        assert.equal(
          BigInt(logs[i].fromBlock),
          BigInt(logs[i - 1].toBlock) + 1n,
        );
      await page.getByRole("cell", { name: "0.90%" }).waitFor();
    },
  );
  await env.context.close();
  env = await setup({ wrong: true, unknown: true });
  page = env.page;
  await waitReady(page);
  await connect(page);
  await record(
    "Unknown chain offers exact wallet_addEthereumChain after 4902, then switches",
    async () => {
      await page.getByRole("button", { name: "Switch to Sepolia" }).click();
      await page
        .getByRole("button", { name: "Switch to Sepolia" })
        .waitFor({ state: "detached" });
      const calls = await page.evaluate(() => window.walletCalls);
      assert.deepEqual(
        calls.find((c) => c.method === "wallet_addEthereumChain").params,
        [manifest.walletAddChain],
      );
      assert.equal(
        calls.filter((c) => c.method === "wallet_switchEthereumChain").length,
        2,
      );
    },
  );
  await quote(page, "0.003");
  await page.getByLabel("I accept partial fills").check();
  env.fixture.revertReceipt = true;
  await record(
    "Reverted receipt is reported as failure, never success",
    async () => {
      await page.getByRole("button", { name: "Confirm buy in wallet" }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "transaction reverted" })
        .waitFor();
      assert.equal(
        await page
          .getByText("Transaction confirmed. Pool state refreshed.", {
            exact: false,
          })
          .count(),
        0,
      );
    },
  );
  await env.context.close();
  env = await setup({ wallet: false });
  page = env.page;
  await waitReady(page);
  await record("Missing wallet has an actionable error", async () => {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "No browser wallet found" })
      .waitFor();
  });
  await env.context.close();
  env = await setup({ zeroLiquidity: true, emptyHistory: true });
  page = env.page;
  await waitReady(page);
  await connect(page);
  await record(
    "Zero liquidity disables donation while allowing first-buy quote; empty history is explicit",
    async () => {
      assert.equal(
        await page
          .getByRole("button", { name: "Donate accrued fees" })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("button", { name: "Get quote" }).isEnabled(),
        true,
      );
      await page.getByText("No swaps in this window.").waitFor();
      await quote(page, "0.003");
    },
  );
  await env.context.close();
  env = await setup({ failReads: true });
  page = env.page;
  await record(
    "RPC failure keeps transaction controls disabled and offers retry",
    async () => {
      await page
        .getByRole("alert")
        .filter({ hasText: "Live pool data is unavailable." })
        .waitFor({ timeout: 30000 });
      assert.equal(
        await page.getByRole("button", { name: "Get quote" }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("button", { name: "Retry connection" }).count(),
        1,
      );
    },
  );
  await env.context.close();
  env = await setup({ tamperAbi: true });
  page = env.page;
  await record("Tampered implementation ABI blocks app startup", async () => {
    await page
      .getByRole("alert")
      .filter({ hasText: "Momentum ABI integrity check failed" })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Get quote" }).count(),
      0,
    );
  });
  await env.context.close();
  env = await setup({ noCode: true });
  page = env.page;
  await record("Missing deployed code fails closed", async () => {
    await page
      .getByRole("alert")
      .filter({ hasText: "No contract code" })
      .waitFor({ timeout: 30000 });
    assert.equal(
      await page.getByRole("button", { name: "Get quote" }).isDisabled(),
      true,
    );
  });
  await env.context.close();
  env = await setup();
  page = env.page;
  await waitReady(page);
  await connect(page);
  await record(
    "Insufficient balance is rejected before quoting or signing",
    async () => {
      await page.getByLabel("You pay, up to").fill("11");
      await page.getByRole("button", { name: "Get quote" }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Insufficient ETH balance" })
        .waitFor();
      assert.equal(env.fixture.sent.length, 0);
    },
  );
  await record(
    "Keyboard completes buy preview, acceptance and confirmation",
    async () => {
      await page.getByLabel("You pay, up to").focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("0.003");
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "price-limit",
      );
      await page.keyboard.press("Tab");
      assert.match(
        await page.evaluate(() => document.activeElement.textContent),
        /Get quote/,
      );
      await page.keyboard.press("Enter");
      await page.getByText("Preview ready", { exact: true }).waitFor();
      await page.getByLabel("I accept partial fills").focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("Tab");
      assert.match(
        await page.evaluate(() => document.activeElement.textContent),
        /Confirm buy/,
      );
      await page.keyboard.press("Enter");
      await page
        .getByText("Transaction confirmed. Pool state refreshed.", {
          exact: false,
        })
        .waitFor();
      assert.equal(env.fixture.sent.length, 1);
    },
  );
  await quote(page, "0.003");
  await record(
    "Desktop accessibility scan has no WCAG A/AA violations",
    async () => {
      const scan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      await writeFile(
        new URL("axe-desktop.json", evidence),
        JSON.stringify(
          {
            violations: scan.violations,
            passes: scan.passes.map((p) => p.id),
            incomplete: scan.incomplete.map((p) => p.id),
          },
          null,
          2,
        ),
      );
      assert.equal(scan.violations.length, 0, JSON.stringify(scan.violations));
    },
  );
  for (const width of [1440, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    await record(`No page overflow at ${width}px`, async () => {
      const metrics = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert(metrics.scroll <= metrics.client, JSON.stringify(metrics));
    });
    if (width === 1440 || width === 390)
      await page.screenshot({
        path: fileURLToPath(new URL(`mocked-${width}.png`, evidence)),
        fullPage: true,
      });
  }
  await record(
    "Mobile accessibility scan has no WCAG A/AA violations",
    async () => {
      const scan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      await writeFile(
        new URL("axe-mobile.json", evidence),
        JSON.stringify(
          {
            violations: scan.violations,
            passes: scan.passes.map((p) => p.id),
            incomplete: scan.incomplete.map((p) => p.id),
          },
          null,
          2,
        ),
      );
      assert.equal(scan.violations.length, 0, JSON.stringify(scan.violations));
    },
  );
  await record(
    "Keyboard focus follows native controls and skip link reaches main",
    async () => {
      await page.goto(url);
      await page
        .getByRole("link", { name: "Skip to content" })
        .waitFor({ state: "attached" });
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement.textContent),
        "Skip to content",
      );
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      const tag = await page.evaluate(() => document.activeElement.tagName);
      assert(["BUTTON", "INPUT", "A"].includes(tag));
    },
  );
  await page.setViewportSize({ width: 820, height: 1080 });
  await page.evaluate(() => (document.documentElement.style.fontSize = "32px"));
  await record("200% text enlargement has no page overflow", async () => {
    assert(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    );
  });
  await page.evaluate(() => (document.documentElement.style.fontSize = ""));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await record("Reduced motion disables button transitions", async () =>
    assert.equal(
      await page
        .locator("button")
        .first()
        .evaluate((e) => getComputedStyle(e).transitionDuration),
      "0s",
    ),
  );
  await record("No page script errors or failed local resources", async () => {
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(resourceErrors, []);
  });
  await env.context.close();
  await writeFile(
    new URL("browser-results.json", evidence),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: browser.version(),
        mode: "Production export at /preview/; wallet and RPC responses mocked, no broadcast",
        tests,
        consoleErrors,
        resourceErrors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${tests.length} browser checks passed.`);
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({
      path: fileURLToPath(new URL("test/scratch/failure.png", root)),
      fullPage: true,
    });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
