import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import katex from 'katex';
import {
  scheduleOrMountMath,
  unobserveMathElement,
  upgradeMathElementNow,
} from './mathViewportScheduler';

const inlineKatexTemplateCache = new Map<string, HTMLTemplateElement>();
const MAX_INLINE_KATEX_CACHE_SIZE = 2048;

function mountInlineKatex(target: HTMLElement, latex: string): void {
  target.classList.remove('lemma-math-deferred');
  const expr = latex.trim() || '\\square';
  let tpl = inlineKatexTemplateCache.get(expr);
  if (!tpl) {
    let rendered: string;
    try {
      rendered = katex.renderToString(expr, {
        displayMode: false,
        output: 'html',
        throwOnError: false,
        trust: true,
        strict: 'ignore',
      });
    } catch {
      rendered = expr;
    }

    tpl = document.createElement('template');
    tpl.innerHTML = rendered;
    inlineKatexTemplateCache.set(expr, tpl);

    if (inlineKatexTemplateCache.size > MAX_INLINE_KATEX_CACHE_SIZE) {
      const oldestKey = inlineKatexTemplateCache.keys().next().value;
      if (oldestKey !== undefined) {
        inlineKatexTemplateCache.delete(oldestKey);
      }
    }
  }

  target.replaceChildren(tpl.content.cloneNode(true));
}

/**
 * Matches inline `$...$` (non-empty, single line, not `$$` and not escaped `\$`).
 */
const INLINE_MATH_INPUT_REGEX = /(?<![\\$])\$([^$\n]+)\$$/;

