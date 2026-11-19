import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { Editor, Node as TiptapNode } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import {
  applyAcceptHunkToBaseline,
  buildRevertTransaction,
  computeDocDiff,
} from '../diffEngine';
import {
  createDiffReviewPlugin,
  createSanitizedSvgContainer,
  diffPluginKey,
} from '../diffPlugin';
import { useDiffReview, type UseDiffReviewResult } from '../useDiffReview';

const testSchema = new Schema({
  nodes: {
    doc: {
      content: 'block+',
    },
    paragraph: {
      group: 'block',
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM() {
        return ['p', 0];
      },
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      parseDOM: [{ tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }],
      toDOM(node) {
        return [`h${node.attrs.level}`, 0];
      },
    },
    blockquote: {
      group: 'block',
      content: 'block+',
      parseDOM: [{ tag: 'blockquote' }],
      toDOM() {
        return ['blockquote', 0];
      },
    },
    callout: {
      group: 'block',
      content: 'block+',
      attrs: { kind: { default: 'note' } },
      toDOM(node) {
        return ['div', { 'data-callout': node.attrs.kind }, 0];
      },
    },
    bulletList: {
      group: 'block',
      content: 'listItem+',
      toDOM() {
        return ['ul', 0];
      },
    },
    listItem: {
      content: 'paragraph block*',
      toDOM() {
        return ['li', 0];
      },
    },
    mathBlock: {
      group: 'block',
      atom: true,
      attrs: { latex: { default: '' } },
      toDOM(node) {
        return ['div', { class: 'math-block', 'data-latex': node.attrs.latex }];
      },
    },
    svgBlock: {
      group: 'block',
      atom: true,
      attrs: { code: { default: '' } },
      toDOM(node) {
        return ['div', { class: 'svg-block', 'data-svg': node.attrs.code }];
      },
    },
    table: {
      group: 'block',
      content: 'tableRow+',
      toDOM() {
        return ['table', ['tbody', 0]];
      },
    },
    tableRow: {
      content: 'tableCell+',
      toDOM() {
        return ['tr', 0];
      },
    },
    tableCell: {
      content: 'paragraph+',
      toDOM() {
        return ['td', 0];
      },
    },
    text: {
      group: 'inline',
    },
    mathInline: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { latex: { default: '' } },
      toDOM(node) {
        return ['span', { class: 'math-inline', 'data-latex': node.attrs.latex }];
      },
    },
  },
  marks: {
    bold: {
      toDOM() {
        return ['strong', 0];
      },
    },
  },
});

const doc = (...blocks: PMNode[]) => testSchema.nodes.doc.create(null, blocks);
const p = (...inline: PMNode[]) =>
  testSchema.nodes.paragraph.create(null, inline);
const h = (level: number, ...inline: PMNode[]) =>
  testSchema.nodes.heading.create({ level }, inline);
const txt = (s: string) => testSchema.text(s);
const mathIn = (latex: string) => testSchema.nodes.mathInline.create({ latex });
const mathBlk = (latex: string) => testSchema.nodes.mathBlock.create({ latex });
const svgBlk = (code: string) => testSchema.nodes.svgBlock.create({ code });
const tbl = (rows: string[][]) =>
  testSchema.nodes.table.create(
    null,
    rows.map((r) =>
      testSchema.nodes.tableRow.create(
        null,
        r.map((cellText) =>
          testSchema.nodes.tableCell.create(null, [p(txt(cellText))])
        )
      )
    )
  );

