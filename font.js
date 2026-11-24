/**
 * font.js — 纯 Node（无第三方依赖）的 TrueType 字体工具。
 *
 * 只做两件事：
 *   1. 读取 hhea / head / maxp / hmtx / cmap / loca / glyf，提供每个字符的 advance width；
 *   2. 把源字体裁剪成一个只包含指定字符的子集字体（Buffer），
 *      以便以 base64 data URI 内嵌进 SVG，保持"单文件、无外部资源"。
 *
 * 子集化说明：
 *   · 保留 .notdef 与所有被引用到的复合字形；
 *   · 丢弃 gvar / HVAR / fvar / avar / MVAR / STAT（可变轴）→ 静态 400 字重；
 *   · 丢弃 GSUB / GPOS / GDEF / BASE / kern（本项目的字符是逐个绝对定位的，不用连字和 kerning）；
 *   · 重建 cmap(format 4) / glyf / loca(long) / hmtx / hhea / maxp / post(v3)，
 *     其余 (name / OS/2 / prep / gasp) 原样复制；
 *   · 重新计算表校验和与 head.checkSumAdjustment。
 *
 * 局限：子集中只包含 BMP 字符；JetBrains Mono 不含 CJK 字形，缺字时由浏览器回退。
 */

'use strict';

const fs = require('node:fs');

/* ══════════════════════════════════════════════════════════════════
   1. sfnt 基础读取
   ══════════════════════════════════════════════════════════════════ */

function readTableDirectory(buf) {
  const numTables = buf.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const tag = buf.toString('ascii', record, record + 4);
    tables.set(tag, {
      offset: buf.readUInt32BE(record + 8),
      length: buf.readUInt32BE(record + 12),
    });
  }
  return tables;
}

function tableSlice(buf, tables, tag) {
  const entry = tables.get(tag);
  if (!entry) return null;
  return buf.subarray(entry.offset, entry.offset + entry.length);
}

/* ══════════════════════════════════════════════════════════════════
   2. 字形映射（cmap）与 advance width（hmtx）
   ══════════════════════════════════════════════════════════════════ */

function pickCmapSubtable(cmap) {
  const numTables = cmap.readUInt16BE(2);
  let fallback = null;
  let best = null;

  for (let i = 0; i < numTables; i++) {
    const record = 4 + i * 8;
    const platform = cmap.readUInt16BE(record);
    const encoding = cmap.readUInt16BE(record + 2);
    const offset = cmap.readUInt32BE(record + 4);
    const format = cmap.readUInt16BE(offset);

    if ((platform === 3 && encoding === 10) || (platform === 0 && (encoding === 4 || encoding === 6))) {
      if (format === 12) { best = { offset, format }; break; }
    }
    if (platform === 3 && encoding === 1 && format === 4) fallback = { offset, format };
    if (platform === 0 && encoding === 3 && format === 4 && !fallback) fallback = { offset, format };
  }

  return best || fallback;
}

function lookupFormat4(cmap, offset, codepoint) {
  if (codepoint > 0xffff) return 0;
  const segCountX2 = cmap.readUInt16BE(offset + 6);
  const segCount = segCountX2 / 2;
  const endCode = offset + 14;
  const startCode = endCode + segCountX2 + 2;
  const idDelta = startCode + segCountX2;
  const idRangeOffset = idDelta + segCountX2;

  for (let i = 0; i < segCount; i++) {
    const end = cmap.readUInt16BE(endCode + i * 2);
    if (codepoint > end) continue;

    const start = cmap.readUInt16BE(startCode + i * 2);
    if (codepoint < start) return 0;

    const delta = cmap.readInt16BE(idDelta + i * 2);
    const rangeOffset = cmap.readUInt16BE(idRangeOffset + i * 2);
    if (rangeOffset === 0) return (codepoint + delta) & 0xffff;

    const glyphOffset = idRangeOffset + i * 2 + rangeOffset + (codepoint - start) * 2;
    const glyph = cmap.readUInt16BE(glyphOffset);
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
  }
  return 0;
}