export const MathInline = Node.create({
  name: 'mathInline',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
        renderHTML: (attributes) => ({
          'data-latex': attributes.latex ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-type="math-inline"]' },
      { tag: 'span.lemma-math-inline[data-latex]' },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'math-inline',
        class: 'lemma-math-inline',
      }),
      `$${node.attrs.latex ?? ''}$`,
    ];
  },

  addNodeView() {
    return ({ node: initialNode, editor, getPos }) => {
      let currentNode = initialNode;
      let committedLatex = String(currentNode.attrs.latex ?? '');
      let draft = committedLatex;
      let isOpen = false;
      let popoverEl: HTMLDivElement | null = null;
      let inputEl: HTMLInputElement | null = null;
      let previewDiv: HTMLDivElement | null = null;
      let focusRaf: number | null = null;

      const dom = document.createElement('span');
      dom.className = 'lemma-math-inline';
      dom.setAttribute('data-type', 'math-inline');
      dom.setAttribute('data-latex', committedLatex);
      dom.style.position = 'relative';
      dom.style.display = 'inline-block';
      dom.style.cursor = 'pointer';

      const renderSpan = document.createElement('span');
      renderSpan.className = 'lemma-math-inline-render';
      scheduleOrMountMath({
        dom,
        renderTarget: renderSpan,
        latex: committedLatex,
        displayMode: false,
        mountFn: () => mountInlineKatex(renderSpan, committedLatex),
      });
      dom.appendChild(renderSpan);

      const handleOutsideMouseDown = (event: MouseEvent) => {
        const target = event.target as globalThis.Node | null;
        if (target && !dom.contains(target) && !popoverEl?.contains(target)) {
          commitAndClose();
        }
      };

      const cleanupPopover = () => {
        if (focusRaf !== null) {
          cancelAnimationFrame(focusRaf);
          focusRaf = null;
        }
        document.removeEventListener('mousedown', handleOutsideMouseDown, true);
        if (popoverEl) {
          popoverEl.remove();
          popoverEl = null;
        }
        inputEl = null;
        previewDiv = null;
        dom.classList.remove('is-editing');
      };

      const commitAndClose = () => {
        if (!isOpen) return;
        isOpen = false;
        const nextLatex = draft.trim();
        cleanupPopover();
        unobserveMathElement(dom);

        if (nextLatex !== committedLatex) {
          committedLatex = nextLatex;
          dom.setAttribute('data-latex', committedLatex);
          mountInlineKatex(renderSpan, committedLatex);
          if (typeof getPos === 'function' && !editor.isDestroyed) {
            const pos = getPos();
            if (typeof pos === 'number') {
              editor.view.dispatch(
                editor.state.tr.setNodeMarkup(pos, undefined, {
                  ...currentNode.attrs,
                  latex: nextLatex,
                })
              );
            }
          }
        } else {
          draft = committedLatex;
          mountInlineKatex(renderSpan, committedLatex);
        }
      };

      const openPopover = () => {
        if (isOpen || !editor.isEditable) return;
        upgradeMathElementNow(dom);
        isOpen = true;
        draft = committedLatex;
        dom.classList.add('is-editing');

        const popover = document.createElement('div');
        popover.className = 'lemma-math-inline-popover lemma-math-popover';
        popover.contentEditable = 'false';
        popover.style.position = 'absolute';
        popover.style.top = 'calc(100% + 6px)';
        popover.style.left = '0';
        popover.style.zIndex = '60';
        popover.style.minWidth = '240px';
        popover.style.maxWidth = '380px';
        popover.style.marginTop = '0';
        popover.style.padding = '8px 10px';
        popover.style.borderRadius = '6px';
        popover.style.border =
          '1px solid var(--latex-border-soft, rgba(120, 120, 120, 0.3))';
        popover.style.background = 'var(--bg-color, #ffffff)';
        popover.style.color = 'var(--text-color, #141414)';
        popover.style.boxShadow = '0 8px 24px rgba(15, 23, 42, 0.18)';
        popover.style.display = 'flex';
        popover.style.flexDirection = 'column';
        popover.style.gap = '6px';
        popover.style.cursor = 'default';
        popover.addEventListener('mousedown', (e) => e.stopPropagation());
        popover.addEventListener('click', (e) => e.stopPropagation());

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'lemma-math-inline-input';
        input.value = draft;
        input.placeholder = '输入 LaTeX 公式，例如 \\alpha + \\beta';
        input.style.width = '100%';
        input.style.boxSizing = 'border-box';
        input.style.fontFamily =
          'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';
        input.style.fontSize = '12.5px';
        input.style.lineHeight = '1.4';
        input.style.padding = '4px 7px';
        input.style.borderRadius = '4px';
        input.style.border =
          '1px solid var(--latex-border-soft, rgba(120, 120, 120, 0.35))';
        input.style.background =
          'var(--latex-code-bg, rgba(127, 127, 127, 0.06))';
        input.style.color = 'var(--latex-code-inline-color, inherit)';
        input.style.outline = 'none';

        const preview = document.createElement('div');
        preview.className = 'lemma-math-inline-preview';
        preview.style.fontSize = '13px';
        preview.style.padding = '3px 4px';
        preview.style.overflowX = 'auto';
        preview.style.borderTop =
          '1px dashed var(--latex-border-soft, rgba(120, 120, 120, 0.25))';
        mountInlineKatex(preview, draft);

        input.addEventListener('input', () => {
          draft = input.value;
          mountInlineKatex(renderSpan, draft);
          mountInlineKatex(preview, draft);
        });

        input.addEventListener('keydown', (e: KeyboardEvent) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            commitAndClose();
            editor.commands.focus();
          }
        });

        input.addEventListener('blur', (e: FocusEvent) => {
          const related = e.relatedTarget as globalThis.Node | null;
          if (related && popoverEl?.contains(related)) {
            return;
          }
          commitAndClose();
        });

        popover.append(input, preview);
        dom.appendChild(popover);

        popoverEl = popover;
        inputEl = input;
        previewDiv = preview;

        document.addEventListener('mousedown', handleOutsideMouseDown, true);
        focusRaf = requestAnimationFrame(() => {
          focusRaf = null;
          inputEl?.focus();
          inputEl?.select();
        });
      };

      dom.addEventListener('click', (e: MouseEvent) => {
        if (!editor.isEditable) return;
        const targetNode = e.target as globalThis.Node | null;
        const targetEl =
          targetNode instanceof Element
            ? targetNode
            : targetNode?.parentElement ?? null;
        if (targetEl?.closest('.lemma-math-inline-popover')) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (!isOpen) {
          openPopover();
        }
      });

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type !== currentNode.type) {
            return false;
          }
          currentNode = updatedNode;
          const nextLatex = String(updatedNode.attrs.latex ?? '');
          if (nextLatex !== committedLatex) {
            committedLatex = nextLatex;
            dom.setAttribute('data-latex', committedLatex);
            unobserveMathElement(dom);
            if (!isOpen) {
              draft = committedLatex;
              mountInlineKatex(renderSpan, committedLatex);
            }
          }
          return true;
        },
        selectNode: () => {
          dom.classList.add('is-selected');
        },
        deselectNode: () => {
          dom.classList.remove('is-selected');
        },
        stopEvent: (event) => {
          const targetNode = event.target as globalThis.Node | null;
          const targetEl =
            targetNode instanceof Element
              ? targetNode
              : targetNode?.parentElement ?? null;
          return Boolean(targetEl?.closest('.lemma-math-inline-popover'));
        },
        ignoreMutation: () => true,
        destroy: () => {
          unobserveMathElement(dom);
          cleanupPopover();
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: INLINE_MATH_INPUT_REGEX,
        handler: ({ state, range, match }) => {
          const latex = (match[1] ?? '').trim();
          if (!latex) return null;
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex })
          );
        },
      }),
    ];
  },
});

export default MathInline;
