import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';

interface NodeFsSubset {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: 'utf8') => string;
}

async function loadNodeFs(): Promise<NodeFsSubset> {
  const modId = 'node:fs';
  return (await import(/* @vite-ignore */ modId)) as unknown as NodeFsSubset;
}
import {
  LemmaEditor,
  SYNC_MATH_BUDGET_PER_BURST,
  createLemmaExtensions,
  createParseContext,
  parseMarkdownChunkToBlocks,
  parseMarkdownToDocJson,
  parseMarkdownToPmNode,
  serializeDocToMarkdown,
  splitMarkdownForProgressiveLoad,
  type LemmaEditorHandle,
} from '../editor';
import {
  beginHydrationSliceMount,
  endHydrationSliceMount,
  getPendingDeferredMathCount,
  isHydrationActive,
  resetMathSchedulerForTests,
} from '../editor/extensions/mathViewportScheduler';
import { tauriBridge } from '../services/tauriBridge';
import { App } from '../App';
import type { OutlineHeading } from '../types/contract';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const REAL_NOTE_PATH =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.LEMMA_BENCH_MD ?? '';

const noopResolveAssetUrl = (rawSrc: string) => rawSrc;

/**
 * Builds a ~34 KB synthetic academic torture Markdown document exercising every
 * tricky multi-line block construct across chunk boundaries.
 */
function buildSyntheticTortureMarkdown(): string {
  const sections: string[] = [
    '# 渐进式水合与跨块边界等价性压力测试手稿',
    '',
    '> [!IMPORTANT]',
    '> 本文档用于验证 `splitMarkdownForProgressiveLoad` 在代码块、多行公式、松散列表、引用块、三线表、SVG 与行内批注下的 **100% AST 等价性**。',
    '',
  ];

  for (let s = 1; s <= 14; s++) {
    sections.push(`## 第 ${s} 节：动态随机一般均衡与校准推断 ($\\theta_${s}$)`);
    sections.push('');
    sections.push(
      `在本节中，我们考察代表性企业 $i$ 在第 $t$ 期的投资决策 $I_{i,t} = \\alpha_${s} K_{i,t} + \\beta_${s} Q_{i,t}$。` +
        `其中 <mark data-color="green">边际托宾 Q</mark> 满足欧拉方程，且 {==样本外校准误差显著下降==}{>>第 ${s} 节自动编号批注<<}，` +
        `同时包含无显式 ID 的 <span data-comment="AI 审稿意见 ${s}">内生性讨论锚点</span>。`
    );
    sections.push('');
    sections.push('$$');
    sections.push('\\begin{aligned}');
    sections.push(
      `\\mathcal{L}_${s} &= \\sum_{t=0}^{\\infty} \\beta^t \\left[ \\frac{C_t^{1-\\sigma}}{1-\\sigma} - \\chi \\frac{N_t^{1+\\varphi}}{1+\\varphi} \\right] \\\\[4pt]`
    );
    sections.push('');
    sections.push(
      `\\text{s.t. } K_{t+1} &= (1 - \\delta) K_t + I_t - \\frac{\\phi}{2}\\left(\\frac{I_t}{K_t} - \\delta\\right)^2 K_t`
    );
    sections.push('\\end{aligned}');
    sections.push('$$');
    sections.push('');
    sections.push('\\[');
    sections.push(`\\widehat{\\text{ECE}}_${s} = \\sum_{m=1}^{M} \\frac{|B_m|}{n} |\\bar{y}_m - \\bar{p}_m|`);
    sections.push('');
    sections.push(`\\text{Brier}_${s} = \\frac{1}{n} \\sum_{i=1}^n (\\hat{p}_i - y_i)^2`);
    sections.push('\\]');
    sections.push('');
    sections.push(
      `- 松散列表第一项（第 ${s} 节）：包含行内代码 \`<!-- not an html block\` 与 \`\\[ not math\`；`
    );
    sections.push('');
    sections.push(
      `  同一列表项的缩进续段，包含行内公式 $\\mathbb{E}[u_{i,t} \\mid X_{i,t}] = 0$。`
    );
    sections.push('');
    sections.push(
      `- 松散列表第二项：验证空行后紧跟 \`- \` 绝不能被切分为两个独立的 \`bulletList\`！`
    );
    sections.push('');
    sections.push('```python');
    sections.push(`# 第 ${s} 节代码块（内部故意包含空行与顶格伪标题）`);
    sections.push('def estimate_ppi_rectifier(x, y_hat, y_true):');
    sections.push('');
    sections.push('# 顶格伪标题不应触发切分');
    sections.push('---');
    sections.push(`    return (x.T @ (y_hat - y_true)) / len(y_true)  # sec ${s}`);
    sections.push('```');
    sections.push('');
    sections.push('| 模型设定 | 估计系数 | 稳健标准误 | 校准误差 |');
    sections.push('| :--- | :---: | :---: | ---: |');
    sections.push(
      `| 基准模型 (${s}) | $0.${10 + s}4^{***}$ | $(0.01${s})$ | $0.021$ |`
    );
    sections.push(
      `| 双重纠偏 (${s}) | $0.${12 + s}8^{***}$ | $(0.01${s})$ | $0.014$ |`
    );
    sections.push('');
    sections.push('> 传统测量误差使解释变量系数衰减，');
    sections.push('> 而最优预测误差在被解释变量端产生收缩效应。');
    sections.push('');
    sections.push('---');
    sections.push('');
  }

  sections.push('<!--');
  sections.push('多行 HTML 注释块内部空行测试');
  sections.push('');
  sections.push('# 不应在注释内部切分');
  sections.push('-->');
  sections.push('');
  sections.push('```svg');
  sections.push(
    '<svg viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg"><line x1="10" y1="50" x2="110" y2="10" stroke="#0b3d91" /></svg>'
  );
  sections.push('```');
  sections.push('');
  sections.push('全文末尾总结段落：渐进分片与全量解析完全一致。');

  return sections.join('\n');
}

