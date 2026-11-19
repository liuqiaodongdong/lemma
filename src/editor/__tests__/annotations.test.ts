import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { createLemmaExtensions, createLemmaSchema } from '../schemaExtensions';
import { parseMarkdownToPmNode } from '../codec/markdownParser';
import { serializeDocToMarkdown } from '../codec/markdownSerializer';
import {
  addCommentAtRange,
  clearAllComments,
  extractDocumentComments,
  findCommentIdAtPos,
  removeCommentById,
  updateCommentTextById,
} from '../extensions/CommentMark';
import {
  applyHighlightColor,
  clearAllHighlights,
  getSelectionHighlightColor,
  hasAnyHighlightInDoc,
} from '../extensions/HighlightMark';
import { buildRevertTransaction, computeDocDiff } from '../../diff/diffEngine';
import { EditorState } from '@tiptap/pm/state';

describe('Annotations: Multi-color Highlights & Word-style Inline Comments', () => {
  const schema = createLemmaSchema();

  it('1. round-trips all 4 highlight colors (<mark> for yellow, <mark data-color="..."> for green/blue/pink)', () => {
    const md = [
      '基准回归中 <mark>核心系数显著为正</mark>，稳健性检验支持 <mark data-color="green">工具变量估计</mark>、',
      '<mark data-color="blue">安慰剂检验</mark> 与 <mark data-color="pink">异质性分析</mark>。',
    ].join('');

    const doc = parseMarkdownToPmNode(md, schema);
    expect(hasAnyHighlightInDoc(doc)).toBe(true);
    expect(serializeDocToMarkdown(doc)).toBe(md);
  });

  it('2. parses Typora ==highlight== (including inline math) without false-triggering on x == 1 or ===', () => {
    const input = [
      '实证结果显示 ==处理效应显著 ($p < 0.01$)==，而条件 `x == 1` 或文内 if x == 1 and y == 2 与 a === b 不应误判。',
    ].join('\n');

    const doc = parseMarkdownToPmNode(input, schema);
    const serialized = serializeDocToMarkdown(doc);
    expect(serialized).toContain('<mark>处理效应显著 ($p < 0.01$)</mark>');
    expect(serialized).toContain('if x == 1 and y == 2');
    expect(serialized).toContain('a === b');
  });

  it('3. round-trips multi-line Chinese comments with quotes, <, >, &, and | inside paragraphs & GFM tables', () => {
    const complexComment = '第一行：检查 p < 0.05 & "内生性"\n第二行：补充 IV | 2SLS 对照';
    const editor = new Editor({
      extensions: createLemmaExtensions(),
      content: '',
    });

    const initialMd = [
      '核心解释变量 $X_{it}$ 对全要素生产率具有显著促进作用。',
      '',
      '| 变量 | 系数 |',
      '| :--- | :---: |',
      '| DID 交互项 | 0.042*** |',
    ].join('\n');

    const loaded = parseMarkdownToPmNode(initialMd, editor.schema);
    editor.commands.setContent(loaded.toJSON());

    // Add comment across text + inline math in paragraph
    const id1 = addCommentAtRange(
      editor,
      1,
      15,
      complexComment,
      '2026-11-15 19:30'
    );
    expect(id1).toBeTruthy();

    // Find table cell "0.042***" and add comment containing | and newline
    let cellTextFrom = -1;
    let cellTextTo = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '0.042***') {
        cellTextFrom = pos;
        cellTextTo = pos + node.nodeSize;
      }
    });
    expect(cellTextFrom).toBeGreaterThan(0);
    const id2 = addCommentAtRange(
      editor,
      cellTextFrom,
      cellTextTo,
      '表内批注：建议汇报稳健标准误 | 聚类到城市层面\n并核对样本量',
      '2026-11-15 19:31'
    );
    expect(id2).toBeTruthy();

    const mdOut = serializeDocToMarkdown(editor.state.doc);
    // Re-parse serialized Markdown and verify 100% lossless comments + table integrity
    const reparsed = parseMarkdownToPmNode(mdOut, schema);
    const extracted = extractDocumentComments(reparsed);
    expect(extracted).toHaveLength(2);
    expect(extracted[0].text).toBe(complexComment);
    expect(extracted[0].quote).toContain('$X_{it}$');
    expect(extracted[1].text).toBe(
      '表内批注：建议汇报稳健标准误 | 聚类到城市层面\n并核对样本量'
    );
    expect(extracted[1].quote).toBe('0.042***');
    expect(serializeDocToMarkdown(reparsed)).toBe(mdOut);

    editor.destroy();
  });

  it('4. parses AI-authored <span data-comment="..."> (without data-id) and CriticMarkup {==...==}{>>...<<}', () => {
    const aiMd = [
      '模型假定 <span data-comment="建议在此处补充平行趋势检验图">处理组与对照组满足平行趋势</span>，',
      '且 {==工具变量满足排他性约束==}{>>排他性约束无法直接检验，需加强经济学机制论述<<}。',
    ].join('');

    const doc = parseMarkdownToPmNode(aiMd, schema);
    const comments = extractDocumentComments(doc);
    expect(comments).toHaveLength(2);
    expect(comments[0].id).toBeTruthy();
    expect(comments[0].quote).toBe('处理组与对照组满足平行趋势');
    expect(comments[0].text).toBe('建议在此处补充平行趋势检验图');
    expect(comments[1].quote).toBe('工具变量满足排他性约束');
    expect(comments[1].text).toBe('排他性约束无法直接检验，需加强经济学机制论述');
  });

  it('5. supports highlight + comment + bold + inline math + inline code and clean single/bulk removal', () => {
    const editor = new Editor({
      extensions: createLemmaExtensions(),
      content: '',
    });

    const md = '估计方程 $Y_{it} = \\beta X_{it}$ 使用 `reghdfe` 命令进行回归。';
    editor.commands.setContent(parseMarkdownToPmNode(md, editor.schema).toJSON());

    // Select full paragraph inline range and apply green highlight + comment
    const endPos = editor.state.doc.child(0).nodeSize;
    editor.commands.setTextSelection({ from: 1, to: endPos });
    applyHighlightColor(editor, 'green');
    expect(getSelectionHighlightColor(editor)).toBe('green');

    const commentId = addCommentAtRange(
      editor,
      1,
      endPos,
      '请补充固定效应说明',
      '2026-11-15 19:35'
    );
    expect(commentId).toBeTruthy();
    expect(findCommentIdAtPos(editor.state.doc, 3)).toBe(commentId);

    // Edit comment text
    expect(
      updateCommentTextById(editor, commentId!, '请补充年份与个体双向固定效应说明')
    ).toBe(true);
    expect(extractDocumentComments(editor.state.doc)[0].text).toBe(
      '请补充年份与个体双向固定效应说明'
    );

    // Round-trip serialized markdown
    const serialized = serializeDocToMarkdown(editor.state.doc);
    const reparsed = parseMarkdownToPmNode(serialized, editor.schema);
    expect(extractDocumentComments(reparsed)[0].text).toBe(
      '请补充年份与个体双向固定效应说明'
    );

    // Resolve comment -> keeps green highlight & underlying math/code intact!
    expect(removeCommentById(editor, commentId!)).toBe(true);
    expect(extractDocumentComments(editor.state.doc)).toHaveLength(0);
    expect(hasAnyHighlightInDoc(editor.state.doc)).toBe(true);

    // Clear all highlights -> restores exact original clean Markdown!
    expect(clearAllHighlights(editor)).toBe(true);
    expect(clearAllComments(editor)).toBe(false);
    expect(serializeDocToMarkdown(editor.state.doc)).toBe(md);

    editor.destroy();
  });

  it('6. integrates cleanly with AST computeDocDiff & single-hunk revert when external AI adds/edits comments', () => {
    const baseDoc = parseMarkdownToPmNode('本文采用双重差分法识别政策效应。', schema);
    const aiReviewedDoc = parseMarkdownToPmNode(
      '本文采用 <span data-comment="建议增加多期 DID 异质性处理效应稳健性检验" data-id="c-ai-1">双重差分法</span> 识别政策效应。',
      schema
    );

    const hunks = computeDocDiff(baseDoc, aiReviewedDoc);
    expect(hunks).toHaveLength(1);

    const state = EditorState.create({ doc: aiReviewedDoc, schema });
    const revertedState = state.apply(buildRevertTransaction(state, hunks[0]));
    expect(serializeDocToMarkdown(revertedState.doc)).toBe(
      '本文采用双重差分法识别政策效应。'
    );
  });
});
