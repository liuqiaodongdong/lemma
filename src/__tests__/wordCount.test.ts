import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_WORD_COUNT_STATS,
  computeMarkdownWordStats,
  computeProseMirrorSelectionWordStats,
} from '../utils/wordCount';
import type { WordCountStats } from '../types/contract';
import { WordCountBar } from '../components/shell/WordCountBar';
import { createLemmaSchema, parseMarkdownToPmNode } from '../editor';
import { App } from '../App';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface NodeFsSubset {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: 'utf8') => string;
}

async function loadNodeFs(): Promise<NodeFsSubset> {
  const modId = 'node:fs';
  return (await import(/* @vite-ignore */ modId)) as unknown as NodeFsSubset;
}

const REAL_NOTE_PATH =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.LEMMA_BENCH_MD ?? '';

describe('Academic Word Count Engine (Markdown & ProseMirror Selection)', () => {
  const schema = createLemmaSchema();

  it('1. returns zeroed stats for empty or whitespace/structural-only documents', () => {
    expect(computeMarkdownWordStats('')).toEqual(EMPTY_WORD_COUNT_STATS);
    expect(
      computeMarkdownWordStats(
        '   \n\n---\n\n<!-- 纯注释 -->\n\n```svg\n<svg><path d="M 0 0 L 10 20"/></svg>\n```\n'
      )
    ).toEqual(EMPTY_WORD_COUNT_STATS);
  });

  it('2. counts mixed Chinese + English + hyphenated/decimal academic Economics text accurately (Word / Typora standard)', () => {
    const sample = '本文基于 2018-2024 年 System-1 专利数据检验 DID 模型';
    const stats = computeMarkdownWordStats(sample);

    // CJK characters: 本 文 基 于 年 专 利 数 据 检 验 模 型 = 13
    expect(stats.cjkChars).toBe(13);
    // Latin/numeric words: "2018-2024", "System-1", "DID" = 3
    expect(stats.latinWords).toBe(3);
    // Total words = 13 + 3 = 16
    expect(stats.totalWords).toBe(16);
    expect(stats.paragraphs).toBe(1);
    expect(stats.mathCount).toBe(0);
    expect(stats.readingMinutes).toBe(1);
    // Non-space chars: 13 CJK + 9 ("2018-2024") + 8 ("System-1") + 3 ("DID") = 33
    expect(stats.charsNoSpaces).toBe(33);
    // 6 internal single spaces -> 33 + 6 = 39
    expect(stats.charsWithSpaces).toBe(39);

    // Decimals, contractions, thousands separators, accented names, and model identifiers each count as 1 word
    const tokensSample = "BERT Jev 2026 0.05 don't 4,731 Itô's Bénabou";
    const tokenStats = computeMarkdownWordStats(tokensSample);
    expect(tokenStats.cjkChars).toBe(0);
    expect(tokenStats.latinWords).toBe(8);
    expect(tokenStats.totalWords).toBe(8);

    // Surrogate-pair CJK Extension B ideograph (`𠮷` U+20BB7) counts as 1 CJK char and 1 non-space char
    const extBSample = '𠮷野家样本';
    const extBStats = computeMarkdownWordStats(extBSample);
    expect(extBStats.cjkChars).toBe(5);
    expect(extBStats.charsNoSpaces).toBe(5);

    // Cross-mark hyphenation (`System-**1**`) stays 1 word in both Markdown and ProseMirror,
    // while double-dot range (`1..10`) counts as 2 numeric tokens
    expect(computeMarkdownWordStats('System-**1** vs 1..10').latinWords).toBe(4);
    const markedDoc = parseMarkdownToPmNode('System-**1**', schema);
    expect(
      computeProseMirrorSelectionWordStats(markedDoc, 0, markedDoc.content.size)
        ?.latinWords
    ).toBe(1);

    // UTF-8 BOM at start of file does not leak `#` heading marker into charsNoSpaces
    const bomHeading = computeMarkdownWordStats('\uFEFF# 一、引言\n\n实证检验');
    expect(bomHeading.cjkChars).toBe(7); // 一引言(3) + 实证检验(4)
    expect(bomHeading.charsNoSpaces).toBe(8); // 一、引言(4) + 实证检验(4)
    expect(bomHeading.paragraphs).toBe(2);
  });

  it('3. excludes advisor <span data-comment="..."> attributes and CriticMarkup {>>...<<} comments 100% while preserving highlighted/anchored body text', () => {
    const annotatedMd = [
      '<span data-comment="这段逻辑不对 > 建议重写两百字并补充 $R^2$ 检验..." data-id="c-1" data-time="2026-11-15 20:00">基准回归显著</span>',
      '{==核心结论==}{>>老师批注：此处 p < 0.05 需要稳健标准误<<}',
      '<mark data-color="green">稳健性</mark>',
      '==安慰剂检验==',
    ].join('\n\n');

    const stats = computeMarkdownWordStats(annotatedMd);

    // Body CJK only: 基准回归显著 (6) + 核心结论 (4) + 稳健性 (3) + 安慰剂检验 (5) = 18
    expect(stats.cjkChars).toBe(18);
    // Zero words or math leaked from advisor comments (`c-1`, `2026-11-15`, `p`, `0.05`, `$R^2$`, `green`)
    expect(stats.latinWords).toBe(0);
    expect(stats.totalWords).toBe(18);
    expect(stats.mathCount).toBe(0);
    expect(stats.paragraphs).toBe(4);
    expect(stats.charsNoSpaces).toBe(18);
    expect(stats.charsWithSpaces).toBe(18);
  });

  it('4. counts inline/display/AI LaTeX formulas in mathCount without polluting latinWords, and strips SVG blocks, images, link URLs, callouts, and GFM table pipes', () => {
    const complexAcademicMd = [
      '# 一、跨期消费欧拉方程',
      '',
      '> [!IMPORTANT]',
      '> 家庭最大化效用函数 $u(c) = \\frac{c^{1-\\sigma}}{1-\\sigma}$，参见 [Acemoglu (2024)](https://doi.org/10.1257/aer.2024.0001)。',
      '',
      '$$',
      'Y_t = A_t K_t^\\alpha L_t^{1-\\alpha}',
      '$$',
      '',
      '```svg',
      '<svg viewBox="0 0 400 300"><path d="M 10 20 L 30 40 C 50 60 70 80 90 100" /><text>均衡点 E0</text></svg>',
      '```',
      '',
      '<svg width="200" height="100">',
      '  <line x1="0" y1="0" x2="200" y2="100" />',
      '</svg>',
      '',
      '![脉冲响应图](./assets/irf_2026_plot.png)',
      '',
      '| 变量 | 系数 |',
      '| :--- | :---: |',
      '| 处理效应 | 0.086 |',
    ].join('\n');

    const stats = computeMarkdownWordStats(complexAcademicMd);

    // Exactly 2 math formulas: 1 inline `$u(c)...$` + 1 display `$$Y_t...$$`
    expect(stats.mathCount).toBe(2);

    // Verify LaTeX commands (\frac, \sigma, \alpha), SVG coordinates (400, 300, 10, 20...),
    // image path (irf_2026_plot), link URL (10.1257/aer.2024.0001), and [!IMPORTANT] did NOT leak:
    // Remaining Latin/numeric tokens: "Acemoglu" (1), "2024" (1), "0.086" (1) => 3!
    expect(stats.latinWords).toBe(3);

    // CJK check:
    // 一跨期消费欧拉方程 (9)
    // 家庭最大化效用函数 + 参见 (9 + 2 = 11)
    // 变量 + 系数 (2 + 2 = 4)
    // 处理效应 (4)
    // Total CJK = 9 + 11 + 4 + 4 = 28
    expect(stats.cjkChars).toBe(28);
    expect(stats.totalWords).toBe(31);
    // Paragraphs: H1 line (1) + callout body line (1) + table header row (1) + table data row (1) = 4
    expect(stats.paragraphs).toBe(4);
  });

  it('5. supports AI math delimiters (\\[...\\] & \\(...\\)), avoids currency false-positives ($50 to $100), and ignores $ / HTML inside code', () => {
    const md = [
      '模型采用 `Prefill-Only` 并在 `</opt>` 锚点读出（`output_tokens = 0`，不触发 `$PATH`）：',
      '',
      '\\[',
      '\\widehat{\\theta} = (X^\\prime X)^{-1} X^\\prime Y',
      '\\]',
      '',
      '其中渐近方差满足 \\( \\sqrt{n}(\\hat{\\theta} - \\theta_0) \\xrightarrow{d} \\mathcal{N}(0, \\Omega) \\)。',
      '',
      'Subsidy rose from $50 to $100 per household.',
      '',
      '```python',
      'def run_ols(x, y):',
      '    # $not_math$ and <tag>',
      '    return x @ y',
      '```',
    ].join('\n');

    const stats = computeMarkdownWordStats(md);
    // Only `\[...\]` and `\(...\)` count as math (2 total); `$50 to $100`, `$PATH`, and `$not_math$` are NOT math!
    expect(stats.mathCount).toBe(2);
    // CJK: 模型采用(4) + 并在(2) + 锚点读出(4) + 不触发(3) + 其中渐近方差满足(8) = 21
    expect(stats.cjkChars).toBe(21);
    expect(stats.paragraphs).toBe(6); // 3 prose lines + 3 non-empty code lines
  });

  it('6. computes exact ProseMirror partial selection stats across paragraphs, inline math, standalone math, SVG, and images', () => {
    const md = [
      '第一段前缀 **核心结论** 包含公式 $\\alpha + \\beta = 1$ 与 English words。',
      '',
      '```svg',
      '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>',
      '```',
      '',
      '第二段包含 2026 年实证数据 $Y_{it}$ 结尾。',
    ].join('\n');

    const doc = parseMarkdownToPmNode(md, schema);

    // Collapsed or inverted ranges return null
    expect(computeProseMirrorSelectionWordStats(doc, 3, 3)).toBeNull();
    expect(computeProseMirrorSelectionWordStats(doc, 10, 4)).toBeNull();

    // Full document selection in ProseMirror
    const fullSel = computeProseMirrorSelectionWordStats(
      doc,
      0,
      doc.content.size
    );
    expect(fullSel).not.toBeNull();
    expect(fullSel!.mathCount).toBe(2);
    expect(fullSel!.paragraphs).toBe(2); // svgBlock excluded
    expect(fullSel!.latinWords).toBe(3); // "English", "words", "2026"

    // Partial selection starting mid-Paragraph 1 ("核心结论 包含公式 $\alpha+\beta=1$ 与 English words。")
    // across the SVG block into mid-Paragraph 2 ("第二段包含 2026")
    let startPos = -1;
    let endPos = -1;
    let inlineMathPos = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'mathInline' && inlineMathPos === -1) {
        inlineMathPos = pos;
      }
      if (node.isText && node.text) {
        const idx1 = node.text.indexOf('核心结论');
        if (idx1 !== -1 && startPos === -1) {
          startPos = pos + idx1;
        }
        const idx2 = node.text.indexOf('2026');
        if (idx2 !== -1) {
          endPos = pos + idx2 + '2026'.length;
        }
      }
      return true;
    });

    expect(startPos).toBeGreaterThan(0);
    expect(endPos).toBeGreaterThan(startPos);

    const partialStats = computeProseMirrorSelectionWordStats(
      doc,
      startPos,
      endPos
    );
    expect(partialStats).not.toBeNull();
    // CJK: 核心结论(4) + 包含公式(4) + 与(1) + 第二段包含(5) = 14
    expect(partialStats!.cjkChars).toBe(14);
    // Latin: "English", "words", "2026" = 3
    expect(partialStats!.latinWords).toBe(3);
    expect(partialStats!.totalWords).toBe(17);
    // Only the 1st inline math is inside [startPos, endPos]; $Y_{it}$ is after "2026"!
    expect(partialStats!.mathCount).toBe(1);
    expect(partialStats!.paragraphs).toBe(2);

    // Selecting ONLY a single inline math node returns mathCount=1 (not null!)
    const mathOnlyStats = computeProseMirrorSelectionWordStats(
      doc,
      inlineMathPos,
      inlineMathPos + 1
    );
    expect(mathOnlyStats).not.toBeNull();
    expect(mathOnlyStats!.mathCount).toBe(1);
    expect(mathOnlyStats!.totalWords).toBe(0);
    expect(mathOnlyStats!.readingMinutes).toBe(1);

    // Selecting ONLY the svgBlock returns null
    const svgNodePos = doc.child(0).nodeSize;
    const svgNodeEnd = svgNodePos + doc.child(1).nodeSize;
    expect(doc.child(1).type.name).toBe('svgBlock');
    expect(
      computeProseMirrorSelectionWordStats(doc, svgNodePos, svgNodeEnd)
    ).toBeNull();

    // Selecting a GFM table in ProseMirror matches raw Markdown row paragraphs & cell spaces 1:1
    const tableMd = '| 变量 | 系数 |\n| :--- | :---: |\n| 处理效应 | 0.086 |';
    const tableDoc = parseMarkdownToPmNode(tableMd, schema);
    const mdTableStats = computeMarkdownWordStats(tableMd);
    const pmTableStats = computeProseMirrorSelectionWordStats(
      tableDoc,
      0,
      tableDoc.content.size
    );
    expect(pmTableStats).toEqual(mdTableStats);
  });

  it('7. benchmarks computeMarkdownWordStats on the real 102KB / 257-formula QA note (< 15ms target, expected < 1.5ms)', async () => {
    const fs = await loadNodeFs();
    if (!REAL_NOTE_PATH || !fs.existsSync(REAL_NOTE_PATH)) {
      return;
    }

    const realMd = fs.readFileSync(REAL_NOTE_PATH, 'utf8');
    expect(realMd.length).toBeGreaterThan(50000);

    // Compare mathCount against full ProseMirror AST ground truth
    const pmDoc = parseMarkdownToPmNode(realMd, schema);
    let astMathCount = 0;
    pmDoc.descendants((node) => {
      if (node.type.name === 'mathInline' || node.type.name === 'mathBlock') {
        astMathCount++;
      }
      return true;
    });

    // Warm up JIT
    for (let w = 0; w < 5; w++) {
      computeMarkdownWordStats(realMd);
    }

    // Measure median & average over 30 runs for reliable sub-millisecond timing
    const timings: number[] = [];
    let result = computeMarkdownWordStats(realMd);
    for (let iter = 0; iter < 30; iter++) {
      const t0 = performance.now();
      result = computeMarkdownWordStats(realMd);
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const medianMs = timings[Math.floor(timings.length / 2)];
    const avgMs = timings.reduce((s, v) => s + v, 0) / timings.length;

    console.info(
      `[WordCount Benchmark 102KB Note] median=${medianMs.toFixed(
        3
      )} ms, avg=${avgMs.toFixed(3)} ms | totalWords=${
        result.totalWords
      } (CJK=${result.cjkChars}, Latin=${result.latinWords}), mathCount=${
        result.mathCount
      } (AST=${astMathCount}), paragraphs=${result.paragraphs}, charsNoSpaces=${
        result.charsNoSpaces
      }, charsWithSpaces=${result.charsWithSpaces}, readingMinutes=${
        result.readingMinutes
      }`
    );

    expect(medianMs).toBeLessThan(15);
    expect(result.mathCount).toBe(257);
    expect(result.mathCount).toBe(astMathCount);
    expect(result.totalWords).toBe(result.cjkChars + result.latinWords);
    expect(result.charsWithSpaces).toBeGreaterThanOrEqual(result.charsNoSpaces);
    expect(result.readingMinutes).toBeGreaterThan(30);
  });

  it('8. renders <WordCountBar /> pill & popover (1-col 全文 vs 2-col 已选/全文), preserves editor selection on mouseDown, and closes on Escape / outside click', async () => {
    const docStats: WordCountStats = {
      totalWords: 12480,
      cjkChars: 11200,
      latinWords: 1280,
      charsNoSpaces: 18540,
      charsWithSpaces: 19820,
      paragraphs: 96,
      mathCount: 42,
      readingMinutes: 38,
    };
    const selectionStats: WordCountStats = {
      totalWords: 286,
      cjkChars: 250,
      latinWords: 36,
      charsNoSpaces: 412,
      charsWithSpaces: 448,
      paragraphs: 2,
      mathCount: 3,
      readingMinutes: 1,
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      // 1) Normal full-document pill (`12,480 字`)
      await act(async () => {
        root.render(
          React.createElement(WordCountBar, {
            docStats,
            selectionStats: null,
          })
        );
      });

      const pill = container.querySelector(
        '.lemma-wordcount-pill'
      ) as HTMLButtonElement;
      expect(pill).not.toBeNull();
      expect(pill.classList.contains('has-selection')).toBe(false);
      expect(pill.textContent).toBe('12,480 字');
      expect(container.querySelector('.lemma-wordcount-popover')).toBeNull();

      // 2) Pill mouseDown calls preventDefault() so ProseMirror selection stays intact
      const pillMouseDown = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        pill.dispatchEvent(pillMouseDown);
      });
      expect(pillMouseDown.defaultPrevented).toBe(true);

      // 3) Clicking pill opens 1-column `全文统计` popover with all 7 rows + reading time
      await act(async () => {
        pill.click();
      });

      let popover = container.querySelector(
        '.lemma-wordcount-popover'
      ) as HTMLElement;
      expect(popover).not.toBeNull();
      expect(popover.classList.contains('is-dual')).toBe(false);
      expect(
        popover.querySelector('.lemma-wordcount-scope-badge')?.textContent
      ).toBe('全文统计');
      expect(popover.querySelector('.lemma-wordcount-col-head')).toBeNull();

      const singleRows = Array.from(
        popover.querySelectorAll('.lemma-wordcount-row')
      );
      expect(singleRows).toHaveLength(7);
      const expectedSingleRows: Array<[string, string]> = [
        ['总字数', '12,480'],
        ['中文字符', '11,200'],
        ['英文与数字词', '1,280'],
        ['字符数（不计空格）', '18,540'],
        ['字符数（计空格）', '19,820'],
        ['段落数', '96'],
        ['数学公式', '42'],
      ];
      expectedSingleRows.forEach(([label, val], idx) => {
        expect(singleRows[idx].textContent).toContain(label);
        expect(
          singleRows[idx].querySelector('.lemma-wordcount-row-val')?.textContent
        ).toBe(val);
      });
      expect(
        popover.querySelector('.lemma-wordcount-footer')?.textContent
      ).toContain('预计阅读约 38 分钟');

      // 4) Passing `selectionStats` switches pill to `已选 286 / 12,480 字` and upgrades popover to 2-column `已选 | 全文`
      await act(async () => {
        root.render(
          React.createElement(WordCountBar, {
            docStats,
            selectionStats,
          })
        );
      });

      expect(pill.classList.contains('has-selection')).toBe(true);
      expect(pill.textContent).toBe('已选 286 / 12,480 字');

      popover = container.querySelector(
        '.lemma-wordcount-popover'
      ) as HTMLElement;
      expect(popover.classList.contains('is-dual')).toBe(true);
      expect(
        popover.querySelector('.lemma-wordcount-scope-badge')?.textContent
      ).toBe('当前选中范围');
      const colHead = popover.querySelector('.lemma-wordcount-col-head');
      expect(colHead?.textContent).toContain('已选');
      expect(colHead?.textContent).toContain('全文');

      // Popover mouseDown also calls preventDefault()
      const popMouseDown = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        popover.dispatchEvent(popMouseDown);
      });
      expect(popMouseDown.defaultPrevented).toBe(true);

      const dualRows = Array.from(
        popover.querySelectorAll('.lemma-wordcount-row.is-dual')
      );
      expect(dualRows).toHaveLength(7);
      const expectedDualRows: Array<[string, string, string]> = [
        ['总字数', '286', '12,480'],
        ['中文字符', '250', '11,200'],
        ['英文与数字词', '36', '1,280'],
        ['字符数（不计空格）', '412', '18,540'],
        ['字符数（计空格）', '448', '19,820'],
        ['段落数', '2', '96'],
        ['数学公式', '3', '42'],
      ];
      expectedDualRows.forEach(([label, selVal, docVal], idx) => {
        expect(dualRows[idx].textContent).toContain(label);
        expect(
          dualRows[idx].querySelector('.is-sel-val')?.textContent
        ).toBe(selVal);
        expect(
          dualRows[idx].querySelector('.is-doc-val')?.textContent
        ).toBe(docVal);
      });
      expect(
        popover.querySelector('.lemma-wordcount-footer')?.textContent
      ).toContain('预计阅读约 1 分钟');

      // 5) Escape key closes popover cleanly
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      expect(container.querySelector('.lemma-wordcount-popover')).toBeNull();

      // 6) Re-open and close via outside mousedown
      await act(async () => {
        pill.click();
      });
      expect(container.querySelector('.lemma-wordcount-popover')).not.toBeNull();

      await act(async () => {
        document.body.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true })
        );
      });
      expect(container.querySelector('.lemma-wordcount-popover')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('9. integrates deferred Frame-1 word count, live ProseMirror selection stats, Source Mode selection reset, and Ctrl+N reset in <App />', async () => {
    vi.useFakeTimers();

    const bootMd =
      '# 实证结果\n\n本文基于 2018-2024 年 System-1 专利数据检验 $Y_{it} = \\beta D_{it}$ 模型。';
    const expectedFull = computeMarkdownWordStats(bootMd);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      // 1) Frame 1 mounts immediately with 0ms sync word-count overhead (deferred via 16ms timer)
      await act(async () => {
        root.render(
          React.createElement(App, {
            initialBootDoc: {
              path: '/demo/wordcount-integration.md',
              content: bootMd,
              sha256: 'wc-sha-1',
              modifiedMs: 1000,
            },
            bootResolved: true,
          })
        );
      });

      const pill = container.querySelector(
        '.lemma-wordcount-pill'
      ) as HTMLButtonElement;
      expect(pill).not.toBeNull();
      expect(pill.textContent).toBe('0 字');

      // Advance 20ms -> off-Frame-1 full-document word count populates
      await act(async () => {
        vi.advanceTimersByTime(20);
      });
      expect(pill.textContent).toBe(`${expectedFull.totalWords} 字`);

      // 2) Select all inside ProseMirror (Ctrl+A) -> pill switches to `已选 N / N 字`
      const pmEl = container.querySelector('.ProseMirror') as HTMLElement;
      expect(pmEl).not.toBeNull();
      await act(async () => {
        pmEl.focus();
        pmEl.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });

      expect(pill.classList.contains('has-selection')).toBe(true);
      expect(pill.textContent).toBe(
        `已选 ${expectedFull.totalWords} / ${expectedFull.totalWords} 字`
      );

      // 3) Toggle to Source Mode (`Ctrl+/`) -> stale ProseMirror selection clears immediately
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '/',
            code: 'Slash',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(pill.classList.contains('has-selection')).toBe(false);
      expect(pill.textContent).toBe(`${expectedFull.totalWords} 字`);

      // 4) Switch back to WYSIWYG (`Ctrl+/`), re-select (`Ctrl+A`), then trigger New Document (`Ctrl+N`) -> resets selection & updates count
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '/',
            code: 'Slash',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      await act(async () => {
        pmEl.focus();
        pmEl.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(pill.classList.contains('has-selection')).toBe(true);

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'n',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      await act(async () => {
        vi.advanceTimersByTime(25);
      });

      expect(pill.classList.contains('has-selection')).toBe(false);
      // `# 未命名文稿\n\n` has 5 CJK characters
      expect(pill.textContent).toBe('5 字');
    } finally {
      vi.useRealTimers();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
