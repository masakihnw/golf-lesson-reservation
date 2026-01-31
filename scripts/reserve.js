#!/usr/bin/env node
/**
 * ゴルフレッスン予約 自動化スクリプト（Playwright）
 *
 * 手順: ログイン → 空枠確認・予約する → 各種50分枠レッスン → カレンダーで〇を選択 → ペアレッスンにチェック → 予約する
 *
 * 使い方:
 *   cp config.example.yaml config.yaml  # 編集
 *   cp .env.example .env                 # メール・パスワードを設定
 *   npm install
 *   npx playwright install chromium
 *   npm run reserve          # ヘッドレス
 *   npm run reserve:headed   # ブラウザ表示
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import "dotenv/config";
import { JP_HOLIDAYS } from "./jp-holidays.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const WAITLIST_PATH = resolve(projectRoot, "waitlist.json");
const MAX_WAITLIST = 10;

// --- 設定読み込み ---
function loadConfig() {
  const path = resolve(projectRoot, "config.yaml");
  try {
    const raw = readFileSync(path, "utf8");
    return yaml.load(raw);
  } catch (e) {
    if (e.code === "ENOENT") {
      console.error("config.yaml が見つかりません。config.example.yaml をコピーして config.yaml を作成し、編集してください。");
    } else {
      console.error("config.yaml の読み込みに失敗しました:", e.message);
    }
    process.exit(1);
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

/** 予約詳細ページの本文から「YYYY年M月D日 HH:MM」をパース */
function parseDetailDateTime(text) {
  const m = text && text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, y, mon, d, h] = m;
  return {
    year: parseInt(y, 10),
    month: parseInt(mon, 10),
    day: parseInt(d, 10),
    hour: parseInt(h, 10),
  };
}

function isWeekday(year, month, day) {
  const d = new Date(year, month - 1, day);
  return d.getDay() !== 0 && d.getDay() !== 6;
}

function isJapaneseHoliday(year, month, day) {
  const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return JP_HOLIDAYS.has(key);
}

/** 土日祝なら true（予約優先: 土日祝 > 平日） */
function isWeekendOrHoliday(year, month, day) {
  return !isWeekday(year, month, day) || isJapaneseHoliday(year, month, day);
}

