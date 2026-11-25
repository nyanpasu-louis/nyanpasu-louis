#!/usr/bin/env node
/**
 * gen.js — 把 Markdown 文本编译成一张"会打字"的自播放 SVG。
 *
 * 原理：时间轴在构建期就算好了。每个字符是独立的 <text class="ch">，
 * 初始 opacity:0，靠 style="animation-delay: {t}ms" 排队出现；
 * 所有元素共用 <style> 里的 @keyframes，1ms step-start + fill-mode:both
 * 就是一次"瞬时刷新"。全程无 SMIL / 无 JS / 无外部资源。
 *
 * 字体：目录内的 JetBrainsMono-Regular.ttf
 *   · 构建时读取字体的 advance width，按等宽步进排布；
 *   · 只把用到的字形子集化（font.js）并以 base64 内嵌进 @font-face，
 *     因此 output.svg 仍是单文件、可离线播放。
 *
 * 主题：深色为默认，@media (prefers-color-scheme: light) 自动切浅色。
 * 外观：无边框、无标题栏；先播一段 Unix 开机日志（内核 → getty 登录 → cat），
 *       整块淡出后正文才进场：顶部是 shell 提示符 + cat 命令，底部回到提示符等待输入。
 *
 * 用法：
 *   node gen.js                      # 用内置 Markdown，输出 ./output.svg
 *   node gen.js README.md            # 读入指定 Markdown
 *   node gen.js README.md out.svg    # 指定输入与输出
 *
 * 调试时想连 README.md 一起重建：node build.js --watch
 *
 * 流程：parseLines → layout → compileTimeline → emitSvg
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadFont } = require('./font.js');

/* ══════════════════════════════════════════════════════════════════
   1. 可调参数
   ══════════════════════════════════════════════════════════════════ */

