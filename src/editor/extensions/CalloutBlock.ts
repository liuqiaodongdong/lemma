import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import type { CalloutKind } from '../../types/contract';

const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

function normalizeCalloutKind(raw: unknown): CalloutKind {
  const lower = String(raw ?? 'note').toLowerCase();
  if (
    lower === 'note' ||
    lower === 'tip' ||
    lower === 'important' ||
    lower === 'warning' ||
    lower === 'caution'
  ) {
    return lower;
  }
  return 'note';
}

export const CalloutBlock = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note' as CalloutKind,
        parseHTML: (element) =>
          normalizeCalloutKind(element.getAttribute('data-callout')),
        renderHTML: (attributes) => ({
          'data-callout': normalizeCalloutKind(attributes.kind),
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-callout]',
        contentElement: 'div.md-alert-content',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = normalizeCalloutKind(node.attrs.kind);
    const label = CALLOUT_LABELS[kind];
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: `md-alert md-alert-${kind}`,
        'data-callout': kind,
      }),
      ['p', { class: 'md-alert-title', contenteditable: 'false' }, label],
      ['div', { class: 'md-alert-content' }, 0],
    ];
  },

  addNodeView() {
    return ({ node }) => {
      let currentKind = normalizeCalloutKind(node.attrs.kind);

      const dom = document.createElement('div');
      dom.className = `md-alert md-alert-${currentKind}`;
      dom.setAttribute('data-callout', currentKind);

      const titleEl = document.createElement('p');
      titleEl.className = 'md-alert-title';
      titleEl.contentEditable = 'false';
      titleEl.textContent = CALLOUT_LABELS[currentKind];

      const contentDOM = document.createElement('div');
      contentDOM.className = 'md-alert-content';

      dom.append(titleEl, contentDOM);

      return {
        dom,
        contentDOM,
        update: (updatedNode) => {
          if (updatedNode.type !== this.type) {
            return false;
          }
          const nextKind = normalizeCalloutKind(updatedNode.attrs.kind);
          if (nextKind !== currentKind) {
            currentKind = nextKind;
            dom.className = `md-alert md-alert-${currentKind}`;
            dom.setAttribute('data-callout', currentKind);
            titleEl.textContent = CALLOUT_LABELS[currentKind];
          }
          return true;
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s$/i,
        handler: ({ state, range, match }) => {
          const kind = normalizeCalloutKind(match[1]);
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') {
            return null;
          }
          const blockFrom = $from.before();
          const blockTo = $from.after();
          const paragraphType = state.schema.nodes.paragraph;
          const calloutNode = this.type.create(
            { kind },
            paragraphType ? [paragraphType.create()] : []
          );
          if (
            $from
              .node(-1)
              .canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)
          ) {
            state.tr.replaceWith(blockFrom, blockTo, calloutNode);
          }
        },
      }),
    ];
  },
});

export default CalloutBlock;
