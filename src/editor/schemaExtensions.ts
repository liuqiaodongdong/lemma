import { getSchema, type AnyExtension } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { MathInline } from './extensions/MathInline';
import { MathBlock } from './extensions/MathBlock';
import { SvgBlock } from './extensions/SvgBlock';
import { CalloutBlock } from './extensions/CalloutBlock';
import { LocalImage } from './extensions/LocalImage';
import { HighlightMark } from './extensions/HighlightMark';
import { CommentMark } from './extensions/CommentMark';

/**
 * Relaxes StarterKit's `code` mark `excludes` (from `'_'` to `'bold italic strike code'`)
 * so `highlight`, `comment`, and `link` marks can wrap inline `` `code` `` spans cleanly.
 */
const RelaxedCode = Code.extend({
  excludes: 'bold italic strike code',
});

const AlignedTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-align') ||
          element.style.textAlign ||
          null,
        renderHTML: (attributes) => {
          if (!attributes.align) return {};
          return {
            'data-align': attributes.align,
            style: `text-align: ${attributes.align}`,
          };
        },
      },
    };
  },
});

const AlignedTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-align') ||
          element.style.textAlign ||
          null,
        renderHTML: (attributes) => {
          if (!attributes.align) return {};
          return {
            'data-align': attributes.align,
            style: `text-align: ${attributes.align}`,
          };
        },
      },
    };
  },
});

export interface CreateLemmaExtensionsOptions {
  resolveAssetUrl?: (rawSrc: string) => string;
  placeholder?: string;
}

/**
 * Shared Tiptap / ProseMirror extension factory used by BOTH `LemmaEditor.tsx`
 * AND headless ProseMirror schema consumers (unit tests & AST Diff engine).
 */
export function createLemmaExtensions(
  options?: CreateLemmaExtensionsOptions
): AnyExtension[] {
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      code: false,
      codeBlock: {
        HTMLAttributes: {
          class: 'md-fences',
        },
      },
    }),
    RelaxedCode,
    CommentMark,
    HighlightMark,
    Table.configure({
      resizable: false,
    }),
    TableRow,
    AlignedTableHeader,
    AlignedTableCell,
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    Link.configure({
      openOnClick: false,
    }),
    MathInline,
    MathBlock,
    SvgBlock,
    CalloutBlock,
    LocalImage.configure({
      resolveAssetUrl: options?.resolveAssetUrl,
    }),
    Placeholder.configure({
      placeholder:
        options?.placeholder ?? '开始撰写手稿，输入 $...$ 或 $$ 插入数学公式…',
    }),
  ];

  return extensions;
}

/**
 * Builds a headless ProseMirror `Schema` matching `LemmaEditor`'s exact node/mark set.
 */
export function createLemmaSchema(
  options?: CreateLemmaExtensionsOptions
): Schema {
  return getSchema(createLemmaExtensions(options));
}
