import katex from 'katex';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { DiffHunk } from '../types/contract';
import {
  computeInlineDiffForNodes,
  type PositionedInlineDelete,
  type PositionedInlineInsert,
  type RichDiffHunk,
} from './diffEngine';

export interface DiffPluginHandlers {
  onAcceptHunk: (hunkId: string) => void;
  onRevertHunk: (hunkId: string) => void;
  onSelectHunk?: (index: number) => void;
}

export interface DiffPluginData {
  baselineDoc: PMNode | null;
  hunks: DiffHunk[];
  activeHunkIndex: number;
  showDeletions: boolean;
}

export interface DiffPluginState extends DiffPluginData {
  decorations: DecorationSet;
}

export const diffPluginKey = new PluginKey<DiffPluginState>('lemmaDiffReview');

const FORBIDDEN_SVG_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'foreignobject',
  'link',
  'meta',
  'base',
]);

function renderKatexSafe(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex || '', {
      displayMode,
      output: 'html',
      throwOnError: false,
      strict: 'ignore',
    });
  } catch {
    const escaped = (latex || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  }
}

/**
 * Sanitizes raw SVG markup into a safe DOM element without script/event execution vectors.
 */
export function createSanitizedSvgContainer(rawSvg: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'lemma-diff-svg-preview';

  const trimmed = (rawSvg || '').trim();
  if (!trimmed) {
    wrapper.textContent = '[空 SVG 图表]';
    return wrapper;
  }

  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(trimmed, 'image/svg+xml');
    const parserError = parsed.querySelector('parsererror');
    const svgRoot = parsed.querySelector('svg');

    if (parserError || !svgRoot) {
      const fallbackPre = document.createElement('pre');
      fallbackPre.className = 'lemma-diff-svg-fallback';
      fallbackPre.textContent = trimmed;
      wrapper.appendChild(fallbackPre);
      return wrapper;
    }

    const cleanNode = (el: Element) => {
      const children = Array.from(el.children);
      for (const child of children) {
        if (FORBIDDEN_SVG_TAGS.has(child.tagName.toLowerCase())) {
          child.remove();
          continue;
        }
        cleanNode(child);
      }

      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        const nameLower = attr.name.toLowerCase();
        const valLower = attr.value.trim().toLowerCase();
        if (nameLower.startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (
          (nameLower === 'href' ||
            nameLower === 'xlink:href' ||
            nameLower === 'src') &&
          (valLower.startsWith('javascript:') ||
            valLower.startsWith('vbscript:') ||
            valLower.startsWith('data:text/html'))
        ) {
          el.removeAttribute(attr.name);
        }
      }
    };

    cleanNode(svgRoot);
    const importedSvg = document.importNode(svgRoot, true);
    const viewBox = importedSvg.getAttribute('viewBox') ?? '';
    const vbParts = viewBox.trim().split(/[\s,]+/);
    const rawW = importedSvg.getAttribute('width') ?? '';
    const baseWidth =
      vbParts.length === 4 && Number.isFinite(parseFloat(vbParts[2]))
        ? parseFloat(vbParts[2])
        : parseFloat(rawW);
    if (Number.isFinite(baseWidth) && baseWidth > 0) {
      const existingStyle = importedSvg.getAttribute('style') ?? '';
      const prefix = existingStyle.trim()
        ? `${existingStyle.replace(/;?\s*$/, '; ')}`
        : '';
      importedSvg.setAttribute(
        'style',
        `${prefix}width: min(100%, calc(${baseWidth}px * var(--doc-scale, 1))); height: auto;`
      );
    }
    wrapper.appendChild(importedSvg);
    return wrapper;
  } catch {
    const fallbackPre = document.createElement('pre');
    fallbackPre.className = 'lemma-diff-svg-fallback';
    fallbackPre.textContent = trimmed;
    wrapper.appendChild(fallbackPre);
    return wrapper;
  }
}

function createInlineDeleteWidget(del: PositionedInlineDelete): HTMLElement {
  const span = document.createElement('span');
  span.className = del.isInlineMath
    ? 'lemma-diff-del lemma-diff-del-math'
    : 'lemma-diff-del';
  span.contentEditable = 'false';

  if (del.isInlineMath) {
    span.innerHTML = renderKatexSafe(del.text, false);
  } else {
    span.textContent = del.text;
  }

  return span;
}