function lookupFormat12(cmap, offset, codepoint) {
  const numGroups = cmap.readUInt32BE(offset + 12);
  let lo = 0;
  let hi = numGroups - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const group = offset + 16 + mid * 12;
    const start = cmap.readUInt32BE(group);
    const end = cmap.readUInt32BE(group + 4);
    if (codepoint < start) hi = mid - 1;
    else if (codepoint > end) lo = mid + 1;
    else return cmap.readUInt32BE(group + 8) + (codepoint - start);
  }
  return 0;
}

/* ══════════════════════════════════════════════════════════════════
   3. loadFont —— 对外只暴露排版需要的 metrics
   ══════════════════════════════════════════════════════════════════ */

/**
 * @param {string} fontPath
 */
function loadFont(fontPath) {
  const buf = fs.readFileSync(fontPath);
  const tables = readTableDirectory(buf);

  const head = tableSlice(buf, tables, 'head');
  const hhea = tableSlice(buf, tables, 'hhea');
  const maxp = tableSlice(buf, tables, 'maxp');
  const hmtx = tableSlice(buf, tables, 'hmtx');
  const cmap = tableSlice(buf, tables, 'cmap');
  const loca = tableSlice(buf, tables, 'loca');
  const glyf = tableSlice(buf, tables, 'glyf');

  if (!head || !hhea || !maxp || !hmtx || !cmap || !loca || !glyf) {
    throw new Error(`字体缺少必要表: ${fontPath}`);
  }

  const unitsPerEm = head.readUInt16BE(18);
  const indexToLocFormat = head.readInt16BE(50);
  const numGlyphs = maxp.readUInt16BE(4);
  const numberOfHMetrics = hhea.readUInt16BE(34);
  const cmapSubtable = pickCmapSubtable(cmap);

  if (!cmapSubtable) throw new Error(`字体没有可用的 cmap: ${fontPath}`);

  const locaOffset = (glyphId) =>
    indexToLocFormat === 1 ? loca.readUInt32BE(glyphId * 4) : loca.readUInt16BE(glyphId * 2) * 2;

  const glyphForCodepoint = (codepoint) =>
    cmapSubtable.format === 12
      ? lookupFormat12(cmap, cmapSubtable.offset, codepoint)
      : lookupFormat4(cmap, cmapSubtable.offset, codepoint);

  const advanceOfGlyph = (glyphId) =>
    hmtx.readUInt16BE(Math.min(glyphId, numberOfHMetrics - 1) * 4);

  const lsbOfGlyph = (glyphId) => {
    if (glyphId < numberOfHMetrics) return hmtx.readInt16BE(glyphId * 4 + 2);
    const start = numberOfHMetrics * 4;
    return hmtx.readInt16BE(start + (glyphId - numberOfHMetrics) * 2);
  };

  const advanceCache = new Map();

  /** 字符宽度（font units）；字体缺该字符时返回 null */
  function advanceForCodepoint(codepoint) {
    if (advanceCache.has(codepoint)) return advanceCache.get(codepoint);
    const glyphId = glyphForCodepoint(codepoint);
    const advance = glyphId ? advanceOfGlyph(glyphId) : null;
    advanceCache.set(codepoint, advance);
    return advance;
  }

  const font = {
    path: fontPath,
    buffer: buf,
    tables,
    unitsPerEm,
    ascender: hhea.readInt16BE(4),
    descender: hhea.readInt16BE(6),
    lineGap: hhea.readInt16BE(8),
    numGlyphs,
    hasCodepoint: (codepoint) => glyphForCodepoint(codepoint) !== 0,
    advanceForCodepoint,
    glyphForCodepoint,
    locaOffset,
    advanceOfGlyph,
    lsbOfGlyph,
    loca,
    glyf,
    head,
    hhea,
    maxp,
    hmtx,
    cmap,
    name: tableSlice(buf, tables, 'name'),
    os2: tableSlice(buf, tables, 'OS/2'),
    post: tableSlice(buf, tables, 'post'),
    cvt: tableSlice(buf, tables, 'cvt '),
    fpgm: tableSlice(buf, tables, 'fpgm'),
    prep: tableSlice(buf, tables, 'prep'),
    gasp: tableSlice(buf, tables, 'gasp'),
  };

  font.subset = (codepoints) => subsetFont(font, codepoints);
  return font;
}

