#!/usr/bin/env node
/**
 * Googleカレンダーから対象月の「空いている日」を取得し、Slack に予約候補日として投稿する。
 * 予約実行の前日などに実行すると、候補日を忘れずに共有できる。
 *
 * 使い方:
 *   CALENDAR_ID=primary SLACK_WEBHOOK_URL=... GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json node scripts/post-calendar-candidates-to-slack.js
 *   npm run calendar-to-slack
 */

import { google } from "googleapis";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { JP_HOLIDAYS } from "./jp-holidays.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// 候補日判定: 1コマ1時間、移動で前後30分確保
// 土日祝: 9:00-20:00（最終枠20:00）→ カレンダーが 8:30-20:30 空いている日を候補
// 平日: 18:00-20:00（最終枠20:00）→ カレンダーが 17:30-20:30 空いている日を候補
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];

const WEEKEND_SLOT_LABEL = "9:00-20:00";
const WEEKEND_CHECK = { startHour: 8, startMin: 30, endHour: 20, endMin: 30 };

const WEEKDAY_SLOT_LABEL = "18:00-20:00";
const WEEKDAY_CHECK = { startHour: 17, startMin: 30, endHour: 20, endMin: 30 };

function getTargetMonth() {
  const env = process.env.TARGET_MONTH;
  if (env) return env;
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getAuth() {
  const jsonPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (jsonPath) {
    const keyPath = jsonPath.startsWith("/") ? jsonPath : resolve(projectRoot, jsonPath);
    if (existsSync(keyPath)) {
      return new google.auth.GoogleAuth({ keyFile: keyPath, scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
    }
  }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    let key;
    try {
      key = typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch (_) {
      console.error("GOOGLE_SERVICE_ACCOUNT_JSON のパースに失敗しました。");
      process.exit(1);
    }
    return new google.auth.GoogleAuth({ credentials: key, scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
  }
  console.error("GOOGLE_APPLICATION_CREDENTIALS または GOOGLE_SERVICE_ACCOUNT_JSON を設定してください。");
  process.exit(1);
}

function isWeekday(year, month, day) {
  const d = new Date(year, month - 1, day);
  const dow = d.getDay();
  return dow !== 0 && dow !== 6;
}

function isJapaneseHoliday(year, month, day) {
  const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return JP_HOLIDAYS.has(key);
}

/** 指定時間帯内の空きを判定。check は { startHour, startMin, endHour, endMin } */
function isWindowFree(year, month, day, busy, check) {
  const dayStart = new Date(year, month - 1, day, check.startHour, check.startMin, 0).getTime();
  const dayEnd = new Date(year, month - 1, day, check.endHour, check.endMin, 0).getTime();
  const overlapping = busy
    .map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() }))
    .filter((b) => b.s < dayEnd && b.e > dayStart);
  return overlapping.length === 0;
}

/** 日ごとに候補かどうかと枠ラベルを返す。キーは日(1..31)、値は "9:00-20:00" または "18:00-20:00" */
async function getFreeSlotsPerDay(auth, calendarId, year, month) {
  const calendar = google.calendar({ version: "v3", auth });
  const timeMin = new Date(year, month - 1, 1).toISOString();
  const timeMax = new Date(year, month, 0, 23, 59, 59).toISOString();
  const res = await calendar.freebusy.query({
    requestBody: { timeMin, timeMax, items: [{ id: calendarId }] },
  });
  const busy = res.data.calendars?.[calendarId]?.busy ?? [];
  const lastDay = new Date(year, month, 0).getDate();
  const result = new Map();
  for (let day = 1; day <= lastDay; day++) {
    const isWeekendOrHoliday = !isWeekday(year, month, day) || isJapaneseHoliday(year, month, day);
    const check = isWeekendOrHoliday ? WEEKEND_CHECK : WEEKDAY_CHECK;
    const label = isWeekendOrHoliday ? WEEKEND_SLOT_LABEL : WEEKDAY_SLOT_LABEL;
    if (isWindowFree(year, month, day, busy, check)) result.set(day, label);
  }
  return result;
}

async function postSlack(webhookUrl, text) {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function main() {
  const calendarId = process.env.CALENDAR_ID;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!calendarId || !webhookUrl) {
    console.error("CALENDAR_ID と SLACK_WEBHOOK_URL を設定してください。");
    process.exit(1);
  }
  const targetMonth = getTargetMonth();
  const [year, month] = targetMonth.split("-").map(Number);
  const auth = getAuth();
  const slotsByDay = await getFreeSlotsPerDay(auth, calendarId, year, month);
  const lines = [];
  for (const day of [...slotsByDay.keys()].sort((a, b) => a - b)) {
    const dow = new Date(year, month - 1, day).getDay();
    const label = slotsByDay.get(day);
    lines.push(`${month}/${day}（${DOW_JA[dow]}） ${label}`);
  }
  const body = lines.length === 0 ? "（該当なし）" : lines.join("\n");
  const text = `【ゴルフレッスン】${year}年${month}月の予約候補日（土日祝 9:00-20:00 / 平日 18:00-20:00、1コマ1h・移動前後30分）:\n${body}`;
  await postSlack(webhookUrl, text);
  console.log("Slack に投稿しました:", text);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