function createCompareCardWidget(
  hunk: DiffHunk,
  hunkIndex: number,
  isActive: boolean,
  handlers: DiffPluginHandlers
): HTMLElement {
  const card = document.createElement('div');
  card.className = isActive
    ? 'lemma-diff-compare-card lemma-diff-active-compare'
    : 'lemma-diff-compare-card';
  card.contentEditable = 'false';
  card.setAttribute('data-diff-hunk-id', hunk.id);

  if (handlers.onSelectHunk) {
    card.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement | null)?.closest('button')) return;
      handlers.onSelectHunk?.(hunkIndex);
    });
  }

  const grid = document.createElement('div');
  grid.className = 'lemma-diff-compare-grid';

  // Before column: 【修改前】
  const beforeCol = document.createElement('div');
  beforeCol.className =
    'lemma-diff-compare-pane lemma-diff-compare-col lemma-diff-compare-before';
  const beforeLabel = document.createElement('div');
  beforeLabel.className = 'lemma-diff-compare-label';
  beforeLabel.textContent = '【修改前】';
  const beforeBody = document.createElement('div');
  beforeBody.className = 'lemma-diff-compare-body';

  if (hunk.kind === 'math-modified') {
    beforeBody.innerHTML = renderKatexSafe(hunk.oldLatex ?? '', true);
  } else if (hunk.kind === 'svg-modified') {
    beforeBody.appendChild(createSanitizedSvgContainer(hunk.oldSvg ?? ''));
  }
  beforeCol.appendChild(beforeLabel);
  beforeCol.appendChild(beforeBody);

  // After column: 【修改后】
  const afterCol = document.createElement('div');
  afterCol.className =
    'lemma-diff-compare-pane lemma-diff-compare-col lemma-diff-compare-after';
  const afterLabel = document.createElement('div');
  afterLabel.className = 'lemma-diff-compare-label';
  afterLabel.textContent = '【修改后】';
  const afterBody = document.createElement('div');
  afterBody.className = 'lemma-diff-compare-body';

  if (hunk.kind === 'math-modified') {
    afterBody.innerHTML = renderKatexSafe(hunk.newLatex ?? '', true);
  } else if (hunk.kind === 'svg-modified') {
    afterBody.appendChild(createSanitizedSvgContainer(hunk.newSvg ?? ''));
  }
  afterCol.appendChild(afterLabel);
  afterCol.appendChild(afterBody);

  grid.appendChild(beforeCol);
  grid.appendChild(afterCol);
  card.appendChild(grid);

  return card;
}

function createDeletedBlockWidget(
  hunk: DiffHunk,
  hunkIndex: number,
  isActive: boolean,
  handlers: DiffPluginHandlers
): HTMLElement {
  const card = document.createElement('div');
  card.className = isActive
    ? 'lemma-diff-block-deleted lemma-diff-active-hunk'
    : 'lemma-diff-block-deleted';
  card.contentEditable = 'false';
  card.setAttribute('data-diff-hunk-id', hunk.id);

  if (handlers.onSelectHunk) {
    card.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement | null)?.closest('button')) return;
      handlers.onSelectHunk?.(hunkIndex);
    });
  }

  const header = document.createElement('div');
  header.className = 'lemma-diff-deleted-header';
  header.textContent = `【已删除】${hunk.summary}`;
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'lemma-diff-deleted-body';

  if (typeof hunk.oldLatex === 'string') {
    body.innerHTML = renderKatexSafe(hunk.oldLatex, true);
  } else if (typeof hunk.oldSvg === 'string') {
    body.appendChild(createSanitizedSvgContainer(hunk.oldSvg));
  } else {
    body.textContent = hunk.oldPreviewText ?? '';
  }

  card.appendChild(body);
  return card;
}