/* ══════════════════════════════════════════════════════════════════
   4. 复合字形
   ══════════════════════════════════════════════════════════════════ */

/** @returns {{data: Buffer|null, numberOfContours:number}} */
function glyphData(font, glyphId) {
  const start = font.locaOffset(glyphId);
  const end = font.locaOffset(glyphId + 1);
  if (end <= start) return { data: null, numberOfContours: 0 };
  const data = font.glyf.subarray(start, end);
  return { data, numberOfContours: data.readInt16BE(0) };
}

/** 复合字形引用的 component glyph id 列表 */
function componentGlyphs(font, glyphId) {
  const { data, numberOfContours } = glyphData(font, glyphId);
  if (!data || numberOfContours >= 0) return [];

  const gids = [];
  let offset = 10;
  let more = true;
  while (more) {
    const flags = data.readUInt16BE(offset);
    gids.push(data.readUInt16BE(offset + 2));
    offset += 4;
    offset += flags & 0x0001 ? 4 : 2; // ARG_1_AND_2_ARE_WORDS
    if (flags & 0x0008) offset += 2; // WE_HAVE_A_SCALE
    else if (flags & 0x0040) offset += 4; // WE_HAVE_AN_X_AND_Y_SCALE
    else if (flags & 0x0080) offset += 8; // WE_HAVE_A_TWO_BY_TWO
    more = Boolean(flags & 0x0020); // MORE_COMPONENTS
  }
  return gids;
}