describe('Progressive Markdown Hydration & Viewport-First KaTeX Engine', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetMathSchedulerForTests();
  });

  it('1. splits synthetic 34KB torture Markdown only at safe top-level boundaries with 100% AST & comment-ID identity', () => {
    const tortureMd = buildSyntheticTortureMarkdown();
    expect(tortureMd.length).toBeGreaterThan(10000);

    const { head, tailChunks } = splitMarkdownForProgressiveLoad(tortureMd, {
      minProgressiveChars: 4000,
      headTargetChars: 2600,
      tailChunkTargetChars: 5000,
    });

    expect(tailChunks.length).toBeGreaterThanOrEqual(2);
    expect([head, ...tailChunks].join('')).toBe(tortureMd);

    const sharedCtx = createParseContext();
    const chunkedBlocks = [head, ...tailChunks].flatMap((chunk) =>
      parseMarkdownChunkToBlocks(chunk, sharedCtx)
    );
    const fullDocJson = parseMarkdownToDocJson(tortureMd);

    expect(chunkedBlocks).toEqual(fullDocJson.content);

    // Bailout checks for footnotes and reference-style links
    const withFootnote = `${tortureMd}\n\nHere is a note[^1].\n\n[^1]: Footnote definition.`;
    expect(splitMarkdownForProgressiveLoad(withFootnote).tailChunks).toEqual([]);

    const withRefLink = `${tortureMd}\n\nSee [paper][ref1].\n\n[ref1]: https://example.org/paper.pdf`;
    expect(splitMarkdownForProgressiveLoad(withRefLink).tailChunks).toEqual([]);

    // Guard against phase-inversion when a line starts with single-line inline `$$x=1$$ prose`
    // followed later by a multi-line `$$\n...\n$$` display block containing blank lines
    const inlineDollarThenBlock = [
      '$$x = 1$$ 是基准校准初值，后续紧跟大量段落与跨空行多行公式块。',
      '',
      tortureMd,
    ].join('\n');
    const splitDollar = splitMarkdownForProgressiveLoad(inlineDollarThenBlock, {
      minProgressiveChars: 4000,
      headTargetChars: 2400,
      tailChunkTargetChars: 4500,
    });
    expect(splitDollar.tailChunks.length).toBeGreaterThanOrEqual(2);
    const dollarCtx = createParseContext();
    const dollarChunked = [splitDollar.head, ...splitDollar.tailChunks].flatMap(
      (c) => parseMarkdownChunkToBlocks(c, dollarCtx)
    );
    expect(dollarChunked).toEqual(
      parseMarkdownToDocJson(inlineDollarThenBlock).content
    );
  });

  it('2. achieves 100% AST identity on the real 102KB / 794-line / 257-formula QA note', async () => {
    const fs = await loadNodeFs();
    if (!REAL_NOTE_PATH || !fs.existsSync(REAL_NOTE_PATH)) {
      return;
    }

    const realMd = fs.readFileSync(REAL_NOTE_PATH, 'utf8');
    expect(realMd.length).toBeGreaterThan(30000);

    const { head, tailChunks } = splitMarkdownForProgressiveLoad(realMd);
    expect(head.length).toBeGreaterThanOrEqual(4200);
    expect(head.length).toBeLessThan(8500);
    expect(tailChunks.length).toBeGreaterThanOrEqual(3);
    expect([head, ...tailChunks].join('')).toBe(realMd);

    const sharedCtx = createParseContext();
    const chunkedBlocks = [head, ...tailChunks].flatMap((chunk) =>
      parseMarkdownChunkToBlocks(chunk, sharedCtx)
    );
    const fullDocJson = parseMarkdownToDocJson(realMd);

    expect(chunkedBlocks).toEqual(fullDocJson.content);
  });

  it('3. mounts only head blocks on Frame 1, preserves 100% untruncated getMarkdown(), flushes losslessly on mid-hydration edits, and completes background slices', async () => {
    vi.useFakeTimers();

    const tortureMd = buildSyntheticTortureMarkdown();
    const fullDocJson = parseMarkdownToDocJson(tortureMd);
    const totalExpectedBlocks = fullDocJson.content?.length ?? 0;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const handleRef = createRef<LemmaEditorHandle>();
    const onMarkdownChange = vi.fn();
    const onDocDirty = vi.fn();
    const hydrationEvents: Array<{ count: number; isFinal: boolean }> = [];
    let latestOutline: OutlineHeading[] = [];

    try {
      await act(async () => {
        root.render(
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(LemmaEditor, {
              ref: handleRef,
              initialMarkdown: tortureMd,
              currentFilePath: 'C:/notes/torture.md',
              resolveAssetUrl: noopResolveAssetUrl,
              onMarkdownChange,
              onDocDirty,
              onOutlineChange: (headings) => {
                latestOutline = headings;
              },
              onHydrationAppend: (frag, _ed, isFinal) => {
                hydrationEvents.push({
                  count: frag.childCount,
                  isFinal,
                });
              },
            })
          )
        );
      });

      const handle = handleRef.current!;
      const editor = handle.getEditor()!;
      expect(editor).not.toBeNull();

      // Frame 1: ONLY head blocks are mounted, hydration is still active!
      const frame1BlockCount = editor.state.doc.childCount;
      expect(handle.isHydrating()).toBe(true);
      expect(frame1BlockCount).toBeGreaterThan(0);
      expect(frame1BlockCount).toBeLessThan(totalExpectedBlocks / 2);
      expect(hydrationEvents).toHaveLength(0);

      // Initial head outline already emitted via microtask
      expect(latestOutline.length).toBeGreaterThan(0);
      expect(latestOutline.length).toBeLessThan(15);

      // Spacer paddingBottom is active while tail chunks remain
      const hostDiv = container.querySelector('#write > div') as HTMLDivElement;
      expect(hostDiv.style.paddingBottom).not.toBe('');

      // Calling getMarkdown() BEFORE local edits returns 100% untruncated raw Markdown in O(1) without flushing!
      expect(handle.getMarkdown()).toBe(tortureMd);
      expect(handle.isHydrating()).toBe(true);
      expect(editor.state.doc.childCount).toBe(frame1BlockCount);

      // Advance timers to complete all background hydration slices
      await act(async () => {
        vi.runAllTimers();
      });

      expect(handle.isHydrating()).toBe(false);
      expect(hostDiv.style.paddingBottom).toBe('');
      expect(editor.state.doc.childCount).toBe(totalExpectedBlocks);
      const expectedPmDoc = parseMarkdownToPmNode(tortureMd, editor.schema);
      expect(editor.state.doc.toJSON()).toEqual(expectedPmDoc.toJSON());
      expect(hydrationEvents.length).toBeGreaterThan(0);
      expect(hydrationEvents[hydrationEvents.length - 1].isFinal).toBe(true);
      expect(latestOutline).toHaveLength(15); // 1 H1 + 14 H2 sections
      expect(onMarkdownChange).not.toHaveBeenCalled();

      // Now test progressive reload + mid-hydration user edit + getMarkdown() lossless flush!
      await act(async () => {
        handle.setMarkdownFromExternal(tortureMd, { progressive: true });
      });

      expect(handle.isHydrating()).toBe(true);
      expect(editor.state.doc.childCount).toBe(frame1BlockCount);

      // User types into Heading 1 while tail chunks are STILL pending!
      await act(async () => {
        editor.view.dispatch(editor.state.tr.insertText('【已修订】', 1));
      });

      expect(onDocDirty).toHaveBeenCalledTimes(1);
      expect(handle.isHydrating()).toBe(true);

      // Debounced 220ms serialize must NOT emit a truncated document while hydrating:
      // test immediate Ctrl+S / getMarkdown() mid-hydration -> flushes remaining tail chunks first!
      const savedMidHydration = handle.getMarkdown();
      expect(handle.isHydrating()).toBe(false);
      expect(editor.state.doc.childCount).toBe(totalExpectedBlocks);
      expect(savedMidHydration).toContain(
        '# 【已修订】渐进式水合与跨块边界等价性压力测试手稿'
      );
      expect(savedMidHydration).toContain(
        '全文末尾总结段落：渐进分片与全量解析完全一致。'
      );

      // Also verify scrollToPos(farPos) mid-hydration flushes automatically
      await act(async () => {
        handle.setMarkdownFromExternal(tortureMd, { progressive: true });
      });
      expect(handle.isHydrating()).toBe(true);
      await act(async () => {
        handle.scrollToPos(999999);
      });
      expect(handle.isHydrating()).toBe(false);
      expect(editor.state.doc.childCount).toBe(totalExpectedBlocks);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('4. renders KaTeX with output:"html" (0 MathML nodes) and defers off-screen formulas via IntersectionObserver + idle trickle', async () => {
    vi.useFakeTimers();

    const observedElements = new Set<Element>();
    let ioCallback: IntersectionObserverCallback | null = null;

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = '900px 0px';
      readonly thresholds: ReadonlyArray<number> = [0];

      constructor(cb: IntersectionObserverCallback) {
        ioCallback = cb;
      }
      observe(target: Element): void {
        observedElements.add(target);
      }
      unobserve(target: Element): void {
        observedElements.delete(target);
      }
      disconnect(): void {
        observedElements.clear();
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    const prevIO = globalThis.IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver =
      MockIntersectionObserver;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const handleRef = createRef<LemmaEditorHandle>();

    try {
      // Build document with 30 formulas in head + 25 formulas in tail (> 8000 chars)
      const headFormulas = Array.from(
        { length: 30 },
        (_, i) =>
          `第 ${i + 1} 条均衡条件满足 $x_{${i + 1}} + y_{${i + 1}} = \\alpha_{${i + 1}}$，用于验证首屏同步预算。`
      ).join('\n\n');
      const paddingProse = Array.from(
        { length: 90 },
        (_, i) =>
          `过渡论述第 ${i + 1} 段：在异质性代理人模型中，资产分布演化由柯尔莫哥洛夫前向方程决定，稳态利率内生出清资本市场，跨期替代弹性决定储蓄响应路径。`
      ).join('\n\n');
      const tailFormulas = Array.from(
        { length: 25 },
        (_, i) =>
          `尾部第 ${i + 1} 条公式：\n\n$$\nV_{${i + 1}}(k) = \\max_c \\{ u(c) + \\beta V_{${i + 1}}(k') \\}\n$$`
      ).join('\n\n');

      const docMd = `# 视口公式调度测试\n\n${headFormulas}\n\n${paddingProse}\n\n${tailFormulas}`;
      expect(docMd.length).toBeGreaterThan(8500);

      await act(async () => {
        root.render(
          React.createElement(LemmaEditor, {
            ref: handleRef,
            initialMarkdown: docMd,
            currentFilePath: null,
            resolveAssetUrl: noopResolveAssetUrl,
            onMarkdownChange: () => {},
          })
        );
      });

      // 1) First 20 formulas in head mounted KaTeX synchronously with `output: 'html'` (zero <math> elements!)
      const frame1Katex = container.querySelectorAll('.katex');
      expect(frame1Katex.length).toBe(SYNC_MATH_BUDGET_PER_BURST);
      expect(container.querySelectorAll('math').length).toBe(0);

      // Remaining 10 formulas in head are deferred lightweight text nodes
      const frame1Deferred = container.querySelectorAll('.lemma-math-deferred');
      expect(frame1Deferred.length).toBe(10);
      expect(getPendingDeferredMathCount()).toBe(10);

      // 2) Trigger IntersectionObserver on the first deferred formula -> upgrades immediately!
      const firstDeferredSpan = frame1Deferred[0] as HTMLElement;
      const firstDeferredWrapper = firstDeferredSpan.closest(
        '.lemma-math-inline'
      ) as HTMLElement;
      expect(observedElements.has(firstDeferredWrapper)).toBe(true);

      await act(async () => {
        ioCallback!(
          [
            {
              target: firstDeferredWrapper,
              isIntersecting: true,
            } as unknown as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        );
      });

      expect(firstDeferredSpan.classList.contains('lemma-math-deferred')).toBe(
        false
      );
      expect(firstDeferredWrapper.querySelector('.katex')).not.toBeNull();
      expect(observedElements.has(firstDeferredWrapper)).toBe(false);

      // 3) Clicking a still-deferred formula upgrades it immediately before opening popover
      const secondDeferredWrapper = (
        container.querySelectorAll('.lemma-math-deferred')[0] as HTMLElement
      ).closest('.lemma-math-inline') as HTMLElement;

      await act(async () => {
        secondDeferredWrapper.click();
      });
      expect(secondDeferredWrapper.querySelector('.katex')).not.toBeNull();

      // 4) Run all timers -> finishes tail block hydration AND runs background idle KaTeX trickle to 0 pending!
      await act(async () => {
        vi.runAllTimers();
      });

      expect(handleRef.current?.isHydrating()).toBe(false);
      expect(getPendingDeferredMathCount()).toBe(0);
      expect(container.querySelectorAll('.lemma-math-deferred').length).toBe(0);
      expect(
        container.querySelectorAll('.lemma-math-block-deferred').length
      ).toBe(0);
      expect(container.querySelectorAll('math').length).toBe(0);
      // All 30 inline + 25 block = 55 formulas (plus any preview inside open popover) are now upgraded `.katex`
      expect(container.querySelectorAll('#write .katex').length).toBeGreaterThanOrEqual(
        55
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (globalThis as Record<string, unknown>).IntersectionObserver = prevIO;
    }
  });

  it('5. benchmarks Frame-1 mount speedup and DOM node reduction on the 102KB / 257-formula note', async () => {
    const fs = await loadNodeFs();
    if (!REAL_NOTE_PATH || !fs.existsSync(REAL_NOTE_PATH)) {
      return;
    }

    const realMd = fs.readFileSync(REAL_NOTE_PATH, 'utf8');
    const extensions = createLemmaExtensions({
      resolveAssetUrl: noopResolveAssetUrl,
    });

    // Warm up JIT / unified / KaTeX caches once with a tiny snippet so measurement reflects steady runtime
    const warmHost = document.createElement('div');
    const warmEd = new Editor({
      element: warmHost,
      extensions,
      content: parseMarkdownToDocJson('# Warmup\n\n$x + y = z$\n\n$$\na = b\n$$'),
    });
    warmEd.destroy();
    resetMathSchedulerForTests();

    // --- Baseline ("Before"): Full-document synchronous parse + full 192-block / 257-KaTeX mount ---
    const fullHost = document.createElement('div');
    document.body.appendChild(fullHost);
    const t0Full = performance.now();
    const fullDocJson = parseMarkdownToDocJson(realMd);
    const fullEditor = new Editor({
      element: fullHost,
      extensions,
      content: fullDocJson,
    });
    const fullMountMs = performance.now() - t0Full;
    const fullDomNodes = fullHost.querySelectorAll('*').length;
    const fullBlocks = fullEditor.state.doc.childCount;
    fullEditor.destroy();
    fullHost.remove();

    // --- Progressive ("After"): Frame-1 split + head parse + head mount with IntersectionObserver active ---
    class BenchIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '900px 0px';
      readonly thresholds = [0];
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    const prevIO = globalThis.IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver =
      BenchIntersectionObserver;
    resetMathSchedulerForTests();

    const progHost = document.createElement('div');
    document.body.appendChild(progHost);
    let progMountMs = 0;
    let progDomNodes = 0;
    let progBlocks = 0;
    let tailSliceCount = 0;
    let maxSliceMs = 0;

    try {
      const t0Prog = performance.now();
      const { head, tailChunks } = splitMarkdownForProgressiveLoad(realMd);
      const parseCtx = createParseContext();
      const headBlocks = parseMarkdownChunkToBlocks(head, parseCtx);
      const progEditor = new Editor({
        element: progHost,
        extensions,
        content: { type: 'doc', content: headBlocks },
      });
      progMountMs = performance.now() - t0Prog;
      progDomNodes = progHost.querySelectorAll('*').length;
      progBlocks = progEditor.state.doc.childCount;

      // Also verify serialized equivalence & deferred-KaTeX slice speed after appending tail chunks
      for (const chunk of tailChunks) {
        const s0 = performance.now();
        const blocks = parseMarkdownChunkToBlocks(chunk, parseCtx);
        const nodes = blocks.map((b) => progEditor.schema.nodeFromJSON(b));
        if (nodes.length > 0) {
          const tr = progEditor.state.tr
            .insert(
              progEditor.state.doc.content.size,
              progEditor.schema.nodes.doc.create(null, nodes).content
            )
            .setMeta('addToHistory', false)
            .setMeta('lemmaHydrationAppend', true);
          beginHydrationSliceMount();
          try {
            progEditor.view.dispatch(tr);
          } finally {
            endHydrationSliceMount();
          }
        }
        const elapsed = performance.now() - s0;
        if (elapsed > maxSliceMs) maxSliceMs = elapsed;
        tailSliceCount++;
      }

      expect(serializeDocToMarkdown(progEditor.state.doc)).toBe(
        serializeDocToMarkdown(
          progEditor.schema.nodeFromJSON(fullDocJson)
        )
      );

      progEditor.destroy();
    } finally {
      progHost.remove();
      (globalThis as Record<string, unknown>).IntersectionObserver = prevIO;
    }

    console.info(
      `[Benchmark 102KB / 257-Formula Note] Full sync mount: ${fullMountMs.toFixed(
        2
      )} ms (${fullBlocks} blocks, ${fullDomNodes} DOM nodes) -> Progressive Frame-1 mount: ${progMountMs.toFixed(
        2
      )} ms (${progBlocks} blocks, ${progDomNodes} DOM nodes; ${tailSliceCount} tail chunks, max tail chunk=${maxSliceMs.toFixed(
        2
      )} ms)`
    );

    expect(progBlocks).toBeLessThan(fullBlocks / 3);
    expect(progDomNodes).toBeLessThan(fullDomNodes / 4);
    expect(progMountMs).toBeLessThan(fullMountMs);
  });

  it('6. preserves ProseMirror undo history across hydration so Ctrl+Z undoes only user edits and never undoes hydrated tail chunks', async () => {
    vi.useFakeTimers();

    const tortureMd = buildSyntheticTortureMarkdown();
    const totalExpectedBlocks =
      parseMarkdownToDocJson(tortureMd).content?.length ?? 0;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const handleRef = createRef<LemmaEditorHandle>();

    try {
      await act(async () => {
        root.render(
          React.createElement(LemmaEditor, {
            ref: handleRef,
            initialMarkdown: tortureMd,
            currentFilePath: 'C:/notes/undo-hydration.md',
            resolveAssetUrl: noopResolveAssetUrl,
            onMarkdownChange: () => {},
          })
        );
      });

      const handle = handleRef.current!;
      const editor = handle.getEditor()!;
      expect(handle.isHydrating()).toBe(true);

      // User types into Heading 1 BEFORE hydration finishes (recorded in ProseMirror history)
      await act(async () => {
        editor.commands.insertContentAt(1, '【可撤销修订】');
      });
      expect(editor.state.doc.firstChild?.textContent).toContain('【可撤销修订】');
      expect(handle.isHydrating()).toBe(true);

      // Let all background hydration slices append (`addToHistory: false`)
      await act(async () => {
        vi.runAllTimers();
      });
      expect(handle.isHydrating()).toBe(false);
      expect(editor.state.doc.childCount).toBe(totalExpectedBlocks);

      // Press Ctrl+Z (`undo`): user's edit in Heading 1 is undone, while ALL hydrated tail chunks remain intact!
      await act(async () => {
        expect(editor.commands.undo()).toBe(true);
      });
      expect(editor.state.doc.firstChild?.textContent).not.toContain(
        '【可撤销修订】'
      );
      expect(editor.state.doc.childCount).toBe(totalExpectedBlocks);

      // Repeated Ctrl+Z calls cannot undo any hydration chunk
      for (let i = 0; i < 5; i++) {
        editor.commands.undo();
      }
      expect(editor.state.doc.childCount).toBe(totalExpectedBlocks);
      expect(handle.getMarkdown()).toContain(
        '全文末尾总结段落：渐进分片与全量解析完全一致。'
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('7. handles App initialBootDoc, early Ctrl+S / blur / Ctrl+/ mid-hydration, mid-hydration AI diff without false tail hunks, and rapid Ctrl+O file switching', async () => {
    vi.useFakeTimers();

    const baseRaw = buildSyntheticTortureMarkdown();
    const schema = createLemmaExtensions({ resolveAssetUrl: noopResolveAssetUrl });
    const tempEd = new Editor({
      extensions: schema,
      content: parseMarkdownToDocJson(baseRaw),
    });
    const canonicalMdA = serializeDocToMarkdown(tempEd.state.doc);
    tempEd.destroy();

    const fileAPath = '/demo/large-file-a.md';
    const fileBPath = '/demo/large-file-b.md';
    const fileCPath = '/demo/large-file-c.md';
    const canonicalMdB = canonicalMdA
      .replace(
        '# 渐进式水合与跨块边界等价性压力测试手稿',
        '# 文件 B：货币政策冲击传导手稿'
      )
      .replace(
        '全文末尾总结段落：渐进分片与全量解析完全一致。',
        '文件 B 专属尾部：零跨文件分片泄漏验证。'
      );
    const canonicalMdC = canonicalMdA
      .replace(
        '# 渐进式水合与跨块边界等价性压力测试手稿',
        '# 文件 C：财政乘数非线性效应手稿'
      )
      .replace(
        '全文末尾总结段落：渐进分片与全量解析完全一致。',
        '文件 C 专属尾部：快速连续 Ctrl+O 最终落盘一致性。'
      );

    await tauriBridge.writeMarkdownFile(fileAPath, canonicalMdA);
    await tauriBridge.writeMarkdownFile(fileBPath, canonicalMdB);
    await tauriBridge.writeMarkdownFile(fileCPath, canonicalMdC);

    const writeSpy = vi.spyOn(tauriBridge, 'writeMarkdownFile');
    const pickSpy = vi.spyOn(tauriBridge, 'pickMarkdownFile');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      // 1) Mount App under React.StrictMode with preloaded `initialBootDoc` (simulating CLI double-click boot)
      await act(async () => {
        root.render(
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(App, {
              initialBootDoc: {
                path: fileAPath,
                content: canonicalMdA,
                sha256: 'boot-sha-a',
                modifiedMs: 1000,
              },
              bootResolved: true,
            })
          )
        );
      });

      expect(container.querySelector('#write')).not.toBeNull();
      expect(isHydrationActive()).toBe(true);
      writeSpy.mockClear();

      // 2) Early Ctrl+S mid-hydration WITHOUT local edits -> writes 100% untruncated file & stays clean
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 's',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0][1]).toContain(
        '全文末尾总结段落：渐进分片与全量解析完全一致。'
      );
      expect(isHydrationActive()).toBe(false);
      writeSpy.mockClear();

      // 2b) Re-open File A progressively, edit Paragraph 1 mid-hydration, and blur window immediately:
      // verifies 100% lossless write (Head edit + Tail intact) AND no stale 220ms timer re-dirtying after save!
      pickSpy.mockResolvedValueOnce(fileAPath);
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'o',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(isHydrationActive()).toBe(true);

      const pmDom = container.querySelector('.ProseMirror') as HTMLElement;
      expect(pmDom).not.toBeNull();
      await act(async () => {
        const pasteEvent = new Event('paste', {
          bubbles: true,
          cancelable: true,
        }) as ClipboardEvent;
        Object.defineProperty(pasteEvent, 'clipboardData', {
          value: {
            items: [],
            files: [],
            getData: (mime: string) =>
              mime === 'text/plain' ? '<mark>窗口失焦秒存</mark>' : '',
          },
        });
        pmDom.dispatchEvent(pasteEvent);
      });
      expect(isHydrationActive()).toBe(true);

      await act(async () => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(isHydrationActive()).toBe(false);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0][1]).toContain('<mark>窗口失焦秒存</mark>');
      expect(writeSpy.mock.calls[0][1]).toContain(
        '全文末尾总结段落：渐进分片与全量解析完全一致。'
      );

      // Advance past 220ms serialize debounce + 900ms idle autosave -> must NOT re-dirty or double-write!
      writeSpy.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(writeSpy).not.toHaveBeenCalled();
      expect(document.title.startsWith('• ')).toBe(false);

      // Restore clean canonicalMdA on virtual disk before step 3
      await tauriBridge.writeMarkdownFile(fileAPath, canonicalMdA);
      writeSpy.mockClear();

      // 3) Re-open File A progressively via Ctrl+O, then trigger AI external file change MID-HYDRATION!
      pickSpy.mockResolvedValueOnce(fileAPath);
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'o',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(isHydrationActive()).toBe(true);

      // AI modifies ONLY the final paragraph at the bottom while tail chunks are still unhydrated!
      const aiEditedMdA = canonicalMdA.replace(
        '全文末尾总结段落：渐进分片与全量解析完全一致。',
        '全文末尾总结段落：AI 审稿人已在水合中途精准修订本段结论。'
      );
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('lemma:external-file-change', {
            detail: {
              path: fileAPath,
              content: aiEditedMdA,
              sha256: 'ai-mid-hydration-sha',
              modifiedMs: 2000,
            },
          })
        );
        vi.advanceTimersByTime(32);
      });

      // flushPendingHydration() ran BEFORE diff baseline comparison -> EXACTLY 1 hunk (zero false tail additions!)
      expect(isHydrationActive()).toBe(false);
      expect(container.querySelector('.lemma-diff-bar')?.textContent).toContain(
        '共 1 处修改'
      );

      // 4) Rapid Ctrl+O switching across File A -> File B -> File C mid-hydration: zero cross-file chunk leakage!
      pickSpy.mockResolvedValueOnce(fileAPath);
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'o',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(isHydrationActive()).toBe(true);

      pickSpy.mockResolvedValueOnce(fileBPath);
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'o',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(isHydrationActive()).toBe(true);

      pickSpy.mockResolvedValueOnce(fileCPath);
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'o',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(isHydrationActive()).toBe(true);

      // Finish all timers -> ONLY File C's tail chunks may exist!
      await act(async () => {
        vi.runAllTimers();
      });
      expect(isHydrationActive()).toBe(false);
      const writeTextAfterSwitch =
        container.querySelector('#write')?.textContent ?? '';
      expect(writeTextAfterSwitch).toContain('文件 C：财政乘数非线性效应手稿');
      expect(writeTextAfterSwitch).toContain(
        '文件 C 专属尾部：快速连续 Ctrl+O 最终落盘一致性。'
      );
      expect(writeTextAfterSwitch).not.toContain('文件 B 专属尾部');
      expect(writeTextAfterSwitch).not.toContain(
        '全文末尾总结段落：渐进分片与全量解析完全一致。'
      );

      // 5) Re-open File B progressively, toggle Ctrl+/ into Source Mode mid-hydration -> 100% untruncated!
      pickSpy.mockResolvedValueOnce(fileBPath);
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'o',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(isHydrationActive()).toBe(true);

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
      expect(isHydrationActive()).toBe(false);

      // Ctrl+S while in Source Mode writes 100% untruncated File B
      writeSpy.mockClear();
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 's',
            ctrlKey: true,
            bubbles: true,
          })
        );
      });
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0][0]).toBe(fileBPath);
      expect(writeSpy.mock.calls[0][1]).toContain(
        '文件 B 专属尾部：零跨文件分片泄漏验证。'
      );
    } finally {
      writeSpy.mockRestore();
      pickSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      // Unmounting always resets scheduler hydration flag cleanly
      expect(isHydrationActive()).toBe(false);
      container.remove();
    }
  });
});