/** 字体（放在本文件同目录） */
const FONT = {
  FILE: 'JetBrainsMono-Regular.ttf',
  FAMILY: 'JetBrains Mono',
  STACK: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`,
};

/** 时间轴参数（毫秒） */
const TIME = {
  CHAR_STEP: 20,        // 行内相邻字符间隔（原 40ms，整体加快一倍）
  LINE_GAP: 100,        // 行与行之间的停顿（原 180ms）
  LINE_HOLD: 80,        // 每行最后一个字符出现后，定格多久才开始下一行（原 120ms）
  START_DELAY: 200,     // 第一个字符出现前的空白（原 300ms）
  CURSOR_BLINK_MS: 530, // 光标闪烁周期
  TOTAL_BLINK_CYCLES: 2,// TOTAL = 光标出现时刻 + N 个完整闪烁周期
};

/** 等宽排版参数（px） */
const LAYOUT = {
  FONT_SIZE: 15,
  LINE_H: 26,
  MAX_COLS: 52,         // 超过这个列数就软换行，避免超长行撑爆画布
  PAD_X: 30,
  TOP_PAD: 38,          // 首行基线距终端顶部的距离
  BOTTOM_PAD: 28,
  MIN_WIDTH: 380,
  CURSOR_H: 18,
  CURSOR_LIFT: 14,      // 光标方块相对基线向上偏移
  CURSOR_RX: 1.5,
};

/* ── 文档标题 / 说明：只用于 <title> 和 README 的 alt，不渲染进画面 ── */
const DOCUMENT_TITLE = 'readme.md';
const DOCUMENT_TAGLINE = 'a markdown file that types itself.';

/** macOS zsh 默认提示符（user@host path %）；root 风格把 SYMBOL 改成 '#' */
const SHELL = {
  USER: 'nyanpasulouis',
  HOST: 'Gitprofile',
  PATH: '~',
  SYMBOL: '#',
  COMMAND: 'fastfetch', // 设为 '' 则只显示提示符
  // 内容输出完后同时输入的命令：多行并排逐字打出，模拟并行执行
  NEXT_COMMANDS: [
    'cat personal_attributes.json',
    'cat mbti_enneagram_famlines.txt',
  ],
};

const PROMPT_TEXT = `${SHELL.USER}@${SHELL.HOST} ${SHELL.PATH} ${SHELL.SYMBOL} `;
const PROMPT_LEN = PROMPT_TEXT.length;

// 提示符内部各段的下标（用于逐字符着色）
const PROMPT_POS = (() => {
  const userStart = 0;
  const userEnd = userStart + SHELL.USER.length;
  const at = userEnd;
  const hostStart = at + 1;
  const hostEnd = hostStart + SHELL.HOST.length;
  const pathStart = hostEnd + 1;
  const pathEnd = pathStart + SHELL.PATH.length;
  const symbol = pathEnd + 1;
  return { userStart, userEnd, at, hostStart, hostEnd, pathStart, pathEnd, symbol };
})();

/* ── 名字横幅：5×5 点阵，用 ▩ 纹理单元格填充 ─────────────────────── */

// 5×5 点阵目前收录了这两个名字用到的字母；换名字请用大写并补 PIXEL_FONT
const BANNER = {
  WORDS: ['NYANPASU', 'LOUIS'],
  WORD_GAP: 3,       // 两个单词之间空 3 列
  CELL: 9,           // 与 15px JetBrains Mono 的字符步进一致
  TOP_GAP: 6,        // 横幅上方留白
  BOTTOM_GAP: 50,    // 横幅下方留白（预留一整行）
  ROW_STEP_MS: 40,   // 点阵逐行出现的间隔（原 60ms）
  HOLD_MS: 80,       // 最后一行出现后的定格（原 120ms）
};

/* ── 贡献热力图：最近 33 周 × 7 天，粉色方块 ───────────────────────── */

const HEATMAP = {
  WEEKS: 33,
  CELL: 8,
  GAP: 2,
  RX: 1,
  TOP_GAP: 20,    // 相对上一行基线的下移量
  BOTTOM_GAP: 16, // 方块阵列下方留白
  STEP_MS: 14,    // 每周一列出现的间隔
  HOLD_MS: 120,   // 最后一列出现后的定格
  get WIDTH() {
    return this.WEEKS * this.CELL + (this.WEEKS - 1) * this.GAP;
  },
  get HEIGHT() {
    return 7 * this.CELL + 6 * this.GAP;
  },
};

/* ── 语言占比条：像素宽度与热力图对齐（420–748px），整条由矩形绘制 ── */

const BAR = {
  WIDTH: HEATMAP.WIDTH,
  HEIGHT: 14,
  TOP_OFFSET: 15, // 相对文字基线向上偏移
  STEP_MS: 90,    // 每个色段出现的间隔
  HOLD_MS: 80,    // 最后一段出现后的定格
};

const PIXEL_FONT = {
  A: ['01110', '10001', '11111', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '11110', '10000', '10000'],
  S: ['01111', '10000', '01110', '00001', '11110'],
  U: ['10001', '10001', '10001', '10001', '01110'],
  Y: ['10001', '10001', '01010', '00100', '00100'],
};

/** 把一个单词渲染成 5 行 "▩/空格" 点阵（字母之间空一列） */
function pixelWordRows(word) {
  const rows = Array(5).fill('');
  for (const [i, ch] of [...word].entries()) {
    const glyph = PIXEL_FONT[ch];
    if (!glyph) throw new Error(`点阵字体里没有字符 "${ch}"`);
    for (let r = 0; r < 5; r++) {
      if (i) rows[r] += ' ';
      rows[r] += glyph[r].replace(/1/g, '▩').replace(/0/g, ' ');
    }
  }
  // 每一行补齐到同一个宽度，否则拼接第二个单词时起始列会逐行漂移
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => row.padEnd(width, ' '));
}

/** 所有单词在同一行拼接，单词之间空 WORD_GAP 列 */
function buildBannerRows() {
  const rows = Array(5).fill('');

  BANNER.WORDS.forEach((word, index) => {
    const wordRows = pixelWordRows(word);
    for (let r = 0; r < 5; r++) {
      if (index > 0) rows[r] += ' '.repeat(BANNER.WORD_GAP);
      rows[r] += wordRows[r];
    }
  });

  return rows.map((raw, row) => {
    const text = raw.replace(/\s+$/, '');
    return {
      text,
      row,
      cells: [...text].flatMap((ch, col) => (ch === '▩' ? [col] : [])),
    };
  });
}

const BANNER_ROWS = buildBannerRows();
const BANNER_COLS = Math.max(0, ...BANNER_ROWS.map((row) => row.text.length));
const BANNER_HEIGHT = BANNER_ROWS.length * BANNER.CELL;
const BANNER_MARKER_HEIGHT = BANNER.TOP_GAP + BANNER_HEIGHT + BANNER.BOTTOM_GAP;
const BANNER_CELLS = BANNER_ROWS.reduce((sum, row) => sum + row.cells.length, 0);

/** 深浅色主题：CSS 变量名由 key 自动转 kebab-case（heat0 → --heat0） */
const THEMES = {
  dark: {
    bg: '#0c1218',
    divider: '#243244',
    body: '#c9d5e2',
    prose: '#c9d5e2',
    heading: '#79c0ff',
    mark: '#3f5061',
    code: '#e5b567',
    quote: '#93a4b8',
    cmd: '#ffa8cd',
    bullet: '#79c0ff',
    cursor: '#ffa8cd',
    heat0: '#211a24',
    heat1: '#4b2b3d',
    heat2: '#7c4664',
    heat3: '#b06f92',
    heat4: '#ffa8cd',
  },
  light: {
    bg: '#f8fafc',
    divider: '#d3dde9',
    body: '#52627a',
    prose: '#0f141b',
    heading: '#2b6ce6',
    mark: '#96a2b2',
    code: '#c2660c',
    quote: '#6b7a8e',
    cmd: '#cf3573',
    bullet: '#2b6ce6',
    cursor: '#cf3573',
    heat0: '#efe7ec',
    heat1: '#f6c3da',
    heat2: '#efa3c6',
    heat3: '#e070a2',
    heat4: '#cf3573',
  },
};

/** 兼容旧导出：COLOR 指向深色主题 */
const COLOR = THEMES.dark;

/** 内置示例 Markdown（无 CJK / emoji，保证等宽网格严格对齐） */
const SAMPLE_MARKDOWN = `# README.md
`;

/* ══════════════════════════════════════════════════════════════════
   2. 字体加载 + 度量
   ══════════════════════════════════════════════════════════════════ */

let fontCache = null;

/** 懒加载字体；找不到时给出可读的错误 */
function getFont() {
  if (fontCache) return fontCache;
  const fontPath = path.join(__dirname, FONT.FILE);
  if (!fs.existsSync(fontPath)) {
    throw new Error(`找不到字体文件：${fontPath}`);
  }
  fontCache = loadFont(fontPath);
  return fontCache;
}

/** JetBrains Mono 的 advance width → 像素步进（15px 字号下为 9px） */
function fontCharWidth(font) {
  const advance = font.advanceForCodepoint(0x4d); // 'M'
  if (!advance) throw new Error('字体缺少 "M" 字形，无法确定等宽步进');
  return (advance / font.unitsPerEm) * LAYOUT.FONT_SIZE;
}

/** 东亚宽字符（CJK / 全角 / emoji）在等宽网格里占两格 */
function isWideCodepoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

function charCells(ch) {
  return isWideCodepoint(ch.codePointAt(0)) ? 2 : 1;
}

function textCells(text) {
  let cells = 0;
  for (const ch of Array.from(text)) cells += charCells(ch);
  return cells;
}

/** 缺字会回退到系统字体，格线可能对不齐，提前提示一下 */
function warnMissingGlyphs(font, lines) {
  const missing = new Set();
  for (const line of lines) {
    for (const ch of Array.from(line.text)) {
      if (!font.hasCodepoint(ch.codePointAt(0))) missing.add(ch);
    }
  }
  if (missing.size) {
    const sample = [...missing].slice(0, 12).join(' ');
    console.warn(`⚠ 字体缺少这些字符，将由系统字体回退：${sample}`);
  }
}

/** 收集需要打进子集字体的字符（含空格） */
function collectCodepoints(rows) {
  const codepoints = new Set([0x20]);
  for (const row of rows) {
    for (const c of row.chars) codepoints.add(c.char.codePointAt(0));
  }
  return [...codepoints];
}

/* ── GitHub 语言统计（由 fetch-langs.js 生成 github-langs.json） ─────── */

let languageCache;

function getLanguageStats() {
  if (languageCache !== undefined) return languageCache;
  try {
    languageCache = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'github-langs.json'), 'utf8'),
    );
  } catch {
    languageCache = null;
  }
  return languageCache;
}

const LANGUAGE_ABBR = {
  JavaScript: 'JS',
  TypeScript: 'TS',
  Python: 'Py',
  HTML: 'HTML',
  CSS: 'CSS',
  Shell: 'sh',
  'C++': 'C++',
  'C#': 'C#',
  Java: 'Java',
  Go: 'Go',
  Rust: 'Rust',
  Vue: 'Vue',
  Svelte: 'Svelte',
  Astro: 'Astro',
  Ruby: 'Rb',
  PHP: 'PHP',
  Swift: 'Swift',
  Kotlin: 'Kt',
  C: 'C',
  Lua: 'Lua',
  Dart: 'Dart',
  Dockerfile: 'Docker',
  Makefile: 'Make',
  Nix: 'Nix',
  SCSS: 'SCSS',
  Less: 'Less',
  'Jupyter Notebook': 'Jupyter',
  TeX: 'TeX',
  MDX: 'MDX',
  Handlebars: 'HBS',
  EJS: 'EJS',
  Batchfile: 'bat',
  PowerShell: 'pwsh',
  'Objective-C': 'ObjC',
  R: 'R',
  Scala: 'Scala',
  Elixir: 'Elixir',
  Haskell: 'Haskell',
  Zig: 'Zig',
  Solidity: 'Sol',
  Assembly: 'asm',
  'Vim Script': 'vim',
  HCL: 'HCL',
  Nushell: 'nu',
  Just: 'Just',
  CoffeeScript: 'Coffee',
  Elm: 'Elm',
  Crystal: 'Crystal',
  OCaml: 'OCaml',
};

function languageAbbr(name) {
  return LANGUAGE_ABBR[name] || (name.length > 4 ? name.slice(0, 4) : name);
}

/** 右栏宽度约 38 列，把语言比例压成一行；放不下就减少条目、把剩余并入 +X% */
function languageRatioLine(stats) {
  if (!stats || !Array.isArray(stats.languages) || stats.languages.length === 0) {
    return 'run: node fetch-langs.js';
  }

  const languages = stats.languages
    .filter((item) => item && item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const total = languages.reduce((sum, item) => sum + item.bytes, 0) || 1;

  for (let count = Math.min(4, languages.length); count >= 1; count--) {
    const top = languages.slice(0, count);
    const restBytes = total - top.reduce((sum, item) => sum + item.bytes, 0);
    const restPercent = Math.round((restBytes / total) * 100);

    const parts = top.map((item) => ({
      label: languageAbbr(item.name),
      percent: Math.round((item.bytes / total) * 100),
    }));
    if (restPercent > 0) parts.push({ label: '', percent: restPercent });

    // 四舍五入后补足到 100，避免出现 99% / 101%
    const sum = parts.reduce((acc, part) => acc + part.percent, 0);
    if (sum !== 100) {
      let largest = 0;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].percent > parts[largest].percent) largest = i;
      }
      parts[largest].percent += 100 - sum;
    }

    const line = parts
      .map((part) => (part.label ? `${part.label} ${part.percent}%` : `+${part.percent}%`))
      .join(' ');
    if (line.length <= 38) return line;
  }

  return languages[0] ? `${languageAbbr(languages[0].name)} 100%` : 'no language data';
}

const LANGUAGE_CLASS = {
  JavaScript: 'lang-js',
  TypeScript: 'lang-ts',
  Python: 'lang-py',
  CSS: 'lang-css',
  HTML: 'lang-html',
  Shell: 'lang-sh',
};

function languageClass(name) {
  return LANGUAGE_CLASS[name] || 'lang-other';
}

/** 堆叠条形图 + 一行图例；每段颜色由 lang-* class 控制 */
function buildLanguageChart(stats, barWidth = BAR.WIDTH) {
  const languages = stats.languages
    .filter((item) => item && item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const total = languages.reduce((sum, item) => sum + item.bytes, 0) || 1;

  const top = languages.slice(0, 4).map((item) => ({
    label: languageAbbr(item.name),
    cls: languageClass(item.name),
    percent: (item.bytes / total) * 100,
  }));

  const restBytes = total - languages.slice(0, 4).reduce((sum, item) => sum + item.bytes, 0);
  if (restBytes > 0) {
    top.push({ label: '', cls: 'lang-other', percent: (restBytes / total) * 100 });
  }

  for (const item of top) item.percentInt = Math.round(item.percent);

  // 百分比补足到 100
  let percentSum = top.reduce((sum, item) => sum + item.percentInt, 0);
  if (percentSum !== 100) {
    let largest = 0;
    for (let i = 1; i < top.length; i++) {
      if (top[i].percentInt > top[largest].percentInt) largest = i;
    }
    top[largest].percentInt += 100 - percentSum;
  }

  // 按比例分配条形图宽度：先取整，再按余数把剩余的格子补上
  const exact = top.map((item) => (item.percentInt / 100) * barWidth);
  const widths = exact.map((value) => Math.floor(value));
  let remainder = barWidth - widths.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, fraction: value - widths[index] }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < remainder; i++) {
    widths[byRemainder[i % byRemainder.length].index] += 1;
  }

  const segments = top.map((item, index) => ({ cls: item.cls, width: widths[index] }));

  const legendParts = top.map((item) =>
    item.label ? `${item.label} ${item.percentInt}%` : `+${item.percentInt}%`,
  );
  const legendClasses = [];
  legendParts.forEach((part, index) => {
    if (index > 0) legendClasses.push('md-body');
    for (const _ch of part) legendClasses.push(top[index].cls);
  });

  return {
    segments,
    legendText: legendParts.join(' '),
    legendClasses,
  };
}

/* ── GitHub 贡献日历（由 fetch-contributions.js 生成 github-contributions.json） ── */

let contributionCache;

function clampLevel(value) {
  const level = Math.round(Number(value) || 0);
  return Math.min(4, Math.max(0, level));
}

/** 读取最近 HEATMAP.WEEKS 周；每个元素是 7 天的 level 数组 */
function getContributions() {
  if (contributionCache !== undefined) return contributionCache;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'github-contributions.json'), 'utf8'),
    );
    const rawWeeks = (Array.isArray(raw.weeks) ? raw.weeks : []).slice(-HEATMAP.WEEKS);
    const weeks = rawWeeks.map((week) =>
      Array.from({ length: 7 }, (_, day) => clampLevel(week?.days?.[day]?.level)),
    );
    if (!weeks.length) throw new Error('empty weeks');

    const total = rawWeeks
      .flatMap((week) => week?.days || [])
      .reduce((sum, day) => sum + (Number(day?.count) || 0), 0);

    contributionCache = { weeks, total };
  } catch {
    contributionCache = null;
  }
  return contributionCache;
}

/** fastfetch 风格的系统信息：左栏内容，一行一条（放不下时按栏宽自动换行） */
const FETCH_INFO = [
  ['OS', 'macOS Golden Gate arm64'],
  ['Kernel', 'Darwin 27.3.0'],
  ['Shell', 'zsh 5.9'],
  ['WM', 'Quartz Compositor 1.600.0'],
  ['Theme', 'Liquid Glass Light'],
  ['Pkgs', '57 (brew)'],
  ['Terminal Font', 'Jetbrains Mono'],
  ['Locale', 'zh_CN.UTF-8'],
];

function fetchSectionLines() {
  return FETCH_INFO.map(([label, value]) => ({
    index: -1,
    text: `${label}: ${value}`,
    kind: 'body',
    classes: [
      ...Array.from({ length: label.length }, () => ['md-host']),
      ['md-mark'],
      ['md-mark'],
      ...Array.from({ length: value.length }, () => ['md-body']),
    ],
  }));
}

function contributionSectionLines() {
  const contributions = getContributions();
  if (!contributions) {
    return [
      { index: -1, text: 'run: node fetch-contributions.js', kind: 'cmd' },
      { index: -1, text: '', kind: 'blank' },
    ];
  }

  return [
    { index: -1, text: `contributions - last 33 wks`, kind: 'heading' },
    { index: -1, text: '', kind: 'heatmap', weeks: contributions.weeks },
    { index: -1, text: '', kind: 'blank' },
  ];
}

function languageSectionLines() {
  const stats = getLanguageStats();
  if (!stats || !Array.isArray(stats.languages) || stats.languages.length === 0) {
    return [
      { index: -1, text: 'langs', kind: 'heading' },
      { index: -1, text: 'run: node fetch-langs.js', kind: 'cmd' },
      { index: -1, text: '', kind: 'blank' },
    ];
  }

  const chart = buildLanguageChart(stats);
  const repoLabel = stats.repoCount ? ` · ${stats.repoCount} repos` : '';
  return [
    { index: -1, text: `langs${repoLabel}`, kind: 'heading' },
    { index: -1, text: '', kind: 'langbar', segments: chart.segments },
    { index: -1, text: chart.legendText, kind: 'langs', classes: chart.legendClasses },
    { index: -1, text: '', kind: 'blank' },
  ];
}

/* ── `cat Personal attributes.json` 的输出（Level 按构建日期计算） ── */

const BIRTHDAY = { year: 2006, month: 2, day: 26 };

/** GMT+8 时间分量：不依赖构建机器的本地时区 */
function gmt8Parts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** Level = 当前 GMT+8 日期减 2006-02-26 的周岁 */
function currentLevel(date = new Date()) {
  const now = gmt8Parts(date);
  const birthdayPassed =
    now.month > BIRTHDAY.month ||
    (now.month === BIRTHDAY.month && now.day >= BIRTHDAY.day);
  return now.year - BIRTHDAY.year - (birthdayPassed ? 0 : 1);
}

/** 左栏可用的等宽列数（780px 画布、中线居中、左右边距 30px） */
/** 左右栏可用的等宽列数（与 layout 的分栏几何一致） */
function columnGeometry() {
  const charW = fontCharWidth(getFont());
  const width = Math.max(
    LAYOUT.MIN_WIDTH,
    Math.ceil(LAYOUT.PAD_X * 2 + BANNER_COLS * charW + charW),
    HEATMAP.WIDTH * 2 + LAYOUT.PAD_X * 4 + 2,
  );
  const ruleX = Math.round(width / 2);
  const rightX = ruleX + Math.round(charW * 10 / 3);
  const cols = (available) => Math.max(1, Math.floor((available - 8) / charW));
  return {
    left: cols(ruleX - LAYOUT.PAD_X),
    right: cols(width - rightX - LAYOUT.PAD_X),
  };
}

function leftColumnCols() {
  return columnGeometry().left;
}

/** 超宽 JSON 行在冒号后折行，折行后仍是合法 JSON */
function formatJsonForColumns(value) {
  const maxCols = leftColumnCols();
  const out = [];
  for (const line of JSON.stringify(value, null, 2).split('\n')) {
    if (textCells(line) <= maxCols) {
      out.push(line);
      continue;
    }
    const match = /^(\s*)("[^"]+":)(\s+)(.+)$/.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    out.push(`${match[1]}${match[2]}`);
    out.push(`${match[1]}  ${match[4]}`);
  }
  return out;
}

/** JSON 语法着色：键蓝、字符串粉、数字橙、标点灰 */
function jsonClasses(text) {
  const chars = Array.from(text);
  const classes = chars.map(() => 'md-body');
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < chars.length) {
        if (chars[end] === '\\') {
          end += 2;
          continue;
        }
        if (chars[end] === '"') {
          end++;
          break;
        }
        end++;
      }
      let next = end;
      while (next < chars.length && /\s/.test(chars[next])) next++;
      const cls = chars[next] === ':' ? 'md-host' : 'md-cmd';
      for (let n = i; n < end; n++) classes[n] = cls;
      i = end;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      while (i < chars.length && chars[i] >= '0' && chars[i] <= '9') {
        classes[i] = 'md-code';
        i++;
      }
      continue;
    }
    if ('{}[]:,'.includes(ch)) classes[i] = 'md-mark';
    i++;
  }
  return classes.map((cls) => [cls]);
}

function personalAttributesSectionLines() {
  const attributes = {
    chinese_name: '刘与盼',
    english_name: 'Nyanpasu Louis',
    Level: currentLevel(),
    zodiac_sign: 'Pisces',
    romantic_orientation: 'Quoiromantic',
    sexual_orientation: ['Graysexual','Heterosexual'],
    frequent_ip_locations: ['Beijing CN', 'Tianjin CN'],
    available_platforms: ['macOS', 'Windows', 'WSL'],
    email: 'jrlouis_cn@icloud.com',
    links: ['https://nyanpasu-louis.github.io', 'https://bonjour.bio/0421bv'],
  };

  return formatJsonForColumns(attributes).map((text) => ({
    index: -1,
    text,
    kind: 'body',
    classes: jsonClasses(text),
  }));
}

/** MBTI：标题 + 四个维度，每维一行标签 + 一条双色条形图 */
const MBTI_DIMENSIONS = [
  { left: '25% Extrovert', right: '75% Introvert', leftPercent: 25 },
  { left: '100% Intuition', right: '0% Sensing', leftPercent: 100 },
  { left: '45% Thinking', right: '55% Feeling', leftPercent: 45 },
  { left: '5% Judging', right: '95% Perceiving', leftPercent: 5 },
];

function mbtiSectionLines() {
  const cols = columnGeometry().right;
  const charsOf = (text, cls) => Array.from(text, () => [cls]);

  const lines = [
    {
      index: -1,
      text: 'INFP - INTP',
      kind: 'body',
      classes: [
        ...charsOf('INFP', 'md-host'),
        ...charsOf(' / ', 'md-mark'),
        ...charsOf('INTP', 'md-cmd'),
      ],
    },
  ];

  for (const dimension of MBTI_DIMENSIONS) {
    const gap = ' '.repeat(
      Math.max(1, cols - textCells(dimension.left) - textCells(dimension.right)),
    );
    lines.push({
      index: -1,
      text: dimension.left + gap + dimension.right,
      kind: 'body',
      classes: [
        ...charsOf(dimension.left, 'md-host'),
        ...charsOf(gap, 'md-mark'),
        ...charsOf(dimension.right, 'md-cmd'),
      ],
    });

    const filled = Math.min(
      cols,
      Math.max(0, Math.round((dimension.leftPercent / 100) * cols)),
    );
    lines.push({
      index: -1,
      text: '█'.repeat(cols),
      kind: 'body',
      classes: [
        ...Array.from({ length: filled }, () => ['md-host']),
        ...Array.from({ length: cols - filled }, () => ['md-cmd']),
      ],
    });
  }

  return lines;
}

/** 九型人格：空一行 → "1w2" → 九段色块条形图 */
function enneagramSectionLines() {
  const cols = columnGeometry().right;
  const gap = 1;
  const segment = Math.max(1, Math.floor((cols - 8 * gap) / 9));
  const bar = [];
  const classes = [];

  for (let i = 0; i < 9; i++) {
    const cls = i === 0 ? 'md-cmd' : i === 1 ? 'md-host' : 'md-code';
    bar.push('█'.repeat(segment));
    classes.push(...Array.from({ length: segment }, () => [cls]));
    if (i < 8) {
      bar.push(' '.repeat(gap));
      classes.push(...Array.from({ length: gap }, () => ['md-mark']));
    }
  }

  return [
    { index: -1, text: '', kind: 'blank' },
    {
      index: -1,
      text: '1w2',
      kind: 'body',
      classes: Array.from('1w2', () => ['md-h']),
    },
    { index: -1, text: bar.join(''), kind: 'body', classes },
  ];
}

/** 按列宽贪心折行（按词边界） */
function wrapText(text, maxCols) {
  const lines = [];
  let current = '';
  for (const word of String(text).split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (current && textCells(next) > maxCols) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const SUN_OF_CHINA_QUOTE = [
  'No one knows how far the Sun of China will travel, or what wonders await Shuiwa',
  'and his companions in the vast universe. Perhaps one day, they will',
  'send a call back to Earth, only to wait a thousand years for an answer.',
  'But Shuiwa will never forget the country called China on his mother planet，nor',
  'the little village nestled in the arid lands of its western',
  'region, nor the narrow path in front of the village—where he',
  'first set out on his journey.',
].join(' ');

/** 《中国太阳》结尾：空一行 → 黑色正文 → 粉色右对齐落款（书名斜体） */
function closingSectionLines() {
  const cols = columnGeometry().right;
  const signature = '——The Sun of China, Liu Cixin';
  const signatureChars = Array.from(signature);
  const titleStart = 2; // 两个破折号之后
  const titleEnd = titleStart + Array.from('The Sun of China').length;
  const pad = Math.max(0, cols - textCells(signature));

  const signatureClasses = signatureChars.map((_, i) =>
    i >= titleStart && i < titleEnd ? ['md-cmd', 'md-italic'] : ['md-cmd'],
  );

  return [
    { index: -1, text: '', kind: 'blank' },
    ...wrapText(SUN_OF_CHINA_QUOTE, cols).map((text) => ({
      index: -1,
      text,
      kind: 'body',
      classes: Array.from(text, () => ['md-prose']),
    })),
    {
      index: -1,
      text: ' '.repeat(pad) + signature,
      kind: 'body',
      classes: [
        ...Array.from({ length: pad }, () => ['md-mark']),
        ...signatureClasses,
      ],
    },
  ];
}

/* ══════════════════════════════════════════════════════════════════
   3. parseLines —— 拆行 + 判定 Markdown 行类型
   ══════════════════════════════════════════════════════════════════ */

/**
 * @param {string} markdown
 * @returns {{index:number, text:string, kind:string}[]}
 */
function parseLines(markdown) {
  const normalized = String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  '); // 制表符会破坏等宽网格，先展开

  const raw = normalized.split('\n');
  // 文件末尾的换行不算一行空行
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();

  return raw.map((text, index) => {
    const clean = text.replace(/\s+$/, '');
    return { index, text: clean, kind: classifyLine(clean) };
  });
}

/** @param {string} text */
function classifyLine(text) {
  if (/^\s*```/.test(text)) return 'fence';
  if (/^#{1,6}(\s|$)/.test(text)) return 'heading';
  if (/^>\s?/.test(text)) return 'quote';
  if (/^\s*[-*+]\s/.test(text)) return 'list';
  if (/^\s{2,}\S/.test(text)) return 'cmd';
  if (/^\s*$/.test(text)) return 'blank';
  return 'body';
}