function patchCompositeGlyph(data, glyphIdMap) {
  const out = Buffer.from(data);
  let offset = 10;
  let more = true;
  while (more) {
    const flags = out.readUInt16BE(offset);
    const oldGlyphId = out.readUInt16BE(offset + 2);
    const newGlyphId = glyphIdMap.get(oldGlyphId);
    if (newGlyphId === undefined) {
      throw new Error(`复合字形引用了未收录的字形 ${oldGlyphId}`);
    }
    out.writeUInt16BE(newGlyphId, offset + 2);
    offset += 4;
    offset += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) offset += 2;
    else if (flags & 0x0040) offset += 4;
    else if (flags & 0x0080) offset += 8;
    more = Boolean(flags & 0x0020);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   5. 子集构建
   ══════════════════════════════════════════════════════════════════ */

function subsetFont(font, codepoints) {
  // 1) 收集需要的字形（BMP only）
  const codepointToGlyph = new Map();
  for (const codepoint of codepoints) {
    if (codepoint > 0xffff) continue;
    const glyphId = font.glyphForCodepoint(codepoint);
    if (glyphId) codepointToGlyph.set(codepoint, glyphId);
  }

  // 2) 复合字形闭包 + .notdef
  const included = new Set([0, ...codepointToGlyph.values()]);
  const queue = [...included];
  while (queue.length) {
    const glyphId = queue.pop();
    for (const component of componentGlyphs(font, glyphId)) {
      if (!included.has(component)) {
        included.add(component);
        queue.push(component);
      }
    }
  }

  // 3) 新字形顺序 / id 映射
  const glyphOrder = [...included].sort((a, b) => a - b);
  const glyphIdMap = new Map(glyphOrder.map((oldId, newId) => [oldId, newId]));
  const numGlyphs = glyphOrder.length;

  // 4) glyf + loca（long format，4 字节对齐）
  const glyphBuffers = [];
  const locaOffsets = [];
  let glyfLength = 0;

  for (const glyphId of glyphOrder) {
    locaOffsets.push(glyfLength);
    const { data, numberOfContours } = glyphData(font, glyphId);
    let glyph = data ? Buffer.from(data) : Buffer.alloc(0);
    if (data && numberOfContours < 0) glyph = patchCompositeGlyph(glyph, glyphIdMap);

    const padded = Buffer.alloc(Math.ceil(glyph.length / 4) * 4);
    glyph.copy(padded);
    glyphBuffers.push(padded);
    glyfLength += padded.length;
  }
  locaOffsets.push(glyfLength);

  const glyf = Buffer.concat(glyphBuffers, glyfLength);
  const loca = Buffer.alloc((numGlyphs + 1) * 4);
  locaOffsets.forEach((offset, i) => loca.writeUInt32BE(offset, i * 4));

  // 5) hmtx
  const hmtx = Buffer.alloc(numGlyphs * 4);
  glyphOrder.forEach((glyphId, newId) => {
    hmtx.writeUInt16BE(font.advanceOfGlyph(glyphId), newId * 4);
    hmtx.writeInt16BE(font.lsbOfGlyph(glyphId), newId * 4 + 2);
  });

  // 6) cmap（format 4，一个字符一个 segment）
  const cmap = buildCmapFormat4(codepointToGlyph, glyphIdMap);

  // 7) head / hhea / maxp
  const head = Buffer.from(font.head);
  head.writeUInt32BE(0, 8); // checkSumAdjustment 由 assemble 回填
  head.writeInt16BE(1, 50); // indexToLocFormat = long

  const hhea = Buffer.from(font.hhea);
  hhea.writeUInt16BE(numGlyphs, 34); // numberOfHMetrics

  const maxp = Buffer.from(font.maxp);
  maxp.writeUInt16BE(numGlyphs, 4);

  // 8) OS/2：更新首/末字符
  let os2 = null;
  if (font.os2) {
    os2 = Buffer.from(font.os2);
    const codepointsSorted = [...codepointToGlyph.keys()].sort((a, b) => a - b);
    const first = codepointsSorted.length ? codepointsSorted[0] : 0xffff;
    const last = codepointsSorted.length ? codepointsSorted[codepointsSorted.length - 1] : 0xffff;
    if (os2.length >= 68) {
      os2.writeUInt16BE(first, 64);
      os2.writeUInt16BE(last, 66);
    }
  }

  // 9) post：版本 3（不含字形名），只保留下划线信息
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);
  if (font.post && font.post.length >= 12) {
    font.post.copy(post, 4, 4, 12);
  }

  const subsetTables = new Map();
  subsetTables.set('cmap', cmap);
  subsetTables.set('glyf', glyf);
  subsetTables.set('head', head);
  subsetTables.set('hhea', hhea);
  subsetTables.set('hmtx', hmtx);
  subsetTables.set('loca', loca);
  subsetTables.set('maxp', maxp);
  subsetTables.set('post', post);
  if (font.name) subsetTables.set('name', Buffer.from(font.name));
  if (os2) subsetTables.set('OS/2', os2);
  if (font.cvt) subsetTables.set('cvt ', Buffer.from(font.cvt));
  if (font.fpgm) subsetTables.set('fpgm', Buffer.from(font.fpgm));
  if (font.prep) subsetTables.set('prep', Buffer.from(font.prep));
  if (font.gasp) subsetTables.set('gasp', Buffer.from(font.gasp));

  return assembleSfnt(subsetTables);
}

