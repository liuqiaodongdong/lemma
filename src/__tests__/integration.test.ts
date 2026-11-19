/// <reference types="vite/client" />
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import rawShowcaseMarkdown from '../../public/demo/economics-showcase.md?raw';
import {
  LemmaEditor,
  createLemmaSchema,
  parseMarkdownToPmNode,
  serializeDocToMarkdown,
  type LemmaEditorHandle,
} from '../editor';
import {
  applyAcceptHunkToBaseline,
  buildRevertTransaction,
  computeDocDiff,
} from '../diff';
import { tauriBridge } from '../services/tauriBridge';
import { App } from '../App';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('Cross-Module End-to-End Integration Suite (Codec + AST Diff + App Lifecycle)', () => {
  const schema = createLemmaSchema({
    resolveAssetUrl: (rawSrc) =>
      tauriBridge.resolveLocalAssetUrl('C:\\papers\\econ\\showcase.md', rawSrc),
  });

  it('1. round-trips real demo/economics-showcase.md losslessly across headings, CJK prose, inline/aligned/Bellman math, callouts, booktabs table, and SVG diagram', () => {
    const doc1 = parseMarkdownToPmNode(rawShowcaseMarkdown, schema);
    const serialized1 = serializeDocToMarkdown(doc1);
    const doc2 = parseMarkdownToPmNode(serialized1, schema);
    const serialized2 = serializeDocToMarkdown(doc2);

    // Structural & textual idempotence across passes
    expect(doc2.toJSON()).toEqual(doc1.toJSON());
    expect(serialized2).toBe(serialized1);
    expect(computeDocDiff(doc1, doc2)).toHaveLength(0);

    // Verify H1 & H2 section titles
    expect(serialized1).toContain(
      '# 信贷约束缓解、跨期消费平滑与总需求传导机制研究'
    );
    expect(serialized1).toContain('## 一、代表性家庭跨期最优化');
    expect(serialized1).toContain('## 二、动态规划与贝尔曼方程');
    expect(serialized1).toContain('## 三、市场供需冲击均衡图解');
    expect(serialized1).toContain('## 四、双重差分（DID）基准回归结果');

    // Verify inline formulas, highlights, comments & Chinese prose
    expect(serialized1).toContain('$\\LaTeX$');
    expect(serialized1).toContain('$\\beta \\in (0.95, 0.99)$');
    expect(serialized1).toContain('$\\psi \\equiv 1/\\sigma$');
    expect(serialized1).toContain('<mark data-color="green">');
    expect(serialized1).toContain('data-comment=');

    // Verify multi-line \begin{aligned} Euler equation & Bellman equation mathBlocks
    expect(serialized1).toContain('\\begin{aligned}');
    expect(serialized1).toContain(
      '\\frac{\\partial \\mathcal{L}}{\\partial C_t} &= C_t^{-\\sigma} - \\lambda_t = 0'
    );
    expect(serialized1).toContain('\\end{aligned}');
    expect(serialized1).toContain(
      'V(A_t, Y_t) &= \\max_{C_t, A_{t+1}} \\left\\{ \\frac{C_t^{1-\\sigma} - 1}{1 - \\sigma} + \\beta \\mathbb{E}_t \\Big[ V(A_{t+1}, Y_{t+1}) \\,\\Big|\\, Y_t \\Big] \\right\\}'
    );

    // Verify [!IMPORTANT] and [!NOTE] callouts
    expect(serialized1).toContain('> [!IMPORTANT]');
    expect(serialized1).toContain('> [!NOTE]');

    // Verify Booktabs GFM table alignment, significance stars, and italicized note with escaped stars
    expect(serialized1).toContain('| :--- | :---: | :---: | :---: |');
    expect(serialized1).toContain(
      '| 政策交互项 $\\text{Treat}_i \\times \\text{Post}_t$ | 0.086*** | 0.074*** | 0.072*** |'
    );
    expect(serialized1).toContain('\\*\\*\\*、\\*\\*、\\*');

    // Verify ```svg supply-demand equilibrium vector diagram
    expect(serialized1).toContain('```svg\n<svg ');
    expect(serialized1).toContain('市场供需冲击比较静态均衡图');
    expect(serialized1).toContain('</svg>\n```');
  });

  it('2. detects 4 simultaneous AI Agent edits on economics-showcase.md and selectively reverts any single hunk without disturbing the other 3 AI edits', () => {
    const baselineDoc = parseMarkdownToPmNode(rawShowcaseMarkdown, schema);
    const canonicalBaselineMd = serializeDocToMarkdown(baselineDoc);

    // Simulate external AI Agent making 4 simultaneous domain-specific edits:
    // ① Chinese economics prose + inline formula parameter (\beta \in (0.95, 0.99) -> \beta \in (0.96, 0.995))
    const origProseTarget =
      '其中 $\\beta \\in (0.95, 0.99)$ 表示季度校准下的主观贴现因子，';
    const aiProseReplacement =
      '其中 $\\beta \\in (0.96, 0.995)$ 表示校准后的月度主观贴现因子，';

    // ② Bellman equation mathBlock modification (updating borrowing constraint time subscript)
    const origBellmanLatex = [
      '\\begin{aligned}',
      'V(A_t, Y_t) &= \\max_{C_t, A_{t+1}} \\left\\{ \\frac{C_t^{1-\\sigma} - 1}{1 - \\sigma} + \\beta \\mathbb{E}_t \\Big[ V(A_{t+1}, Y_{t+1}) \\,\\Big|\\, Y_t \\Big] \\right\\} \\\\',
      '\\text{s.t.} \\quad A_{t+1} &\\ge -\\underline{B}_t, \\quad C_t + A_{t+1} = (1 + r_t) A_t + Y_t',
      '\\end{aligned}',
    ].join('\n');
    const aiBellmanLatex = [
      '\\begin{aligned}',
      'V(A_t, Y_t) &= \\max_{C_t, A_{t+1}} \\left\\{ \\frac{C_t^{1-\\sigma} - 1}{1 - \\sigma} + \\beta \\mathbb{E}_t \\Big[ V(A_{t+1}, Y_{t+1}) \\,\\Big|\\, Y_t \\Big] \\right\\} \\\\',
      '\\text{s.t.} \\quad A_{t+1} &\\ge -\\underline{B}_{t+1}, \\quad C_t + A_{t+1} = (1 + r_t) A_t + Y_t',
      '\\end{aligned}',
    ].join('\n');

    // ③ SVG supply-demand diagram modification (updating shifted equilibrium point & caption)
    const origSvgSnippet = '信贷约束缓解冲击';
    const aiSvgSnippet = '普惠信贷扩容外生冲击 (ΔD)';

    // ④ Booktabs regression table coefficient modification (0.072*** -> 0.082***)
    const origTableLine =
      '| 政策交互项 $\\text{Treat}_i \\times \\text{Post}_t$ | 0.086*** | 0.074*** | 0.072*** |';
    const aiTableLine =
      '| 政策交互项 $\\text{Treat}_i \\times \\text{Post}_t$ | 0.086*** | 0.074*** | 0.082*** |';

    expect(canonicalBaselineMd).toContain(origProseTarget);
    expect(canonicalBaselineMd).toContain(origBellmanLatex);
    expect(canonicalBaselineMd).toContain(origSvgSnippet);
    expect(canonicalBaselineMd).toContain(origTableLine);

    const aiModifiedMd = canonicalBaselineMd
      .replace(origProseTarget, aiProseReplacement)
      .replace(origBellmanLatex, aiBellmanLatex)
      .replace(origSvgSnippet, aiSvgSnippet)
      .replace(origTableLine, aiTableLine);

    const aiDoc = parseMarkdownToPmNode(aiModifiedMd, schema);
    const hunks = computeDocDiff(baselineDoc, aiDoc);

    // Must produce exactly 4 hunks in document order matching the 4 edit types
    expect(hunks).toHaveLength(4);
    expect(hunks.map((h) => h.kind)).toEqual([
      'text-modified',
      'math-modified',
      'svg-modified',
      'table-modified',
    ]);

    // Verify hunk details
    expect(
      hunks[0].segments?.some(
        (s) => s.type === 'delete' && s.isInlineMath && s.text.includes('(0.95, 0.99)')
      )
    ).toBe(true);
    expect(
      hunks[0].segments?.some(
        (s) =>
          s.type === 'insert' &&
          s.isInlineMath &&
          s.text.includes('(0.96, 0.995)')
      )
    ).toBe(true);
    expect(hunks[1].oldLatex).toBe(origBellmanLatex);
    expect(hunks[1].newLatex).toBe(aiBellmanLatex);
    expect(hunks[2].oldSvg).toContain(origSvgSnippet);
    expect(hunks[2].newSvg).toContain(aiSvgSnippet);
    expect(hunks[3].oldPreviewText).toContain('0.072***');
    expect(hunks[3].newPreviewText).toContain('0.082***');
    expect(hunks[3].inlineInserts?.length).toBeGreaterThan(0);
    expect(hunks[3].inlineDeletes?.length).toBeGreaterThan(0);

    // Test reverting EACH of the 4 hunks individually and verifying clean Markdown output
    const checkMarkers = [
      { orig: origProseTarget, ai: aiProseReplacement },
      { orig: origBellmanLatex, ai: aiBellmanLatex },
      { orig: origSvgSnippet, ai: aiSvgSnippet },
      { orig: origTableLine, ai: aiTableLine },
    ];

    for (let targetIdx = 0; targetIdx < hunks.length; targetIdx++) {
      const editorState = EditorState.create({ schema, doc: aiDoc });
      const revertTr = buildRevertTransaction(editorState, hunks[targetIdx]);
      const nextState = editorState.apply(revertTr);
      const serializedAfterRevert = serializeDocToMarkdown(nextState.doc);

      // Zero diff UI artifacts may leak into serialized Markdown
      expect(serializedAfterRevert).not.toContain('lemma-diff');
      expect(serializedAfterRevert).not.toContain('【修改前】');
      expect(serializedAfterRevert).not.toContain('【修改后】');

      for (let idx = 0; idx < checkMarkers.length; idx++) {
        if (idx === targetIdx) {
          expect(serializedAfterRevert).toContain(checkMarkers[idx].orig);
          expect(serializedAfterRevert).not.toContain(checkMarkers[idx].ai);
        } else {
          expect(serializedAfterRevert).toContain(checkMarkers[idx].ai);
        }
      }

      // Remaining diff against baselineDoc must have exactly the other 3 hunks
      const remainingHunks = computeDocDiff(baselineDoc, nextState.doc);
      expect(remainingHunks).toHaveLength(3);
    }

    // Verify applyAcceptHunkToBaseline accepts hunk[1] (Bellman) while preserving the other 3 hunks
    const updatedBaseline = applyAcceptHunkToBaseline(
      baselineDoc,
      aiDoc,
      hunks[1]
    );
    const hunksAfterAccept = computeDocDiff(updatedBaseline, aiDoc);
    expect(hunksAfterAccept.map((h) => h.kind)).toEqual([
      'text-modified',
      'svg-modified',
      'table-modified',
    ]);
  });

  it('3. updates LocalImage resolved asset URLs dynamically via ref when switching between Markdown files in different directories', async () => {
    let activeFilePath: string | null = null;
    const dynamicResolve = (rawSrc: string) =>
      tauriBridge.resolveLocalAssetUrl(activeFilePath, rawSrc);

    const handleRef = createRef<LemmaEditorHandle>();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      const mdWithImage = '# 图表测试\n\n![供需均衡](./assets/equilibrium.png)';

      // 1) Mount as untitled document (currentFilePath = null)
      await act(async () => {
        root.render(
          React.createElement(LemmaEditor, {
            ref: handleRef,
            initialMarkdown: mdWithImage,
            currentFilePath: activeFilePath,
            resolveAssetUrl: dynamicResolve,
            onMarkdownChange: () => {},
          })
        );
      });

      let imgEl = container.querySelector('figure.lemma-local-image img');
      expect(imgEl?.getAttribute('src')).toBe('./assets/equilibrium.png');

      // 2) Save untitled document into Directory A WITHOUT replacing PMNode (in-place path change)
      activeFilePath = 'C:\\Users\\econ\\paper_a\\draft.md';
      await act(async () => {
        root.render(
          React.createElement(LemmaEditor, {
            ref: handleRef,
            initialMarkdown: mdWithImage,
            currentFilePath: activeFilePath,
            resolveAssetUrl: dynamicResolve,
            onMarkdownChange: () => {},
          })
        );
      });

      imgEl = container.querySelector('figure.lemma-local-image img');
      expect(imgEl?.getAttribute('src')).toBe(
        'C:/Users/econ/paper_a/assets/equilibrium.png'
      );

      // 3) Switch to another file in Directory B
      activeFilePath = 'D:\\Research\\monetary_b\\main.md';
      await act(async () => {
        root.render(
          React.createElement(LemmaEditor, {
            ref: handleRef,
            initialMarkdown: mdWithImage,
            currentFilePath: activeFilePath,
            resolveAssetUrl: dynamicResolve,
            onMarkdownChange: () => {},
          })
        );
        handleRef.current?.setMarkdownFromExternal(
          '# 货币传导\n\n![脉冲响应](./assets/irf_shock.png)'
        );
      });

      imgEl = container.querySelector('figure.lemma-local-image img');
      expect(imgEl?.getAttribute('src')).toBe(
        'D:/Research/monetary_b/assets/irf_shock.png'
      );
      expect(handleRef.current?.getMarkdown()).toContain(
        '![脉冲响应](./assets/irf_shock.png)'
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('4. mounts App under React.StrictMode from WelcomeScreen, highlights very first external AI diff, preserves diff on window blur, and writes disk on single-hunk revert', async () => {
    const testPath = '/demo/strict-mode-test.md';
    const initialMd = [
      '# 动态随机一般均衡',
      '',
      '代表性家庭最大化跨期效用 $\\beta = 0.99$。',
      '',
      '$$',
      'C_t^{-\\sigma} = \\beta R_t C_{t+1}^{-\\sigma}',
      '$$',
    ].join('\n');

    await tauriBridge.writeMarkdownFile(testPath, initialMd);

    const pickSpy = vi
      .spyOn(tauriBridge, 'pickMarkdownFile')
      .mockResolvedValue(testPath);
    const writeSpy = vi.spyOn(tauriBridge, 'writeMarkdownFile');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      // Render full App inside <React.StrictMode> starting from WelcomeScreen
      await act(async () => {
        root.render(
          React.createElement(React.StrictMode, null, React.createElement(App))
        );
      });

      // Click "打开本地文件" on WelcomeScreen to mount LemmaEditor for the FIRST time
      const openBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('打开本地文件')
      );
      expect(openBtn).toBeDefined();

      await act(async () => {
        openBtn!.click();
      });

      expect(container.querySelector('#write')).not.toBeNull();
      writeSpy.mockClear();

      // Dispatch FIRST external AI modification event immediately
      const aiUpdatedMd = [
        '# 动态随机一般均衡',
        '',
        '代表性受约束家庭最大化跨期效用 $\\beta = 0.96$。',
        '',
        '$$',
        'C_t^{-\\sigma} = \\beta R_t \\mathbb{E}_t [C_{t+1}^{-\\sigma}] + \\mu_t',
        '$$',
      ].join('\n');

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('lemma:external-file-change', {
            detail: {
              path: testPath,
              content: aiUpdatedMd,
              sha256: 'ai-sha-updated-1',
              modifiedMs: Date.now(),
            },
          })
        );
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      // Verify BOTH hunks are immediately highlighted on first external update!
      expect(container.querySelector('.lemma-diff-bar')).not.toBeNull();
      expect(container.querySelector('.lemma-diff-bar')?.textContent).toContain(
        '共 2 处修改'
      );
      expect(container.querySelectorAll('.lemma-diff-ins').length).toBeGreaterThan(
        0
      );
      expect(container.querySelector('.lemma-diff-compare-card')).not.toBeNull();

      // Simulate clicking window and switching away (`blur` with isDirty === false) -> MUST NOT clear unread Diffs!
      await act(async () => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(writeSpy).not.toHaveBeenCalled();
      expect(container.querySelector('.lemma-diff-bar')?.textContent).toContain(
        '共 2 处修改'
      );

      // Click single-hunk `↩ 撤回` on the first hunk -> writes reverted doc to disk while keeping 2nd hunk highlighted!
      const revertButtons = container.querySelectorAll<HTMLButtonElement>(
        '.lemma-diff-btn-revert'
      );
      expect(revertButtons.length).toBe(2);

      await act(async () => {
        revertButtons[0].click();
      });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenContent] = writeSpy.mock.calls[0];
      expect(writtenPath).toBe(testPath);
      // Hunk 0 reverted to original, while Hunk 1 (AI mathBlock update) remains intact!
      expect(writtenContent).toContain(
        '代表性家庭最大化跨期效用 $\\beta = 0.99$。'
      );
      expect(writtenContent).toContain(
        'C_t^{-\\sigma} = \\beta R_t \\mathbb{E}_t [C_{t+1}^{-\\sigma}] + \\mu_t'
      );

      // Remaining 1 diff hunk (math-modified) is still highlighted!
      expect(container.querySelector('.lemma-diff-bar')?.textContent).toContain(
        '共 1 处修改'
      );
      expect(container.querySelector('.lemma-diff-compare-card')).not.toBeNull();
    } finally {
      pickSpy.mockRestore();
      writeSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('5. scales layout & typography proportionally when window maximizes and supports Ctrl+Wheel / TopBar zoom', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.removeItem('lemma:user-zoom');
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1140,
    });

    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(App));
      });

      const stage = container.querySelector<HTMLElement>('.lemma-canvas-stage');
      const readout = container.querySelector<HTMLButtonElement>(
        '.lemma-zoom-readout-btn'
      );
      expect(stage).not.toBeNull();
      expect(readout?.textContent).toBe('100%');
      expect(stage?.style.getPropertyValue('--doc-scale')).toBe('1.0000');

      // Simulate maximizing window to 1920px wide -> auto proportional scaling (~168%)
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', {
          configurable: true,
          writable: true,
          value: 1920,
        });
        window.dispatchEvent(new Event('resize'));
      });

      expect(readout?.textContent).toBe('168%');
      expect(
        parseFloat(stage?.style.getPropertyValue('--doc-scale') ?? '1')
      ).toBeCloseTo(1920 / 1140, 3);

      // Simulate Ctrl + Wheel Up to zoom in further (+8% manual multiplier)
      await act(async () => {
        window.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -100,
            ctrlKey: true,
            cancelable: true,
          })
        );
      });

      expect(
        parseFloat(stage?.style.getPropertyValue('--doc-scale') ?? '1')
      ).toBeCloseTo((1920 / 1140) * 1.08, 3);

      // Click zoom readout button (or Ctrl+0) to reset manual offset back to auto window fit
      await act(async () => {
        readout!.click();
      });

      expect(readout?.textContent).toBe('168%');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('6. auto-opens Word-style right comment rail when opening a commented .md paper and saves resolved state on blur', async () => {
    const reviewedPath = '/demo/advisor-reviewed.md';
    const reviewedMd = [
      '# 实证识别策略',
      '',
      '本文使用 <mark data-color="green">双重差分模型</mark> 估计政策冲击，假设 <span data-comment="这里平行趋势检验样本期偏短，建议补充事件研究法前4期系数图" data-id="c-prof-1" data-time="2026-11-15 19:20">处理组与控制组在政策前具有共同趋势</span>。',
    ].join('\n');

    await tauriBridge.writeMarkdownFile(reviewedPath, reviewedMd);

    const pickSpy = vi
      .spyOn(tauriBridge, 'pickMarkdownFile')
      .mockResolvedValue(reviewedPath);
    const writeSpy = vi.spyOn(tauriBridge, 'writeMarkdownFile');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(React.createElement(App));
      });

      const openBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('打开本地文件')
      );
      expect(openBtn).toBeDefined();

      await act(async () => {
        openBtn!.click();
      });
      writeSpy.mockClear();

      // Green highlight and comment anchor are rendered inside #write
      expect(
        container.querySelector('#write mark.lemma-highlight[data-color="green"]')
      ).not.toBeNull();
      expect(
        container.querySelector('#write .lemma-comment-anchor[data-comment-id="c-prof-1"]')
      ).not.toBeNull();

      // Right-side comment rail automatically opened showing #1 and advisor's comment
      const rail = container.querySelector('aside.lemma-comment-rail');
      expect(rail).not.toBeNull();
      expect(rail?.textContent).toContain('平行趋势检验样本期偏短');
      expect(rail?.textContent).toContain('处理组与控制组在政策前具有共同趋势');

      // Click "已解决" on card #1 -> strips comment mark while keeping underlying text & green highlight
      const resolveBtn = Array.from(
        rail!.querySelectorAll<HTMLButtonElement>('button')
      ).find((b) => b.textContent?.includes('已解决'));
      expect(resolveBtn).toBeDefined();

      await act(async () => {
        resolveBtn!.click();
      });

      expect(
        container.querySelector('#write .lemma-comment-anchor')
      ).toBeNull();

      // Window blur flushes updated clean Markdown to disk immediately
      await act(async () => {
        window.dispatchEvent(new Event('blur'));
      });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [, savedMd] = writeSpy.mock.calls[0];
      expect(savedMd).not.toContain('data-comment=');
      expect(savedMd).toContain('<mark data-color="green">双重差分模型</mark>');
      expect(savedMd).toContain('处理组与控制组在政策前具有共同趋势');
    } finally {
      pickSpy.mockRestore();
      writeSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