/* ══════════════════════════════════════════════════════════════════
   4. layout —— 等宽网格 + 每个字符的 class
   ──────────────────────────────────────────────────────────────────
   坐标：x = PAD_X + col * charW，y = firstBaseline + row * LINE_H。
   charW 来自字体真实的 advance width（JetBrains Mono = 0.6em），
   所以 15px 字号下正好是 9px，和原来的固定网格完全兼容。
   ══════════════════════════════════════════════════════════════════ */

/**
 * @param {{index:number, text:string, kind:string, staticPrefix?:number}[]} lines
 * @param {ReturnType<typeof loadFont>} [font]
 */
function layout(lines, font = getFont()) {
  warnMissingGlyphs(font, lines);

  const charW = fontCharWidth(font);
  const lineCols = (line) => textCells(line.text || '');
  const maxLen = lines.reduce((max, line) => Math.max(max, lineCols(line)), 0);
  const promptCols = lines.reduce(
    (max, line) => (line.kind === 'prompt' ? Math.max(max, lineCols(line)) : max),
    0,
  );
  const hasBanner = lines.some((line) => line.kind === 'banner');
  // 提示符行不参与软换行，画布必须容纳完整命令
  const contentCols = Math.max(Math.min(maxLen, LAYOUT.MAX_COLS), promptCols);
  // 横幅不参与软换行，画布必须容纳它，不能被 MAX_COLS 截断
  const cols = Math.max(contentCols, hasBanner ? BANNER_COLS : 0) || 1;
  const firstBaseline = LAYOUT.TOP_PAD;

  const hasWideBlock = lines.some(
    (line) =>
      line.kind === 'langbar' ||
      line.kind === 'heatmap' ||
      (line.columns?.right || []).some(
        (columnLine) => columnLine.kind === 'langbar' || columnLine.kind === 'heatmap',
      ),
  );
  const width = Math.max(
    LAYOUT.MIN_WIDTH,
    Math.ceil(LAYOUT.PAD_X * 2 + cols * charW + charW),
    hasWideBlock ? HEATMAP.WIDTH * 2 + LAYOUT.PAD_X * 4 + 2 : 0,
  );

  const ruleX = Math.round(width / 2);
  const rightX = ruleX + Math.round(charW * 10 / 3); // 中间竖线右侧的列起点
  // 分栏内按可用宽度换行，避免长行压到分隔线或画布右边缘
  const columnCols = (available) => Math.max(1, Math.floor((available - 8) / charW));
  const leftMaxCols = columnCols(ruleX - LAYOUT.PAD_X);
  const rightMaxCols = columnCols(width - rightX - LAYOUT.PAD_X);
  const rows = [];
  let cursorY = firstBaseline;
  const lineGroups = [];
  const columnsRules = [];

  function makeTextGroup(line, xOffset, yStart, column, maxCols = LAYOUT.MAX_COLS) {
    const chars = Array.from(line.text || '');
    const classes = (line.classes || classesForChars(line.text || '', line.kind)).map((value) =>
      Array.isArray(value) ? value : [value],
    );
    const group = {
      index: line.index,
      kind: line.kind,
      text: line.text || '',
      charCount: chars.length,
      staticPrefix: line.staticPrefix || 0,
      column,
      simultaneous: Boolean(line.simultaneous),
      rows: [],
      start: 0,
      end: 0,
      lastDelay: 0,
    };

    const chunks = [];
    let chunk = { offset: 0, chars: [], cells: 0 };
    for (const char of chars) {
      const cells = charCells(char);
      if (chunk.chars.length && chunk.cells + cells > maxCols) {
        chunks.push(chunk);
        chunk = { offset: chunk.offset + chunk.chars.length, chars: [], cells: 0 };
      }
      chunk.chars.push(char);
      chunk.cells += cells;
    }
    chunks.push(chunk); // 空行也占一个视觉行

    let y = yStart;
    chunks.forEach((chunk, part) => {
      let x = xOffset;
      const row = {
        index: rows.length,
        sourceIndex: line.index,
        kind: line.kind,
        column,
        part,
        baseline: y,
        cells: chunk.cells,
        chars: chunk.chars.map((char, col) => {
          const cells = charCells(char);
          const charBox = {
            char,
            col,
            offset: chunk.offset + col,
            x,
            width: cells * charW,
            classes: classes[chunk.offset + col],
          };
          x += cells * charW;
          return charBox;
        }),
        firstDelay: 0,
        lastDelay: 0,
      };
      rows.push(row);
      group.rows.push(row);
      y += LAYOUT.LINE_H;
    });

    return { group, y };
  }

  function makeLangbarBlock(line, x, yBaseline) {
    const top = yBaseline - BAR.TOP_OFFSET;
    const cells = [];
    let cursor = x;
    (line.segments || []).forEach((segment, order) => {
      if (segment.width > 0) {
        cells.push({
          x: cursor,
          y: top,
          width: segment.width,
          height: BAR.HEIGHT,
          cls: segment.cls,
          order,
        });
      }
      cursor += segment.width;
    });

    const row = {
      index: rows.length,
      sourceIndex: line.index,
      kind: 'langbar',
      column: 'right',
      top,
      height: BAR.HEIGHT,
      chars: [],
      cells,
      barStart: 0,
      firstDelay: 0,
      lastDelay: 0,
    };
    rows.push(row);

    const group = {
      index: line.index,
      kind: 'langbar',
      text: '',
      charCount: 0,
      staticPrefix: 0,
      column: 'right',
      rows: [row],
      start: 0,
      end: 0,
      lastDelay: 0,
    };

    return { group, y: yBaseline + LAYOUT.LINE_H };
  }

  function makeHeatmapBlock(line, x, yBaseline) {
    const top = yBaseline - LAYOUT.LINE_H + HEATMAP.TOP_GAP;
    const cells = [];
    for (const [col, week] of (line.weeks || []).entries()) {
      for (const [day, level] of week.entries()) {
        cells.push({
          x: x + col * (HEATMAP.CELL + HEATMAP.GAP),
          y: top + day * (HEATMAP.CELL + HEATMAP.GAP),
          level,
          col,
        });
      }
    }

    const row = {
      index: rows.length,
      sourceIndex: line.index,
      kind: 'heatmap',
      column: 'right',
      top,
      height: HEATMAP.HEIGHT,
      chars: [],
      cells,
      heatStart: 0,
      firstDelay: 0,
      lastDelay: 0,
    };
    rows.push(row);

    const group = {
      index: line.index,
      kind: 'heatmap',
      text: '',
      charCount: 0,
      staticPrefix: 0,
      column: 'right',
      rows: [row],
      start: 0,
      end: 0,
      lastDelay: 0,
    };

    return { group, y: top + HEATMAP.HEIGHT + HEATMAP.BOTTOM_GAP };
  }

  for (const line of lines) {
    if (line.kind === 'banner') {
      const group = {
        index: line.index,
        kind: line.kind,
        text: '',
        charCount: 0,
        staticPrefix: 0,
        column: null,
        rows: [],
        start: 0,
        end: 0,
        lastDelay: 0,
      };
      const row = {
        index: rows.length,
        sourceIndex: line.index,
        kind: 'banner',
        top: cursorY + BANNER.TOP_GAP,
        height: BANNER_MARKER_HEIGHT,
        chars: [],
        firstDelay: 0,
        lastDelay: 0,
        bannerStart: 0,
      };
      rows.push(row);
      group.rows.push(row);
      lineGroups.push(group);
      cursorY += row.height;
      continue;
    }

    if (line.kind === 'columns') {
      const contentTop = cursorY;
      let leftY = contentTop;
      let rightY = contentTop;
      const rule = {
        x: ruleX,
        y1: contentTop - 20,
        y2: contentTop,
        delay: 0,
        firstRowIndex: null,
      };
      const noteFirstRow = (group) => {
        if (rule.firstRowIndex === null && group.rows.length) {
          rule.firstRowIndex = group.rows[0].index;
        }
      };

      for (const columnLine of line.columns.left) {
        const { group, y } = makeTextGroup(
          columnLine,
          LAYOUT.PAD_X,
          leftY,
          'left',
          leftMaxCols,
        );
        noteFirstRow(group);
        lineGroups.push(group);
        leftY = y;
      }
      for (const columnLine of line.columns.right) {
        if (columnLine.kind === 'heatmap' || columnLine.kind === 'langbar') {
          const block = columnLine.kind === 'heatmap'
            ? makeHeatmapBlock(columnLine, rightX, rightY)
            : makeLangbarBlock(columnLine, rightX, rightY);
          noteFirstRow(block.group);
          lineGroups.push(block.group);
          rightY = block.y;
          continue;
        }
        const { group, y } = makeTextGroup(
          columnLine,
          rightX,
          rightY,
          'right',
          rightMaxCols,
        );
        noteFirstRow(group);
        lineGroups.push(group);
        rightY = y;
      }

      const blockBottom = Math.max(leftY, rightY);
      rule.y2 = blockBottom - LAYOUT.LINE_H + 8;
      columnsRules.push(rule);
      cursorY = blockBottom;
      continue;
    }

    const { group, y } = makeTextGroup(
      line,
      LAYOUT.PAD_X,
      cursorY,
      null,
      line.kind === 'prompt' ? contentCols : LAYOUT.MAX_COLS,
    );
    lineGroups.push(group);
    cursorY = y;
  }

  // 最后一行如果刚好写满 MAX_COLS，光标换到下一行行首，画布要多留一行
  const lastRow = [...rows].reverse().find((row) => row.chars.length > 0);
  const cursorRow = lastRow
    ? lastRow.index +
      (lastRow.kind !== 'prompt' && lastRow.cells >= LAYOUT.MAX_COLS ? 1 : 0)
    : 0;
  let height = cursorY - LAYOUT.LINE_H + LAYOUT.BOTTOM_PAD;
  if (cursorRow >= rows.length) height += LAYOUT.LINE_H;

  return {
    width,
    height,
    cols,
    charW,
    firstBaseline,
    rows,
    lineGroups,
    cursorRow,
    columnsRules,
  };
}

