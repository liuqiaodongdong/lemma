import React, { createRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { generateHTML, getSchema } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { createLemmaExtensions } from '../schemaExtensions';
import { normalizeAiMathDelimiters } from '../codec/mathDelimiterNormalizer';
import {
  parseMarkdownToDocJson,
  parseMarkdownToPmNode,
} from '../codec/markdownParser';
import { serializeDocToMarkdown } from '../codec/markdownSerializer';
import { sanitizeSvgCode } from '../extensions/SvgBlock';
import {
  LemmaEditor,
  extractOutlineHeadings,
  type LemmaEditorHandle,
} from '../LemmaEditor';
import type { OutlineHeading } from '../../types/contract';

describe('Lemma Markdown <-> ProseMirror AST Codec & Extensions', () => {
  const resolveAssetUrl = (rawSrc: string) =>
    rawSrc.startsWith('http')
      ? rawSrc
      : `asset://localhost/C%3A/papers/macro/${rawSrc}`;

  const extensions = createLemmaExtensions({ resolveAssetUrl });
  const schema = getSchema(extensions);

  describe('1. AI Math Delimiter Normalizer', () => {
    it('converts \\(...\\) and \\[...\\] outside code blocks while leaving fenced and inline code untouched', () => {
      const input = [
        'Consider discount factor \\( \\beta \\in (0, 1) \\) and CRRA utility \\(u(c) = \\frac{c^{1-\\sigma}}{1-\\sigma}\\).',
        '',
        '\\[',
        'V(k) = \\max_{c} \\left\\{ u(c) + \\beta V(f(k) - c) \\right\\}',
        '\\]',
        '',
        'Inline code like `\\( x + y \\)` and ``\\[ a = b \\]`` must stay untouched.',
        '',
        '```python',
        '# Do not touch AI delimiters inside code fences:',
        'raw_tex = r"\\[ E[X] = \\mu \\] and \\( \\sigma^2 \\)"',
        '```',
        '',
        '~~~tex',
        '\\[ \\int_0^1 x^2 dx = \\frac{1}{3} \\]',
        '~~~',
      ].join('\n');

      const output = normalizeAiMathDelimiters(input);

      expect(output).toContain('$\\beta \\in (0, 1)$');
      expect(output).toContain('$u(c) = \\frac{c^{1-\\sigma}}{1-\\sigma}$');
      expect(output).toContain(
        '$$\nV(k) = \\max_{c} \\left\\{ u(c) + \\beta V(f(k) - c) \\right\\}\n$$'
      );
      expect(output).toContain('`\\( x + y \\)`');
      expect(output).toContain('``\\[ a = b \\]``');
      expect(output).toContain(
        'raw_tex = r"\\[ E[X] = \\mu \\] and \\( \\sigma^2 \\)"'
      );
      expect(output).toContain(
        '~~~\n'.replace('~~~\n', '') +
          '~~~tex\n\\[ \\int_0^1 x^2 dx = \\frac{1}{3} \\]\n~~~'
      );
    });

    it('preserves LaTeX row-spacing \\[6pt] inside aligned equations without mistaking it for AI delimiters', () => {
      const input = [
        '\\[',
        '\\begin{aligned}',
        '\\mathcal{L} &= u(c_t) + \\lambda_t (w_t - c_t) \\\\[6pt]',
        '\\frac{\\partial \\mathcal{L}}{\\partial c_t} &= u\'(c_t) - \\lambda_t = 0',
        '\\end{aligned}',
        '\\]',
      ].join('\n');

      const normalized = normalizeAiMathDelimiters(input);
      expect(normalized).toContain('\\\\[6pt]');
      expect(normalized.startsWith('$$\n\\begin{aligned}')).toBe(true);
      expect(normalized.endsWith('\\end{aligned}\n$$')).toBe(true);
    });
  });

  describe('2. Inline & Multi-Line Bellman / Lagrangian Math Round-Trip', () => {
    it('round-trips inline math and multi-line \\begin{aligned} Bellman & Lagrangian blocks cleanly', () => {
      const source = [
        '## 1. Household Optimization ($\\beta$-Discounted)',
        '',
        'Given state $k_t > 0$ and Lagrange multiplier $\\lambda_t$, solve:',
        '',
        '$$',
        '\\begin{aligned}',
        'V(k_t) &= \\max_{c_t, k_{t+1}} \\left\\{ \\frac{c_t^{1 - \\gamma}}{1 - \\gamma} + \\beta \\mathbb{E}_t [V(k_{t+1})] \\right\\} \\\\[4pt]',
        '\\mathcal{L} &= u(c_t) + \\beta V(k_{t+1}) + \\lambda_t \\left( A_t k_t^\\alpha + (1 - \\delta) k_t - c_t - k_{t+1} \\right)',
        '\\end{aligned}',
        '$$',
      ].join('\n');

      const doc1 = parseMarkdownToPmNode(source, schema);
      const serialized = serializeDocToMarkdown(doc1);

      expect(serialized).toBe(source);

      // Second pass idempotence check
      const doc2 = parseMarkdownToPmNode(serialized, schema);
      expect(doc2.toJSON()).toEqual(doc1.toJSON());

      // Verify OutlineHeading extraction preserves inline math
      const outline = extractOutlineHeadings(doc1);
      expect(outline).toHaveLength(1);
      expect(outline[0].level).toBe(2);
      expect(outline[0].text).toBe('1. Household Optimization ($\\beta$-Discounted)');
    });
  });

  describe('3. Booktabs GFM Regression Table Round-Trip', () => {
    it('round-trips academic regression tables with math, empty cells, formatting, and escaped pipes', () => {
      const tableMd = [
        '| Variable | (1) OLS | (2) IV-2SLS | Notes |',
        '| --- | --- | --- | --- |',
        '| $\\log(K_{it})$ | 0.342*** | 0.418*** | Baseline \\| Robust |',
        '|  | (0.041) | (0.056) |  |',
        '| $R^2$ | 0.684 | 0.671 | **Clustered SE** |',
      ].join('\n');

      const doc = parseMarkdownToPmNode(tableMd, schema);
      expect(doc.firstChild?.type.name).toBe('table');
      expect(doc.firstChild?.childCount).toBe(4);

      const roundTripped = serializeDocToMarkdown(doc);
      expect(roundTripped).toBe(tableMd);

      // Re-parse and verify AST structural identity
      const reparsed = parseMarkdownToPmNode(roundTripped, schema);
      expect(reparsed.toJSON()).toEqual(doc.toJSON());
    });
  });

  describe('4. SVG Diagram Block Round-Trip & Security Sanitization', () => {
    it('parses ```svg fenced blocks into svgBlock and round-trips cleanly', () => {
      const svgDiagram = [
        '<svg viewBox="0 0 320 200" width="320" height="200" xmlns="http://www.w3.org/2000/svg">',
        '  <defs>',
        '    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">',
        '      <polygon points="0 0, 8 4, 0 8" fill="#1e293b" />',
        '    </marker>',
        '  </defs>',
        '  <style>.axis { stroke: #1e293b; stroke-width: 1.5; }</style>',
        '  <g>',
        '    <line x1="30" y1="170" x2="290" y2="170" class="axis" marker-end="url(#arrow)" />',
        '    <path d="M 40 40 Q 150 160 270 165" fill="none" stroke="#2563eb" stroke-width="2" />',
        '    <circle cx="155" cy="108" r="4" fill="#dc2626" />',
        '    <rect x="162" y="92" width="48" height="20" fill="none" />',
        '    <text x="165" y="106"><tspan>E*</tspan></text>',
        '  </g>',
        '</svg>',
      ].join('\n');

      const md = `\`\`\`svg\n${svgDiagram}\n\`\`\``;
      const doc = parseMarkdownToPmNode(md, schema);

      expect(doc.firstChild?.type.name).toBe('svgBlock');
      expect(doc.firstChild?.attrs.code).toBe(svgDiagram);

      const serialized = serializeDocToMarkdown(doc);
      expect(serialized).toBe(md);
    });

    it('strips <script> tags and on*= event handlers while preserving vector elements', () => {
      const untrustedSvg = [
        '<svg onload="alert(1)" viewBox="0 0 100 100">',
        '  <script type="text/javascript">window.pwned = true;</script>',
        '  <circle cx="50" cy="50" r="40" onclick=\'steal()\' fill="teal" />',
        '  <a href="javascript:evil()"><text x="10" y="20">Label</text></a>',
        '</svg>',
      ].join('\n');

      const clean = sanitizeSvgCode(untrustedSvg);
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('onload=');
      expect(clean).not.toContain('onclick=');
      expect(clean).not.toContain('javascript:');
      expect(clean).toContain('<circle cx="50" cy="50" r="40" fill="teal" />');
      expect(clean).toContain('<text x="10" y="20">Label</text>');
    });
  });

  describe('5. Callout Block (> [!IMPORTANT]) Round-Trip & tcolorbox HTML', () => {
    it('parses > [!IMPORTANT] into callout node, renders md-alert HTML, and round-trips cleanly', () => {
      const calloutMd = [
        '> [!IMPORTANT]',
        '> Transversality condition $\\lim_{t \\to \\infty} \\beta^t \\lambda_t k_{t+1} = 0$ is necessary for optimality.',
      ].join('\n');

      const docJson = parseMarkdownToDocJson(calloutMd);
      expect(docJson.content?.[0]?.type).toBe('callout');
      expect(docJson.content?.[0]?.attrs).toEqual({ kind: 'important' });

      const docNode = parseMarkdownToPmNode(calloutMd, schema);
      const serialized = serializeDocToMarkdown(docNode);
      expect(serialized).toBe(calloutMd);

      const html = generateHTML(docJson, extensions);
      expect(html).toContain('class="md-alert md-alert-important"');
      expect(html).toContain('data-callout="important"');
      expect(html).toContain('<p class="md-alert-title" contenteditable="false">Important</p>');
      expect(html).toContain('class="md-alert-content"');
    });
  });

  describe('6. Relative LocalImage Path Preservation vs Asset URL Resolution', () => {
    it('retains raw relative src in AST & serialized Markdown while rendering resolved asset:// URL in HTML', () => {
      const imageMd = '![图1](assets/eq.png)';
      const docJson = parseMarkdownToDocJson(imageMd);

      expect(docJson.content?.[0]).toEqual({
        type: 'image',
        attrs: {
          src: 'assets/eq.png',
          alt: '图1',
          title: null,
        },
      });

      const html = generateHTML(docJson, extensions);
      expect(html).toContain(
        'src="asset://localhost/C%3A/papers/macro/assets/eq.png"'
      );
      expect(html).toContain('data-raw-src="assets/eq.png"');
      expect(html).toContain('alt="图1"');

      const pmDoc = parseMarkdownToPmNode(imageMd, schema);
      expect(pmDoc.firstChild?.attrs.src).toBe('assets/eq.png');

      const serialized = serializeDocToMarkdown(pmDoc);
      expect(serialized).toBe('![图1](assets/eq.png)');
      expect(serialized).not.toContain('asset://');
    });
  });

  describe('7. Task Lists, Nested Lists, Code Fences, and Empty Doc', () => {
    it('round-trips task lists, nested bullet lists, and fenced code blocks', () => {
      const md = [
        '- [x] Derive Euler equation $u\'(c_t) = \\beta R_{t+1} u\'(c_{t+1})$',
        '- [ ] Calibrate $\\sigma = 2.0$ and $\\beta = 0.99$',
        '',
        '```r',
        'feols(y ~ x1 + x2 | id + year, data = panel_df)',
        '```',
      ].join('\n');

      const doc = parseMarkdownToPmNode(md, schema);
      expect(serializeDocToMarkdown(doc)).toBe(md);
    });

    it('ensures an empty Markdown string still produces a valid ProseMirror doc with one empty paragraph', () => {
      const docJson = parseMarkdownToDocJson('');
      expect(docJson).toEqual({
        type: 'doc',
        content: [{ type: 'paragraph' }],
      });
      const pmDoc = parseMarkdownToPmNode('', schema);
      expect(serializeDocToMarkdown(pmDoc)).toBe('');
    });
  });

  describe('8. LemmaEditor Component, NodeViews, External Reload & Plugin Registration', () => {
    it('renders KaTeX/SVG/Callout/LocalImage NodeViews, preserves scrollTop on setMarkdownFromExternal without emitting dirty update, and registers extraPlugins', async () => {
      // Enable React 18 act environment flag for clean test output
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      const handleRef = createRef<LemmaEditorHandle>();
      const onMarkdownChange = vi.fn();
      let latestOutline: OutlineHeading[] = [];
      const customPluginKey = new PluginKey('testDiffPlugin');
      const customPlugin = new Plugin({
        key: customPluginKey,
        state: {
          init: () => 'plugin-active',
          apply: (_tr, val) => val,
        },
      });

      const initialMd = [
        '# Section 1',
        '',
        'Inline Euler $u\'(c_t) = \\beta R_{t+1} u\'(c_{t+1})$.',
        '',
        '![图1](assets/eq.png)',
        '',
        '> [!NOTE]',
        '> Balanced growth path holds.',
        '',
        '```svg',
        '<svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" /></svg>',
        '```',
      ].join('\n');

      await act(async () => {
        root.render(
          React.createElement(LemmaEditor, {
            ref: handleRef,
            initialMarkdown: initialMd,
            currentFilePath: 'C:/papers/macro/model.md',
            resolveAssetUrl,
            onMarkdownChange,
            onOutlineChange: (headings) => {
              latestOutline = headings;
            },
            hideDeletions: true,
            extraPlugins: [customPlugin],
          })
        );
      });

      const writeEl = container.querySelector('#write');
      expect(writeEl).not.toBeNull();
      expect(writeEl?.classList.contains('lemma-hide-deletions')).toBe(true);

      // Verify KaTeX inline, LocalImage resolved URL, Callout, and SVG figure rendered
      expect(container.querySelector('.lemma-math-inline .katex')).not.toBeNull();
      const imgEl = container.querySelector('figure.lemma-local-image img');
      expect(imgEl?.getAttribute('src')).toBe(
        'asset://localhost/C%3A/papers/macro/assets/eq.png'
      );
      expect(container.querySelector('.md-alert.md-alert-note')).not.toBeNull();
      expect(container.querySelector('figure.lemma-svg-figure svg circle')).not.toBeNull();

      // Verify extraPlugin was registered onto ProseMirror state
      const editor = handleRef.current?.getEditor();
      expect(editor).not.toBeNull();
      expect(customPluginKey.getState(editor!.state)).toBe('plugin-active');

      // Verify getMarkdown preserves raw relative image path
      expect(handleRef.current?.getMarkdown()).toBe(initialMd);
      expect(onMarkdownChange).not.toHaveBeenCalled();

      // Simulate scroll position and external reload (e.g. Claude Code edited file on disk)
      const scrollEl = container.querySelector('.lemma-desk-scroll') as HTMLDivElement;
      scrollEl.scrollTop = 240;

      const updatedExternalMd = [
        '# Section 1',
        '',
        '## Section 1.1 ($r > g$)',
        '',
        '\\[',
        'Y_t = A_t K_t^\\alpha L_t^{1-\\alpha}',
        '\\]',
      ].join('\n');

      await act(async () => {
        handleRef.current?.setMarkdownFromExternal(updatedExternalMd);
      });

      // External reload MUST NOT falsely mark editor dirty via onMarkdownChange
      expect(onMarkdownChange).not.toHaveBeenCalled();
      expect(scrollEl.scrollTop).toBe(240);
      expect(latestOutline).toHaveLength(2);
      expect(latestOutline[1].text).toBe('Section 1.1 ($r > g$)');
      expect(container.querySelector('.lemma-math-block .katex-display')).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });
  });
});
