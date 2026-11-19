import { InputRule, Node, mergeAttributes } from '@tiptap/core';

export interface LocalImageOptions {
  resolveAssetUrl?: (rawSrc: string) => string;
  HTMLAttributes: Record<string, unknown>;
}

const IMAGE_INPUT_REGEX =
  /(?:^|\s)!\[([^\]]*)\]\((\S+)(?:\s+["']([^"']+)["'])?\)$/;

export const LocalImage = Node.create<LocalImageOptions>({
  name: 'image',
  inline: false,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      resolveAssetUrl: undefined,
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-raw-src') ??
          element.getAttribute('src') ??
          '',
      },
      alt: {
        default: null,
        parseHTML: (element) => element.getAttribute('alt'),
      },
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute('title'),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const rawSrc = String(node.attrs.src ?? '');
    const resolvedSrc = this.options.resolveAssetUrl
      ? this.options.resolveAssetUrl(rawSrc)
      : rawSrc;

    return [
      'img',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        src: resolvedSrc,
        'data-raw-src': rawSrc,
        alt: node.attrs.alt ?? '',
        title: node.attrs.title ?? undefined,
      }),
    ];
  },

  addNodeView() {
    return ({ node: initialNode, extension, editor }) => {
      let currentNode = initialNode;

      const dom = document.createElement('figure');
      dom.className = 'lemma-local-image lemma-image-figure';
      dom.setAttribute('data-type', 'lemma-image');
      dom.contentEditable = 'false';
      dom.style.margin = '1.25rem 0';
      dom.style.textAlign = 'center';

      const img = document.createElement('img');
      dom.appendChild(img);

      let captionEl: HTMLElement | null = null;

      const syncDom = () => {
        const rawSrc = String(currentNode.attrs.src ?? '');
        const alt = currentNode.attrs.alt ? String(currentNode.attrs.alt) : '';
        const title = currentNode.attrs.title
          ? String(currentNode.attrs.title)
          : null;
        const resolveFn = (extension.options as LocalImageOptions | undefined)
          ?.resolveAssetUrl;
        const resolvedSrc = resolveFn ? resolveFn(rawSrc) : rawSrc;

        img.setAttribute('src', resolvedSrc);
        img.setAttribute('data-raw-src', rawSrc);
        img.setAttribute('alt', alt);
        if (title) {
          img.setAttribute('title', title);
        } else {
          img.removeAttribute('title');
        }

        if (alt) {
          if (!captionEl) {
            captionEl = document.createElement('figcaption');
            captionEl.className = 'lemma-figure-caption lemma-image-caption';
            dom.appendChild(captionEl);
          }
          captionEl.textContent = alt;
        } else if (captionEl) {
          captionEl.remove();
          captionEl = null;
        }
      };

      syncDom();

      const handleTransaction = ({
        transaction,
      }: {
        transaction: { getMeta: (key: string) => unknown };
      }) => {
        if (transaction.getMeta('lemmaFilePath') !== undefined) {
          syncDom();
        }
      };

      editor.on('transaction', handleTransaction);

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type !== currentNode.type) {
            return false;
          }
          currentNode = updatedNode;
          syncDom();
          return true;
        },
        selectNode: () => {
          dom.classList.add('is-selected');
        },
        deselectNode: () => {
          dom.classList.remove('is-selected');
        },
        ignoreMutation: () => true,
        destroy: () => {
          editor.off('transaction', handleTransaction);
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: IMAGE_INPUT_REGEX,
        handler: ({ state, range, match }) => {
          const alt = match[1] ?? '';
          const src = match[2] ?? '';
          const title = match[3] ?? null;
          if (!src) return null;

          const $from = state.doc.resolve(range.from);
          const imageNode = this.type.create({ src, alt, title });

          if (
            $from.parent.type.name === 'paragraph' &&
            $from.parent.textContent.trim().length <= match[0].trim().length &&
            $from
              .node(-1)
              .canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)
          ) {
            state.tr.replaceWith($from.before(), $from.after(), imageNode);
          } else {
            state.tr
              .delete(range.from, range.to)
              .insert($from.after() - (range.to - range.from), imageNode);
          }
        },
      }),
    ];
  },
});

export default LocalImage;