/** 行内 class 生成：先按行类型给底色，再叠加 `inline code` 高亮 */
function classesForChars(text, kind) {
  if (kind === 'prompt') return promptClasses(text);

  const chars = Array.from(text);
  const out = [];
  let inCode = false;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '`') {
      inCode = !inCode;
      out.push(['md-mark']);
    } else if (inCode) {
      out.push(['md-code']);
    } else {
      out.push(baseClasses(chars, text, kind, i));
    }
  }
  return out;
}

/** 提示符着色：user 粉、host/path 蓝、$ 粉、括号和 @ 灰、命令用正文色 */
function promptClasses(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (i >= PROMPT_LEN) {
      out.push(['md-body']);
    } else if (i >= PROMPT_POS.userStart && i < PROMPT_POS.userEnd) {
      out.push(['md-user']);
    } else if (i >= PROMPT_POS.hostStart && i < PROMPT_POS.hostEnd) {
      out.push(['md-host']);
    } else if (i >= PROMPT_POS.pathStart && i < PROMPT_POS.pathEnd) {
      out.push(['md-path']);
    } else if (i === PROMPT_POS.symbol) {
      out.push(['md-symbol']);
    } else {
      out.push(['md-prompt']);
    }
  }
  return out;
}

function baseClasses(chars, text, kind, i) {
  switch (kind) {
    case 'heading': {
      const hashes = /^(#{1,6})/.exec(text);
      const markerEnd = hashes ? hashes[1].length : 0;
      return i < markerEnd ? ['md-mark'] : ['md-h'];
    }
    case 'quote':
      return i === 0 ? ['md-mark'] : ['md-quote'];
    case 'list':
      return chars[i] === '-' && i === 0 ? ['md-bullet'] : ['md-body'];
    case 'fence':
      return ['md-mark'];
    case 'cmd':
      return ['md-cmd'];
    default:
      return ['md-body'];
  }
}

/* ══════════════════════════════════════════════════════════════════
   5. compileTimeline —— 把时间轴编译进每个元素
   ══════════════════════════════════════════════════════════════════
   规则：
     第 i 行 start = 第 i-1 行 end + LINE_GAP（首行 = START_DELAY）
     第 i 行第 j 个字符 delay = start + j * CHAR_STEP
     end = 本行最后一个字符的 delay + LINE_HOLD
     光标 delay = 最后一个字符的 delay + LINE_HOLD
*/

/**
 * @param {ReturnType<typeof layout>} doc
 */
/** 给单个文字组 / 图形块排时间轴，返回带 start/end 的副本 */
function scheduleGroup(group, start) {
  if (group.kind === 'langbar') {
    const marker = group.rows[0];
    const segments = marker ? marker.cells.length : 0;
    const end = start + Math.max(0, segments - 1) * BAR.STEP_MS + BAR.HOLD_MS;
    if (marker) marker.barStart = start;
    return { ...group, start, end, lastDelay: end };
  }

  if (group.kind === 'heatmap') {
    const end = start + (HEATMAP.WEEKS - 1) * HEATMAP.STEP_MS + HEATMAP.HOLD_MS;
    const marker = group.rows[0];
    if (marker) marker.heatStart = start;
    return { ...group, start, end, lastDelay: end };
  }

  if (group.kind === 'banner') {
    const end = start + (BANNER_ROWS.length - 1) * BANNER.ROW_STEP_MS + BANNER.HOLD_MS;
    const marker = group.rows[0];
    if (marker) marker.bannerStart = start;
    return { ...group, start, end, lastDelay: end };
  }

  const prefix = group.staticPrefix || 0;
  group.rows.forEach((row) => {
    row.chars.forEach((c) => {
      if (c.offset < prefix) {
        c.delay = start; // 提示符本身瞬间出现，只有命令逐字打
      } else {
        const typedIndex = prefix > 0 ? c.offset - prefix + 1 : c.offset;
        c.delay = roundMs(start + typedIndex * TIME.CHAR_STEP);
      }
    });
    row.firstDelay = row.chars.length ? row.chars[0].delay : start;
    row.lastDelay = row.chars.length ? row.chars[row.chars.length - 1].delay : start;
  });

  const typedCount = group.charCount - prefix;
  const lastDelay = typedCount > 0
    ? roundMs(start + (prefix > 0 ? typedCount : typedCount - 1) * TIME.CHAR_STEP)
    : start;
  return { ...group, start, end: lastDelay + TIME.LINE_HOLD, lastDelay };
}

function compileTimeline(doc) {
  let clock = TIME.START_DELAY;
  const lineGroups = [];
  const source = doc.lineGroups;

  // 按源码行串行推进；同一行的软换行共享这条时间轴。
  // 分栏块里左右两栏按行成对出现，而不是左栏全部打完再打右栏。
  let index = 0;
  while (index < source.length) {
    if (!source[index].column) {
      // 连续标记为 simultaneous 的行共享同一起始时间，逐字并行打出
      if (source[index].simultaneous) {
        const batch = [];
        while (
          index < source.length &&
          !source[index].column &&
          source[index].simultaneous
        ) {
          batch.push(source[index]);
          index++;
        }
        let end = clock;
        for (const group of batch) {
          const scheduled = scheduleGroup(group, clock);
          end = Math.max(end, scheduled.end);
          lineGroups.push(scheduled);
        }
        clock = end + TIME.LINE_GAP;
        continue;
      }

      const group = scheduleGroup(source[index], clock);
      clock = group.end + TIME.LINE_GAP;
      lineGroups.push(group);
      index++;
      continue;
    }

    const left = [];
    const right = [];
    while (index < source.length && source[index].column) {
      (source[index].column === 'left' ? left : right).push(source[index]);
      index++;
    }

    const pairs = Math.max(left.length, right.length);
    for (let row = 0; row < pairs; row++) {
      const pair = [left[row], right[row]].filter(Boolean);
      let end = clock;
      for (const group of pair) {
        const scheduled = scheduleGroup(group, clock);
        end = Math.max(end, scheduled.end);
        lineGroups.push(scheduled);
      }
      clock = end + TIME.LINE_GAP;
    }
  }

  for (const rule of doc.columnsRules) {
    if (rule.firstRowIndex === null) continue;
    const first = lineGroups.find((group) =>
      group.rows.some((row) => row.index === rule.firstRowIndex),
    );
    if (first) rule.delay = first.start;
  }

  const rows = doc.rows;

  // 光标落在最后一个有内容的行尾；该行写满了就换到下一行行首
  const lastGroup = [...lineGroups].reverse().find((group) => group.charCount > 0);
  const anchor = lastGroup ? lastGroup.rows[lastGroup.rows.length - 1] : null;
  // 并行命令可在相近时间结束，光标等全部行都打完再出现
  const typeEnd = lineGroups.reduce(
    (max, group) => Math.max(max, group.end),
    TIME.START_DELAY,
  );
  const cursorDelay = typeEnd;
  const wrapped = Boolean(
    anchor && anchor.kind !== 'prompt' && anchor.cells >= LAYOUT.MAX_COLS,
  );

  const cursorRowData = doc.rows[doc.cursorRow];
  const anchorBaseline = anchor ? anchor.baseline : doc.firstBaseline;
  const cursorBaseline = wrapped
    ? (cursorRowData && cursorRowData.baseline != null ? cursorRowData.baseline : anchorBaseline + LAYOUT.LINE_H)
    : anchorBaseline;

  const cursor = {
    x:
      anchor && !wrapped
        ? anchor.chars[anchor.chars.length - 1].x +
          anchor.chars[anchor.chars.length - 1].width
        : LAYOUT.PAD_X,
    y: cursorBaseline - LAYOUT.CURSOR_LIFT,
    width: doc.charW,
    height: LAYOUT.CURSOR_H,
    delay: cursorDelay,
  };

  const total = cursorDelay + TIME.CURSOR_BLINK_MS * TIME.TOTAL_BLINK_CYCLES;
  const charCount = lineGroups.reduce((sum, group) => sum + group.charCount, 0);

  return {
    ...doc,
    rows,
    lineGroups,
    cursor,
    total,
    charCount,
    typeEnd,
    lineCount: lineGroups.length,
  };
}

function roundMs(n) {
  return Math.round(n);
}

/* ══════════════════════════════════════════════════════════════════
   6. emitSvg —— 纯模板字符串拼 SVG
   ══════════════════════════════════════════════════════════════════ */

/**
 * @param {ReturnType<typeof compileTimeline>} plan
 */
function emitSvg(plan) {
  const { width, height, rows, cursor, total } = plan;
  const bannerRow = rows.find((row) => row.kind === 'banner');
  const bannerTop = bannerRow ? bannerRow.top : 0;
  const cell = BANNER.CELL;

  // 只嵌入这份文档实际用到的字形
  const font = getFont();
  const fontSubset = font.subset(collectCodepoints(rows));
  const fontData = fontSubset.toString('base64');
  const fontKb = (fontSubset.length / 1024).toFixed(1);

  const out = [];

  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<!-- generated by gen.js · ${plan.charCount} chars · ${plan.total}ms · ` +
      `JetBrains Mono subset ${fontKb} KB · ` +
      `CSS only, no SMIL/JS -->`,
  );
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tty-title tty-desc" ` +
      `style="--total: ${total}ms; max-width: 100%; height: auto; display: block">`,
  );

  out.push(
    `  <title id="tty-title">${escapeXml(DOCUMENT_TITLE)} - a markdown file that types itself</title>`,
  );
  out.push(
    '  <desc id="tty-desc">A terminal where a zsh prompt runs fastfetch with a ' +
      'block-letter Nyanpasu / Louis banner, a language bar and a pink contribution heatmap. ' +
      'After two cat commands are typed in parallel, a second two-column section shows a JSON ' +
      'personal-attributes file on the left and an MBTI result with four proportion bars plus ' +
      'an enneagram 1w2 nine-segment bar on the right, closing with a quote from Liu Cixin, ' +
      'then a fresh shell prompt with a blinking cursor. Everything is animated by CSS ' +
      'keyframes; the palette follows prefers-color-scheme.</desc>',
  );

  out.push('  <defs>');
  out.push(
    `    <pattern id="tty-block" x="${LAYOUT.PAD_X}" y="${bannerTop}" ` +
      `width="${cell}" height="${cell}" patternUnits="userSpaceOnUse">`,
  );
  out.push(`      <rect class="block-bg" x="0.5" y="0.5" width="${cell - 1}" height="${cell - 1}"/>`);
  out.push(`      <rect class="block-line" x="0.5" y="0.5" width="${cell - 1}" height="${cell - 1}"/>`);
  out.push(
    `      <path class="block-line" d="M1 1 L${cell - 1} ${cell - 1} ` +
      `M${cell - 1} 1 L1 ${cell - 1}"/>`,
  );
  out.push('    </pattern>');
  out.push('  </defs>');

  // 背景：铺满整个矩形终端的纯色底，无描边
  out.push(`  <rect class="tty-bg" width="${width}" height="${height}"/>`);

  // 各分栏区块之间的竖线
  for (const rule of plan.columnsRules) {
    out.push(
      `  <line class="columns-rule" aria-hidden="true" x1="${rule.x}" y1="${rule.y1}" ` +
        `x2="${rule.x}" y2="${rule.y2}" style="animation-delay:${rule.delay}ms"/>`,
    );
  }

  // 唯一的 <style>：字体、主题变量、动画全在这里
  out.push('  <style>');
  out.push('    @font-face {');
  out.push(`      font-family: "${FONT.FAMILY}";`);
  out.push(`      src: url("data:font/ttf;base64,${fontData}") format("truetype");`);
  out.push('      font-weight: 400;');
  out.push('      font-style: normal;');
  out.push('      font-display: block;');
  out.push('    }');
  out.push('');
  out.push('    :root {');
  for (const line of paletteLines(THEMES.dark, '      ')) out.push(line);
  out.push('    }');
  out.push('');
  out.push('    @media (prefers-color-scheme: light) {');
  out.push('      :root {');
  for (const line of paletteLines(THEMES.light, '        ')) out.push(line);
  out.push('      }');
  out.push('    }');
  out.push('');
  out.push('    @keyframes appear { 0% { opacity: 0 } 100% { opacity: 1 } }');
  out.push('    @keyframes blink  { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }');
  out.push('');
  out.push('    .ch {');
  out.push('      opacity: 0;');
  out.push('      animation: appear 1ms step-start both;');
  out.push(`      font-family: ${FONT.STACK};`);
  out.push(`      font-size: ${LAYOUT.FONT_SIZE}px;`);
  out.push('      font-variant-ligatures: none;');
  out.push('      white-space: pre;');
  out.push('    }');
  out.push('');
  out.push('    .md-body   { fill: var(--body) }');
  out.push('    .md-prose  { fill: var(--prose) }');
  out.push('    .md-italic { font-style: italic }');
  out.push('    .md-h      { fill: var(--heading); font-weight: 600 }');
  out.push('    .md-mark   { fill: var(--mark) }');
  out.push('    .md-code   { fill: var(--code) }');
  out.push('    .md-quote  { fill: var(--quote); font-style: italic }');
  out.push('    .md-cmd    { fill: var(--cmd) }');
  out.push('    .md-bullet { fill: var(--bullet) }');
  out.push('    .md-prompt { fill: var(--quote) }');
  out.push('    .md-user   { fill: var(--cmd) }');
  out.push('    .md-host   { fill: var(--heading) }');
  out.push('    .md-path   { fill: var(--heading) }');
  out.push('    .md-symbol { fill: var(--cmd) }');
  out.push('');
  out.push('    .heat-0 { fill: var(--heat0) }');
  out.push('    .heat-1 { fill: var(--heat1) }');
  out.push('    .heat-2 { fill: var(--heat2) }');
  out.push('    .heat-3 { fill: var(--heat3) }');
  out.push('    .heat-4 { fill: var(--heat4) }');
  out.push('    .heat-cell { opacity: 0; animation: appear 1ms step-start both }');
  out.push('    .langbar-cell { opacity: 0; animation: appear 1ms step-start both }');
  out.push('');
  out.push('    .lang-js    { fill: var(--code) }');
  out.push('    .lang-ts    { fill: var(--code) }');
  out.push('    .lang-py    { fill: var(--heading) }');
  out.push('    .lang-css   { fill: var(--cmd) }');
  out.push('    .lang-html  { fill: var(--quote) }');
  out.push('    .lang-sh    { fill: var(--bullet) }');
  out.push('    .lang-other { fill: var(--mark) }');
  out.push('');
  out.push('    .tty-bg     { fill: var(--bg) }');
  out.push('    .block-bg   { fill: var(--cmd) }');
  out.push('    .block-line { stroke: var(--bg); stroke-width: 1; fill: none }');
  out.push('    .block-cell { opacity: 0; animation: appear 1ms step-start both }');
  out.push('    .columns-rule { stroke: var(--divider); stroke-width: 1; opacity: 0; ' +
    'animation: appear 1ms step-start both }');
  out.push('');
  out.push('    /* 延迟结束前保持 opacity:0（不写 fill-mode，避免反向填充把光标提前点亮） */');
  out.push('    .cursor {');
  out.push('      opacity: 0;');
  out.push('      fill: var(--cursor);');
  out.push(`      animation: blink ${TIME.CURSOR_BLINK_MS}ms steps(1) infinite;`);
  out.push('    }');
  out.push('');
  out.push('    @media (prefers-reduced-motion: reduce) {');
  out.push('      .ch { opacity: 1; animation: none }');
  out.push('      .block-cell { opacity: 1; animation: none }');
  out.push('      .heat-cell { opacity: 1; animation: none }');
  out.push('      .langbar-cell { opacity: 1; animation: none }');
  out.push('      .columns-rule { opacity: 1; animation: none }');
  out.push('      .cursor { opacity: 1; animation: none }');
  out.push('    }');
  out.push('  </style>');

  // 逐行、逐字符（软换行算同一源码行的延续）
  rows.forEach((row) => {
    if (row.kind === 'banner') {
      out.push('  <!-- name banner: NYANPASU / LOUIS, ▩-textured cells -->');
      out.push('  <g class="banner" aria-hidden="true" shape-rendering="crispEdges">');
      for (const line of BANNER_ROWS) {
        const delay = row.bannerStart + line.row * BANNER.ROW_STEP_MS;
        for (const col of line.cells) {
          const x = LAYOUT.PAD_X + col * BANNER.CELL;
          const y = row.top + line.row * BANNER.CELL;
          out.push(
            `    <rect class="block-cell" x="${x}" y="${y}" width="${BANNER.CELL}" ` +
              `height="${BANNER.CELL}" fill="url(#tty-block)" style="animation-delay:${delay}ms"/>`,
          );
        }
      }
      out.push('  </g>');
      return;
    }
    if (row.kind === 'langbar') {
      out.push(`  <!-- language bar · ${BAR.WIDTH}px wide, starts at ${row.cells[0] ? row.cells[0].x : 0}px -->`);
      out.push('  <g class="langbar" aria-hidden="true">');
      for (const cell of row.cells) {
        const delay = row.barStart + cell.order * BAR.STEP_MS;
        out.push(
          `    <rect class="langbar-cell ${cell.cls}" x="${cell.x}" y="${cell.y}" ` +
            `width="${cell.width}" height="${cell.height}" style="animation-delay:${delay}ms"/>`,
        );
      }
      out.push('  </g>');
      return;
    }
    if (row.kind === 'heatmap') {
      out.push(`  <!-- contribution heatmap · last ${HEATMAP.WEEKS} weeks · pink squares -->`);
      out.push('  <g class="heatmap" aria-hidden="true">');
      for (const cell of row.cells) {
        const delay = row.heatStart + cell.col * HEATMAP.STEP_MS;
        out.push(
          `    <rect class="heat-cell heat-${cell.level}" x="${cell.x}" y="${cell.y}" ` +
            `width="${HEATMAP.CELL}" height="${HEATMAP.CELL}" rx="${HEATMAP.RX}" ` +
            `style="animation-delay:${delay}ms"/>`,
        );
      }
      out.push('  </g>');
      return;
    }
    if (!row.chars.length) return;
    const cont = row.part > 0 ? ' (cont.)' : '';
    const column = row.column ? ` · ${row.column}` : '';
    out.push(
      `  <!-- line ${String(row.sourceIndex + 1).padStart(2, '0')} · ${row.kind}${column}${cont} · ` +
        `first char at ${row.firstDelay}ms, last at ${row.lastDelay}ms -->`,
    );
    out.push('  <g>');
    row.chars.forEach((c) => {
      out.push(
        `    <text class="ch ${c.classes.join(' ')}" style="animation-delay:${c.delay}ms" ` +
          `x="${c.x}" y="${row.baseline}" xml:space="preserve">${escapeXml(c.char)}</text>`,
      );
    });
    out.push('  </g>');
  });

  // 光标：最后一个字符出现 + LINE_HOLD 之后开始闪
  out.push(`  <!-- cursor · starts at ${cursor.delay}ms · ${TIME.CURSOR_BLINK_MS}ms loop -->`);
  out.push(
    `  <rect class="cursor" x="${cursor.x}" y="${cursor.y}" width="${cursor.width}" ` +
      `height="${cursor.height}" rx="${LAYOUT.CURSOR_RX}" style="animation-delay:${cursor.delay}ms"/>`,
  );

  out.push('</svg>');
  out.push('');

  plan.fontBytes = fontSubset.length;
  return out.join('\n');
}