// --- メイン ---
async function main() {
  let config = loadConfig();
  if (process.env.TARGET_MONTH) config = { ...config, targetMonth: process.env.TARGET_MONTH };
  if (process.env.STOP_BEFORE_RESERVE === "1" || process.env.USE_CURRENT_MONTH === "1") {
    const now = new Date();
    config.targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const { email, password } = getEnvCredentials();

  const opensAt = process.env.RESERVATION_OPENS_AT || (config.reservationOpensAt ? `${config.reservationOpensAt.day}日${String(config.reservationOpensAt.hour).padStart(2, "0")}:${String(config.reservationOpensAt.minute || 0).padStart(2, "0")}` : "23日22:00");
  await notifySlack(`【ゴルフレッスン予約】スクリプトを実行しました。対象月: ${config.targetMonth || "未設定"}（予約可能: ${opensAt}）`);

  const baseUrl = config.baseUrl || "https://appy-epark.com";
  const targetMonth = config.targetMonth;
  // 予約してよい日: 環境変数 ALLOWED_DAYS（例: 2,5,9）があればそれを使う。なければ config.preferredDays
  const preferredDaysRaw = process.env.ALLOWED_DAYS
    ? process.env.ALLOWED_DAYS.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
    : config.preferredDays || [];
  const preferredDays = new Set(preferredDaysRaw);
  const timeStart = config.timeRange?.start ?? 17;
  const timeEnd = config.timeRange?.end ?? 18;
  const maxSlots = process.env.STOP_BEFORE_RESERVE === "1" ? 1 : (config.maxSlots ?? 2);
  const minDaysBetweenSlots = config.minDaysBetweenSlots ?? 7;
  const stopBeforeReserve = process.env.STOP_BEFORE_RESERVE === "1";

  const [targetYear, targetMonthNum] = targetMonth.split("-").map(Number);
  let firstBookedDate = null; // 1件目の予約日（2件目を minDaysBetweenSlots 以上空けるため）

  const headed = process.env.HEADED === "1";
  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 100 : 0,
  });

  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    // 1) ログイン
    const loginPath = config.loginPath || "/users/login/login.php";
    const loginUrl = baseUrl.replace(/\/$/, "") + loginPath;
    console.log("ログイン画面を開いています:", loginUrl);
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    let filled = false;
    // メール欄: 複数パターンを試す
    for (const loc of [
      () => page.getByLabel(/メール|email|ログイン|ID/i).first(),
      () => page.getByPlaceholder(/メール|mail|email/i).first(),
      () => page.locator('input[type="email"]').first(),
      () => page.locator('input[name*="mail"], input[name*="login"], input[name*="user"]').first(),
      () => page.locator('form input[type="text"]').first(),
      () => page.locator('input:not([type="password"])').first(),
    ]) {
      try {
        const el = loc();
        await el.fill(email, { timeout: 3000 });
        filled = true;
        break;
      } catch (_) {}
    }
    if (!filled) {
      const outDir = resolve(projectRoot, "test-results");
      await import("fs").then((fs) => fs.promises.mkdir(outDir, { recursive: true }));
      await page.screenshot({ path: resolve(projectRoot, "test-results", "login-page.png") });
      console.error("ログイン画面でメール入力欄が見つかりません。test-results/login-page.png を確認し、config でセレクタを調整してください。");
      await browser.close();
      process.exit(1);
    }

    // パスワード欄
    const passwordInput = page.getByLabel(/パスワード|password/i).first().or(page.locator('input[type="password"]').first());
    await passwordInput.fill(password, { timeout: 5000 });

    await page.locator('button[type="submit"], input[type="submit"], [type="submit"]').first().click();
    await page.waitForURL(/mypage|index\.php/, { timeout: 15000 }).catch(() => {});

    // 2) 空枠確認・予約する
    console.log("空枠確認・予約する をクリック");
    await page.getByRole("link", { name: /空枠確認・予約する/ }).click();
    await page.waitForLoadState("domcontentloaded");

    // 3) 各種50分枠レッスン
    console.log("各種50分枠レッスン をクリック");
    await page.waitForLoadState("networkidle").catch(() => {});
    let lessonClicked = false;
    for (const loc of [
      () => page.getByRole("link", { name: /各種50分枠レッスン/ }).first(),
      () => page.getByText(/各種50分枠レッスン/).first(),
      () => page.locator('a:has-text("各種50分枠レッスン")').first(),
      () => page.locator('[href*="lesson"]:has-text("各種50分")').first(),
    ]) {
      try {
        const el = loc();
        await el.click({ timeout: 5000 });
        lessonClicked = true;
        break;
      } catch (_) {}
    }
    if (!lessonClicked) {
      const outDir = resolve(projectRoot, "test-results");
      await import("fs").then((fs) => fs.promises.mkdir(outDir, { recursive: true }));
      await page.screenshot({ path: resolve(projectRoot, "test-results", "after-empty-slot.png") });
      console.error("「各種50分枠レッスン」が見つかりません。test-results/after-empty-slot.png を確認してください。");
      await browser.close();
      process.exit(1);
    }
    await page.waitForLoadState("domcontentloaded");

    // 4) 予約カレンダーまで遷移済み。当月の週まで「次の一週間」を押す（当月の予約のみ取れるため当月を表示）
    const nextWeekBtn = page.getByRole("button", { name: /次の一週間/ }).or(page.getByText("次の一週間").first());
    let weeksClicked = 0;
    const maxWeeks = 6;
    while (weeksClicked < maxWeeks) {
      const body = await page.locator("body").textContent();
      if (body && body.includes(`${targetYear}年${targetMonthNum}月`)) break;
      const visible = await nextWeekBtn.isVisible().catch(() => false);
      if (!visible) break;
      await nextWeekBtn.click();
      await page.waitForTimeout(800);
      weeksClicked++;
    }

    let booked = 0;
    const nextMonthNum = targetMonthNum === 12 ? 1 : targetMonthNum + 1;
    const nextMonthYear = targetMonthNum === 12 ? targetYear + 1 : targetYear;

    while (booked < maxSlots) {
      // 1件目: 候補を集め、土日祝 > 平日 の優先で1件選んで予約する
      // 2件目: 候補を集めてから「月内で均等な1件」を選ぶ（土日祝優先）
      let firstCandidates = [];
      let secondCandidates = [];
      let foundSlot = false;
      let seenNextMonthWeek = false;
      for (let w = 0; w < 6; w++) {
        if (seenNextMonthWeek) break;

        const body = await page.locator("body").textContent();
        if (body && body.includes(`${nextMonthYear}年${nextMonthNum}月`) && !body.includes(`${targetYear}年${targetMonthNum}月`) && !body.includes(`${targetMonthNum}月`)) break;

        // サイトの丸は ○(U+25CB)。td 内の ○ を探し、リンクがあればクリック、なければセルをクリック
        const cellsWithCircle = page.locator("td").filter({ hasText: "○" });
        const count = await cellsWithCircle.count();
        if (count > 0) console.log(`今週の空き枠（○）: ${count} 件`);
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
          if (parsed.year !== targetYear || parsed.month !== targetMonthNum) {
            await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
            await page.waitForLoadState("domcontentloaded");
            continue;
          }
          const dayOk = stopBeforeReserve || preferredDays.size === 0 || preferredDays.has(parsed.day);
          const hourOk = stopBeforeReserve || (parsed.hour >= timeStart && parsed.hour < timeEnd);
          if (!dayOk || !hourOk) {
            await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
            await page.waitForLoadState("domcontentloaded");
            continue;
          }
          // 1件目候補: 土日祝 > 平日 で優先するため、まず候補を集める（後でソートしてから1件予約）
          if (!firstBookedDate) {
            firstCandidates.push({ ...parsed, slotDate: new Date(parsed.year, parsed.month - 1, parsed.day) });
            await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
            await page.waitForLoadState("domcontentloaded");
            continue;
          }
          // 2件目候補: 1件目から minDaysBetweenSlots 日以上空いているか。候補を集め、あとで均等間隔の1件を選ぶ（土日祝優先）
          if (firstBookedDate && minDaysBetweenSlots > 0) {
            const slotDate = new Date(parsed.year, parsed.month - 1, parsed.day);
            const daysDiff = Math.round((slotDate - firstBookedDate) / (24 * 60 * 60 * 1000));
            if (daysDiff < minDaysBetweenSlots) {
              console.log(`${parsed.month}月${parsed.day}日は1件目から${minDaysBetweenSlots}日以上空いていないためスキップします。`);
              await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
              await page.waitForLoadState("domcontentloaded");
              continue;
            }
            // 2件目候補として記録（あとで月内で均等になる1件を選んで予約する）
            secondCandidates.push({ ...parsed, slotDate });
            await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
            await page.waitForLoadState("domcontentloaded");
            continue;
          }

          // 6) 条件に合う: ペアレッスンにチェック → 予約する（STOP_BEFORE_RESERVE のときは押さない）
          const pairCheckbox = page.getByRole("checkbox", { name: "ペアレッスン" });
          const pairLabel = page.getByText("ペアレッスン").first();
          if (await pairCheckbox.isVisible().catch(() => false)) {
            await pairCheckbox.check();
          } else {
            await pairLabel.click();
          }
          await page.waitForTimeout(300);

          if (stopBeforeReserve) {
            console.log(`予約する直前で停止しました。（${parsed.month}月${parsed.day}日 ${parsed.hour}時台）STOP_BEFORE_RESERVE=1`);
            if (headed) await page.waitForTimeout(5000);
            await browser.close();
            process.exit(0);
          }

          // 1) 「予約する」をクリック → 確認モーダルが開く（#modal-open はモーダルを開くだけ）
          const reserveBtn = page.locator('input[value="予約する"], input.reserve_btn, #modal-open, button:has-text("予約する")').first();
          await reserveBtn.click();
          // モーダルが表示されるまで待つ（背後の画面ではなくモーダル内のボタンを押すため必須）
          await page.getByText("この内容で予約しますか？").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(600);

          // 2) モーダル内の「予約する」をクリック（HTML: <a id="modal-content_ok" class="btn_decide">予約する</a>）
          let confirmed = false;
          try {
            const modalConfirmBtn = page.locator("#modal-content_ok");
            await modalConfirmBtn.waitFor({ state: "visible", timeout: 3000 });
            await modalConfirmBtn.scrollIntoViewIfNeeded();
            await modalConfirmBtn.click({ timeout: 3000 });
            confirmed = true;
          } catch (_) {}
          if (confirmed) {
            await page.waitForLoadState("domcontentloaded");
            await page.waitForTimeout(1500);
          }
          if (!confirmed) {
            console.log(`モーダル内の確定ボタンが見つかりませんでした。${parsed.month}月${parsed.day}日 ${parsed.hour}時台をスキップします。`);
            await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
            await page.waitForLoadState("domcontentloaded");
            continue;
          }

          // 3) 予約完了になったか判定。完了していなければ booked を増やさない
          const bodyAfter = await page.locator("body").textContent();
          const hasSuccessText = bodyAfter && /予約が完了|予約完了|登録しました|受け付けました|予約を完了|いただきました/.test(bodyAfter);
          const hasErrorText = bodyAfter && /申し訳ありません|エラー|既に予約|上限に達しています|できません/.test(bodyAfter);
          const stillOnDetail = bodyAfter && bodyAfter.includes("ペアレッスン") && bodyAfter.includes("予約する");
          if (!hasSuccessText && (hasErrorText || stillOnDetail)) {
            console.log(`予約は確定しませんでした。${parsed.month}月${parsed.day}日 ${parsed.hour}時台をスキップします。`);
            await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
            await page.waitForLoadState("domcontentloaded");
            continue;
          }
          booked++;
          if (booked === 1) firstBookedDate = new Date(parsed.year, parsed.month - 1, parsed.day);
          console.log(`予約 ${booked} 件目を実行しました。（${parsed.day}日 ${parsed.hour}時台）`);
          foundSlot = true;
          break;
        }
        if (foundSlot) break;

        if (body && body.includes(`${nextMonthYear}年${nextMonthNum}月`)) {
          seenNextMonthWeek = true; // 翌月1週目を見たので打ち切り（翌月2週目以降には進まない）
        }
        const vis = await nextWeekBtn.isVisible().catch(() => false);
        if (!vis) break;
        await nextWeekBtn.click();
        await page.waitForTimeout(800);
      }

      // 1件目: 候補を土日祝優先でソートし、選んだ枠を予約する
      if (booked === 0 && firstCandidates.length > 0) {
        firstCandidates.sort((a, b) => {
          const aW = isWeekendOrHoliday(a.year, a.month, a.day);
          const bW = isWeekendOrHoliday(b.year, b.month, b.day);
          if (aW !== bW) return aW ? -1 : 1;
          return a.slotDate.getTime() - b.slotDate.getTime();
        });
        const chosenFirstSlot = firstCandidates[0];
        console.log(`1件目候補 ${firstCandidates.length} 件のうち、土日祝優先で ${chosenFirstSlot.month}月${chosenFirstSlot.day}日 ${chosenFirstSlot.hour}時台 を予約します。`);
        await page.goto(baseUrl + "/users/mypage/reservation/calendar.php", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded");
        await page.getByRole("link", { name: /各種50分枠レッスン/ }).first().click({ timeout: 15000 }).catch(() => page.getByText(/各種50分枠レッスン/).first().click({ timeout: 15000 }));
        await page.waitForLoadState("domcontentloaded");
        weeksClicked = 0;
        while (weeksClicked < maxWeeks) {
          const body = await page.locator("body").textContent();
          if (body && body.includes(`${targetYear}年${targetMonthNum}月`)) break;
          if (!(await nextWeekBtn.isVisible().catch(() => false))) break;
          await nextWeekBtn.click();
          await page.waitForTimeout(800);
          weeksClicked++;
        }
        let bookedFirst = false;
        for (let w2 = 0; w2 < 6; w2++) {
          if (bookedFirst) break;
          const body = await page.locator("body").textContent();
          if (body && body.includes(`${nextMonthYear}年${nextMonthNum}月`) && !body.includes(`${targetYear}年${targetMonthNum}月`) && !body.includes(`${targetMonthNum}月`)) break;
          const cellsWithCircle2 = page.locator("td").filter({ hasText: "○" });
          const count2 = await cellsWithCircle2.count();
          for (let i2 = 0; i2 < count2; i2++) {
            const cell = cellsWithCircle2.nth(i2);
            const link = cell.locator("a").first();
            if ((await link.count()) > 0) await link.click();
            else await cell.click();
            await page.waitForLoadState("domcontentloaded");
            const bodyText = await page.locator("body").textContent();
            const parsed = parseDetailDateTime(bodyText || "");
            if (!parsed || parsed.year !== chosenFirstSlot.year || parsed.month !== chosenFirstSlot.month || parsed.day !== chosenFirstSlot.day || parsed.hour !== chosenFirstSlot.hour) {
              await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
              await page.waitForLoadState("domcontentloaded");
              continue;
            }
            const pairCheckbox = page.getByRole("checkbox", { name: "ペアレッスン" });
            const pairLabel = page.getByText("ペアレッスン").first();
            if (await pairCheckbox.isVisible().catch(() => false)) await pairCheckbox.check();
            else await pairLabel.click();
            await page.waitForTimeout(300);
            if (stopBeforeReserve) {
              console.log(`予約する直前で停止しました。（${parsed.month}月${parsed.day}日 ${parsed.hour}時台）STOP_BEFORE_RESERVE=1`);
              if (headed) await page.waitForTimeout(5000);
              await browser.close();
              process.exit(0);
            }
            const reserveBtn = page.locator('input[value="予約する"], input.reserve_btn, #modal-open, button:has-text("予約する")').first();
            await reserveBtn.click();
            await page.getByText("この内容で予約しますか？").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(600);
            let confirmed = false;
            try {
              const modalConfirmBtn = page.locator("#modal-content_ok");
              await modalConfirmBtn.waitFor({ state: "visible", timeout: 3000 });
              await modalConfirmBtn.scrollIntoViewIfNeeded();
              await modalConfirmBtn.click({ timeout: 3000 });
              confirmed = true;
            } catch (_) {}
            if (confirmed) {
              await page.waitForLoadState("domcontentloaded");
              await page.waitForTimeout(1500);
            }
            const bodyAfter = await page.locator("body").textContent();
            const hasSuccessText = bodyAfter && /予約が完了|予約完了|登録しました|受け付けました|予約を完了|いただきました/.test(bodyAfter);
            const hasErrorText = bodyAfter && /申し訳ありません|エラー|既に予約|上限に達しています|できません/.test(bodyAfter);
            const stillOnDetail = bodyAfter && bodyAfter.includes("ペアレッスン") && bodyAfter.includes("予約する");
            if (!hasSuccessText && (hasErrorText || stillOnDetail)) {
              console.log(`予約は確定しませんでした。${parsed.month}月${parsed.day}日 ${parsed.hour}時台をスキップします。`);
              await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
              await page.waitForLoadState("domcontentloaded");
              continue;
            }
            booked++;
            firstBookedDate = new Date(parsed.year, parsed.month - 1, parsed.day);
            console.log(`予約 1 件目を実行しました。（${parsed.day}日 ${parsed.hour}時台）`);
            bookedFirst = true;
            break;
          }
          if (bookedFirst) break;
          if (body && body.includes(`${nextMonthYear}年${nextMonthNum}月`)) seenNextMonthWeek = true;
          const vis2 = await nextWeekBtn.isVisible().catch(() => false);
          if (!vis2) break;
          await nextWeekBtn.click();
          await page.waitForTimeout(800);
        }
        if (bookedFirst) continue;
      }

      // 2件目: 候補のうち土日祝優先し、そのうえで月内均等間隔になる1件を選ぶ
      if (booked === 1 && secondCandidates.length > 0) {
        const daysInMonth = new Date(targetYear, targetMonthNum, 0).getDate();
        const halfMonthMs = (daysInMonth / 2) * 24 * 60 * 60 * 1000;
        const idealSecondDate = new Date(firstBookedDate.getTime() + halfMonthMs);
        secondCandidates.sort((a, b) => {
          const aW = isWeekendOrHoliday(a.year, a.month, a.day);
          const bW = isWeekendOrHoliday(b.year, b.month, b.day);
          if (aW !== bW) return aW ? -1 : 1;
          return Math.abs(a.slotDate.getTime() - idealSecondDate.getTime()) - Math.abs(b.slotDate.getTime() - idealSecondDate.getTime());
        });
        const best = secondCandidates[0];
        console.log(`2件目候補 ${secondCandidates.length} 件のうち、土日祝優先・均等間隔で ${best.month}月${best.day}日 ${best.hour}時台 を予約します。`);
        // カレンダーに戻り、選んだ枠を開いて予約する
        await page.goto(baseUrl + "/users/mypage/reservation/calendar.php", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded");
        await page.getByRole("link", { name: /各種50分枠レッスン/ }).first().click({ timeout: 15000 }).catch(() => page.getByText(/各種50分枠レッスン/).first().click({ timeout: 15000 }));
        await page.waitForLoadState("domcontentloaded");
        weeksClicked = 0;
        while (weeksClicked < maxWeeks) {
          const body = await page.locator("body").textContent();
          if (body && body.includes(`${targetYear}年${targetMonthNum}月`)) break;
          if (!(await nextWeekBtn.isVisible().catch(() => false))) break;
          await nextWeekBtn.click();
          await page.waitForTimeout(800);
          weeksClicked++;
        }
        let bookedSecond = false;
        for (let w = 0; w < 6; w++) {
          if (bookedSecond) break;
          const body = await page.locator("body").textContent();
          if (body && body.includes(`${nextMonthYear}年${nextMonthNum}月`) && !body.includes(`${targetMonthNum}月`)) break;
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
            if (!parsed || parsed.year !== best.year || parsed.month !== best.month || parsed.day !== best.day || parsed.hour !== best.hour) {
              await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
              await page.waitForLoadState("domcontentloaded");
              continue;
            }
            const pairCheckbox = page.getByRole("checkbox", { name: "ペアレッスン" });
            const pairLabel = page.getByText("ペアレッスン").first();
            if (await pairCheckbox.isVisible().catch(() => false)) await pairCheckbox.check();
            else await pairLabel.click();
            await page.waitForTimeout(300);
            const reserveBtn = page.locator('input[value="予約する"], input.reserve_btn, #modal-open, button:has-text("予約する")').first();
            await reserveBtn.click();
            await page.getByText("この内容で予約しますか？").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(600);
            try {
              const modalConfirmBtn = page.locator("#modal-content_ok");
              await modalConfirmBtn.waitFor({ state: "visible", timeout: 3000 });
              await modalConfirmBtn.click({ timeout: 3000 });
            } catch (_) {}
            await page.waitForLoadState("domcontentloaded");
            await page.waitForTimeout(1500);
            const bodyAfter = await page.locator("body").textContent();
            const hasSuccessText = bodyAfter && /予約が完了|予約完了|登録しました|受け付けました|予約を完了|いただきました/.test(bodyAfter);
            const hasErrorText = bodyAfter && /申し訳ありません|エラー|既に予約|上限に達しています|できません/.test(bodyAfter);
            const stillOnDetail = bodyAfter && bodyAfter.includes("ペアレッスン") && bodyAfter.includes("予約する");
            if (!hasSuccessText && (hasErrorText || stillOnDetail)) {
              await page.getByText(/前のページに戻る|戻る/).first().click().catch(() => page.goBack());
              await page.waitForLoadState("domcontentloaded");
              continue;
            }
            booked++;
            console.log(`予約 2 件目を実行しました。（${best.day}日 ${best.hour}時台）`);
            bookedSecond = true;
            foundSlot = true;
            break;
          }
          if (bookedSecond) break;
          const vis = await nextWeekBtn.isVisible().catch(() => false);
          if (!vis) break;
          await nextWeekBtn.click();
          await page.waitForTimeout(800);
        }
        if (booked >= maxSlots) break;
        // 2件目を予約したのでループを抜ける（空枠確認に戻る処理は不要）
        break;
      }

      if (!foundSlot) {
        console.log("条件に合う空き枠がありませんでした。");
        break;
      }
      if (booked >= maxSlots) break;

      // 2枠目: 予約完了後は確認画面にいるため、マイページ経由で空枠確認に戻る
      console.log("2枠目を探すため、空枠確認に戻ります。");
      const backToEmptySlot = page.getByRole("link", { name: /空枠確認・予約する/ }).first();
      if (await backToEmptySlot.isVisible().catch(() => false)) {
        await backToEmptySlot.click({ timeout: 10000 });
      } else {
        await page.goto(baseUrl + "/users/mypage/", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.getByRole("link", { name: /空枠確認・予約する/ }).first().click({ timeout: 10000 });
      }
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);
      await page.getByRole("link", { name: /各種50分枠レッスン/ }).first().click({ timeout: 15000 }).catch(() => page.getByText(/各種50分枠レッスン/).first().click({ timeout: 15000 }));
      await page.waitForLoadState("domcontentloaded");
      weeksClicked = 0;
      while (weeksClicked < maxWeeks) {
        const body = await page.locator("body").textContent();
        if (body && body.includes(`${targetYear}年${targetMonthNum}月`)) break;
        if (!(await nextWeekBtn.isVisible().catch(() => false))) break;
        await nextWeekBtn.click();
        await page.waitForTimeout(800);
        weeksClicked++;
      }
    }

    // 7) 2枠取れなかった場合: 条件に合う〇をキャンセル待ちとして登録（最大10件）。STOP_BEFORE_RESERVE のときはスキップ
    const maxWaitlist = config.maxWaitlist ?? MAX_WAITLIST;
    const waitlistSlots = [];
    if (!stopBeforeReserve && booked < maxSlots && maxWaitlist > 0) {
      console.log("キャンセル待ちを登録します（条件に合う〇を最大" + maxWaitlist + "件）");
      await page.goto(baseUrl + "/users/mypage/reservation/calendar.php", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!(await nextWeekBtn.isVisible().catch(() => false))) {
        await page.getByRole("link", { name: /各種50分枠レッスン/ }).first().click({ timeout: 5000 }).catch(() => page.getByText(/各種50分枠レッスン/).first().click({ timeout: 5000 }));
        await page.waitForLoadState("domcontentloaded");
      }
      let wWeeks = 0;
      while (wWeeks < 6) {
        const body = await page.locator("body").textContent();
        if (body && body.includes(`${targetYear}年${targetMonthNum}月`)) break;
        const vis = await nextWeekBtn.isVisible().catch(() => false);
        if (!vis) break;
        await nextWeekBtn.click();
        await page.waitForTimeout(800);
        wWeeks++;
      }

      let waitlistCount = 0;
      const maxAttempts = 25;
      for (let attempt = 0; attempt < maxAttempts && waitlistCount < maxWaitlist; attempt++) {
        const cellsWithCircle = page.locator("td").filter({ hasText: "○" });
        const count = await cellsWithCircle.count();
        if (count === 0) {
          const vis = await nextWeekBtn.isVisible().catch(() => false);
          if (vis) {
            await nextWeekBtn.click();
            await page.waitForTimeout(800);
          } else break;
          continue;
        }
        const cell = cellsWithCircle.first();
        const link = cell.locator("a").first();
        if ((await link.count()) > 0) await link.click();
        else await cell.click();
        await page.waitForLoadState("domcontentloaded");

        const pairCheckbox = page.getByRole("checkbox", { name: "ペアレッスン" });
        const pairLabel = page.getByText("ペアレッスン").first();
        if (await pairCheckbox.isVisible().catch(() => false)) await pairCheckbox.check();
        else await pairLabel.click().catch(() => {});

        const waitlistBtn = page.getByRole("button", { name: /キャンセル待ち|待ち/ }).or(page.getByText(/キャンセル待ち/).first());
        const hasWaitlist = await waitlistBtn.isVisible().catch(() => false);
        if (hasWaitlist) {
          await waitlistBtn.click().catch(() => {});
          await page.waitForLoadState("domcontentloaded");
          const bodyText = await page.locator("body").textContent();
          const m = bodyText && bodyText.match(/\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}/);
          if (m) {
            const normalized = m[0].replace(/年/g, "-").replace(/月/g, "-").replace(/日\s*/, "T").replace(/\s+/, "");
            waitlistSlots.push(normalized);
            waitlistCount++;
            console.log(`キャンセル待ち ${waitlistCount} 件目を登録しました。`);
          }
        }

        await page.goto(baseUrl + "/users/mypage/reservation/calendar.php", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForLoadState("networkidle").catch(() => {});
        if (!(await nextWeekBtn.isVisible().catch(() => false))) {
          await page.getByRole("link", { name: /各種50分枠レッスン/ }).first().click({ timeout: 5000 }).catch(() => page.getByText(/各種50分枠レッスン/).first().click({ timeout: 5000 }));
          await page.waitForLoadState("domcontentloaded");
        }
        wWeeks = 0;
        while (wWeeks < 6) {
          const b = await page.locator("body").textContent();
          if (b && b.includes(`${targetYear}年${targetMonthNum}月`)) break;
          const v = await nextWeekBtn.isVisible().catch(() => false);
          if (!v) break;
          await nextWeekBtn.click();
          await page.waitForTimeout(800);
          wWeeks++;
        }
      }

      if (waitlistSlots.length > 0) {
        const data = { targetMonth, slots: waitlistSlots };
        writeFileSync(WAITLIST_PATH, JSON.stringify(data, null, 2), "utf8");
        console.log(`キャンセル待ち ${waitlistSlots.length} 件を登録し、waitlist.json に保存しました。`);
      }
    }

    console.log(`完了。予約枠 ${booked} 件を処理しました。`);
  } catch (err) {
    console.error("エラー:", err.message);
    if (headed) await page.waitForTimeout(5000);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
