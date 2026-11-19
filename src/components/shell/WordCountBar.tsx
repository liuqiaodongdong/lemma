import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { WordCountStats } from '../../types/contract';

export interface WordCountBarProps {
  docStats: WordCountStats;
  selectionStats: WordCountStats | null;
}

interface StatRowDefinition {
  key: keyof Omit<WordCountStats, 'readingMinutes'>;
  label: string;
  subLabel?: string;
  isPrimary?: boolean;
}

const STAT_ROWS: readonly StatRowDefinition[] = [
  {
    key: 'totalWords',
    label: '总字数',
    subLabel: '中文 + 英文词',
    isPrimary: true,
  },
  { key: 'cjkChars', label: '中文字符' },
  { key: 'latinWords', label: '英文与数字词' },
  { key: 'charsNoSpaces', label: '字符数（不计空格）' },
  { key: 'charsWithSpaces', label: '字符数（计空格）' },
  { key: 'paragraphs', label: '段落数' },
  { key: 'mathCount', label: '数学公式' },
];

function formatStatNumber(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString('en-US');
}

export function WordCountBar({
  docStats,
  selectionStats,
}: WordCountBarProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const hasSelection = selectionStats !== null;
  const activeStats = selectionStats ?? docStats;

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (anchorRef.current && target && !anchorRef.current.contains(target)) {
        setIsOpen(false);
      }
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    window.addEventListener('keydown', handleEscapeKey);
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      window.removeEventListener('keydown', handleEscapeKey);
    };
  }, [isOpen]);

  return (
    <div className="lemma-wordcount-anchor" ref={anchorRef}>
      {isOpen && (
        <div
          className={`lemma-wordcount-popover ${hasSelection ? 'is-dual' : ''}`}
          role="dialog"
          aria-label="字数统计详情"
          onMouseDown={(e) => {
            // Preserve live text selection inside ProseMirror when interacting with popover
            e.preventDefault();
          }}
        >
          <div className="lemma-wordcount-popover-header">
            <span className="lemma-wordcount-popover-title">字数统计</span>
            <span
              className={`lemma-wordcount-scope-badge ${hasSelection ? 'is-selection' : ''}`}
            >
              {hasSelection ? '当前选中范围' : '全文统计'}
            </span>
          </div>

          {hasSelection && (
            <div className="lemma-wordcount-col-head" aria-hidden="true">
              <span>指标</span>
              <span className="lemma-wordcount-col-sel">已选</span>
              <span className="lemma-wordcount-col-doc">全文</span>
            </div>
          )}

          <div className="lemma-wordcount-rows">
            {STAT_ROWS.map((row) => (
              <div
                key={row.key}
                className={`lemma-wordcount-row ${row.isPrimary ? 'is-primary' : ''} ${hasSelection ? 'is-dual' : ''}`}
              >
                <span className="lemma-wordcount-row-label">
                  <span>{row.label}</span>
                  {row.subLabel && (
                    <span className="lemma-wordcount-row-sub">
                      {row.subLabel}
                    </span>
                  )}
                </span>

                {hasSelection ? (
                  <>
                    <span className="lemma-wordcount-row-val is-sel-val">
                      {formatStatNumber(selectionStats[row.key])}
                    </span>
                    <span className="lemma-wordcount-row-val is-doc-val">
                      {formatStatNumber(docStats[row.key])}
                    </span>
                  </>
                ) : (
                  <span className="lemma-wordcount-row-val">
                    {formatStatNumber(docStats[row.key])}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="lemma-wordcount-footer">
            预计阅读约 {formatStatNumber(activeStats.readingMinutes)} 分钟 · 已排除批注与排版标记
          </div>
        </div>
      )}

      <button
        type="button"
        className={`lemma-wordcount-pill ${hasSelection ? 'has-selection' : ''} ${isOpen ? 'is-open' : ''}`}
        onMouseDown={(e) => {
          // Keep current text selection inside the ProseMirror paper active when clicking the pill
          e.preventDefault();
        }}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={
          hasSelection
            ? `字数统计：已选 ${formatStatNumber(selectionStats.totalWords)} 字，全文 ${formatStatNumber(docStats.totalWords)} 字`
            : `字数统计：全文 ${formatStatNumber(docStats.totalWords)} 字`
        }
        title={
          isOpen
            ? '收起字数统计详情 (Esc)'
            : '点击查看详细字数统计（中文字符、英文词数、字符数、段落与公式）'
        }
      >
        <span className="lemma-wordcount-pill-text">
          {hasSelection
            ? `已选 ${formatStatNumber(selectionStats.totalWords)} / ${formatStatNumber(docStats.totalWords)} 字`
            : `${formatStatNumber(docStats.totalWords)} 字`}
        </span>
        {isOpen ? (
          <ChevronDown
            size={11}
            strokeWidth={2}
            className="lemma-wordcount-pill-chevron"
            aria-hidden="true"
          />
        ) : (
          <ChevronUp
            size={11}
            strokeWidth={2}
            className="lemma-wordcount-pill-chevron"
            aria-hidden="true"
          />
        )}
      </button>
    </div>
  );
}

export default WordCountBar;
