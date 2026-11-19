import 'katex/dist/katex.min.css';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import { Fragment, Node as PMNode } from '@tiptap/pm/model';
import { Selection, type Plugin } from '@tiptap/pm/state';
import type { OutlineHeading } from '../types/contract';
import { createLemmaExtensions } from './schemaExtensions';
import {
  createParseContext,
  parseMarkdownChunkToBlocks,
  parseMarkdownToDocJson,
  type ParseContext,
} from './codec/markdownParser';
import { splitMarkdownForProgressiveLoad } from './codec/markdownChunker';
import { serializeDocToMarkdown } from './codec/markdownSerializer';
import {
  beginBulkMathMountWindow,
  beginHydrationSliceMount,
  endBulkMathMountWindow,
  endHydrationSliceMount,
  setHydrationActive,
} from './extensions/mathViewportScheduler';

export interface SetExternalMarkdownOptions {
  progressive?: boolean;
}

export interface LemmaEditorHandle {
  getEditor: () => Editor | null;
  getMarkdown: () => string;
  setMarkdownFromExternal: (
    markdown: string,
    options?: SetExternalMarkdownOptions
  ) => void;
  flushPendingHydration: () => void;
  isHydrating: () => boolean;
  scrollToPos: (pos: number) => void;
}

export interface LemmaEditorProps {
  initialMarkdown: string;
  currentFilePath: string | null;
  resolveAssetUrl: (rawSrc: string) => string;
  onPasteImage?: (base64Data: string, ext: string) => Promise<string | null>;
  onMarkdownChange: (markdown: string) => void;
  /** Lightweight O(1) synchronous callback fired immediately on user doc mutation before debounced Markdown serialization */
  onDocDirty?: () => void;
  onOutlineChange?: (headings: OutlineHeading[]) => void;
  onEditorReady?: (editor: Editor | null) => void;
  onBlurSave?: () => void;
  onHydrationAppend?: (
    appendedFragment: Fragment,
    editor: Editor,
    isFinalChunk: boolean
  ) => void;
  hideDeletions?: boolean;
  extraPlugins?: Plugin[];
}

const SUPPORTED_IMAGE_MIMES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const HYDRATION_SLICE_BUDGET_MS = 6.5;

/**
 * Extracts `h1`–`h6` outline headings with readable inline math text and ProseMirror positions.
 */
export function extractOutlineHeadings(doc: PMNode): OutlineHeading[] {
  const headings: OutlineHeading[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1));
      const parts: string[] = [];
      node.forEach((child) => {
        if (child.isText) {
          parts.push(child.text ?? '');
        } else if (child.type.name === 'mathInline') {
          parts.push(`$${String(child.attrs.latex ?? '').trim()}$`);
        } else {
          parts.push(child.textContent);
        }
      });
      const text = parts.join('').trim();
      const slug = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      headings.push({
        id: `heading-${pos}${slug ? `-${slug}` : ''}`,
        level,
        text: text || '(未命名标题)',
        pos,
      });
      return false;
    }
    return true;
  });

  return headings;
}

