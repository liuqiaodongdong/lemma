import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Editor } from '@tiptap/core';
import type { Fragment } from '@tiptap/pm/model';
import { MessageSquareText } from 'lucide-react';
import type {
  DocumentComment,
  EditorViewMode,
  FileSnapshot,
  HighlightColor,
  OutlineHeading,
  PendingCommentDraft,
  ThemeMode,
  WordCountStats,
} from './types/contract';
import { tauriBridge } from './services/tauriBridge';
import {
  EMPTY_WORD_COUNT_STATS,
  computeMarkdownWordStats,
  computeProseMirrorSelectionWordStats,
} from './utils/wordCount';
import {
  CommentSidebar,
  SelectionToolbar,
} from './components/annotations';
import {
  DiffReviewBar,
  Sidebar,
  TopBar,
  WelcomeScreen,
  WordCountBar,
} from './components/shell';
import {
  LemmaEditor,
  addCommentAtRange,
  applyHighlightColor,
  clearAllComments,
  clearAllHighlights,
  createActiveCommentPlugin,
  extractDocumentComments,
  extractSelectionQuote,
  getSelectionHighlightColor,
  hasAnyHighlightInDoc,
  hasAnyHighlightInSelection,
  removeCommentById,
  removeSelectionHighlight,
  setActiveCommentDecoration,
  updateCommentTextById,
  type LemmaEditorHandle,
} from './editor';
import { useDiffReview } from './diff';

const LazySourceEditor = lazy(() => import('./components/source/SourceEditor'));

const THEME_STORAGE_KEY = 'lemma:theme-mode';
const USER_ZOOM_STORAGE_KEY = 'lemma:user-zoom';
const REF_CANVAS_WIDTH = 1140;
// Exact outer flex widths matching app-shell.css (.lemma-sidebar: 264px + 1px border-right)
// and annotations.css (aside.lemma-comment-rail: 312px + 1px border-left)
const SIDEBAR_PIXEL_WIDTH = 265;
const COMMENT_RAIL_PIXEL_WIDTH = 313;
const MIN_USER_ZOOM = 0.5;
const MAX_USER_ZOOM = 2.5;
const IDLE_AUTOSAVE_MS = 900;

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function clampUserZoom(val: number): number {
  if (!Number.isFinite(val)) return 1;
  return Math.min(MAX_USER_ZOOM, Math.max(MIN_USER_ZOOM, val));
}

function normalizePathKey(p: string | null): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function getFileBaseName(filePath: string | null): string {
  if (!filePath) return 'Lemma';
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'Lemma';
}

function areCommentsEqual(
  a: DocumentComment[],
  b: DocumentComment[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a[i];
    const cb = b[i];
    if (
      ca.id !== cb.id ||
      ca.text !== cb.text ||
      ca.quote !== cb.quote ||
      ca.from !== cb.from ||
      ca.to !== cb.to ||
      ca.createdAt !== cb.createdAt
    ) {
      return false;
    }
  }
  return true;
}

function areOutlinesEqual(a: OutlineHeading[], b: OutlineHeading[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].level !== b[i].level ||
      a[i].text !== b[i].text ||
      a[i].pos !== b[i].pos
    ) {
      return false;
    }
  }
  return true;
}

function areWordStatsEqual(a: WordCountStats, b: WordCountStats): boolean {
  if (a === b) return true;
  return (
    a.totalWords === b.totalWords &&
    a.cjkChars === b.cjkChars &&
    a.latinWords === b.latinWords &&
    a.charsNoSpaces === b.charsNoSpaces &&
    a.charsWithSpaces === b.charsWithSpaces &&
    a.paragraphs === b.paragraphs &&
    a.mathCount === b.mathCount &&
    a.readingMinutes === b.readingMinutes
  );
}

function areNullableWordStatsEqual(
  a: WordCountStats | null,
  b: WordCountStats | null
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return areWordStatsEqual(a, b);
}

