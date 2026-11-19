import { InputRule, Node, mergeAttributes } from '@tiptap/core';

/**
 * Sanitizes raw SVG markup by stripping `<script>` elements, `on*=` inline event
 * handlers, and `javascript:` URIs while preserving full vector drawing elements
 * (`<svg>`, `<style>`, `<defs>`, `<marker>`, `<path>`, `<line>`, `<circle>`,
 * `<rect>`, `<polygon>`, `<g>`, `<text>`, `<tspan>`, etc.).
 */
export function sanitizeSvgCode(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(
      /\s+on[a-zA-Z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      ''
    )
    .replace(
      /(\b(?:xlink:)?href\s*=\s*["'])\s*javascript:[^"']*(['"])/gi,
      '$1#$2'
    );
}

/**
 * Enhances the rendered `<svg>` root element (display-only, never mutating Markdown source)
 * so diagrams with fixed pixel `width` + `viewBox` scale up crisply with `--doc-scale`.
 */
function makeRenderedSvgResponsive(sanitizedSvg: string): string {
  if (!sanitizedSvg) return '';
  return sanitizedSvg.replace(/<svg\b([^>]*)>/i, (fullMatch, attrs: string) => {
    const vbMatch = attrs.match(
      /\bviewBox\s*=\s*["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i
    );
    const widthMatch = attrs.match(
      /\bwidth\s*=\s*["']\s*([0-9.]+)(?:px)?\s*["']/i
    );
    const baseWidth = vbMatch
      ? parseFloat(vbMatch[1])
      : widthMatch
        ? parseFloat(widthMatch[1])
        : NaN;

    if (!Number.isFinite(baseWidth) || baseWidth <= 0) {
      return fullMatch;
    }

    const scaleStyle = `width: min(100%, calc(${baseWidth}px * var(--doc-scale, 1))); height: auto;`;
    if (/\bstyle\s*=\s*["']/i.test(attrs)) {
      const updatedAttrs = attrs.replace(
        /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i,
        (_m, q: string, existing: string) =>
          `style=${q}${existing.replace(/;?\s*$/, '; ')}${scaleStyle}${q}`
      );
      return `<svg${updatedAttrs}>`;
    }
    return `<svg${attrs} style="${scaleStyle}">`;
  });
}

export const SvgBlock = Node.create({
  name: 'svgBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-svg-code') ?? element.innerHTML ?? '',
        renderHTML: (attributes) => ({
          'data-svg-code': attributes.code ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'figure.lemma-svg-figure[data-svg-code]' },
      { tag: 'div[data-type="svg-block"]' },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'svg-block',
        class: 'lemma-svg-figure',
      }),
      ['pre', ['code', { class: 'language-svg' }, String(node.attrs.code ?? '')]],
    ];
  },

  addNodeView() {
    return ({ node: initialNode, editor, getPos }) => {
      let currentNode = initialNode;
      let committedCode = String(currentNode.attrs.code ?? '');
      let draft = committedCode;
      let isEditing = Boolean(
        editor.isEditable && committedCode.trim().length === 0
      );
      let isHovered = false;
      let isSelected = false;
      let focusRaf: number | null = null;
      let editorWrapEl: HTMLDivElement | null = null;
      let textareaEl: HTMLTextAreaElement | null = null;

      const dom = document.createElement('figure');
      dom.className = 'lemma-svg-figure';
      dom.setAttribute('data-type', 'svg-block');
      dom.contentEditable = 'false';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'lemma-svg-edit-btn';
      editBtn.style.position = 'absolute';
      editBtn.style.top = '8px';
      editBtn.style.right = '8px';
      editBtn.style.transition = 'opacity 0.15s ease';
      editBtn.style.padding = '3px 9px';
      editBtn.style.fontSize = '12px';
      editBtn.style.borderRadius = '4px';
      editBtn.style.border =
        '1px solid var(--latex-border-soft, rgba(120, 120, 120, 0.35))';
      editBtn.style.background = 'var(--bg-color, #ffffff)';
      editBtn.style.color = 'var(--text-color, #141414)';
      editBtn.style.cursor = 'pointer';
      editBtn.style.zIndex = '5';
      if (editor.isEditable) {
        dom.appendChild(editBtn);
      }

      const contentHost = document.createElement('div');
      dom.appendChild(contentHost);

      const dispatchCodeUpdate = (nextCode: string) => {
        if (nextCode === committedCode) return;
        committedCode = nextCode;
        if (typeof getPos === 'function' && !editor.isDestroyed) {
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(pos, undefined, {
                ...currentNode.attrs,
                code: nextCode,
              })
            );
          }
        }
      };

      const syncButtonState = () => {
        const show = editor.isEditable && (isHovered || isEditing || isSelected);
        editBtn.textContent = isEditing ? '完成编辑' : '编辑 SVG 代码';
        editBtn.style.opacity = show ? '0.92' : '0';
        editBtn.style.pointerEvents = show ? 'auto' : 'none';
      };

      const renderSvgSurface = () => {
        const active = isEditing ? draft : committedCode;
        const sanitized = makeRenderedSvgResponsive(
          sanitizeSvgCode(active.trim())
        );
        if (sanitized) {
          contentHost.className = 'lemma-svg-canvas';
          contentHost.style.display = 'flex';
          contentHost.style.justifyContent = 'center';
          contentHost.style.alignItems = 'center';
          contentHost.style.maxWidth = '100%';
          contentHost.style.overflowX = 'auto';
          contentHost.style.padding = '';
          contentHost.style.fontSize = '';
          contentHost.style.color = '';
          contentHost.style.fontStyle = '';
          contentHost.innerHTML = sanitized;
        } else {
          contentHost.className = 'lemma-svg-empty';
          contentHost.style.display = '';
          contentHost.style.padding = '1rem';
          contentHost.style.fontSize = '13px';
          contentHost.style.color = 'var(--text-muted, inherit)';
          contentHost.style.fontStyle = 'italic';
          contentHost.textContent =
            '空白 SVG 矢量图区块（点击右上角“编辑 SVG 代码”输入 <svg>…</svg>）';
        }
      };

      const closeEditorPanel = () => {
        if (focusRaf !== null) {
          cancelAnimationFrame(focusRaf);
          focusRaf = null;
        }
        if (editorWrapEl) {
          editorWrapEl.remove();
          editorWrapEl = null;
        }
        textareaEl = null;
        dom.classList.remove('is-editing');
      };

      const openEditorPanel = () => {
        dom.classList.add('is-editing');
        if (editorWrapEl) return;

        const wrap = document.createElement('div');
        wrap.className = 'lemma-svg-editor lemma-math-popover';
        wrap.style.marginTop = '0.65rem';
        wrap.style.padding = '0.65rem 0.75rem';
        wrap.style.borderRadius = '4px';
        wrap.style.border =
          '1px solid var(--latex-border-soft, rgba(120, 120, 120, 0.3))';
        wrap.style.background = 'var(--bg-color, #ffffff)';
        wrap.style.textAlign = 'left';
        wrap.addEventListener('mousedown', (e) => e.stopPropagation());
        wrap.addEventListener('click', (e) => e.stopPropagation());

        const textarea = document.createElement('textarea');
        textarea.className = 'lemma-svg-textarea';
        textarea.value = draft;
        textarea.rows = Math.max(5, Math.min(16, draft.split('\n').length + 1));
        textarea.placeholder =
          '<svg viewBox="0 0 300 180" width="300" height="180" xmlns="http://www.w3.org/2000/svg">\n  ...\n</svg>';
        textarea.style.width = '100%';
        textarea.style.boxSizing = 'border-box';
        textarea.style.fontFamily =
          'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';
        textarea.style.fontSize = '12.5px';
        textarea.style.lineHeight = '1.5';
        textarea.style.padding = '8px 10px';
        textarea.style.borderRadius = '3px';
        textarea.style.border =
          '1px solid var(--latex-border-soft, rgba(120, 120, 120, 0.3))';
        textarea.style.background = 'var(--latex-code-bg, #f8f9fb)';
        textarea.style.color = 'var(--latex-code-inline-color, inherit)';
        textarea.style.resize = 'vertical';
        textarea.style.outline = 'none';

        textarea.addEventListener('input', () => {
          draft = textarea.value;
          textarea.rows = Math.max(
            5,
            Math.min(16, draft.split('\n').length + 1)
          );
          renderSvgSurface();
          dispatchCodeUpdate(draft);
        });

        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
          e.stopPropagation();
          if (
            e.key === 'Escape' ||
            ((e.ctrlKey || e.metaKey) && e.key === 'Enter')
          ) {
            e.preventDefault();
            if (draft !== committedCode) {
              dispatchCodeUpdate(draft);
            }
            isEditing = false;
            closeEditorPanel();
            renderSvgSurface();
            syncButtonState();
            editor.commands.focus();
          }
        });

        wrap.appendChild(textarea);
        dom.appendChild(wrap);
        editorWrapEl = wrap;
        textareaEl = textarea;

        focusRaf = requestAnimationFrame(() => {
          focusRaf = null;
          textareaEl?.focus();
        });
      };

      editBtn.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (isEditing) {
          if (draft !== committedCode) {
            dispatchCodeUpdate(draft);
          }
          isEditing = false;
          closeEditorPanel();
        } else {
          draft = committedCode;
          isEditing = true;
          openEditorPanel();
        }
        renderSvgSurface();
        syncButtonState();
      });

      dom.addEventListener('mouseenter', () => {
        isHovered = true;
        syncButtonState();
      });

      dom.addEventListener('mouseleave', () => {
        isHovered = false;
        syncButtonState();
      });

      renderSvgSurface();
      if (isEditing) {
        openEditorPanel();
      }
      syncButtonState();

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type !== currentNode.type) {
            return false;
          }
          currentNode = updatedNode;
          const nextCode = String(updatedNode.attrs.code ?? '');
          if (nextCode !== committedCode) {
            committedCode = nextCode;
            if (!isEditing) {
              draft = committedCode;
              renderSvgSurface();
            }
          }
          return true;
        },
        selectNode: () => {
          isSelected = true;
          dom.classList.add('is-selected');
          syncButtonState();
        },
        deselectNode: () => {
          isSelected = false;
          dom.classList.remove('is-selected');
          syncButtonState();
        },
        stopEvent: (event) => {
          const targetNode = event.target as globalThis.Node | null;
          const targetEl =
            targetNode instanceof Element
              ? targetNode
              : targetNode?.parentElement ?? null;
          return Boolean(
            targetEl?.closest('.lemma-svg-editor') ||
              targetEl?.closest('.lemma-svg-edit-btn')
          );
        },
        ignoreMutation: () => true,
        destroy: () => {
          closeEditorPanel();
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^```svg\s$/i,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') {
            return null;
          }
          const blockFrom = $from.before();
          const blockTo = $from.after();
          if (
            $from
              .node(-1)
              .canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)
          ) {
            state.tr.replaceWith(
              blockFrom,
              blockTo,
              this.type.create({ code: '' })
            );
          }
        },
      }),
    ];
  },
});

export default SvgBlock;