function buildCmapFormat4(codepointToGlyph, glyphIdMap) {
  const entries = [...codepointToGlyph.entries()]
    .map(([codepoint, oldGlyphId]) => ({ codepoint, glyphId: glyphIdMap.get(oldGlyphId) }))
    .filter((entry) => entry.codepoint < 0xffff)
    .sort((a, b) => a.codepoint - b.codepoint);

  const segCount = entries.length + 1; // + 0xFFFF 哨兵
  const length = 16 + segCount * 8;
  const subtable = Buffer.alloc(length);

  subtable.writeUInt16BE(4, 0);
  subtable.writeUInt16BE(length, 2);
  subtable.writeUInt16BE(0, 4); // language
  subtable.writeUInt16BE(segCount * 2, 6);

  const power = 2 ** Math.floor(Math.log2(segCount));
  subtable.writeUInt16BE(power * 2, 8); // searchRange
  subtable.writeUInt16BE(Math.log2(power), 10); // entrySelector
  subtable.writeUInt16BE(segCount * 2 - power * 2, 12); // rangeShift

  const endCode = 14;
  const reservedPad = endCode + segCount * 2;
  const startCode = reservedPad + 2;
  const idDelta = startCode + segCount * 2;
  const idRangeOffset = idDelta + segCount * 2;

  entries.forEach((entry, i) => {
    subtable.writeUInt16BE(entry.codepoint, endCode + i * 2);
    subtable.writeUInt16BE(entry.codepoint, startCode + i * 2);
    subtable.writeUInt16BE((entry.glyphId - entry.codepoint) & 0xffff, idDelta + i * 2);
    subtable.writeUInt16BE(0, idRangeOffset + i * 2);
  });

  const sentinel = segCount - 1;
  subtable.writeUInt16BE(0xffff, endCode + sentinel * 2);
  subtable.writeUInt16BE(0xffff, startCode + sentinel * 2);
  subtable.writeUInt16BE(1, idDelta + sentinel * 2); // 0xFFFF -> 0
  subtable.writeUInt16BE(0, idRangeOffset + sentinel * 2);

  const cmap = Buffer.alloc(12 + length);
  cmap.writeUInt16BE(0, 0); // version
  cmap.writeUInt16BE(1, 2); // numTables
  cmap.writeUInt16BE(3, 4); // platform = Microsoft
  cmap.writeUInt16BE(1, 6); // encoding = Unicode BMP
  cmap.writeUInt32BE(12, 8); // offset
  subtable.copy(cmap, 12);
  return cmap;
}

/* ══════════════════════════════════════════════════════════════════
   6. sfnt 组装 + 校验和
   ══════════════════════════════════════════════════════════════════ */

function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const word =
      ((buf[i] || 0) << 24) |
      ((buf[i + 1] || 0) << 16) |
      ((buf[i + 2] || 0) << 8) |
      (buf[i + 3] || 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

function assembleSfnt(tables) {
  const tags = [...tables.keys()].sort();
  const numTables = tags.length;
  const headerSize = 12 + numTables * 16;

  let offset = headerSize;
  const records = tags.map((tag) => {
    const data = tables.get(tag);
    const paddedLength = Math.ceil(data.length / 4) * 4;
    const padded = Buffer.alloc(paddedLength);
    data.copy(padded);

    const record = {
      tag,
      data: padded,
      length: data.length,
      offset,
      checksum: checksum(padded),
    };
    offset += paddedLength;
    return record;
  });

  const font = Buffer.alloc(offset);
  font.writeUInt32BE(0x00010000, 0);
  font.writeUInt16BE(numTables, 4);

  const power = 2 ** Math.floor(Math.log2(numTables));
  font.writeUInt16BE(power * 16, 6);
  font.writeUInt16BE(Math.log2(power), 8);
  font.writeUInt16BE(numTables * 16 - power * 16, 10);

  records.forEach((record, i) => {
    const recordOffset = 12 + i * 16;
    font.write(record.tag, recordOffset, 4, 'ascii');
    font.writeUInt32BE(record.checksum, recordOffset + 4);
    font.writeUInt32BE(record.offset, recordOffset + 8);
    font.writeUInt32BE(record.length, recordOffset + 12);
    record.data.copy(font, record.offset);
  });

  const headRecord = records.find((record) => record.tag === 'head');
  if (headRecord) {
    const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
    font.writeUInt32BE(adjustment, headRecord.offset + 8);
  }

  return font;
}

module.exports = {
  loadFont,
  subsetFont,
};