describe('Lemma AST & CJK/Formula/SVG Diff Engine', () => {
  it('detects Chinese academic character/word insertions and verifies exact ProseMirror inline positions', () => {
    const baseline = doc(
      h(1, txt('跨期消费选择理论')),
      p(txt('代表性消费者的边际效用递减。'))
    );
    const current = doc(
      h(1, txt('跨期消费选择理论')),
      p(txt('代表性消费者的跨期边际效用严格递减。'))
    );

    const hunks = computeDocDiff(baseline, current);
    expect(hunks).toHaveLength(1);

    const hunk = hunks[0];
    expect(hunk.kind).toBe('text-modified');
    expect(hunk.summary).toBe('修改了正文段落');
    expect(current.nodeAt(hunk.newFrom)?.type.name).toBe('paragraph');
    expect(hunk.newTo - hunk.newFrom).toBe(
      current.nodeAt(hunk.newFrom)!.nodeSize
    );

    // Verify inline segments capture exact Chinese additions
    expect(hunk.segments).toEqual([
      { type: 'equal', text: '代表性消费者的' },
      { type: 'insert', text: '跨期' },
      { type: 'equal', text: '边际效用' },
      { type: 'insert', text: '严格' },
      { type: 'equal', text: '递减。' },
    ]);

    // Verify positioned inline inserts slice exact text out of currentDoc
    expect(hunk.inlineInserts).toHaveLength(2);
    const [ins1, ins2] = hunk.inlineInserts!;
    expect(current.textBetween(ins1.from, ins1.to)).toBe('跨期');
    expect(current.textBetween(ins2.from, ins2.to)).toBe('严格');
    expect(hunk.inlineDeletes).toEqual([]);
  });

  it('diffs inline math formulas ($\\beta_1$ -> $\\beta_2$) atomically inside a Chinese paragraph', () => {
    const baseline = doc(
      p(txt('工具变量回归中斜率系数 '), mathIn('\\beta_1'), txt(' 显著为正。'))
    );
    const current = doc(
      p(
        txt('工具变量回归中斜率系数 '),
        mathIn('\\beta_2'),
        txt(' 高度显著为正。')
      )
    );

    const hunks = computeDocDiff(baseline, current);
    expect(hunks).toHaveLength(1);

    const hunk = hunks[0];
    expect(hunk.kind).toBe('text-modified');

    // Verify mathInline delete & insert segments are marked with isInlineMath: true
    expect(hunk.segments).toEqual([
      { type: 'equal', text: '工具变量回归中斜率系数 ' },
      { type: 'delete', text: '\\beta_1', isInlineMath: true },
      { type: 'insert', text: '\\beta_2', isInlineMath: true },
      { type: 'equal', text: ' ' },
      { type: 'insert', text: '高度' },
      { type: 'equal', text: '显著为正。' },
    ]);

    // Verify deleted inline math anchors right at the inserted \beta_2 node position
    expect(hunk.inlineDeletes).toHaveLength(1);
    expect(hunk.inlineDeletes![0].isInlineMath).toBe(true);
    expect(hunk.inlineDeletes![0].text).toBe('\\beta_1');

    const mathInsert = hunk.inlineInserts![0];
    const nodeAtInsert = current.nodeAt(mathInsert.from);
    expect(nodeAtInsert?.type.name).toBe('mathInline');
    expect(nodeAtInsert?.attrs.latex).toBe('\\beta_2');
    expect(hunk.inlineDeletes![0].pos).toBe(mathInsert.from);

    const wordInsert = hunk.inlineInserts![1];
    expect(current.textBetween(wordInsert.from, wordInsert.to)).toBe('高度');
  });

  it('pairs modified Bellman display mathBlock into a single math-modified hunk', () => {
    const oldBellman =
      'V(k) = \\max_{c} \\left\\{ u(c) + \\beta V(k^{\\prime}) \\right\\}';
    const newBellman =
      'V(k, z) = \\max_{c, k^{\\prime}} \\left\\{ u(c) + \\beta \\mathbb{E}[V(k^{\\prime}, z^{\\prime}) \\mid z] \\right\\}';

    const baseline = doc(p(txt('动态规划核心贝尔曼方程如下：')), mathBlk(oldBellman));
    const current = doc(p(txt('动态规划核心贝尔曼方程如下：')), mathBlk(newBellman));

    const hunks = computeDocDiff(baseline, current);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].kind).toBe('math-modified');
    expect(hunks[0].summary).toBe('修改了数学公式');
    expect(hunks[0].oldLatex).toBe(oldBellman);
    expect(hunks[0].newLatex).toBe(newBellman);
    expect(current.nodeAt(hunks[0].newFrom)?.type.name).toBe('mathBlock');
  });

  it('pairs modified svgBlock supply-demand diagram into svg-modified and sanitizes SVG safely', () => {
    const oldSvg =
      '<svg viewBox="0 0 200 200"><line x1="20" y1="180" x2="180" y2="20" stroke="#1e3a8a" /></svg>';
    const newSvg =
      '<svg viewBox="0 0 200 200"><line x1="20" y1="180" x2="180" y2="20" stroke="#1e3a8a" /><line x1="20" y1="20" x2="180" y2="180" stroke="#dc2626" /></svg>';

    const baseline = doc(svgBlk(oldSvg));
    const current = doc(svgBlk(newSvg));

    const hunks = computeDocDiff(baseline, current);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].kind).toBe('svg-modified');
    expect(hunks[0].summary).toBe('修改了 SVG 矢量图表');
    expect(hunks[0].oldSvg).toBe(oldSvg);
    expect(hunks[0].newSvg).toBe(newSvg);

    // Verify XSS vector removal in SVG sanitizer
    const dirtySvg =
      '<svg viewBox="0 0 100 100" onload="alert(1)"><script>alert(2)</script><circle cx="50" cy="50" r="30" onclick="evil()" /><a href="javascript:alert(3)"><text>均衡点 E</text></a></svg>';
    const sanitized = createSanitizedSvgContainer(dirtySvg);
    expect(sanitized.querySelector('script')).toBeNull();
    expect(sanitized.querySelector('svg')?.getAttribute('onload')).toBeNull();
    expect(
      sanitized.querySelector('circle')?.getAttribute('onclick')
    ).toBeNull();
    expect(sanitized.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(sanitized.textContent).toContain('均衡点 E');
  });

  it('detects table-modified, pure block-added, and pure block-deleted hunks accurately', () => {
    const baseline = doc(
      p(txt('引言段落保持不变。')),
      p(txt('这一段旧文献综述将被 AI 删除。')),
      tbl([
        ['变量', '系数'],
        ['教育年限', '0.082***'],
      ])
    );

    const current = doc(
      p(txt('引言段落保持不变。')),
      tbl([
        ['变量', '系数'],
        ['教育年限', '0.095***'],
      ]),
      mathBlk('y_i = \\alpha + \\beta \\text{Edu}_i + \\varepsilon_i')
    );

    const hunks = computeDocDiff(baseline, current);
    expect(hunks).toHaveLength(3);

    // 1. Deleted paragraph anchored right before the table
    expect(hunks[0].kind).toBe('block-deleted');
    expect(hunks[0].newFrom).toBe(hunks[0].newTo);
    expect(hunks[0].oldPreviewText).toBe('这一段旧文献综述将被 AI 删除。');

    // 2. Modified three-line table
    expect(hunks[1].kind).toBe('table-modified');
    expect(hunks[1].summary).toBe('修改了三线表格');
    expect(hunks[1].oldPreviewText).toContain('0.082***');
    expect(hunks[1].newPreviewText).toContain('0.095***');

    // 3. Newly added mathBlock at the end
    expect(hunks[2].kind).toBe('block-added');
    expect(hunks[2].summary).toBe('新增了数学公式');
    expect(hunks[2].oldNodesJson).toEqual([]);
  });

  it('reconstructs oldNodesJson and applies tr.replaceWith to revert a single hunk without disturbing other AI changes', () => {
    const baseline = doc(
      p(txt('消费理论核心假设：边际效用递减。')),
      mathBlk('u(c) = \\ln(c)'),
      p(txt('旧版附录：早期农业部门静态出清模型。'))
    );

    const aiUpdated = doc(
      p(txt('消费理论核心假设：跨期边际效用严格递减。')),
      mathBlk('u(c) = \\frac{c^{1-\\sigma} - 1}{1 - \\sigma}'),
      p(txt('实证稳健性检验支持动态面板广义矩估计结果。'))
    );

    let state = EditorState.create({ doc: aiUpdated });
    const initialHunks = computeDocDiff(baseline, state.doc);
    // Expect: [0] modified p1, [1] modified mathBlock, [2] deleted old appendix, [3] added robustness check
    expect(initialHunks.map((h) => h.kind)).toEqual([
      'text-modified',
      'math-modified',
      'block-deleted',
      'block-added',
    ]);

    // Revert ONLY hunk[1] (the CRRA utility formula back to log utility) via tr.replaceWith
    const mathHunk = initialHunks[1];
    const oldNodes = mathHunk.oldNodesJson.map((json) =>
      state.schema.nodeFromJSON(json)
    );
    state = state.apply(
      state.tr.replaceWith(mathHunk.newFrom, mathHunk.newTo, oldNodes)
    );

    // Recompute diff: math-modified hunk is gone, while p1, deleted block, and added block remain intact!
    const afterMathRevert = computeDocDiff(baseline, state.doc);
    expect(afterMathRevert.map((h) => h.kind)).toEqual([
      'text-modified',
      'block-deleted',
      'block-added',
    ]);
    expect(state.doc.child(0).textContent).toBe(
      '消费理论核心假设：跨期边际效用严格递减。'
    );
    expect(state.doc.child(1).attrs.latex).toBe('u(c) = \\ln(c)');
    expect(state.doc.child(2).textContent).toBe(
      '实证稳健性检验支持动态面板广义矩估计结果。'
    );

    // Now revert the deleted paragraph (afterMathRevert[1]) to restore it!
    const delHunk = afterMathRevert[1];
    state = state.apply(buildRevertTransaction(state, delHunk));

    const afterDelRevert = computeDocDiff(baseline, state.doc);
    expect(afterDelRevert.map((h) => h.kind)).toEqual([
      'text-modified',
      'block-added',
    ]);
    expect(state.doc.child(2).textContent).toBe(
      '旧版附录：早期农业部门静态出清模型。'
    );
  });

  it('accepts a single hunk onto baselineDoc cleanly, leaving remaining hunks with exact positions', () => {
    const baseline = doc(
      p(txt('第一段原始文本。')),
      mathBlk('Y = A K^\\alpha L^{1-\\alpha}'),
      p(txt('第三段原始文本。'))
    );

    const current = doc(
      p(txt('第一段已被修改且变长了很多的文本。')),
      mathBlk('Y = A K^\\alpha (h L)^{1-\\alpha}'),
      p(txt('第三段同样被修改的文本。'))
    );

    const hunks = computeDocDiff(baseline, current);
    expect(hunks).toHaveLength(3);

    // Accept ONLY hunk 0 (first paragraph)
    const nextBaseline = applyAcceptHunkToBaseline(baseline, current, hunks[0]);
    const remaining = computeDocDiff(nextBaseline, current);

    expect(remaining).toHaveLength(2);
    expect(remaining[0].kind).toBe('math-modified');
    expect(remaining[1].kind).toBe('text-modified');

    // Verify exact ProseMirror positions in currentDoc for the remaining 2 hunks
    expect(current.nodeAt(remaining[0].newFrom)?.type.name).toBe('mathBlock');
    expect(current.nodeAt(remaining[1].newFrom)?.textContent).toBe(
      '第三段同样被修改的文本。'
    );
  });

  it('renders ProseMirror decorations, handles button clicks, toggles deletions, and survives live user typing', () => {
    const baseline = doc(
      p(txt('消费函数满足 '), mathIn('\\beta_1'), txt(' 假设。')),
      mathBlk('r = \\rho + \\theta g'),
      p(txt('被删除的附录说明。'))
    );
    const current = doc(
      p(txt('消费函数严格满足 '), mathIn('\\beta_2'), txt(' 假设。')),
      mathBlk('r = \\rho + \\theta g - \\frac{1}{2}\\theta^2 \\sigma^2')
    );

    const onAcceptHunk = vi.fn();
    const onRevertHunk = vi.fn();
    const plugin = createDiffReviewPlugin({ onAcceptHunk, onRevertHunk });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const state = EditorState.create({
      doc: current,
      plugins: [plugin],
    });
    const view = new EditorView(host, { state });

    try {
      const hunks = computeDocDiff(baseline, view.state.doc);
      expect(hunks).toHaveLength(3);

      // Activate plugin decorations
      view.dispatch(
        view.state.tr.setMeta(diffPluginKey, {
          baselineDoc: baseline,
          hunks,
          activeHunkIndex: 0,
          showDeletions: true,
        })
      );

      // Check exact CSS classes in DOM
      expect(host.querySelectorAll('.lemma-diff-ins').length).toBeGreaterThan(0);
      expect(host.querySelectorAll('.lemma-diff-del').length).toBe(1);
      expect(host.querySelector('.lemma-diff-del .katex')).not.toBeNull();
      expect(host.querySelector('.lemma-diff-compare-card')).not.toBeNull();
      expect(host.querySelector('.lemma-diff-compare-card')?.textContent).toContain(
        '【修改前】'
      );
      expect(host.querySelector('.lemma-diff-compare-card')?.textContent).toContain(
        '【修改后】'
      );
      expect(host.querySelector('.lemma-diff-block-deleted')).not.toBeNull();
      expect(host.querySelector('.lemma-diff-active-hunk')).not.toBeNull();
      expect(host.querySelectorAll('.lemma-diff-hunk-actions').length).toBe(3);

      // Click accept & revert buttons
      const acceptBtn = host.querySelector<HTMLButtonElement>(
        '.lemma-diff-btn-accept'
      )!;
      acceptBtn.click();
      expect(onAcceptHunk).toHaveBeenCalledWith(hunks[0].id);

      const revertBtn = host.querySelector<HTMLButtonElement>(
        '.lemma-diff-btn-revert'
      )!;
      revertBtn.click();
      expect(onRevertHunk).toHaveBeenCalledWith(hunks[0].id);

      // Hide deletions
      view.dispatch(
        view.state.tr.setMeta(diffPluginKey, {
          baselineDoc: baseline,
          hunks,
          activeHunkIndex: 1,
          showDeletions: false,
        })
      );
      expect(host.querySelectorAll('.lemma-diff-del').length).toBe(0);
      expect(host.querySelector('.lemma-diff-block-deleted')).toBeNull();

      // Simulate direct user typing at start of document while hunks are visible — must NEVER throw
      expect(() => {
        view.dispatch(view.state.tr.insertText('【批注】', 1));
      }).not.toThrow();

      const mappedState = diffPluginKey.getState(view.state);
      expect(mappedState?.hunks.length).toBe(3);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('orchestrates full review lifecycle via useDiffReview with TipTap Editor (reviewExternalUpdate, navigation, acceptHunk, revertHunk, acceptAll)', () => {
    const MathBlockExt = TiptapNode.create({
      name: 'mathBlock',
      group: 'block',
      atom: true,
      addAttributes() {
        return { latex: { default: '' } };
      },
      parseHTML() {
        return [{ tag: 'div[data-math-block]' }];
      },
      renderHTML({ HTMLAttributes }) {
        return ['div', { 'data-math-block': '', ...HTMLAttributes }];
      },
    });

    const editorHost = document.createElement('div');
    document.body.appendChild(editorHost);

    const editor = new Editor({
      element: editorHost,
      extensions: [StarterKit, MathBlockExt],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '均衡利率由储蓄与投资共同决定。' }],
          },
          {
            type: 'mathBlock',
            attrs: { latex: 'S(r) = I(r)' },
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '货币中性在长期成立。' }],
          },
        ],
      },
    });

    const onAfterRevert = vi.fn();
    let latestHook!: UseDiffReviewResult;

    function TestHarness() {
      latestHook = useDiffReview({ editor, onAfterRevert });
      return null;
    }

    const reactContainer = document.createElement('div');
    const root = createRoot(reactContainer);

    try {
      act(() => {
        root.render(React.createElement(TestHarness));
      });

      act(() => {
        latestHook.markCurrentAsBaseline();
      });
      expect(latestHook.diffState.hasChanges).toBe(false);

      // Simulate external AI Agent updating 2 blocks
      act(() => {
        editor.commands.setContent({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '开放经济下均衡实际利率由储蓄、投资与净资本流出共同决定。',
                },
              ],
            },
            {
              type: 'mathBlock',
              attrs: { latex: 'S(r) = I(r) + NCO(r)' },
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '货币中性在长期成立。' }],
            },
          ],
        });
        latestHook.reviewExternalUpdate();
      });

      expect(latestHook.diffState.hasChanges).toBe(true);
      expect(latestHook.diffState.hunks).toHaveLength(2);
      expect(latestHook.diffState.activeHunkIndex).toBe(0);

      // Navigate next / prev hunk
      act(() => {
        latestHook.diffActions.goToNextHunk();
      });
      expect(latestHook.diffState.activeHunkIndex).toBe(1);

      act(() => {
        latestHook.diffActions.goToPrevHunk();
      });
      expect(latestHook.diffState.activeHunkIndex).toBe(0);

      // Accept first hunk (paragraph), leaving ONLY the mathBlock hunk
      const firstHunkId = latestHook.diffState.hunks[0].id;
      act(() => {
        latestHook.diffActions.acceptHunk(firstHunkId);
      });
      expect(latestHook.diffState.hunks).toHaveLength(1);
      expect(latestHook.diffState.hunks[0].kind).toBe('math-modified');

      // Revert remaining mathBlock hunk -> restores S(r) = I(r) and calls onAfterRevert
      const mathHunkId = latestHook.diffState.hunks[0].id;
      act(() => {
        latestHook.diffActions.revertHunk(mathHunkId);
      });

      expect(onAfterRevert).toHaveBeenCalledTimes(1);
      expect(latestHook.diffState.hasChanges).toBe(false);
      expect(latestHook.diffState.hunks).toHaveLength(0);
      expect(editor.state.doc.child(0).textContent).toBe(
        '开放经济下均衡实际利率由储蓄、投资与净资本流出共同决定。'
      );
      expect(editor.state.doc.child(1).attrs.latex).toBe('S(r) = I(r)');
    } finally {
      act(() => {
        root.unmount();
      });
      editor.destroy();
      editorHost.remove();
    }
  });
});