function createHunkActionsWidget(
  hunk: DiffHunk,
  isActive: boolean,
  markAsActiveTarget: boolean,
  handlers: DiffPluginHandlers
): HTMLElement {
  const bar = document.createElement('div');
  const classes = ['lemma-diff-hunk-actions'];
  if (isActive) {
    classes.push('is-active');
  }
  if (markAsActiveTarget) {
    classes.push('lemma-diff-active-hunk');
  }
  bar.className = classes.join(' ');
  bar.contentEditable = 'false';
  bar.setAttribute('data-diff-hunk-id', hunk.id);

  const summaryBadge = document.createElement('span');
  summaryBadge.className = 'lemma-diff-hunk-summary';
  summaryBadge.textContent = hunk.summary;
  bar.appendChild(summaryBadge);

  const btnAccept = document.createElement('button');
  btnAccept.type = 'button';
  btnAccept.className = 'lemma-diff-btn-accept';
  btnAccept.title = '标为已读';
  btnAccept.textContent = '✓ 已读';
  btnAccept.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  btnAccept.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onAcceptHunk(hunk.id);
  });

  const btnRevert = document.createElement('button');
  btnRevert.type = 'button';
  btnRevert.className = 'lemma-diff-btn-revert';
  btnRevert.title = '撤回此处修改并写回文件';
  btnRevert.textContent = '↩ 撤回';
  btnRevert.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  btnRevert.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onRevertHunk(hunk.id);
  });

  bar.appendChild(btnAccept);
  bar.appendChild(btnRevert);
  return bar;
}

function resolveInlineDiffDescriptors(
  doc: PMNode,
  hunk: DiffHunk
): {
  inlineInserts: PositionedInlineInsert[];
  inlineDeletes: PositionedInlineDelete[];
} {
  const rich = hunk as Partial<RichDiffHunk>;
  if (rich.inlineInserts || rich.inlineDeletes) {
    return {
      inlineInserts: rich.inlineInserts ?? [],
      inlineDeletes: rich.inlineDeletes ?? [],
    };
  }

  if (
    hunk.kind === 'text-modified' &&
    hunk.oldNodesJson.length === 1 &&
    hunk.newFrom >= 0 &&
    hunk.newFrom < doc.content.size
  ) {
    const newNode = doc.nodeAt(hunk.newFrom);
    if (newNode) {
      try {
        const oldNode = doc.type.schema.nodeFromJSON(hunk.oldNodesJson[0]);
        const computed = computeInlineDiffForNodes(
          oldNode,
          newNode,
          hunk.newFrom
        );
        return {
          inlineInserts: computed.inlineInserts,
          inlineDeletes: computed.inlineDeletes,
        };
      } catch {
        // Fallback safely if schema cannot deserialize
      }
    }
  }

  return { inlineInserts: [], inlineDeletes: [] };
}

