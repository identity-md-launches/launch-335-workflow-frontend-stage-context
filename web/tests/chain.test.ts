import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  amountUnits,
  decodeDelta,
  priceLimit,
  sqrt,
  switchNetwork,
  displayAmount,
} from "../src/chain";
import { abiHash, type Manifest } from "../src/config";
import type { Abi, EIP1193Provider } from "viem";
const manifest = JSON.parse(
  readFileSync("../dist/imd-deployment.json", "utf8"),
) as Manifest;
describe("Transaction amounts and limits", () => {
  it("rejects zero, negative, exponent, overflow and excess decimal precision", () => {
    for (const bad of [
      "0",
      "-1",
      "1e6",
      ".1",
      "1.0000001",
      "999999999999999999999999999999999999999999",
    ])
      expect(() => amountUnits(bad, 6)).toThrow();
    expect(amountUnits("0.001", 18)).toBe(10n ** 15n);
  });
  it("formats dust without falsely displaying zero", () =>
    expect(displayAmount(1n, 18)).toBe("<0.000001"));
  it("enforces directional pool-price bounds with integer arithmetic", () => {
    const p = 2n ** 96n;
    expect(priceLimit(p, true, 100) ** 2n).toBeLessThanOrEqual(
      (p * p * 9900n) / 10000n,
    );
    expect(priceLimit(p, false, 100) ** 2n).toBeLessThanOrEqual(
      (p * p * 10100n) / 10000n,
    );
    expect(priceLimit(p, false, 100)).toBeGreaterThan(p);
    expect(() => priceLimit(p, true, 0)).toThrow();
    for (let n = 0n; n < 1000n; n++)
      expect(sqrt(n) ** 2n <= n && (sqrt(n) + 1n) ** 2n > n).toBe(true);
  });
  it("decodes signed packed deltas for buy and sell", () => {
    const pack = (a: bigint, b: bigint) =>
      BigInt.asIntN(
        256,
        (BigInt.asUintN(128, a) << 128n) | BigInt.asUintN(128, b),
      );
    expect(decodeDelta(pack(-100n, 200n), true)).toEqual({
      spent: 100n,
      received: 200n,
    });
    expect(decodeDelta(pack(150n, -300n), false)).toEqual({
      spent: 300n,
      received: 150n,
    });
  });
});
describe("Attested interfaces and wallet fallback", () => {
  it("matches canonical Keccak hashes of every implementation ABI", () => {
    for (const c of manifest.contracts) {
      const abi = JSON.parse(
        readFileSync(`../dist/${c.abiPath}`, "utf8"),
      ) as Abi;
      expect(abiHash(abi)).toBe(c.abiHash);
    }
  });
  it("adds an unknown chain using the exact supplied parameters then switches again", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({ code: 4902 })
      .mockResolvedValue(null);
    await switchNetwork({ request } as EIP1193Provider, manifest);
    expect(request.mock.calls.map((c) => c[0].method)).toEqual([
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
    expect(request.mock.calls[1][0].params).toEqual([manifest.walletAddChain]);
  });
  it("does not add a chain when switching is rejected by the user", async () => {
    const request = vi.fn().mockRejectedValue({ code: 4001 });
    await expect(
      switchNetwork({ request } as EIP1193Provider, manifest),
    ).rejects.toEqual({ code: 4001 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