function hasEmbeddedCommentsInMarkdown(md: string): boolean {
  return /<span\s+[^>]*data-comment=|\{==[\s\S]+?==\}\{>>/i.test(md);
}

export interface AppProps {
  initialBootDoc?: FileSnapshot | null;
  bootResolved?: boolean;
}

export function App({
  initialBootDoc = null,
  bootResolved = false,
}: AppProps): React.ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      // Ignore storage access errors
    }
    return 'light';
  });

  const [userZoom, setUserZoom] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(USER_ZOOM_STORAGE_KEY);
      if (raw !== null) {
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed)) return clampUserZoom(parsed);
      }
    } catch {
      // Ignore storage access errors
    }
    return 1;
  });

  const initialCommentRailOpen = initialBootDoc
    ? hasEmbeddedCommentsInMarkdown(initialBootDoc.content)
    : false;

  const [canvasWidth, setCanvasWidth] = useState<number>(() =>
    typeof window !== 'undefined' && window.innerWidth > 0
      ? Math.max(
          320,
          window.innerWidth -
            (initialCommentRailOpen ? COMMENT_RAIL_PIXEL_WIDTH : 0)
        )
      : REF_CANVAS_WIDTH
  );
  const canvasStageRef = useRef<HTMLDivElement | null>(null);

  const [hasDocument, setHasDocument] = useState<boolean>(() =>
    Boolean(initialBootDoc)
  );
  const [isBootingCli, setIsBootingCli] = useState<boolean>(() =>
    bootResolved || initialBootDoc ? false : tauriBridge.isTauri()
  );
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(
    () => initialBootDoc?.path ?? null
  );
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<EditorViewMode>('wysiwyg');

  const [markdown, setMarkdown] = useState<string>(
    () => initialBootDoc?.content ?? ''
  );
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [saveStatusText, setSaveStatusText] = useState<string>(() =>
    initialBootDoc ? '已就绪' : ''
  );
  const [outline, setOutline] = useState<OutlineHeading[]>([]);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const [docWordStats, setDocWordStats] = useState<WordCountStats>(
    EMPTY_WORD_COUNT_STATS
  );
  const [selectionWordStats, setSelectionWordStats] =
    useState<WordCountStats | null>(null);

  // Annotations: Multi-color Highlights & Word-style Inline-Anchored Comments
  const [comments, setComments] = useState<DocumentComment[]>([]);
  const [hasAnyHighlights, setHasAnyHighlights] = useState<boolean>(false);
  const [selectionHighlightColor, setSelectionHighlightColor] =
    useState<HighlightColor | null>(null);
  const [hasSelectionHighlight, setHasSelectionHighlight] =
    useState<boolean>(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] =
    useState<PendingCommentDraft | null>(null);
  const [commentSidebarOpen, setCommentSidebarOpen] = useState<boolean>(
    initialCommentRailOpen
  );
  const autoOpenCommentsOnLoadRef = useRef<boolean>(Boolean(initialBootDoc));

  const editorHandleRef = useRef<LemmaEditorHandle | null>(null);
  const currentFilePathRef = useRef<string | null>(currentFilePath);
  currentFilePathRef.current = currentFilePath;

  const viewModeRef = useRef<EditorViewMode>(viewMode);
  viewModeRef.current = viewMode;

  const markdownRef = useRef<string>(markdown);

  const isDirtyRef = useRef<boolean>(isDirty);
  isDirtyRef.current = isDirty;

  const idleSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wordCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const pendingBaselineResetRef = useRef<boolean>(Boolean(initialBootDoc));
  const fileLoadSeqRef = useRef<number>(0);
  const hasDocumentRef = useRef<boolean>(hasDocument);
  hasDocumentRef.current = hasDocument;

  const clearIdleSaveTimer = useCallback(() => {
    if (idleSaveTimerRef.current !== null) {
      clearTimeout(idleSaveTimerRef.current);
      idleSaveTimerRef.current = null;
    }
  }, []);

  const clearWordCountTimer = useCallback(() => {
    if (wordCountTimerRef.current !== null) {
      clearTimeout(wordCountTimerRef.current);
      wordCountTimerRef.current = null;
    }
  }, []);

  /**
   * Computes full-document word statistics asynchronously off the Frame-1 critical render path.
   */
  const scheduleDocWordCount = useCallback(
    (nextMd: string, delayMs = 16) => {
      clearWordCountTimer();
      wordCountTimerRef.current = setTimeout(() => {
        wordCountTimerRef.current = null;
        if (!hasDocumentRef.current) {
          setDocWordStats((prev) =>
            areWordStatsEqual(prev, EMPTY_WORD_COUNT_STATS)
              ? prev
              : EMPTY_WORD_COUNT_STATS
          );
          return;
        }
        const nextStats = computeMarkdownWordStats(nextMd);
        setDocWordStats((prev) =>
          areWordStatsEqual(prev, nextStats) ? prev : nextStats
        );
      }, delayMs);
    },
    [clearWordCountTimer]
  );

  // Schedule initial full-document word count after Frame-1 paints (0.0 ms Frame-1 impact)
  useEffect(() => {
    if (!hasDocument) {
      clearWordCountTimer();
      setDocWordStats((prev) =>
        areWordStatsEqual(prev, EMPTY_WORD_COUNT_STATS)
          ? prev
          : EMPTY_WORD_COUNT_STATS
      );
      setSelectionWordStats((prev) => (prev === null ? prev : null));
      return;
    }
    scheduleDocWordCount(markdownRef.current, 16);
    return () => {
      clearWordCountTimer();
    };
  }, [hasDocument, clearWordCountTimer, scheduleDocWordCount]);

  const getLiveMarkdown = useCallback((): string => {
    if (viewModeRef.current === 'wysiwyg' && editorHandleRef.current) {
      editorHandleRef.current.flushPendingHydration?.();
      return editorHandleRef.current.getMarkdown();
    }
    return markdownRef.current;
  }, []);

  /**
   * Saves reverted hunk content immediately to disk WITHOUT resetting baselineDoc,
   * so any other remaining AI hunks stay highlighted for review.
   */
  const handleAfterRevertSave = useCallback(() => {
    clearIdleSaveTimer();
    const liveMd = editorHandleRef.current
      ? editorHandleRef.current.getMarkdown()
      : markdownRef.current;
    markdownRef.current = liveMd;
    setMarkdown(liveMd);
    scheduleDocWordCount(liveMd, 16);

    const targetPath = currentFilePathRef.current;
    if (!targetPath) {
      isDirtyRef.current = true;
      setIsDirty(true);
      setSaveStatusText('已撤回该处修改');
      return;
    }

    isDirtyRef.current = false;
    setIsDirty(false);
    void tauriBridge
      .writeMarkdownFile(targetPath, liveMd)
      .then(() => {
        setSaveStatusText('已撤回并自动保存');
      })
      .catch((err) => {
        console.error('[Lemma] Revert save failed:', err);
        setSaveStatusText('撤回保存失败');
      });
  }, [clearIdleSaveTimer, scheduleDocWordCount]);

  const {
    diffState,
    diffActions,
    diffPlugin,
    markCurrentAsBaseline,
    appendToBaseline,
    reviewExternalUpdate,
  } = useDiffReview({
    editor: editorInstance,
    onAfterRevert: handleAfterRevertSave,
  });

  const hasActiveDiffRef = useRef<boolean>(diffState.hasChanges);
  hasActiveDiffRef.current = diffState.hasChanges;

  const activeCommentPlugin = useMemo(
    () =>
      createActiveCommentPlugin((foundId) => {
        setActiveCommentId(foundId);
        if (foundId) {
          setCommentSidebarOpen(true);
        }
      }),
    []
  );

  const extraPlugins = useMemo(
    () => [diffPlugin, activeCommentPlugin],
    [diffPlugin, activeCommentPlugin]
  );

  const syncAnnotationsFromEditor = useCallback(
    (ed: Editor | null, checkAutoOpen = false) => {
      if (!ed || ed.isDestroyed) {
        setComments((prev) => (prev.length === 0 ? prev : []));
        setHasAnyHighlights(false);
        setSelectionHighlightColor(null);
        setHasSelectionHighlight(false);
        return;
      }
      const nextComments = extractDocumentComments(ed.state.doc);
      setComments((prev) =>
        areCommentsEqual(prev, nextComments) ? prev : nextComments
      );
      setHasAnyHighlights(hasAnyHighlightInDoc(ed.state.doc));
      setSelectionHighlightColor(getSelectionHighlightColor(ed));
      setHasSelectionHighlight(hasAnyHighlightInSelection(ed));

      if (checkAutoOpen || autoOpenCommentsOnLoadRef.current) {
        if (nextComments.length > 0) {
          autoOpenCommentsOnLoadRef.current = false;
          setCommentSidebarOpen(true);
        } else if (checkAutoOpen) {
          autoOpenCommentsOnLoadRef.current = false;
        }
      }
    },
    []
  );

  const syncSelectionWordCountFromEditor = useCallback(
    (ed: Editor | null) => {
      if (!ed || ed.isDestroyed || viewModeRef.current !== 'wysiwyg') {
        setSelectionWordStats((prev) => (prev === null ? prev : null));
        return;
      }
      const { from, to, empty } = ed.state.selection;
      if (empty) {
        setSelectionWordStats((prev) => (prev === null ? prev : null));
        return;
      }
      const nextSel = computeProseMirrorSelectionWordStats(
        ed.state.doc,
        from,
        to
      );
      setSelectionWordStats((prev) =>
        areNullableWordStatsEqual(prev, nextSel) ? prev : nextSel
      );
    },
    []
  );

  const handleOutlineChange = useCallback((nextOutline: OutlineHeading[]) => {
    setOutline((prev) =>
      areOutlinesEqual(prev, nextOutline) ? prev : nextOutline
    );
  }, []);

  const handleEditorReady = useCallback(
    (ed: Editor | null) => {
      setEditorInstance(ed);
      if (ed && pendingBaselineResetRef.current) {
        pendingBaselineResetRef.current = false;
        markCurrentAsBaseline(ed);
      }
      syncAnnotationsFromEditor(ed, false);
      syncSelectionWordCountFromEditor(ed);
    },
    [
      markCurrentAsBaseline,
      syncAnnotationsFromEditor,
      syncSelectionWordCountFromEditor,
    ]
  );

  const handleHydrationAppend = useCallback(
    (appendedFragment: Fragment, ed: Editor, isFinalChunk: boolean) => {
      appendToBaseline(appendedFragment);
      if (isFinalChunk) {
        syncAnnotationsFromEditor(ed, autoOpenCommentsOnLoadRef.current);
      }
    },
    [appendToBaseline, syncAnnotationsFromEditor]
  );

  // Subscribe to ProseMirror transactions & selection updates for live comment/highlight/selection-wordcount state
  useEffect(() => {
    if (!editorInstance || editorInstance.isDestroyed) return;

    const handleTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean; getMeta?: (key: string) => unknown };
    }) => {
      if (transaction.getMeta?.('lemmaHydrationAppend')) {
        return;
      }
      if (transaction.docChanged) {
        syncAnnotationsFromEditor(editorInstance);
      } else {
        setSelectionHighlightColor(getSelectionHighlightColor(editorInstance));
        setHasSelectionHighlight(hasAnyHighlightInSelection(editorInstance));
      }
      syncSelectionWordCountFromEditor(editorInstance);
    };

    const handleSelectionUpdate = () => {
      setSelectionHighlightColor(getSelectionHighlightColor(editorInstance));
      setHasSelectionHighlight(hasAnyHighlightInSelection(editorInstance));
      syncSelectionWordCountFromEditor(editorInstance);
    };

    editorInstance.on('transaction', handleTransaction);
    editorInstance.on('selectionUpdate', handleSelectionUpdate);
    return () => {
      editorInstance.off('transaction', handleTransaction);
      editorInstance.off('selectionUpdate', handleSelectionUpdate);
    };
  }, [
    editorInstance,
    syncAnnotationsFromEditor,
    syncSelectionWordCountFromEditor,
  ]);

  // Keep active comment anchor & pending draft range highlighted inside #write
  useEffect(() => {
    if (!editorInstance || editorInstance.isDestroyed) return;
    setActiveCommentDecoration(
      editorInstance,
      activeCommentId,
      pendingDraft
        ? { from: pendingDraft.from, to: pendingDraft.to }
        : null
    );
  }, [editorInstance, activeCommentId, pendingDraft]);

  // Sync theme attribute on <html> and persist preference
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage access errors
    }
  }, [theme]);

  // Update window document title
  useEffect(() => {
    if (!hasDocument) {
      document.title = 'Lemma（引理）';
      return;
    }
    const base = getFileBaseName(currentFilePath);
    document.title = `${isDirty ? '• ' : ''}${base} — Lemma`;
  }, [hasDocument, currentFilePath, isDirty]);

  // Complete baseline initialization as soon as Tiptap mounts for a newly opened document
  useEffect(() => {
    if (editorInstance && pendingBaselineResetRef.current) {
      pendingBaselineResetRef.current = false;
      markCurrentAsBaseline(editorInstance);
    }
    if (
      editorInstance &&
      autoOpenCommentsOnLoadRef.current &&
      !editorHandleRef.current?.isHydrating?.()
    ) {
      autoOpenCommentsOnLoadRef.current = false;
    }
  }, [editorInstance, markCurrentAsBaseline]);

  /**
   * Flushes unsaved user edits to disk immediately (used on window blur, idle timeout, and file switch).
   */
  const flushAutoSave = useCallback(
    async (reason: 'blur' | 'idle' | 'switch' | 'manual'): Promise<void> => {
      clearIdleSaveTimer();
      const targetPath = currentFilePathRef.current;
      if (!targetPath) {
        return;
      }
      if (!isDirtyRef.current && reason !== 'manual') {
        return;
      }

      const contentToWrite = getLiveMarkdown();
      markdownRef.current = contentToWrite;
      setMarkdown(contentToWrite);
      scheduleDocWordCount(contentToWrite, 16);
      isDirtyRef.current = false;
      setIsDirty(false);

      const writeTask = tauriBridge
        .writeMarkdownFile(targetPath, contentToWrite)
        .then(() => {
          // Only advance baseline to user's latest saved version when NOT actively reviewing unaccepted AI hunks,
          // ensuring blur/idle/Ctrl+S saves never clear unreviewed AI Diff highlights prematurely.
          if (!hasActiveDiffRef.current) {
            markCurrentAsBaseline(editorHandleRef.current?.getEditor());
          }
          setSaveStatusText(
            reason === 'blur' ? '切出窗口已秒存' : '已自动保存'
          );
        })
        .catch((err) => {
          console.error('[Lemma] Failed to write markdown file:', err);
          isDirtyRef.current = true;
          setIsDirty(true);
          setSaveStatusText('保存失败');
        });

      saveInFlightRef.current = writeTask;
      await writeTask;
    },
    [
      clearIdleSaveTimer,
      getLiveMarkdown,
      markCurrentAsBaseline,
      scheduleDocWordCount,
    ]
  );

  // Window blur & visibilitychange instant auto-save (prevents race with external AI Agents)
  useEffect(() => {
    const handleWindowBlur = () => {
      if (isDirtyRef.current && currentFilePathRef.current) {
        void flushAutoSave('blur');
      }
    };

    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'hidden' &&
        isDirtyRef.current &&
        currentFilePathRef.current
      ) {
        void flushAutoSave('blur');
      }
    };

    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushAutoSave]);

  // Listen for external file modifications from AI Agents via Rust notify watcher
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void tauriBridge
      .onExternalFileChange((event) => {
        if (cancelled) return;
        const activePath = currentFilePathRef.current;
        if (
          !activePath ||
          normalizePathKey(event.path) !== normalizePathKey(activePath)
        ) {
          return;
        }

        clearIdleSaveTimer();
        markdownRef.current = event.content;
        setMarkdown(event.content);
        setSelectionWordStats(null);
        scheduleDocWordCount(event.content, 16);
        isDirtyRef.current = false;
        setIsDirty(false);

        editorHandleRef.current?.flushPendingHydration?.();

        const liveEditor = editorHandleRef.current?.getEditor() ?? null;
        if (liveEditor && pendingBaselineResetRef.current) {
          pendingBaselineResetRef.current = false;
          markCurrentAsBaseline(liveEditor);
        }

        if (editorHandleRef.current) {
          autoOpenCommentsOnLoadRef.current = true;
          editorHandleRef.current.setMarkdownFromExternal(event.content, {
            progressive: false,
          });
          setSelectionWordStats(null);
        }

        requestAnimationFrame(() => {
          reviewExternalUpdate(editorHandleRef.current?.getEditor());
        });
        setSaveStatusText('AI 已更新文稿');
      })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [
    clearIdleSaveTimer,
    markCurrentAsBaseline,
    reviewExternalUpdate,
    scheduleDocWordCount,
  ]);

  const openFileByPath = useCallback(
    async (filePath: string) => {
      const loadSeq = ++fileLoadSeqRef.current;
      if (isDirtyRef.current && currentFilePathRef.current) {
        await flushAutoSave('switch');
        if (loadSeq !== fileLoadSeqRef.current) return;
      }

      try {
        const snapshot = await tauriBridge.readMarkdownFile(filePath);
        if (loadSeq !== fileLoadSeqRef.current) return;
        clearIdleSaveTimer();

        currentFilePathRef.current = snapshot.path;
        setCurrentFilePath(snapshot.path);
        markdownRef.current = snapshot.content;
        setMarkdown(snapshot.content);
        setSelectionWordStats(null);
        scheduleDocWordCount(snapshot.content, 16);
        isDirtyRef.current = false;
        setIsDirty(false);
        setSaveStatusText('已就绪');

        setPendingDraft(null);
        setActiveCommentId(null);
        setCommentSidebarOpen(hasEmbeddedCommentsInMarkdown(snapshot.content));
        autoOpenCommentsOnLoadRef.current = true;

        if (editorHandleRef.current) {
          editorHandleRef.current.setMarkdownFromExternal(snapshot.content, {
            progressive: true,
          });
          setSelectionWordStats(null);
          const ed = editorHandleRef.current.getEditor();
          markCurrentAsBaseline(ed);
          const isStillHydrating = Boolean(
            editorHandleRef.current.isHydrating?.()
          );
          syncAnnotationsFromEditor(ed, !isStillHydrating);
          if (!hasDocumentRef.current) {
            setHasDocument(true);
          }
        } else {
          pendingBaselineResetRef.current = true;
          setHasDocument(true);
        }

        void tauriBridge.watchFile(snapshot.path);
      } catch (err) {
        if (loadSeq !== fileLoadSeqRef.current) return;
        console.error('[Lemma] Failed to open file:', err);
        setSaveStatusText('打开文件失败');
      }
    },
    [
      clearIdleSaveTimer,
      flushAutoSave,
      markCurrentAsBaseline,
      scheduleDocWordCount,
      syncAnnotationsFromEditor,
    ]
  );

  const handleNewFile = useCallback(async () => {
    const loadSeq = ++fileLoadSeqRef.current;
    if (isDirtyRef.current && currentFilePathRef.current) {
      await flushAutoSave('switch');
      if (loadSeq !== fileLoadSeqRef.current) return;
    }
    await tauriBridge.unwatchFile();
    if (loadSeq !== fileLoadSeqRef.current) return;
    clearIdleSaveTimer();

    const initialContent = '# 未命名文稿\n\n';
    currentFilePathRef.current = null;
    setCurrentFilePath(null);
    markdownRef.current = initialContent;
    setMarkdown(initialContent);
    setSelectionWordStats(null);
    scheduleDocWordCount(initialContent, 16);
    isDirtyRef.current = false;
    setIsDirty(false);
    setSaveStatusText('未保存本地路径');
    viewModeRef.current = 'wysiwyg';
    setViewMode('wysiwyg');
    setPendingDraft(null);
    setActiveCommentId(null);
    setCommentSidebarOpen(false);

    if (editorHandleRef.current) {
      editorHandleRef.current.setMarkdownFromExternal(initialContent);
      setSelectionWordStats(null);
      markCurrentAsBaseline(editorHandleRef.current.getEditor());
      syncAnnotationsFromEditor(editorHandleRef.current.getEditor());
      if (!hasDocumentRef.current) {
        setHasDocument(true);
      }
    } else {
      pendingBaselineResetRef.current = true;
      setHasDocument(true);
    }
  }, [
    clearIdleSaveTimer,
    flushAutoSave,
    markCurrentAsBaseline,
    scheduleDocWordCount,
    syncAnnotationsFromEditor,
  ]);

  const handleLoadDemo = useCallback(async () => {
    const loadSeq = ++fileLoadSeqRef.current;
    if (isDirtyRef.current && currentFilePathRef.current) {
      await flushAutoSave('switch');
      if (loadSeq !== fileLoadSeqRef.current) return;
    }
    await tauriBridge.unwatchFile();
    if (loadSeq !== fileLoadSeqRef.current) return;
    clearIdleSaveTimer();

    let demoContent = '';
    try {
      const resp = await fetch('/demo/economics-showcase.md');
      if (resp.ok) {
        demoContent = await resp.text();
      }
    } catch {
      // Fallback to bridge demo loader
    }
    if (!demoContent.trim()) {
      const snap = await tauriBridge.readMarkdownFile(
        '/demo/economics-showcase.md'
      );
      demoContent = snap.content;
    }
    if (loadSeq !== fileLoadSeqRef.current) return;

    currentFilePathRef.current = null;
    setCurrentFilePath(null);
    markdownRef.current = demoContent;
    setMarkdown(demoContent);
    setSelectionWordStats(null);
    scheduleDocWordCount(demoContent, 16);
    isDirtyRef.current = false;
    setIsDirty(false);
    setSaveStatusText('示例文稿（Ctrl+S 可另存到本地供 AI 编辑）');
    viewModeRef.current = 'wysiwyg';
    setViewMode('wysiwyg');
    setSidebarOpen(true);
    setPendingDraft(null);
    setActiveCommentId(null);
    setCommentSidebarOpen(hasEmbeddedCommentsInMarkdown(demoContent));
    autoOpenCommentsOnLoadRef.current = true;

    if (editorHandleRef.current) {
      editorHandleRef.current.setMarkdownFromExternal(demoContent, {
        progressive: true,
      });
      setSelectionWordStats(null);
      const ed = editorHandleRef.current.getEditor();
      markCurrentAsBaseline(ed);
      const isStillHydrating = Boolean(
        editorHandleRef.current.isHydrating?.()
      );
      syncAnnotationsFromEditor(ed, !isStillHydrating);
      if (!hasDocumentRef.current) {
        setHasDocument(true);
      }
    } else {
      pendingBaselineResetRef.current = true;
      setHasDocument(true);
    }
  }, [
    clearIdleSaveTimer,
    flushAutoSave,
    markCurrentAsBaseline,
    scheduleDocWordCount,
    syncAnnotationsFromEditor,
  ]);

  const handleOpenFile = useCallback(async () => {
    const picked = await tauriBridge.pickMarkdownFile();
    if (picked) {
      await openFileByPath(picked);
    }
  }, [openFileByPath]);

  const handleSaveFile = useCallback(async () => {
    if (currentFilePathRef.current) {
      await flushAutoSave('manual');
      return;
    }

    const pickedSavePath =
      await tauriBridge.pickSaveMarkdownFile('经济学文稿.md');
    if (!pickedSavePath) return;

    const liveContent = getLiveMarkdown();
    try {
      const snap = await tauriBridge.writeMarkdownFile(
        pickedSavePath,
        liveContent
      );
      currentFilePathRef.current = snap.path;
      setCurrentFilePath(snap.path);
      markdownRef.current = snap.content;
      setMarkdown(snap.content);
      scheduleDocWordCount(snap.content, 16);
      isDirtyRef.current = false;
      setIsDirty(false);
      setSaveStatusText('已保存并开启热监听');
      markCurrentAsBaseline(editorHandleRef.current?.getEditor());
      void tauriBridge.watchFile(snap.path);
    } catch (err) {
      console.error('[Lemma] Failed to save new file:', err);
      setSaveStatusText('另存失败');
    }
  }, [
    flushAutoSave,
    getLiveMarkdown,
    markCurrentAsBaseline,
    scheduleDocWordCount,
  ]);

  // Check CLI argument on initial launch (fallback when mounted without pre-resolved boot snapshot, e.g. browser ?file= or tests)
  useEffect(() => {
    if (bootResolved || initialBootDoc) {
      return;
    }
    let mounted = true;
    void tauriBridge
      .getCliInitialPath()
      .then(async (cliPath) => {
        if (!mounted || !cliPath) return;
        const lower = cliPath.toLowerCase();
        if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
          await openFileByPath(cliPath);
        }
      })
      .catch((err) => {
        console.error('[Lemma] Failed to resolve CLI initial path:', err);
      })
      .finally(() => {
        if (mounted) {
          setIsBootingCli(false);
        }
      });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleIdleAutoSave = useCallback(() => {
    clearIdleSaveTimer();
    if (!currentFilePathRef.current) return;
    idleSaveTimerRef.current = setTimeout(() => {
      if (isDirtyRef.current && currentFilePathRef.current) {
        void flushAutoSave('idle');
      }
    }, IDLE_AUTOSAVE_MS);
  }, [clearIdleSaveTimer, flushAutoSave]);

  const handleEditorDocDirty = useCallback(() => {
    if (!isDirtyRef.current) {
      isDirtyRef.current = true;
      setIsDirty(true);
      setSaveStatusText(
        currentFilePathRef.current ? '编辑中…' : '未保存本地路径'
      );
    }
    scheduleIdleAutoSave();
  }, [scheduleIdleAutoSave]);

  const handleEditorMarkdownChange = useCallback(
    (nextMd: string) => {
      if (viewModeRef.current !== 'wysiwyg') {
        return;
      }
      markdownRef.current = nextMd;
      scheduleDocWordCount(nextMd, 24);
      if (!isDirtyRef.current) {
        isDirtyRef.current = true;
        setIsDirty(true);
        setSaveStatusText(
          currentFilePathRef.current ? '编辑中…' : '未保存本地路径'
        );
      }
      scheduleIdleAutoSave();
    },
    [scheduleDocWordCount, scheduleIdleAutoSave]
  );

  const handleSourceChange = useCallback(
    (nextMd: string) => {
      markdownRef.current = nextMd;
      setMarkdown(nextMd);
      scheduleDocWordCount(nextMd, 180);
      isDirtyRef.current = true;
      setIsDirty(true);
      setSaveStatusText(
        currentFilePathRef.current ? '编辑中…' : '未保存本地路径'
      );
      scheduleIdleAutoSave();
    },
    [scheduleDocWordCount, scheduleIdleAutoSave]
  );

  const handleSourceSelectionChange = useCallback(
    (selectedSlice: string | null) => {
      if (viewModeRef.current !== 'source') {
        return;
      }
      if (!selectedSlice) {
        setSelectionWordStats((prev) => (prev === null ? prev : null));
        return;
      }
      const stats = computeMarkdownWordStats(selectedSlice);
      const normalized =
        stats.totalWords === 0 &&
        stats.charsNoSpaces === 0 &&
        stats.mathCount === 0
          ? null
          : stats;
      setSelectionWordStats((prev) =>
        areNullableWordStatsEqual(prev, normalized) ? prev : normalized
      );
    },
    []
  );

  const handleToggleViewMode = useCallback(() => {
    if (!hasDocumentRef.current && !editorHandleRef.current) return;
    setSelectionWordStats(null);
    if (viewModeRef.current === 'wysiwyg') {
      viewModeRef.current = 'source';
      editorHandleRef.current?.flushPendingHydration?.();
      const latest = editorHandleRef.current
        ? editorHandleRef.current.getMarkdown()
        : markdownRef.current;
      markdownRef.current = latest;
      setMarkdown(latest);
      scheduleDocWordCount(latest, 16);
      setViewMode('source');
    } else {
      const latestSource = markdownRef.current;
      viewModeRef.current = 'wysiwyg';
      editorHandleRef.current?.setMarkdownFromExternal(latestSource);
      scheduleDocWordCount(latestSource, 16);
      setViewMode('wysiwyg');
    }
  }, [scheduleDocWordCount]);

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleSelectHeading = useCallback(
    (pos: number) => {
      if (viewModeRef.current !== 'wysiwyg') {
        setSelectionWordStats(null);
        viewModeRef.current = 'wysiwyg';
        editorHandleRef.current?.setMarkdownFromExternal(markdownRef.current);
        scheduleDocWordCount(markdownRef.current, 16);
        setViewMode('wysiwyg');
        requestAnimationFrame(() => {
          editorHandleRef.current?.scrollToPos(pos);
        });
        return;
      }
      if (editorHandleRef.current?.isHydrating?.()) {
        editorHandleRef.current.flushPendingHydration?.();
      }
      editorHandleRef.current?.scrollToPos(pos);
    },
    [scheduleDocWordCount]
  );

  const resolveAssetUrl = useCallback(
    (rawSrc: string) =>
      tauriBridge.resolveLocalAssetUrl(currentFilePathRef.current, rawSrc),
    []
  );

  const handlePasteImage = useCallback(
    async (base64Data: string, ext: string): Promise<string | null> => {
      let targetMdPath = currentFilePathRef.current;
      if (!targetMdPath && tauriBridge.isTauri()) {
        const chosen =
          await tauriBridge.pickSaveMarkdownFile('经济学文稿.md');
        if (!chosen) {
          return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64Data}`;
        }
        const snap = await tauriBridge.writeMarkdownFile(
          chosen,
          getLiveMarkdown()
        );
        targetMdPath = snap.path;
        currentFilePathRef.current = snap.path;
        setCurrentFilePath(snap.path);
        isDirtyRef.current = false;
        setIsDirty(false);
        await tauriBridge.watchFile(snap.path);
      }

      if (!targetMdPath) {
        const saved = await tauriBridge.saveClipboardImage(
          '/untitled.md',
          base64Data,
          ext
        );
        return saved.relativePath;
      }

      const saved = await tauriBridge.saveClipboardImage(
        targetMdPath,
        base64Data,
        ext
      );
      setSaveStatusText(`图片已存入 ${saved.relativePath}`);
      return saved.relativePath;
    },
    [getLiveMarkdown]
  );

  // Persist manual user zoom offset and measure workspace canvas width dynamically
  useEffect(() => {
    try {
      localStorage.setItem(USER_ZOOM_STORAGE_KEY, String(userZoom));
    } catch {
      // Ignore storage access errors
    }
  }, [userZoom]);

  useIsomorphicLayoutEffect(() => {
    const stageEl = canvasStageRef.current;
    const updateWidth = () => {
      const fallbackWidth =
        typeof window !== 'undefined' && window.innerWidth > 0
          ? Math.max(
              320,
              window.innerWidth -
                (sidebarOpen ? SIDEBAR_PIXEL_WIDTH : 0) -
                (hasDocument && commentSidebarOpen
                  ? COMMENT_RAIL_PIXEL_WIDTH
                  : 0)
            )
          : REF_CANVAS_WIDTH;
      const measured =
        stageEl && stageEl.clientWidth > 0 ? stageEl.clientWidth : fallbackWidth;
      setCanvasWidth((prev) =>
        Math.abs(prev - measured) < 0.5 ? prev : measured
      );
    };

    updateWidth();

    let observer: ResizeObserver | null = null;
    if (stageEl && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0) {
            const measured = entry.contentRect.width;
            setCanvasWidth((prev) =>
              Math.abs(prev - measured) < 0.5 ? prev : measured
            );
          }
        }
      });
      observer.observe(stageEl);
    }

    window.addEventListener('resize', updateWidth);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, [hasDocument, sidebarOpen, commentSidebarOpen]);

  // Highlight & Comment handlers
  const handleSelectHighlightColor = useCallback(
    (color: HighlightColor) => {
      if (!editorInstance || editorInstance.isDestroyed) return;
      applyHighlightColor(editorInstance, color);
    },
    [editorInstance]
  );

  const handleClearSelectionHighlight = useCallback(() => {
    if (!editorInstance || editorInstance.isDestroyed) return;
    removeSelectionHighlight(editorInstance);
  }, [editorInstance]);

  const handleStartComment = useCallback(
    (range: { from: number; to: number }) => {
      if (!editorInstance || editorInstance.isDestroyed) return;
      const quote = extractSelectionQuote(
        editorInstance.state.doc,
        range.from,
        range.to
      );
      setActiveCommentId(null);
      setPendingDraft({
        from: range.from,
        to: range.to,
        quote: quote || '选中内容',
      });
      setCommentSidebarOpen(true);
    },
    [editorInstance]
  );

  const handleCommitDraft = useCallback(
    (text: string) => {
      if (!editorInstance || editorInstance.isDestroyed || !pendingDraft) {
        setPendingDraft(null);
        return;
      }
      const createdId = addCommentAtRange(
        editorInstance,
        pendingDraft.from,
        pendingDraft.to,
        text
      );
      setPendingDraft(null);
      if (createdId) {
        setActiveCommentId(createdId);
      }
    },
    [editorInstance, pendingDraft]
  );

  const handleCancelDraft = useCallback(() => {
    setPendingDraft(null);
  }, []);

  const handleSelectComment = useCallback(
    (commentId: string) => {
      setActiveCommentId(commentId);
      if (editorHandleRef.current?.isHydrating?.()) {
        editorHandleRef.current.flushPendingHydration?.();
      }
      const ed = editorHandleRef.current?.getEditor();
      const target =
        comments.find((c) => c.id === commentId) ??
        (ed && !ed.isDestroyed
          ? extractDocumentComments(ed.state.doc).find(
              (c) => c.id === commentId
            )
          : undefined);
      if (!target) return;

      if (viewModeRef.current !== 'wysiwyg') {
        setSelectionWordStats(null);
        viewModeRef.current = 'wysiwyg';
        editorHandleRef.current?.setMarkdownFromExternal(markdownRef.current);
        scheduleDocWordCount(markdownRef.current, 16);
        setViewMode('wysiwyg');
        requestAnimationFrame(() => {
          editorHandleRef.current?.scrollToPos(target.from);
        });
        return;
      }
      editorHandleRef.current?.scrollToPos(target.from);
    },
    [comments, scheduleDocWordCount]
  );

  const handleUpdateComment = useCallback(
    (commentId: string, nextText: string) => {
      if (!editorInstance || editorInstance.isDestroyed) return;
      updateCommentTextById(editorInstance, commentId, nextText);
    },
    [editorInstance]
  );

  const handleResolveComment = useCallback(
    (commentId: string) => {
      if (!editorInstance || editorInstance.isDestroyed) return;
      removeCommentById(editorInstance, commentId);
      setActiveCommentId((prev) => (prev === commentId ? null : prev));
    },
    [editorInstance]
  );

  const handleClearAllComments = useCallback(() => {
    if (!editorInstance || editorInstance.isDestroyed) return;
    editorHandleRef.current?.flushPendingHydration?.();
    clearAllComments(editorInstance);
    setActiveCommentId(null);
  }, [editorInstance]);

  const handleClearAllHighlights = useCallback(() => {
    if (!editorInstance || editorInstance.isDestroyed) return;
    editorHandleRef.current?.flushPendingHydration?.();
    clearAllHighlights(editorInstance);
  }, [editorInstance]);

  const handleToggleCommentSidebar = useCallback(() => {
    setCommentSidebarOpen((prev) => !prev);
  }, []);

  const handleZoomIn = useCallback(() => {
    setUserZoom((prev) => clampUserZoom(Math.round((prev + 0.1) * 100) / 100));
  }, []);

  const handleZoomOut = useCallback(() => {
    setUserZoom((prev) => clampUserZoom(Math.round((prev - 0.1) * 100) / 100));
  }, []);

  const handleZoomReset = useCallback(() => {
    setUserZoom(1);
  }, []);

  // Ctrl + Mouse Wheel smooth zoom
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const step = e.deltaY < 0 ? 0.08 : -0.08;
      setUserZoom((prev) =>
        clampUserZoom(Math.round((prev + step) * 100) / 100)
      );
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);

  const autoScale = Math.min(
    2.4,
    Math.max(1.0, canvasWidth / REF_CANVAS_WIDTH)
  );
  const effectiveScale = Math.min(
    3.2,
    Math.max(0.55, autoScale * userZoom)
  );
  const padScale = Math.min(
    effectiveScale,
    Math.max(0.72, canvasWidth / REF_CANVAS_WIDTH)
  );
  const zoomPercent = Math.round(effectiveScale * 100);
  const isZoomCustomized = Math.abs(userZoom - 1) > 0.005;

  const canvasScaleStyle = useMemo(
    () =>
      ({
        '--doc-scale': effectiveScale.toFixed(4),
        '--doc-pad-scale': padScale.toFixed(4),
      }) as React.CSSProperties,
    [effectiveScale, padScale]
  );

  // Global keyboard shortcuts: Ctrl+/ (Source Mode), Ctrl+S (Save), Ctrl+O (Open), Ctrl+N (New), Ctrl+Shift+L (Sidebar), Ctrl+Alt+M (Comment), Ctrl+Shift+H (Highlight), Ctrl+=/-/0 (Zoom)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      if (e.key === '/' || e.code === 'Slash') {
        e.preventDefault();
        handleToggleViewMode();
      } else if (!e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void handleSaveFile();
      } else if (!e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        void handleOpenFile();
      } else if (!e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        void handleNewFile();
      } else if (e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        handleToggleSidebar();
      } else if (
        (e.altKey || e.shiftKey) &&
        (e.key === 'm' || e.key === 'M' || e.code === 'KeyM')
      ) {
        if (!hasDocument) return;
        e.preventDefault();
        if (
          viewModeRef.current === 'wysiwyg' &&
          editorInstance &&
          !editorInstance.isDestroyed &&
          !editorInstance.state.selection.empty
        ) {
          const { from, to } = editorInstance.state.selection;
          handleStartComment({ from, to });
        } else {
          handleToggleCommentSidebar();
        }
      } else if (
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'h' || e.key === 'H' || e.code === 'KeyH')
      ) {
        if (
          hasDocument &&
          viewModeRef.current === 'wysiwyg' &&
          editorInstance &&
          !editorInstance.isDestroyed &&
          !editorInstance.state.selection.empty
        ) {
          e.preventDefault();
          handleSelectHighlightColor('yellow');
        }
      } else if (
        e.key === '=' ||
        e.key === '+' ||
        e.code === 'Equal' ||
        e.code === 'NumpadAdd'
      ) {
        e.preventDefault();
        handleZoomIn();
      } else if (
        e.key === '-' ||
        e.key === '_' ||
        e.code === 'Minus' ||
        e.code === 'NumpadSubtract'
      ) {
        e.preventDefault();
        handleZoomOut();
      } else if (
        e.key === '0' ||
        e.code === 'Digit0' ||
        e.code === 'Numpad0'
      ) {
        e.preventDefault();
        handleZoomReset();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    editorInstance,
    handleNewFile,
    handleOpenFile,
    handleSaveFile,
    handleSelectHighlightColor,
    handleStartComment,
    handleToggleCommentSidebar,
    handleToggleSidebar,
    handleToggleViewMode,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    hasDocument,
  ]);

  const handleBlurSaveCallback = useCallback(() => {
    if (isDirtyRef.current && currentFilePathRef.current) {
      void flushAutoSave('blur');
    }
  }, [flushAutoSave]);

  return (
    <div className="lemma-app">
      <TopBar
        filePath={currentFilePath}
        isDirty={isDirty}
        saveStatusText={saveStatusText}
        viewMode={viewMode}
        theme={theme}
        sidebarOpen={sidebarOpen}
        zoomPercent={zoomPercent}
        isZoomCustomized={isZoomCustomized}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onToggleSidebar={handleToggleSidebar}
        onNewFile={() => void handleNewFile()}
        onOpenFile={() => void handleOpenFile()}
        onSaveFile={() => void handleSaveFile()}
        onToggleViewMode={handleToggleViewMode}
        onToggleTheme={handleToggleTheme}
        rightSlot={
          <>
            <DiffReviewBar state={diffState} actions={diffActions} />
            {hasDocument && (
              <button
                type="button"
                className={`lemma-icon-btn ${commentSidebarOpen ? 'is-active' : ''}`}
                onClick={handleToggleCommentSidebar}
                title="打开/收起右侧批注栏 (Ctrl+Alt+M)"
                aria-label="切换批注审阅栏"
              >
                <MessageSquareText size={15} strokeWidth={1.85} />
                <span className="lemma-btn-label">
                  批注{comments.length > 0 ? ` (${comments.length})` : ''}
                </span>
              </button>
            )}
          </>
        }
      />

      <div className="lemma-workspace">
        <Sidebar
          isOpen={sidebarOpen}
          outline={outline}
          onSelectHeading={handleSelectHeading}
        />

        <div
          className="lemma-canvas-stage"
          ref={canvasStageRef}
          style={canvasScaleStyle}
        >
          {!hasDocument ? (
            <div className="lemma-desk-scroll">
              {!isBootingCli && (
                <WelcomeScreen
                  onOpenFile={() => void handleOpenFile()}
                  onNewFile={() => void handleNewFile()}
                  onLoadDemo={() => void handleLoadDemo()}
                />
              )}
            </div>
          ) : (
            <>
              <div
                style={{
                  display: viewMode === 'wysiwyg' ? 'contents' : 'none',
                }}
              >
                <LemmaEditor
                  ref={editorHandleRef}
                  initialMarkdown={markdown}
                  currentFilePath={currentFilePath}
                  resolveAssetUrl={resolveAssetUrl}
                  onPasteImage={handlePasteImage}
                  onMarkdownChange={handleEditorMarkdownChange}
                  onDocDirty={handleEditorDocDirty}
                  onOutlineChange={handleOutlineChange}
                  onEditorReady={handleEditorReady}
                  onHydrationAppend={handleHydrationAppend}
                  onBlurSave={handleBlurSaveCallback}
                  hideDeletions={!diffState.showDeletions}
                  extraPlugins={extraPlugins}
                />
                {viewMode === 'wysiwyg' && (
                  <SelectionToolbar
                    editor={editorInstance}
                    activeHighlightColor={selectionHighlightColor}
                    hasSelectionHighlight={hasSelectionHighlight}
                    onSelectHighlightColor={handleSelectHighlightColor}
                    onClearHighlight={handleClearSelectionHighlight}
                    onStartComment={handleStartComment}
                  />
                )}
              </div>

              {viewMode === 'source' && (
                <Suspense fallback={null}>
                  <LazySourceEditor
                    value={markdown}
                    theme={theme}
                    onChange={handleSourceChange}
                    onSelectionChange={handleSourceSelectionChange}
                    onBlurSave={handleBlurSaveCallback}
                  />
                </Suspense>
              )}

              <WordCountBar
                docStats={docWordStats}
                selectionStats={selectionWordStats}
              />
            </>
          )}
        </div>

        {hasDocument && (
          <CommentSidebar
            isOpen={commentSidebarOpen}
            comments={comments}
            activeCommentId={activeCommentId}
            pendingDraft={pendingDraft}
            hasAnyHighlights={hasAnyHighlights}
            onSelectComment={handleSelectComment}
            onCommitDraft={handleCommitDraft}
            onCancelDraft={handleCancelDraft}
            onUpdateComment={handleUpdateComment}
            onResolveComment={handleResolveComment}
            onClearAllComments={handleClearAllComments}
            onClearAllHighlights={handleClearAllHighlights}
            onClose={() => setCommentSidebarOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

export default App;
