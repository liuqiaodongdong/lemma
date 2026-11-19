import React, { useEffect, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import type { ThemeMode } from '../../types/contract';

export interface SourceEditorProps {
  value: string;
  theme: ThemeMode;
  onChange: (next: string) => void;
  onSelectionChange?: (selectedMarkdown: string | null) => void;
  onBlurSave?: () => void;
}

const MONO_FONT_STACK =
  '"Latin Modern Mono", "JetBrains Mono", "Consolas", "Noto Serif SC", "SimSun", monospace';

function buildCodeMirrorTheme(mode: ThemeMode): Extension {
  const isDark = mode === 'dark';

  const baseTheme = EditorView.theme(
    {
      '&': {
        backgroundColor: isDark ? '#181b20' : '#ffffff',
        color: isDark ? '#dcdfe4' : '#1f2328',
        fontFamily: MONO_FONT_STACK,
        fontSize: 'inherit',
      },
      '.cm-scroller': {
        fontFamily: MONO_FONT_STACK,
        lineHeight: '1.68',
      },
      '.cm-content': {
        padding: '32px 48px 72px 18px',
        caretColor: isDark ? '#6cb6ff' : '#111111',
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: isDark ? '#6cb6ff' : '#111111',
        borderLeftWidth: '1.5px',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
        {
          backgroundColor: isDark
            ? '#264f78 !important'
            : 'rgba(11, 61, 145, 0.14) !important',
        },
      '.cm-gutters': {
        backgroundColor: isDark ? '#15181d' : '#fafbfc',
        color: isDark ? '#6e7681' : '#888888',
        borderRight: isDark ? '1px solid #282c34' : '1px solid #e1e4e8',
        paddingLeft: '12px',
        paddingRight: '6px',
        fontFamily: MONO_FONT_STACK,
        fontSize: '0.8rem',
      },
      '.cm-activeLine': {
        backgroundColor: isDark
          ? 'rgba(108, 182, 255, 0.05)'
          : 'rgba(15, 23, 42, 0.028)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: isDark ? '#c9d1d9' : '#222222',
        fontWeight: '700',
      },
    },
    { dark: isDark }
  );

  const highlight = HighlightStyle.define([
    {
      tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4],
      color: isDark ? '#f0f3f6' : '#000000',
      fontWeight: '700',
    },
    {
      tag: [tags.strong],
      color: isDark ? '#f0f3f6' : '#000000',
      fontWeight: '700',
    },
    {
      tag: [tags.emphasis],
      fontStyle: 'italic',
    },
    {
      tag: [tags.quote],
      color: isDark ? '#a5d6ff' : '#334155',
      fontStyle: 'italic',
    },
    {
      tag: [tags.link, tags.url],
      color: isDark ? '#6cb6ff' : '#0b3d91',
      textDecoration: 'underline',
    },
    {
      tag: [tags.monospace, tags.string],
      color: isDark ? '#7ee787' : '#7a1c1c',
    },
    {
      tag: [tags.keyword, tags.processingInstruction, tags.meta],
      color: isDark ? '#ff7b72' : '#0033b3',
      fontWeight: '600',
    },
    {
      tag: [tags.comment],
      color: isDark ? '#8b949e' : '#6a737d',
      fontStyle: 'italic',
    },
  ]);

  return [baseTheme, syntaxHighlighting(highlight)];
}

export function SourceEditor({
  value,
  theme,
  onChange,
  onSelectionChange,
  onBlurSave,
}: SourceEditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartmentRef = useRef<Compartment>(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onBlurSaveRef = useRef(onBlurSave);
  const isApplyingExternalRef = useRef(false);

  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;
  onBlurSaveRef.current = onBlurSave;

  useEffect(() => {
    const container = hostRef.current;
    if (!container) {
      return;
    }

    const startState = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown(),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        themeCompartmentRef.current.of(buildCodeMirrorTheme(theme)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isApplyingExternalRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const main = update.state.selection.main;
            if (main.empty) {
              onSelectionChangeRef.current?.(null);
            } else {
              onSelectionChangeRef.current?.(
                update.state.sliceDoc(main.from, main.to)
              );
            }
          }
        }),
        EditorView.domEventHandlers({
          blur: () => {
            onBlurSaveRef.current?.();
            return false;
          },
        }),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: container,
    });

    viewRef.current = view;

    return () => {
      onSelectionChangeRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // Initial mount only; value and theme updates are synchronized via dedicated effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure CodeMirror palette seamlessly when Light / Dark mode toggles
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        buildCodeMirrorTheme(theme)
      ),
    });
  }, [theme]);

  // Synchronize external value updates without resetting cursor during normal typing
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const currentDoc = view.state.doc.toString();
    if (value === currentDoc) {
      return;
    }

    const currentAnchor = view.state.selection.main.anchor;
    const clampedAnchor = Math.min(currentAnchor, value.length);

    isApplyingExternalRef.current = true;
    try {
      view.dispatch({
        changes: {
          from: 0,
          to: currentDoc.length,
          insert: value,
        },
        selection: { anchor: clampedAnchor },
      });
    } finally {
      isApplyingExternalRef.current = false;
    }
  }, [value]);

  return (
    <div className="lemma-source-outer" data-testid="lemma-source-editor">
      <div className="lemma-source-banner">
        <span>SOURCE MODE · Markdown + LaTeX + SVG</span>
        <span>Latin Modern Mono</span>
      </div>
      <div ref={hostRef} className="lemma-source-cm-host" />
    </div>
  );
}

export default SourceEditor;