function shouldParsePlainTextAsRichMarkdown(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  // AI LaTeX delimiters \(...\) or \[...\]
  if (/\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(text)) {
    return true;
  }
  // Standard Markdown display or inline math
  if (/\$\$[\s\S]+?\$\$|(?<![\\$])\$[^$\n]+\$/.test(text)) {
    return true;
  }
  // Fenced code blocks (including ```svg)
  if (/^[ \t]*(?:```|~~~)/m.test(text)) {
    return true;
  }
  // GFM pipe tables
  if (/^\|.+\|[ \t]*\r?\n\|[ \t:|-]+\|/m.test(text)) {
    return true;
  }
  // GitHub / LaTeX Callouts
  if (/^>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im.test(text)) {
    return true;
  }
  // Headings, task items, or Markdown images
  if (/^(?:#{1,6}\s|- \[[ xX]\]\s|!\[[^\]]*\]\([^)]+\))/m.test(text)) {
    return true;
  }
  // Inline highlights or comments (<mark>, <span data-comment=...>, ==...==, {==...==}{>>...<<})
  if (
    /<mark(?:\s|>)|<span\s+[^>]*data-comment=|(?<!=)==(?=\S)[\s\S]*?(?<=\S)==(?!=)|\{==[\s\S]+?==\}\{>>[\s\S]*?<<\}/.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

function readBlobAsPureBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Failed to read clipboard image'));
    };
    reader.readAsDataURL(blob);
  });
}

function buildProgressivePlan(markdown: string): {
  rawSource: string;
  initialContent: JSONContent;
  remainingQueue: string[];
  remainingTailChars: number;
  parseCtx: ParseContext;
} {
  const rawSource = markdown ?? '';
  const { head, tailChunks } = splitMarkdownForProgressiveLoad(rawSource);
  const parseCtx = createParseContext();
  const remainingQueue = [...tailChunks];
  const headBlocks = parseMarkdownChunkToBlocks(head, parseCtx);

  while (headBlocks.length === 0 && remainingQueue.length > 0) {
    const nextChunk = remainingQueue.shift()!;
    headBlocks.push(...parseMarkdownChunkToBlocks(nextChunk, parseCtx));
  }

  const initialContent: JSONContent = {
    type: 'doc',
    content: headBlocks.length > 0 ? headBlocks : [{ type: 'paragraph' }],
  };

  let remainingTailChars = 0;
  for (const chunk of remainingQueue) {
    remainingTailChars += chunk.length;
  }

  return {
    rawSource,
    initialContent,
    remainingQueue,
    remainingTailChars,
    parseCtx,
  };
}

export const LemmaEditor = forwardRef<LemmaEditorHandle, LemmaEditorProps>(
  function LemmaEditor(
    {
      initialMarkdown,
      currentFilePath,
      resolveAssetUrl,
      onPasteImage,
      onMarkdownChange,
      onDocDirty,
      onOutlineChange,
      onEditorReady,
      onBlurSave,
      onHydrationAppend,
      hideDeletions = false,
      extraPlugins,
    },
    ref
  ) {
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const editorHostRef = useRef<HTMLDivElement | null>(null);
    const isMountedRef = useRef(false);
    const isApplyingExternalRef = useRef(false);
    const editorInstanceRef = useRef<Editor | null>(null);
    const [editor, setEditor] = useState<Editor | null>(null);
    const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Progressive hydration refs
    const hydrationRafRef = useRef<number | null>(null);
    const hydrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingTailChunksRef = useRef<string[]>([]);
    const remainingTailCharsRef = useRef<number>(0);
    const parseCtxRef = useRef<ParseContext>(createParseContext());
    const rawSourceMarkdownRef = useRef<string>(initialMarkdown ?? '');
    const hasLocalEditsRef = useRef<boolean>(false);
    const hasInitializedPlanRef = useRef<boolean>(false);

    // Keep latest callbacks in refs so ProseMirror handlers never read stale closures
    const resolveAssetUrlRef = useRef(resolveAssetUrl);
    resolveAssetUrlRef.current = resolveAssetUrl;

    const onPasteImageRef = useRef(onPasteImage);
    onPasteImageRef.current = onPasteImage;

    const onMarkdownChangeRef = useRef(onMarkdownChange);
    onMarkdownChangeRef.current = onMarkdownChange;

    const onDocDirtyRef = useRef(onDocDirty);
    onDocDirtyRef.current = onDocDirty;

    const onOutlineChangeRef = useRef(onOutlineChange);
    onOutlineChangeRef.current = onOutlineChange;

    const onEditorReadyRef = useRef(onEditorReady);
    onEditorReadyRef.current = onEditorReady;

    const onBlurSaveRef = useRef(onBlurSave);
    onBlurSaveRef.current = onBlurSave;

    const onHydrationAppendRef = useRef(onHydrationAppend);
    onHydrationAppendRef.current = onHydrationAppend;

    const initialExtraPluginsRef = useRef<Plugin[] | undefined>(extraPlugins);
    const prevExtraPluginsRef = useRef<Plugin[]>(
      extraPlugins ? [...extraPlugins] : []
    );

    const initialMountPlan = useMemo(
      () => buildProgressivePlan(initialMarkdown ?? ''),
      // Intentionally parsed once on initial mount; external reloads use setMarkdownFromExternal
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    );

    if (!hasInitializedPlanRef.current) {
      hasInitializedPlanRef.current = true;
      rawSourceMarkdownRef.current = initialMountPlan.rawSource;
      pendingTailChunksRef.current = [...initialMountPlan.remainingQueue];
      remainingTailCharsRef.current = initialMountPlan.remainingTailChars;
      parseCtxRef.current = {
        extCommentCounter: initialMountPlan.parseCtx.extCommentCounter,
      };
      hasLocalEditsRef.current = false;
    }

    const extensions = useMemo(
      () => [
        ...createLemmaExtensions({
          resolveAssetUrl: (rawSrc: string) =>
            resolveAssetUrlRef.current(rawSrc),
        }),
        Extension.create({
          name: 'lemmaExtraPlugins',
          addProseMirrorPlugins() {
            return initialExtraPluginsRef.current ?? [];
          },
        }),
      ],
      []
    );

    const handleEditorCreate = useCallback(
      ({ editor: createdEditor }: { editor: Editor }) => {
        editorInstanceRef.current = createdEditor;
      },
      []
    );

    const clearPendingSerialize = useCallback(() => {
      if (serializeTimerRef.current !== null) {
        clearTimeout(serializeTimerRef.current);
        serializeTimerRef.current = null;
      }
    }, []);

    const cancelHydrationSchedule = useCallback(() => {
      if (hydrationRafRef.current !== null) {
        cancelAnimationFrame(hydrationRafRef.current);
        hydrationRafRef.current = null;
      }
      if (hydrationTimerRef.current !== null) {
        clearTimeout(hydrationTimerRef.current);
        hydrationTimerRef.current = null;
      }
    }, []);

    const syncHydrationSpacer = useCallback(() => {
      const hostEl = editorHostRef.current;
      if (!hostEl) return;
      const rem = remainingTailCharsRef.current;
      if (rem > 0 && pendingTailChunksRef.current.length > 0) {
        hostEl.style.paddingBottom = `${Math.min(
          48000,
          Math.round(rem * 0.38)
        )}px`;
      } else {
        hostEl.style.paddingBottom = '';
      }
    }, []);

    const scheduleNextHydrationSlice = useCallback(
      (targetEditor: Editor) => {
        cancelHydrationSchedule();
        hydrationRafRef.current = requestAnimationFrame(() => {
          hydrationRafRef.current = null;
          hydrationTimerRef.current = setTimeout(() => {
            hydrationTimerRef.current = null;
            if (
              !isMountedRef.current ||
              targetEditor.isDestroyed ||
              editorInstanceRef.current !== targetEditor
            ) {
              return;
            }
            if (pendingTailChunksRef.current.length === 0) {
              remainingTailCharsRef.current = 0;
              syncHydrationSpacer();
              setHydrationActive(false);
              return;
            }

            const sliceStart = performance.now();
            do {
              const chunkStr = pendingTailChunksRef.current.shift();
              if (chunkStr === undefined) break;

              remainingTailCharsRef.current = Math.max(
                0,
                remainingTailCharsRef.current - chunkStr.length
              );

              const blockJsons = parseMarkdownChunkToBlocks(
                chunkStr,
                parseCtxRef.current
              );
              const pmNodes = blockJsons.map((blockJson) =>
                PMNode.fromJSON(targetEditor.schema, blockJson)
              );
              const fragment = Fragment.fromArray(pmNodes);
              const isFinalChunk = pendingTailChunksRef.current.length === 0;

              if (fragment.childCount > 0) {
                const insertPos = targetEditor.state.doc.content.size;
                const tr = targetEditor.state.tr
                  .insert(insertPos, fragment)
                  .setMeta('addToHistory', false)
                  .setMeta('lemmaHydrationAppend', true);

                isApplyingExternalRef.current = true;
                beginHydrationSliceMount();
                try {
                  targetEditor.view.dispatch(tr);
                } finally {
                  endHydrationSliceMount();
                  isApplyingExternalRef.current = false;
                }

                onHydrationAppendRef.current?.(
                  fragment,
                  targetEditor,
                  isFinalChunk
                );
              } else if (isFinalChunk) {
                onHydrationAppendRef.current?.(
                  Fragment.empty,
                  targetEditor,
                  true
                );
              }
            } while (
              pendingTailChunksRef.current.length > 0 &&
              performance.now() - sliceStart < HYDRATION_SLICE_BUDGET_MS
            );

            syncHydrationSpacer();

            if (pendingTailChunksRef.current.length > 0) {
              scheduleNextHydrationSlice(targetEditor);
            } else {
              remainingTailCharsRef.current = 0;
              syncHydrationSpacer();
              setHydrationActive(false);
              onOutlineChangeRef.current?.(
                extractOutlineHeadings(targetEditor.state.doc)
              );
            }
          }, 0);
        });
      },
      [cancelHydrationSchedule, syncHydrationSpacer]
    );

    const flushPendingHydration = useCallback(() => {
      cancelHydrationSchedule();
      const activeEditor = editorInstanceRef.current;
      if (!activeEditor || activeEditor.isDestroyed) {
        pendingTailChunksRef.current = [];
        remainingTailCharsRef.current = 0;
        setHydrationActive(false);
        return;
      }

      if (pendingTailChunksRef.current.length === 0) {
        remainingTailCharsRef.current = 0;
        syncHydrationSpacer();
        setHydrationActive(false);
        return;
      }

      const chunksToFlush = pendingTailChunksRef.current.splice(0);
      remainingTailCharsRef.current = 0;
      syncHydrationSpacer();

      const allBlocks: JSONContent[] = [];
      for (const chunkStr of chunksToFlush) {
        allBlocks.push(
          ...parseMarkdownChunkToBlocks(chunkStr, parseCtxRef.current)
        );
      }

      const pmNodes = allBlocks.map((blockJson) =>
        PMNode.fromJSON(activeEditor.schema, blockJson)
      );
      const combinedFragment = Fragment.fromArray(pmNodes);

      if (combinedFragment.childCount > 0) {
        const insertPos = activeEditor.state.doc.content.size;
        const tr = activeEditor.state.tr
          .insert(insertPos, combinedFragment)
          .setMeta('addToHistory', false)
          .setMeta('lemmaHydrationAppend', true);

        isApplyingExternalRef.current = true;
        beginHydrationSliceMount();
        try {
          activeEditor.view.dispatch(tr);
        } finally {
          endHydrationSliceMount();
          isApplyingExternalRef.current = false;
        }
      }

      setHydrationActive(false);
      onHydrationAppendRef.current?.(combinedFragment, activeEditor, true);
      onOutlineChangeRef.current?.(
        extractOutlineHeadings(activeEditor.state.doc)
      );
    }, [cancelHydrationSchedule, syncHydrationSpacer]);

    useEffect(
      () => () => {
        clearPendingSerialize();
        cancelHydrationSchedule();
        setHydrationActive(false);
      },
      [clearPendingSerialize, cancelHydrationSchedule]
    );

    const scheduleDebouncedSerialize = useCallback(
      (targetEditor: Editor, delayMs: number) => {
        clearPendingSerialize();
        serializeTimerRef.current = setTimeout(() => {
          serializeTimerRef.current = null;
          if (targetEditor.isDestroyed || isApplyingExternalRef.current) {
            return;
          }
          if (pendingTailChunksRef.current.length > 0) {
            scheduleDebouncedSerialize(targetEditor, 120);
            return;
          }
          const md = serializeDocToMarkdown(targetEditor.state.doc);
          onMarkdownChangeRef.current(md);
          onOutlineChangeRef.current?.(
            extractOutlineHeadings(targetEditor.state.doc)
          );
        }, delayMs);
      },
      [clearPendingSerialize]
    );

    const handleEditorUpdate = useCallback(
      ({ editor: updatedEditor }: { editor: Editor }) => {
        if (isApplyingExternalRef.current) {
          return;
        }
        hasLocalEditsRef.current = true;
        onDocDirtyRef.current?.();
        scheduleDebouncedSerialize(updatedEditor, 220);
      },
      [scheduleDebouncedSerialize]
    );

    const handleEditorBlur = useCallback(() => {
      onBlurSaveRef.current?.();
    }, []);

    const editorProps = useMemo(
      () => ({
        attributes: {
          class: 'lemma-prosemirror-editor',
          spellcheck: 'false',
        },
        handlePaste: (_view: unknown, event: ClipboardEvent) => {
          const clipboardData = event.clipboardData;
          if (!clipboardData) return false;

          // 1) Clipboard image paste (`image/png`, `image/jpeg`, `image/webp`)
          if (onPasteImageRef.current) {
            let imageFile: File | null = null;
            let imageExt = 'png';

            for (const item of Array.from(clipboardData.items ?? [])) {
              const ext = SUPPORTED_IMAGE_MIMES[item.type];
              if (ext && item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                  imageFile = file;
                  imageExt = ext;
                  break;
                }
              }
            }

            if (!imageFile && clipboardData.files?.length) {
              for (const file of Array.from(clipboardData.files)) {
                const ext = SUPPORTED_IMAGE_MIMES[file.type];
                if (ext) {
                  imageFile = file;
                  imageExt = ext;
                  break;
                }
              }
            }

            if (imageFile) {
              event.preventDefault();
              const pasteHandler = onPasteImageRef.current;
              void (async () => {
                try {
                  const base64 = await readBlobAsPureBase64(imageFile!);
                  const relPath = await pasteHandler(base64, imageExt);
                  const activeEditor = editorInstanceRef.current;
                  if (relPath && activeEditor && !activeEditor.isDestroyed) {
                    activeEditor
                      .chain()
                      .focus()
                      .insertContent({
                        type: 'image',
                        attrs: { src: relPath, alt: '' },
                      })
                      .run();
                  }
                } catch (err) {
                  console.error(
                    '[LemmaEditor] Failed to paste clipboard image:',
                    err
                  );
                }
              })();
              return true;
            }
          }

          // 2) Plain-text AI LaTeX / Markdown math / GFM tables / SVG blocks paste
          const html = clipboardData.getData('text/html') ?? '';
          const plainText = clipboardData.getData('text/plain') ?? '';

          if (
            !html.includes('data-pm-slice') &&
            shouldParsePlainTextAsRichMarkdown(plainText)
          ) {
            const activeEditor = editorInstanceRef.current;
            if (activeEditor && !activeEditor.isDestroyed) {
              event.preventDefault();
              const parsedDoc = parseMarkdownToDocJson(plainText);
              const blocks = parsedDoc.content ?? [];
              if (blocks.length === 1 && blocks[0].type === 'paragraph') {
                const inlineNodes = blocks[0].content ?? [];
                if (inlineNodes.length > 0) {
                  activeEditor.chain().focus().insertContent(inlineNodes).run();
                }
              } else if (blocks.length > 0) {
                activeEditor.chain().focus().insertContent(blocks).run();
              }
              return true;
            }
          }

          return false;
        },
      }),
      []
    );

    useLayoutEffect(() => {
      isMountedRef.current = true;
      const hostEl = editorHostRef.current;
      if (!hostEl) {
        return;
      }

      setHydrationActive(false);

      let activeEditor = editorInstanceRef.current;
      if (!activeEditor || activeEditor.isDestroyed) {
        beginBulkMathMountWindow();
        try {
          activeEditor = new Editor({
            element: hostEl,
            extensions,
            content: initialMountPlan.initialContent,
            onCreate: handleEditorCreate,
            onUpdate: handleEditorUpdate,
            onBlur: handleEditorBlur,
            editorProps,
          });
        } finally {
          endBulkMathMountWindow();
        }
        editorInstanceRef.current = activeEditor;
        setEditor(activeEditor);
      } else if (activeEditor.view.dom.parentNode !== hostEl) {
        hostEl.appendChild(activeEditor.view.dom);
      }

      onEditorReadyRef.current?.(activeEditor);
      syncHydrationSpacer();

      const mountedEditor = activeEditor;
      queueMicrotask(() => {
        if (
          isMountedRef.current &&
          mountedEditor &&
          !mountedEditor.isDestroyed
        ) {
          onOutlineChangeRef.current?.(
            extractOutlineHeadings(mountedEditor.state.doc)
          );
        }
      });

      if (pendingTailChunksRef.current.length > 0) {
        setHydrationActive(true);
        scheduleNextHydrationSlice(activeEditor);
      }

      return () => {
        isMountedRef.current = false;
        cancelHydrationSchedule();
        setHydrationActive(false);
        onEditorReadyRef.current?.(null);
        const candidate = activeEditor;
        queueMicrotask(() => {
          if (!isMountedRef.current && candidate && !candidate.isDestroyed) {
            pendingTailChunksRef.current = [];
            remainingTailCharsRef.current = 0;
            candidate.destroy();
            if (editorInstanceRef.current === candidate) {
              editorInstanceRef.current = null;
            }
          }
        });
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const prevFilePathRef = useRef<string | null>(currentFilePath);

    // Refresh asset context metadata whenever `currentFilePath` changes in-place
    useEffect(() => {
      if (!editor || editor.isDestroyed) {
        return;
      }
      if (prevFilePathRef.current !== currentFilePath) {
        prevFilePathRef.current = currentFilePath;
        editor.view.dispatch(
          editor.state.tr
            .setMeta('lemmaFilePath', currentFilePath ?? '')
            .setMeta('addToHistory', false)
        );
      }
    }, [editor, currentFilePath]);

    // Synchronize dynamic `extraPlugins` changes without stripping existing plugin state on StrictMode remounts
    useEffect(() => {
      if (!editor || editor.isDestroyed) {
        return;
      }

      const nextPlugins = extraPlugins ?? [];
      const prevPlugins = prevExtraPluginsRef.current;

      const getRawKey = (p: Plugin) => (p as unknown as { key?: string }).key;

      for (const oldPlugin of prevPlugins) {
        if (!nextPlugins.includes(oldPlugin)) {
          const rawKey = getRawKey(oldPlugin);
          if (rawKey) {
            // Tiptap's unregisterPlugin(str) appends '$', whereas ProseMirror plugin.key already ends with '$'
            editor.unregisterPlugin(rawKey.replace(/\$$/, ''));
          }
        }
      }

      for (const plugin of nextPlugins) {
        if (!editor.state.plugins.includes(plugin)) {
          editor.registerPlugin(plugin, (newPlugin, currentPlugins) => [
            ...currentPlugins.filter(
              (existing) => getRawKey(existing) !== getRawKey(newPlugin)
            ),
            newPlugin,
          ]);
        }
      }

      prevExtraPluginsRef.current = [...nextPlugins];
    }, [editor, extraPlugins]);

    const setMarkdownFromExternal = useCallback(
      (markdown: string, options?: SetExternalMarkdownOptions) => {
        const activeEditor = editorInstanceRef.current;
        if (!activeEditor || activeEditor.isDestroyed) return;
        clearPendingSerialize();
        cancelHydrationSchedule();

        const normalizedSource = markdown ?? '';
        rawSourceMarkdownRef.current = normalizedSource;
        hasLocalEditsRef.current = false;

        const scrollEl = scrollContainerRef.current;

        if (options?.progressive === true) {
          const plan = buildProgressivePlan(normalizedSource);
          pendingTailChunksRef.current = [...plan.remainingQueue];
          remainingTailCharsRef.current = plan.remainingTailChars;
          parseCtxRef.current = plan.parseCtx;

          setHydrationActive(false);
          isApplyingExternalRef.current = true;
          beginBulkMathMountWindow();
          try {
            activeEditor.commands.setContent(plan.initialContent, false);
            if (!activeEditor.state.selection.empty) {
              activeEditor.view.dispatch(
                activeEditor.state.tr
                  .setSelection(Selection.atStart(activeEditor.state.doc))
                  .setMeta('addToHistory', false)
              );
            }
          } finally {
            endBulkMathMountWindow();
            isApplyingExternalRef.current = false;
          }

          syncHydrationSpacer();

          if (scrollEl) {
            scrollEl.scrollTop = 0;
          }

          queueMicrotask(() => {
            if (
              isMountedRef.current &&
              !activeEditor.isDestroyed &&
              editorInstanceRef.current === activeEditor
            ) {
              onOutlineChangeRef.current?.(
                extractOutlineHeadings(activeEditor.state.doc)
              );
            }
          });

          if (pendingTailChunksRef.current.length > 0) {
            setHydrationActive(true);
            scheduleNextHydrationSlice(activeEditor);
          }
          return;
        }

        // Default synchronous path (`progressive: false`, e.g. AI file diff & Source Mode toggle)
        pendingTailChunksRef.current = [];
        remainingTailCharsRef.current = 0;
        parseCtxRef.current = createParseContext();
        syncHydrationSpacer();
        setHydrationActive(false);

        const savedScrollTop = scrollEl ? scrollEl.scrollTop : 0;
        const docJson = parseMarkdownToDocJson(normalizedSource);
        isApplyingExternalRef.current = true;
        beginBulkMathMountWindow();
        try {
          activeEditor.commands.setContent(docJson, false);
          if (!activeEditor.state.selection.empty) {
            activeEditor.view.dispatch(
              activeEditor.state.tr
                .setSelection(Selection.atStart(activeEditor.state.doc))
                .setMeta('addToHistory', false)
            );
          }
        } finally {
          endBulkMathMountWindow();
          isApplyingExternalRef.current = false;
        }

        onOutlineChangeRef.current?.(
          extractOutlineHeadings(activeEditor.state.doc)
        );

        if (scrollEl) {
          scrollEl.scrollTop = savedScrollTop;
          requestAnimationFrame(() => {
            if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollTop = savedScrollTop;
            }
          });
        }
      },
      [
        clearPendingSerialize,
        cancelHydrationSchedule,
        syncHydrationSpacer,
        scheduleNextHydrationSlice,
      ]
    );

    const scrollToPos = useCallback(
      (pos: number) => {
        const activeEditor = editorInstanceRef.current;
        if (!activeEditor || activeEditor.isDestroyed) return;
        if (
          pendingTailChunksRef.current.length > 0 &&
          pos >= activeEditor.state.doc.content.size - 2
        ) {
          flushPendingHydration();
        }
        const scrollEl = scrollContainerRef.current;
        const maxPos = activeEditor.state.doc.content.size;
        const safePos = Math.max(0, Math.min(pos, maxPos));

        try {
          const domAtPos = activeEditor.view.nodeDOM(safePos);
          if (domAtPos instanceof HTMLElement && scrollEl) {
            const targetRect = domAtPos.getBoundingClientRect();
            const containerRect = scrollEl.getBoundingClientRect();
            const nextTop =
              scrollEl.scrollTop + (targetRect.top - containerRect.top) - 28;
            scrollEl.scrollTo({
              top: Math.max(0, nextTop),
              behavior: 'smooth',
            });
            return;
          }

          if (scrollEl) {
            const coords = activeEditor.view.coordsAtPos(safePos);
            const containerRect = scrollEl.getBoundingClientRect();
            const nextTop =
              scrollEl.scrollTop + (coords.top - containerRect.top) - 28;
            scrollEl.scrollTo({
              top: Math.max(0, nextTop),
              behavior: 'smooth',
            });
          }
        } catch {
          // Ignore layout coordinate lookup errors in headless environments
        }
      },
      [flushPendingHydration]
    );

    const isHydrating = useCallback(
      () => pendingTailChunksRef.current.length > 0,
      []
    );

    useImperativeHandle(
      ref,
      () => ({
        getEditor: () => {
          const activeEditor = editorInstanceRef.current;
          return activeEditor && !activeEditor.isDestroyed
            ? activeEditor
            : null;
        },
        getMarkdown: () => {
          const activeEditor = editorInstanceRef.current;
          if (!activeEditor || activeEditor.isDestroyed) {
            return rawSourceMarkdownRef.current;
          }
          if (pendingTailChunksRef.current.length > 0) {
            if (!hasLocalEditsRef.current) {
              return rawSourceMarkdownRef.current;
            }
            flushPendingHydration();
          }
          if (serializeTimerRef.current !== null) {
            clearPendingSerialize();
            onOutlineChangeRef.current?.(
              extractOutlineHeadings(activeEditor.state.doc)
            );
          }
          return serializeDocToMarkdown(activeEditor.state.doc);
        },
        setMarkdownFromExternal,
        flushPendingHydration,
        isHydrating,
        scrollToPos,
      }),
      [
        clearPendingSerialize,
        setMarkdownFromExternal,
        flushPendingHydration,
        isHydrating,
        scrollToPos,
      ]
    );

    return (
      <div className="lemma-desk-scroll" ref={scrollContainerRef}>
        <div
          id="write"
          className={hideDeletions ? 'lemma-hide-deletions' : ''}
        >
          <div ref={editorHostRef} />
        </div>
      </div>
    );
  }
);

export default LemmaEditor;
