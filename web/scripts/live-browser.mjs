import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../../", import.meta.url),
  dist = new URL("dist/", root),
  evidence = new URL("docs/evidence/", root);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (!path.startsWith("/preview/") || path.includes(".."))
      throw Error("Invalid path");
    const rel = path.slice(9) || "index.html";
    const bytes = await readFile(new URL(rel, dist));
    res.setHeader(
      "content-type",
      rel.endsWith(".js")
        ? "text/javascript"
        : rel.endsWith(".css")
          ? "text/css"
          : rel.endsWith(".json")
            ? "application/json"
            : "text/html",
    );
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ args: ["--no-sandbox"] }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const result = {
  date: new Date().toISOString(),
  browser: browser.version(),
  mode: "Actual public RPC requests from Chromium; disconnected wallet; no broadcast",
  console: [],
  requests: [],
  contrast: [],
};
page.on("pageerror", (e) => result.console.push(e.message));
page.on("requestfailed", (r) =>
  result.requests.push({ url: r.url(), error: r.failure()?.errorText }),
);
const luma = (rgb) =>
  rgb
    .map((c) => c / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((a, b, i) => a + b * [0.2126, 0.7152, 0.0722][i], 0);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/preview/`);
  await page
    .getByRole("heading", { name: "Every swap changes the rhythm." })
    .waitFor();
  try {
    await page
      .getByText("Live pool", { exact: true })
      .waitFor({ timeout: 45000 });
    result.liveRead = "passed";
  } catch {
    result.liveRead = "unavailable";
  }
  result.text = await page.locator("main").innerText();
  await page.screenshot({
    path: fileURLToPath(new URL("live-desktop.png", evidence)),
    fullPage: true,
  });
  for (const selector of [
    ".lede",
    ".streak-caption",
    ".fees strong",
    ".router-note",
    ".donation-card > p:not(.fine)",
    ".primary",
    ".network-tag",
  ]) {
    const colors = await page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const css = getComputedStyle(el);
        let current = el,
          bg = "";
        while (current) {
          const color = getComputedStyle(current).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
            bg = color;
            break;
          }
          current = current.parentElement;
        }
        return {
          foreground: css.color,
          background: bg,
          fontSize: css.fontSize,
        };
      });
    const parse = (s) =>
        s
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number),
      a = luma(parse(colors.foreground)),
      b = luma(parse(colors.background));
    result.contrast.push({
      selector,
      ...colors,
      ratio: Number(
        ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2),
      ),
    });
  }
  await page.getByRole("button", { name: "Connect wallet" }).focus();
  await page.screenshot({
    path: fileURLToPath(new URL("keyboard-focus.png", evidence)),
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({
    path: fileURLToPath(new URL("live-mobile.png", evidence)),
    fullPage: true,
  });
  result.noMobileOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
} finally {
  await writeFile(
    new URL("live-browser.json", evidence),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, text: undefined }, null, 2));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
