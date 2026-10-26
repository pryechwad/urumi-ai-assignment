#!/usr/bin/env node
// Browser check of the dashboard against a running deployment: signs in, opens every page at
// desktop and phone width, fails on console errors or failed API calls, and saves screenshots.
//
//   node scripts/ui-check.mjs [out-dir]
//
// Uses the locally installed Microsoft Edge or Chrome via playwright-core (no browser download).
// Env: APP_URL, ADMIN_EMAIL, ADMIN_PASSWORD (read from the cluster if unset), KUBE_CONTEXT, BROWSER=msedge|chrome
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const APP = process.env.APP_URL ?? "http://app.localtest.me:8088";
const OUT = process.argv[2] ?? "ui-screenshots";
const EMAIL = process.env.ADMIN_EMAIL ?? "pryechwad@gmail.com";
const PASSWORD =
  process.env.ADMIN_PASSWORD ??
  Buffer.from(
    execFileSync("kubectl", ["--context", process.env.KUBE_CONTEXT ?? "k3d-urumi", "-n", "urumi-platform", "get", "secret", "gateway", "-o", "jsonpath={.data.BOOTSTRAP_ADMIN_PASSWORD}"], { encoding: "utf8" }),
    "base64",
  ).toString();

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER ?? "msedge", headless: true });
const problems = [];

async function run(label, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    // The signed-out session probe (GET /api/auth/me -> 401) is expected on the login page.
    if (m.type() !== "error" || (m.text().includes("401") && m.location().url.endsWith("/api/auth/me"))) return;
    problems.push(`[${label}] console: ${m.text()}`);
  });
  page.on("response", (r) => r.url().includes("/api/") && r.status() >= 500 && problems.push(`[${label}] ${r.status()} ${r.url()}`));

  await page.goto(`${APP}/login`);
  await page.screenshot({ path: join(OUT, `${label}-00-login.png`) });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(`${APP}/`);

  const pages = [
    ["01-overview", "/", /^Welcome back/],
    ["02-servers", "/servers", "Servers"],
    ["04-tools", "/tools", "Tools"],
    ["05-chat", "/chat", "Chat"],
    ["10-stores", "/stores", "Stores"],
    ["06-keys", "/keys", "API keys"],
    ["07-team", "/team", "Team"],
    ["08-audit", "/audit", "Audit log"],
  ];
  for (const [name, path, heading] of pages) {
    await page.goto(`${APP}${path}`);
    await page.getByRole("heading", { level: 1, name: heading }).waitFor({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    // No horizontal page scroll at any width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`[${label}] ${path} overflows horizontally by ${overflow}px`);
    await page.screenshot({ path: join(OUT, `${label}-${name}.png`), fullPage: true });
  }

  // A server detail page and the add-server dialog.
  await page.goto(`${APP}/servers`);
  await page.getByText("WooCommerce", { exact: true }).first().click();
  await page.getByRole("heading", { level: 1, name: "WooCommerce" }).waitFor();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(OUT, `${label}-03-server-detail.png`), fullPage: true });
  if (label === "desktop") {
    await page.goto(`${APP}/servers`);
    await page.getByRole("button", { name: "Add server" }).click();
    await page.getByRole("dialog").waitFor();
    await page.screenshot({ path: join(OUT, `${label}-09-add-server.png`) });
  }
  await ctx.close();
}

await run("desktop", { width: 1366, height: 860 });
await run("phone", { width: 390, height: 844 });
await browser.close();

if (problems.length) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log(`UI check passed; screenshots in ${OUT}`);
