#!/usr/bin/env node
/**
 * fetch-langs.js — 拉取一个 GitHub 用户所有公开仓库的语言字节数，汇总成 github-langs.json。
 *
 * 用法：
 *   node fetch-langs.js
 *   GITHUB_TOKEN=ghp_xxx node fetch-langs.js   # 可选，提高速率限制 / 读取私有仓库
 *
 * 生成的 JSON 交给 gen.js 读取；构建 SVG 时不再联网。
 */

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const USER = process.env.GITHUB_USER || 'nyanpasu-louis';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUTPUT = path.join(__dirname, 'github-langs.json');
const API_HOST = 'api.github.com';

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'gen-svg-language-stats',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    https
      .get({ host: API_HOST, path: pathname, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const hint =
              res.statusCode === 403 && res.headers['x-ratelimit-remaining'] === '0'
                ? ' (rate limit exceeded — set GITHUB_TOKEN)'
                : '';
            reject(new Error(`HTTP ${res.statusCode} ${pathname}${hint}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`invalid JSON from ${pathname}: ${error.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function listRepos() {
  const repos = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await getJson(
      `/users/${encodeURIComponent(USER)}/repos?type=owner&per_page=100&page=${page}`,
    );
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

async function main() {
  const repos = await listRepos();
  const totals = new Map();
  const perRepo = [];

  for (const repo of repos) {
    const languages = await getJson(
      `/repos/${encodeURIComponent(USER)}/${encodeURIComponent(repo.name)}/languages`,
    );
    const bytes = Object.values(languages).reduce((sum, value) => sum + value, 0);
    perRepo.push({ name: repo.name, fork: repo.fork, bytes });
    for (const [language, value] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) || 0) + value);
    }
    console.log(`  ${repo.name.padEnd(32)} ${(bytes / 1024).toFixed(1)} KB`);
  }

  const totalBytes = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const languages = [...totals.entries()]
    .map(([name, bytes]) => ({
      name,
      bytes,
      percent: totalBytes ? Number(((bytes / totalBytes) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const payload = {
    user: USER,
    fetchedAt: new Date().toISOString(),
    repoCount: repos.length,
    repos: perRepo,
    totalBytes,
    languages,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`\n✓ ${path.basename(OUTPUT)}  (${repos.length} repos, ${(totalBytes / 1024).toFixed(1)} KB)`);
  for (const language of languages) {
    console.log(`  ${language.name.padEnd(20)} ${String(language.percent).padStart(6)}%`);
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
});