function buildDecorationsForHunks(
  doc: PMNode,
  hunks: DiffHunk[],
  activeHunkIndex: number,
  showDeletions: boolean,
  handlers: DiffPluginHandlers
): DecorationSet {
  if (hunks.length === 0) {
    return DecorationSet.empty;
  }

  const docSize = doc.content.size;
  const decorations: Decoration[] = [];

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const isActive = i === activeHunkIndex;
    const clampedFrom = Math.max(0, Math.min(hunk.newFrom, docSize));
    const clampedTo = Math.max(clampedFrom, Math.min(hunk.newTo, docSize));

    // 1. Block-level highlight decoration (.lemma-diff-block-added / .lemma-diff-block-modified / .lemma-diff-active-hunk)
    if (hunk.kind !== 'block-deleted' && clampedFrom < clampedTo) {
      const baseBlockClass =
        hunk.kind === 'block-added'
          ? 'lemma-diff-block-added'
          : 'lemma-diff-block-modified';
      const fullClass = isActive
        ? `${baseBlockClass} lemma-diff-active-hunk`
        : baseBlockClass;

      doc.nodesBetween(clampedFrom, clampedTo, (node, pos, parent) => {
        if (parent === doc) {
          const nodeEnd = pos + node.nodeSize;
          if (pos >= 0 && nodeEnd <= docSize) {
            decorations.push(
              Decoration.node(pos, nodeEnd, {
                class: fullClass,
                'data-diff-hunk-id': hunk.id,
              })
            );
          }
          return false;
        }
        return false;
      });
    }

    // 2. Inline insertions (.lemma-diff-ins) and inline deletions (.lemma-diff-del) for text-modified and table-modified
    if (hunk.kind === 'text-modified' || hunk.kind === 'table-modified') {
      const { inlineInserts, inlineDeletes } = resolveInlineDiffDescriptors(
        doc,
        hunk
      );

      for (const ins of inlineInserts) {
        const from = Math.max(0, Math.min(ins.from, docSize));
        const to = Math.max(from, Math.min(ins.to, docSize));
        if (to > from) {
          if (ins.isBlockAtom) {
            decorations.push(
              Decoration.node(from, to, { class: 'lemma-diff-ins' })
            );
          } else {
            decorations.push(
              Decoration.inline(from, to, { class: 'lemma-diff-ins' })
            );
          }
        }
      }

      if (showDeletions) {
        for (const del of inlineDeletes) {
          const pos = Math.max(0, Math.min(del.pos, docSize));
          decorations.push(
            Decoration.widget(pos, () => createInlineDeleteWidget(del), {
              side: -10 + Math.min(9, del.order * 0.01),
              ignoreSelection: true,
              key: `del-${hunk.id}-${del.order}-${del.text}`,
            })
          );
        }
      }
    }

    // 3. Before/After comparison card (.lemma-diff-compare-card) for math-modified and svg-modified
    if (hunk.kind === 'math-modified' || hunk.kind === 'svg-modified') {
      decorations.push(
        Decoration.widget(
          clampedTo,
          () => createCompareCardWidget(hunk, i, isActive, handlers),
          {
            side: 1,
            ignoreSelection: true,
            stopEvent: (event) =>
              event.type === 'mousedown' || event.type === 'click',
            key: `compare-${hunk.id}-${isActive ? 'active' : 'idle'}`,
          }
        )
      );
    }

    // 4. Deleted block review card (.lemma-diff-block-deleted) when showDeletions is true
    if (hunk.kind === 'block-deleted' && showDeletions) {
      decorations.push(
        Decoration.widget(
          clampedFrom,
          () => createDeletedBlockWidget(hunk, i, isActive, handlers),
          {
            side: -200 + i * 2,
            ignoreSelection: true,
            stopEvent: (event) =>
              event.type === 'mousedown' || event.type === 'click',
            key: `block-del-${hunk.id}-${isActive ? 'active' : 'idle'}`,
          }
        )
      );
    }

    // 5. Per-hunk action bar (.lemma-diff-hunk-actions) on every hunk
    const markActionsAsActiveTarget =
      isActive && (hunk.kind === 'block-deleted' && !showDeletions);
    const actionsPos =
      hunk.kind === 'block-deleted' ? clampedFrom : clampedTo;
    const actionsSide =
      hunk.kind === 'block-deleted' ? -200 + i * 2 + 1 : 2 + i * 0.01;

    decorations.push(
      Decoration.widget(
        actionsPos,
        () =>
          createHunkActionsWidget(
            hunk,
            isActive,
            markActionsAsActiveTarget,
            handlers
          ),
        {
          side: actionsSide,
          ignoreSelection: true,
          stopEvent: (event) =>
            event.type === 'mousedown' ||
            event.type === 'mouseup' ||
            event.type === 'click',
          key: `actions-${hunk.id}-${isActive ? 'active' : 'idle'}-${showDeletions ? 'del' : 'nodel'}`,
        }
      )
    );
  }

  try {
    return DecorationSet.create(doc, decorations);
  } catch {
    return DecorationSet.empty;
  }
}

