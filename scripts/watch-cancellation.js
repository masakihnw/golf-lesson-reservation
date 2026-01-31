#!/usr/bin/env node
/**
 * キャンセル監視: キャンセル待ち以外で条件に合う〇が出たら即予約する
 *
 * waitlist.json に登録した日時は除外し、それ以外で preferredDays・timeRange に合う枠があれば
 * 1件予約して Slack 通知して終了。頻繁に実行する想定（例: 30分ごと）。
 *
 * 使い方: npm run watch  /  npm run watch:headed
 */

import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const WAITLIST_PATH = resolve(projectRoot, "waitlist.json");

function loadConfig() {
  const path = resolve(projectRoot, "config.yaml");
  try {
    return yaml.load(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") {
      console.error("config.yaml が見つかりません。");
      process.exit(1);
    }
    throw e;
  }
}

function loadWaitlist() {
  if (!existsSync(WAITLIST_PATH)) return { targetMonth: null, slots: [] };
  try {
    return JSON.parse(readFileSync(WAITLIST_PATH, "utf8"));
  } catch {
    return { targetMonth: null, slots: [] };
  }
}

function getEnvCredentials() {
  const email = process.env.GOLF_RESERVATION_EMAIL;
  const password = process.env.GOLF_RESERVATION_PASSWORD;
  if (!email || !password) {
    console.error(".env に GOLF_RESERVATION_EMAIL と GOLF_RESERVATION_PASSWORD を設定してください。");
    process.exit(1);
  }
  return { email, password };
}

async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.warn("Slack 通知に失敗しました:", e.message);
  }
}

function parseDetailDateTime(text) {
  const m = text && text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, y, mon, d, h, min] = m;
  return {
    key: `${y}-${mon.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min}`,
    day: parseInt(d, 10),
    hour: parseInt(h, 10),
  };
}

async function main() {
  let config = loadConfig();
  if (process.env.TARGET_MONTH) config = { ...config, targetMonth: process.env.TARGET_MONTH };
  const { targetMonth, preferredDays = [], timeRange = {} } = config;
  const timeStart = timeRange.start ?? 17;
  const timeEnd = timeRange.end ?? 18;
  const preferredDaysSet = new Set(preferredDays);
  const { slots: waitlistSlots } = loadWaitlist();
  const waitlistSet = new Set(waitlistSlots || []);

  const [targetYear, targetMonthNum] = (targetMonth || "").split("-").map(Number);
  if (!targetMonth || !targetYear) {
    console.error("config.yaml の targetMonth を設定してください。");
    process.exit(1);
  }

  const { email, password } = getEnvCredentials();
  const baseUrl = config.baseUrl || "https://appy-epark.com";
  const loginPath = config.loginPath || "/users/login/login.php";
  const headed = process.env.HEADED === "1";

  const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 100 : 0 });
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl.replace(/\/$/, "") + loginPath, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    let filled = false;
    for (const loc of [
      () => page.getByLabel(/メール|email|ログイン|ID/i).first(),
      () => page.getByPlaceholder(/メール|mail|email/i).first(),
      () => page.locator('input[type="email"]').first(),
      () => page.locator('input[name*="mail"], input[name*="login"]').first(),
      () => page.locator('form input[type="text"]').first(),
      () => page.locator('input:not([type="password"])').first(),
    ]) {
      try {
        await loc().fill(email, { timeout: 3000 });
        filled = true;
        break;
      } catch (_) {}
    }
    if (!filled) {
      console.error("ログイン画面でメール欄が見つかりません。");
      await browser.close();
      process.exit(1);
    }
    await page.locator('input[type="password"]').first().fill(password, { timeout: 5000 });
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForURL(/mypage|index\.php/, { timeout: 15000 }).catch(() => {});

    await page.getByRole("link", { name: /空枠確認・予約する/ }).click();
    await page.waitForLoadState("domcontentloaded");
    let lessonClicked = false;
    for (const loc of [
      () => page.getByRole("link", { name: /各種50分枠レッスン/ }).first(),
      () => page.getByText(/各種50分枠レッスン/).first(),
      () => page.locator('a:has-text("各種50分枠レッスン")').first(),
    ]) {
      try {
        await loc().click({ timeout: 5000 });
        lessonClicked = true;
        break;
      } catch (_) {}
    }
    if (!lessonClicked) {
      console.error("各種50分枠レッスン が見つかりません。");
      await browser.close();
      process.exit(1);
    }
    await page.waitForLoadState("domcontentloaded");

    const nextWeekBtn = page.getByRole("button", { name: /次の一週間/ }).or(page.getByText("次の一週間").first());
    let weeks = 0;
    while (weeks < 6) {
      const body = await page.locator("body").textContent();
      if (body && body.includes(`${targetYear}年${targetMonthNum}月`)) break;
      if (!(await nextWeekBtn.isVisible().catch(() => false))) break;
      await nextWeekBtn.click();
      await page.waitForTimeout(800);
      weeks++;
    }

    const maxWeeksScan = 6; // 1ページ1週間のため、「次の一週間」で最大6週分を確認
    for (let weekLoop = 0; weekLoop < maxWeeksScan; weekLoop++) {
      const body = await page.locator("body").textContent();
      if (body && !body.includes(`${targetYear}年${targetMonthNum}月`)) break; // 対象月を過ぎたら終了

      const cellsWithCircle = page.locator("td").filter({ hasText: "○" });
      const count = await cellsWithCircle.count();
      for (let i = 0; i < count; i++) {
        const cell = cellsWithCircle.nth(i);
        const link = cell.locator("a").first();
        if ((await link.count()) > 0) await link.click();
        else await cell.click();
        await page.waitForLoadState("domcontentloaded");

        const bodyText = await page.locator("body").textContent();
        const parsed = parseDetailDateTime(bodyText || "");
        if (!parsed) {
          await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
          await page.waitForLoadState("domcontentloaded");
          continue;
        }
        if (waitlistSet.has(parsed.key)) {
          await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
          await page.waitForLoadState("domcontentloaded");
          continue;
        }
        const dayOk = preferredDaysSet.size === 0 || preferredDaysSet.has(parsed.day);
        const hourOk = parsed.hour >= timeStart && parsed.hour < timeEnd;
        if (!dayOk || !hourOk) {
          await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
          await page.waitForLoadState("domcontentloaded");
          continue;
        }

        const pairCheckbox = page.getByRole("checkbox", { name: "ペアレッスン" });
        const pairLabel = page.getByText("ペアレッスン").first();
        if (await pairCheckbox.isVisible().catch(() => false)) await pairCheckbox.check();
        else await pairLabel.click().catch(() => {});
        await page.waitForTimeout(300);

        const reserveBtn = page.getByRole("button", { name: /予約する/ }).or(page.locator('a:has-text("予約する"), button:has-text("予約する")').first());
        await reserveBtn.click();
        await page.waitForLoadState("domcontentloaded");

        await notifySlack(`【ゴルフレッスン予約】キャンセル枠を予約しました。${parsed.key}（対象月: ${targetMonth}）`);
        console.log("キャンセル枠を予約しました:", parsed.key);
        await browser.close();
        process.exit(0);
      }

      if (!(await nextWeekBtn.isVisible().catch(() => false))) break;
      await nextWeekBtn.click();
      await page.waitForTimeout(800);
    }

    console.log("条件に合うキャンセル枠はありませんでした。");
  } catch (err) {
    console.error("エラー:", err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
