import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import type { Plugin, Transaction } from '@tiptap/pm/state';
import type {
  DiffHunk,
  DiffReviewActions,
  DiffReviewState,
} from '../types/contract';
import {
  applyAcceptHunkToBaseline,
  buildRevertTransaction,
  computeDocDiff,
} from './diffEngine';
import {
  createDiffReviewPlugin,
  diffPluginKey,
  setDiffPluginData,
} from './diffPlugin';

export interface UseDiffReviewParams {
  editor: Editor | null;
  onAfterRevert: (revertedMarkdown?: string) => void;
}

export interface UseDiffReviewResult {
  diffState: DiffReviewState;
  diffActions: DiffReviewActions;
  diffPlugin: Plugin;
  markCurrentAsBaseline: (targetEditor?: Editor | null) => void;
  appendToBaseline: (appendedFragment: Fragment) => void;
  reviewExternalUpdate: (targetEditor?: Editor | null) => void;
}

function scrollActiveHunkIntoView(editor: Editor, hunk: DiffHunk | undefined): void {
  if (!editor || editor.isDestroyed || !editor.view || !hunk) {
    return;
  }

  const rootDom = editor.view.dom;
  const activeEl =
    rootDom.querySelector<HTMLElement>('.lemma-diff-active-hunk') ??
    document.querySelector<HTMLElement>('.lemma-diff-active-hunk');

  if (activeEl && typeof activeEl.scrollIntoView === 'function') {
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  try {
    const safePos = Math.max(
      0,
      Math.min(hunk.newFrom, editor.state.doc.content.size)
    );
    const domPos = editor.view.domAtPos(safePos);
    const targetEl =
      domPos.node instanceof HTMLElement
        ? domPos.node
        : domPos.node.parentElement;
    if (targetEl && typeof targetEl.scrollIntoView === 'function') {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch {
    // Ignore DOM lookup errors in detached or headless test containers
  }
}

export function useDiffReview(params: UseDiffReviewParams): UseDiffReviewResult {
  const { editor, onAfterRevert } = params;

  const [diffState, setDiffState] = useState<DiffReviewState>({
    hasChanges: false,
    hunks: [],
    activeHunkIndex: 0,
    showDeletions: true,
  });

  const editorRef = useRef<Editor | null>(editor);
  editorRef.current = editor;

  const onAfterRevertRef = useRef(onAfterRevert);
  onAfterRevertRef.current = onAfterRevert;

  const baselineDocRef = useRef<PMNode | null>(null);
  const stateRef = useRef<DiffReviewState>(diffState);

  const diffPluginRef = useRef<Plugin | null>(null);

  const ensurePluginRegistered = useCallback((ed: Editor) => {
    const plugin = diffPluginRef.current;
    if (plugin && !ed.isDestroyed && !diffPluginKey.get(ed.state)) {
      const getRawKey = (p: Plugin) => (p as unknown as { key?: string }).key;
      ed.registerPlugin(plugin, (newPlugin, currentPlugins) => [
        ...currentPlugins.filter(
          (existing) => getRawKey(existing) !== getRawKey(newPlugin)
        ),
        newPlugin,
      ]);
    }
  }, []);

  const commitReviewState = useCallback(
    (
      next: DiffReviewState,
      baselineDoc: PMNode | null,
      targetEditor?: Editor | null
    ) => {
      stateRef.current = next;
      setDiffState(next);
      const ed = targetEditor ?? editorRef.current;
      if (ed && !ed.isDestroyed) {
        ensurePluginRegistered(ed);
        setDiffPluginData(ed, {
          baselineDoc,
          hunks: next.hunks,
          activeHunkIndex: next.activeHunkIndex,
          showDeletions: next.showDeletions,
        });
      }
    },
    [ensurePluginRegistered]
  );

  const markCurrentAsBaseline = useCallback(
    (targetEditor?: Editor | null) => {
      const ed = targetEditor ?? editorRef.current;
      if (ed && !ed.isDestroyed) {
        editorRef.current = ed;
      }
      const nextBaseline = ed && !ed.isDestroyed ? ed.state.doc : null;
      baselineDocRef.current = nextBaseline;

      commitReviewState(
        {
          hasChanges: false,
          hunks: [],
          activeHunkIndex: 0,
          showDeletions: stateRef.current.showDeletions,
        },
        nextBaseline,
        ed
      );
    },
    [commitReviewState]
  );

  const appendToBaseline = useCallback((appendedFragment: Fragment) => {
    if (
      !appendedFragment ||
      appendedFragment.childCount === 0 ||
      !baselineDocRef.current
    ) {
      return;
    }
    const nextBaseline = baselineDocRef.current.copy(
      baselineDocRef.current.content.append(appendedFragment)
    );
    baselineDocRef.current = nextBaseline;

    const ed = editorRef.current;
    if (ed && !ed.isDestroyed && !stateRef.current.hasChanges) {
      setDiffPluginData(ed, {
        baselineDoc: nextBaseline,
        hunks: stateRef.current.hunks,
        activeHunkIndex: stateRef.current.activeHunkIndex,
        showDeletions: stateRef.current.showDeletions,
      });
    }
  }, []);

  const reviewExternalUpdate = useCallback(
    (targetEditor?: Editor | null) => {
      const ed = targetEditor ?? editorRef.current;
      if (!ed || ed.isDestroyed) {
        return;
      }
      editorRef.current = ed;

      const currentDoc = ed.state.doc;
      const baselineDoc = baselineDocRef.current;
      if (!baselineDoc) {
        baselineDocRef.current = currentDoc;
        commitReviewState(
          {
            hasChanges: false,
            hunks: [],
            activeHunkIndex: 0,
            showDeletions: stateRef.current.showDeletions,
          },
          currentDoc,
          ed
        );
        return;
      }

      const hunks = computeDocDiff(baselineDoc, currentDoc);
      const nextState: DiffReviewState = {
        hasChanges: hunks.length > 0,
        hunks,
        activeHunkIndex: 0,
        showDeletions: stateRef.current.showDeletions,
      };

      commitReviewState(nextState, baselineDoc, ed);

      if (hunks.length > 0) {
        scrollActiveHunkIntoView(ed, hunks[0]);
      }
    },
    [commitReviewState]
  );

  const acceptHunk = useCallback(
    (hunkId: string) => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) {
        return;
      }

      const livePluginState = diffPluginKey.getState(ed.state);
      const currentHunks =
        livePluginState && livePluginState.hunks.length > 0
          ? livePluginState.hunks
          : stateRef.current.hunks;

      const targetIdx = currentHunks.findIndex((h) => h.id === hunkId);
      if (targetIdx === -1) {
        return;
      }

      const targetHunk = currentHunks[targetIdx];
      const baseDoc = baselineDocRef.current ?? ed.state.doc;
      const nextBaselineDoc = applyAcceptHunkToBaseline(
        baseDoc,
        ed.state.doc,
        targetHunk
      );
      baselineDocRef.current = nextBaselineDoc;

      const nextHunks = computeDocDiff(nextBaselineDoc, ed.state.doc);
      const prevActive = stateRef.current.activeHunkIndex;
      const adjustedActive =
        nextHunks.length === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                targetIdx < prevActive ? prevActive - 1 : prevActive,
                nextHunks.length - 1
              )
            );

      commitReviewState(
        {
          hasChanges: nextHunks.length > 0,
          hunks: nextHunks,
          activeHunkIndex: adjustedActive,
          showDeletions: stateRef.current.showDeletions,
        },
        nextBaselineDoc,
        ed
      );
    },
    [commitReviewState]
  );

  const revertHunk = useCallback(
    (hunkId: string) => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) {
        return;
      }

      const livePluginState = diffPluginKey.getState(ed.state);
      const currentHunks =
        livePluginState && livePluginState.hunks.length > 0
          ? livePluginState.hunks
          : stateRef.current.hunks;

      const targetIdx = currentHunks.findIndex((h) => h.id === hunkId);
      if (targetIdx === -1) {
        return;
      }

      const targetHunk = currentHunks[targetIdx];
      const revertTr = buildRevertTransaction(ed.state, targetHunk);
      ed.view.dispatch(revertTr);

      const baseDoc = baselineDocRef.current ?? ed.state.doc;
      baselineDocRef.current = baseDoc;

      const nextHunks = computeDocDiff(baseDoc, ed.state.doc);
      const prevActive = stateRef.current.activeHunkIndex;
      const adjustedActive =
        nextHunks.length === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                targetIdx < prevActive ? prevActive - 1 : prevActive,
                nextHunks.length - 1
              )
            );

      commitReviewState(
        {
          hasChanges: nextHunks.length > 0,
          hunks: nextHunks,
          activeHunkIndex: adjustedActive,
          showDeletions: stateRef.current.showDeletions,
        },
        baseDoc,
        ed
      );

      onAfterRevertRef.current();
    },
    [commitReviewState]
  );

  const selectHunkByIndex = useCallback(
    (index: number) => {
      const ed = editorRef.current;
      const current = stateRef.current;
      if (current.hunks.length === 0) return;
      const clamped = Math.max(0, Math.min(index, current.hunks.length - 1));
      if (clamped === current.activeHunkIndex) return;

      commitReviewState(
        {
          ...current,
          activeHunkIndex: clamped,
        },
        baselineDocRef.current,
        ed
      );
    },
    [commitReviewState]
  );

  const goToNextHunk = useCallback(() => {
    const ed = editorRef.current;
    const current = stateRef.current;
    if (current.hunks.length === 0) return;

    const nextIndex = (current.activeHunkIndex + 1) % current.hunks.length;
    const nextState: DiffReviewState = {
      ...current,
      activeHunkIndex: nextIndex,
    };
    commitReviewState(nextState, baselineDocRef.current, ed);

    if (ed && !ed.isDestroyed) {
      scrollActiveHunkIntoView(ed, current.hunks[nextIndex]);
    }
  }, [commitReviewState]);

  const goToPrevHunk = useCallback(() => {
    const ed = editorRef.current;
    const current = stateRef.current;
    if (current.hunks.length === 0) return;

    const prevIndex =
      (current.activeHunkIndex - 1 + current.hunks.length) %
      current.hunks.length;
    const nextState: DiffReviewState = {
      ...current,
      activeHunkIndex: prevIndex,
    };
    commitReviewState(nextState, baselineDocRef.current, ed);

    if (ed && !ed.isDestroyed) {
      scrollActiveHunkIntoView(ed, current.hunks[prevIndex]);
    }
  }, [commitReviewState]);

  const toggleShowDeletions = useCallback(() => {
    const ed = editorRef.current;
    const current = stateRef.current;
    commitReviewState(
      {
        ...current,
        showDeletions: !current.showDeletions,
      },
      baselineDocRef.current,
      ed
    );
  }, [commitReviewState]);

  const acceptAll = useCallback(() => {
    markCurrentAsBaseline();
  }, [markCurrentAsBaseline]);

  // Keep latest handlers in a ref so the memoized ProseMirror Plugin never goes stale
  const pluginHandlersRef = useRef({
    onAcceptHunk: acceptHunk,
    onRevertHunk: revertHunk,
    onSelectHunk: selectHunkByIndex,
  });
  pluginHandlersRef.current = {
    onAcceptHunk: acceptHunk,
    onRevertHunk: revertHunk,
    onSelectHunk: selectHunkByIndex,
  };

  const diffPlugin = useMemo<Plugin>(
    () =>
      createDiffReviewPlugin({
        onAcceptHunk: (id) => pluginHandlersRef.current.onAcceptHunk(id),
        onRevertHunk: (id) => pluginHandlersRef.current.onRevertHunk(id),
        onSelectHunk: (idx) => pluginHandlersRef.current.onSelectHunk(idx),
      }),
    []
  );
  diffPluginRef.current = diffPlugin;

  // Initialize baseline when editor attaches and keep mapped hunk positions synced on manual edits
  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }

    ensurePluginRegistered(editor);

    if (baselineDocRef.current === null) {
      baselineDocRef.current = editor.state.doc;
      setDiffPluginData(editor, {
        baselineDoc: editor.state.doc,
        hunks: stateRef.current.hunks,
        activeHunkIndex: stateRef.current.activeHunkIndex,
        showDeletions: stateRef.current.showDeletions,
      });
    }

    const handleTransaction = ({
      transaction,
    }: {
      transaction: Transaction;
    }) => {
      if (!transaction.docChanged) return;
      if (transaction.getMeta(diffPluginKey)) return;
      if (!stateRef.current.hasChanges) return;

      const ps = diffPluginKey.getState(editor.state);
      if (!ps) return;

      const nextState: DiffReviewState = {
        hasChanges: ps.hunks.length > 0,
        hunks: ps.hunks,
        activeHunkIndex: ps.activeHunkIndex,
        showDeletions: ps.showDeletions,
      };
      stateRef.current = nextState;
      setDiffState(nextState);
    };

    editor.on('transaction', handleTransaction);
    return () => {
      editor.off('transaction', handleTransaction);
    };
  }, [editor, diffPlugin]);

  const diffActions = useMemo<DiffReviewActions>(
    () => ({
      goToPrevHunk,
      goToNextHunk,
      toggleShowDeletions,
      acceptHunk,
      acceptAll,
      revertHunk,
    }),
    [
      goToPrevHunk,
      goToNextHunk,
      toggleShowDeletions,
      acceptHunk,
      acceptAll,
      revertHunk,
    ]
  );

  return {
    diffState,
    diffActions,
    diffPlugin,
    markCurrentAsBaseline,
    appendToBaseline,
    reviewExternalUpdate,
  };
}