function mapHunksThroughDocChange(
  prevHunks: DiffHunk[],
  doc: PMNode,
  mapPos: (pos: number, assoc?: number) => number
): DiffHunk[] {
  const docSize = doc.content.size;
  const topBlocks: Array<{ from: number; to: number }> = [];
  const boundaries: number[] = [0];

  doc.forEach((child, offset) => {
    const end = offset + child.nodeSize;
    topBlocks.push({ from: offset, to: end });
    boundaries.push(end);
  });

  const mapped: DiffHunk[] = [];

  for (const h of prevHunks) {
    if (h.kind === 'block-deleted') {
      const raw = Math.max(0, Math.min(mapPos(h.newFrom, 1), docSize));
      let nearest = boundaries[0];
      let minDist = Math.abs(raw - nearest);
      for (const b of boundaries) {
        const dist = Math.abs(raw - b);
        if (dist < minDist) {
          minDist = dist;
          nearest = b;
        }
      }
      mapped.push({
        ...h,
        index: mapped.length,
        newFrom: nearest,
        newTo: nearest,
      });
      continue;
    }

    const rawFrom = Math.max(0, Math.min(mapPos(h.newFrom, 1), docSize));
    const rawTo = Math.max(rawFrom, Math.min(mapPos(h.newTo, -1), docSize));

    const overlapping = topBlocks.filter(
      (b) => b.from < rawTo && b.to > rawFrom
    );
    if (overlapping.length === 0) {
      // User manually deleted the entire added/modified block
      continue;
    }

    mapped.push({
      ...h,
      index: mapped.length,
      newFrom: overlapping[0].from,
      newTo: overlapping[overlapping.length - 1].to,
    });
  }

  return mapped;
}

export function createDiffReviewPlugin(handlers: DiffPluginHandlers): Plugin {
  return new Plugin<DiffPluginState>({
    key: diffPluginKey,
    state: {
      init(): DiffPluginState {
        return {
          baselineDoc: null,
          hunks: [],
          activeHunkIndex: 0,
          showDeletions: true,
          decorations: DecorationSet.empty,
        };
      },
      apply(tr, prev, _oldState, newState): DiffPluginState {
        const meta = tr.getMeta(diffPluginKey) as DiffPluginData | undefined;
        if (meta) {
          const safeActiveIndex =
            meta.hunks.length > 0
              ? Math.max(
                  0,
                  Math.min(meta.activeHunkIndex, meta.hunks.length - 1)
                )
              : 0;
          const decorations = buildDecorationsForHunks(
            newState.doc,
            meta.hunks,
            safeActiveIndex,
            meta.showDeletions,
            handlers
          );
          return {
            baselineDoc: meta.baselineDoc,
            hunks: meta.hunks,
            activeHunkIndex: safeActiveIndex,
            showDeletions: meta.showDeletions,
            decorations,
          };
        }

        if (!tr.docChanged) {
          return prev;
        }

        if (prev.hunks.length === 0) {
          return prev.decorations === DecorationSet.empty
            ? prev
            : { ...prev, decorations: DecorationSet.empty };
        }

        // Map decorations and hunk positions safely so direct user edits never throw out-of-bounds errors
        let mappedDecorations = DecorationSet.empty;
        try {
          mappedDecorations = prev.decorations.map(tr.mapping, newState.doc);
        } catch {
          mappedDecorations = DecorationSet.empty;
        }

        const mappedHunks = mapHunksThroughDocChange(
          prev.hunks,
          newState.doc,
          (pos, assoc) => tr.mapping.map(pos, assoc)
        );
        const safeActive =
          mappedHunks.length > 0
            ? Math.max(0, Math.min(prev.activeHunkIndex, mappedHunks.length - 1))
            : 0;

        return {
          ...prev,
          hunks: mappedHunks,
          activeHunkIndex: safeActive,
          decorations: mappedDecorations,
        };
      },
    },
    props: {
      decorations(state) {
        return diffPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
      handleClick(view, pos) {
        if (!handlers.onSelectHunk) return false;
        const pluginState = diffPluginKey.getState(view.state);
        if (!pluginState || pluginState.hunks.length === 0) return false;

        const clickedIdx = pluginState.hunks.findIndex(
          (h) => h.newFrom < h.newTo && pos >= h.newFrom && pos <= h.newTo
        );
        if (clickedIdx !== -1 && clickedIdx !== pluginState.activeHunkIndex) {
          handlers.onSelectHunk(clickedIdx);
        }
        return false;
      },
    },
  });
}

export function setDiffPluginData(editor: Editor, data: DiffPluginData): void {
  if (!editor || editor.isDestroyed || !editor.view) {
    return;
  }
  const existing = diffPluginKey.getState(editor.state);
  if (
    existing &&
    existing.hunks.length === 0 &&
    data.hunks.length === 0 &&
    existing.showDeletions === data.showDeletions
  ) {
    existing.baselineDoc = data.baselineDoc;
    return;
  }
  const tr = editor.state.tr
    .setMeta(diffPluginKey, data)
    .setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}
