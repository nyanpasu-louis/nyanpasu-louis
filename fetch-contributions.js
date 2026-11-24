#!/usr/bin/env node
/**
 * fetch-contributions.js — 抓取一个 GitHub 账号的贡献日历，保存最近 33 周的数据。
 *
 * 用法：
 *   node fetch-contributions.js
 *   GITHUB_USER=someone node fetch-contributions.js
 *
 * 数据来自公开的 https://github.com/users/<user>/contributions 页面（无需 token），
 * 结果写入 github-contributions.json；gen.js 构建 SVG 时只读 JSON，不联网。
 */

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const USER = process.env.GITHUB_USER || 'nyanpasu-louis';
const WEEKS = 33;
const OUTPUT = path.join(__dirname, 'github-contributions.json');
const URL_PATH = `/users/${encodeURIComponent(USER)}/contributions`;

function getHtml(host, pathname) {
  return new Promise((resolve, reject) => {
    https
      .get(
        { host, path: pathname, headers: { 'User-Agent': 'gen-svg-contributions' } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} ${host}${pathname}`));
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(body));
        },
      )
      .on('error', reject);
  });
}

/** 从贡献日历 HTML 里取出 [{ date, level, count }] */
function parseCalendar(html) {
  const counts = new Map();
  for (const match of html.matchAll(/<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const text = match[2].trim();
    const count = /^no\b/i.test(text) ? 0 : Number((/^(\d+)/.exec(text) || [])[1] || 0);
    counts.set(match[1], count);
  }

  const days = [];
  for (const match of html.matchAll(/<td\b[^>]*>/g)) {
    const tag = match[0];
    const date = /\bdata-date="(\d{4}-\d{2}-\d{2})"/.exec(tag);
    if (!date) continue;
    const level = Number((/\bdata-level="(\d)"/.exec(tag) || [])[1] || 0);
    const id = (/\bid="([^"]+)"/.exec(tag) || [])[1];
    days.push({
      date: date[1],
      level: Math.min(4, Math.max(0, level)),
      count: counts.get(id) || 0,
    });
  }

  return days;
}

/** 按周（周日起）分组并补齐 7 天，只保留最近 weeks 周 */
function groupWeeks(days, weeks = WEEKS) {
  const byWeek = new Map();
  for (const day of days) {
    const date = new Date(`${day.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) continue;
    const start = new Date(date);
    start.setUTCDate(date.getUTCDate() - date.getUTCDay());
    const key = start.toISOString().slice(0, 10);
    if (!byWeek.has(key)) byWeek.set(key, new Map());
    byWeek.get(key).set(date.getUTCDay(), day);
  }

  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-weeks)
    .map(([start, week]) => ({
      start,
      days: Array.from({ length: 7 }, (_, index) =>
        week.get(index) || { date: null, level: 0, count: 0 },
      ),
    }));
}

async function main() {
  const html = await getHtml('github.com', URL_PATH);
  const days = parseCalendar(html);
  if (!days.length) throw new Error('贡献日历里没有解析到数据');

  const weeks = groupWeeks(days);
  const total = weeks
    .flatMap((week) => week.days)
    .reduce((sum, day) => sum + day.count, 0);

  const payload = { user: USER, generatedAt: new Date().toISOString(), weeks };
  fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 1) + '\n', 'utf8');

  console.log(`✓ ${path.basename(OUTPUT)}  (${weeks.length} weeks, ${total} contributions)`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseCalendar, groupWeeks };