/** 生成 `--bg: #...;` 这样的 CSS 变量行 */
function paletteLines(theme, indent) {
  return Object.entries(theme).map(
    ([name, value]) => `${indent}--${kebabCase(name)}: ${value};`,
  );
}

function kebabCase(name) {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/** XML 转义（& < > " 以及 '） */
function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   7. render / main
   ══════════════════════════════════════════════════════════════════ */

/**
 * 把 Markdown 编译成自包含的 SVG 字符串。
 * @param {string} markdown
 * @returns {string}
 */
function render(markdown) {
  const plan = build(markdown);
  return emitSvg(plan);
}

/** 在 Markdown 前后包上 shell 提示符：顶部是 prompt + 命令，底部是等待输入的 prompt */
/** 第一个一级标题只当作文档标题（供 README 的 alt 使用），不渲染；原位置换成名字横幅 */
function injectBanner(content) {
  const h1 = content.findIndex((line) => /^#\s+/.test(line.text));
  if (h1 === -1) return content;

  let insertAt = h1 + 1;
  while (insertAt < content.length && content[insertAt].text.trim() === '') insertAt++;

  return [
    ...content.slice(0, h1),
    { text: '', kind: 'banner' },
    ...content.slice(insertAt),
  ];
}

function buildTerminalLines(markdown) {
  const content = injectBanner(parseLines(markdown));
  const bannerIndex = content.findIndex((line) => line.kind === 'banner');

  let blocks = content;
  if (bannerIndex !== -1) {
    const columns = {
      left: fetchSectionLines(),
      right: [
        ...languageSectionLines(),
        ...contributionSectionLines(),
        ...content.slice(bannerIndex + 1),
      ],
    };
    blocks = [...content.slice(0, bannerIndex + 1), { kind: 'columns', text: '', columns }];
  }

  const commands = SHELL.NEXT_COMMANDS.map((command, i) => ({
    index: blocks.length + 1 + i,
    text: PROMPT_TEXT + command,
    kind: 'prompt',
    staticPrefix: PROMPT_LEN,
    simultaneous: true,
  }));

  return [
    { index: 0, text: PROMPT_TEXT + SHELL.COMMAND, kind: 'prompt', staticPrefix: PROMPT_LEN },
    ...blocks.map((line, i) => ({ ...line, index: i + 1 })),
    ...commands,
    { index: blocks.length + commands.length + 1, kind: 'blank', text: '' },
    {
      index: blocks.length + commands.length + 2,
      kind: 'columns',
      text: '',
      columns: {
        left: personalAttributesSectionLines(),
        right: [
          ...mbtiSectionLines(),
          ...enneagramSectionLines(),
          ...closingSectionLines(),
        ],
      },
    },
    {
      index: blocks.length + commands.length + 3,
      text: PROMPT_TEXT,
      kind: 'prompt',
      staticPrefix: PROMPT_LEN,
    },
  ];
}

/** 与 render 相同，但把时间轴统计一并返回（给 main 打印用） */
function build(markdown) {
  const font = getFont();
  return compileTimeline(layout(buildTerminalLines(markdown), font));
}

function main() {
  const [, , inputArg, outputArg] = process.argv;

  const inputPath = inputArg ? path.resolve(process.cwd(), inputArg) : null;
  const outputPath = path.resolve(process.cwd(), outputArg || 'output.svg');

  try {
    const markdown = inputPath ? fs.readFileSync(inputPath, 'utf8') : SAMPLE_MARKDOWN;

    const plan = build(markdown);
    const svg = emitSvg(plan);
    fs.writeFileSync(outputPath, svg, 'utf8');

    const seconds = (n) => (n / 1000).toFixed(2) + 's';

    console.log(`✓ ${displayPath(outputPath)}  (${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB)`);
    console.log(`  source     : ${inputPath ? displayPath(inputPath) : '内置示例 Markdown'}`);
    console.log(`  font       : ${FONT.FILE}  (${(plan.fontBytes / 1024).toFixed(1)} KB 子集内嵌)`);
    console.log(`  theme      : dark / light  (prefers-color-scheme)`);
    const leftCount = plan.lineGroups.filter((group) => group.column === 'left').length;
    const rightCount = plan.lineGroups.filter((group) => group.column === 'right').length;
    console.log(
      `  columns    : left ${leftCount} / right ${rightCount}` +
        (plan.columnsRules.length
          ? `  (rules x=${plan.columnsRules.map((rule) => rule.x).join(',')})`
          : ''),
    );
    const langStats = getLanguageStats();
    if (langStats) {
      console.log(`  langs      : ${languageRatioLine(langStats)}  (${langStats.repoCount} repos)`);
    }
    const contribStats = getContributions();
    if (contribStats) {
      console.log(
        `  contribs   : ${contribStats.total}  (${contribStats.weeks.length} weeks)`,
      );
    }
    console.log(
      `  banner     : ${BANNER.WORDS.join(' / ')}  ` +
        `(${BANNER_COLS} × ${BANNER_ROWS.length} 点阵 · ${BANNER_CELLS} 个 ▩)`,
    );
    console.log(`  lines      : ${plan.lineCount}`);
    console.log(`  chars      : ${plan.charCount}`);
    console.log(`  canvas     : ${plan.width} × ${plan.height}`);
    console.log(`  typing     : ${seconds(plan.typeEnd)}`);
    console.log(`  cursor     : ${seconds(plan.cursor.delay)} 起闪`);
    console.log(`  total      : ${plan.total}ms  (${seconds(plan.total)})`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}

/** 日志里优先显示相对路径；在项目目录之外则显示绝对路径 */
function displayPath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

if (require.main === module) {
  main();
}

module.exports = {
  render,
  build,
  parseLines,
  layout,
  compileTimeline,
  emitSvg,
  getFont,
  TIME,
  LAYOUT,
  DOCUMENT_TITLE,
  DOCUMENT_TAGLINE,
  SHELL,
  BANNER,
  FONT,
  THEMES,
  COLOR,
  SAMPLE_MARKDOWN,
};
