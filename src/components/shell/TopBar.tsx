import React from 'react';
import {
  BookOpen,
  Code2,
  FilePlus2,
  FileUp,
  Minus,
  Moon,
  PanelLeft,
  Plus,
  Save,
  Sun,
} from 'lucide-react';
import type { EditorViewMode, ThemeMode } from '../../types/contract';

export interface TopBarProps {
  filePath: string | null;
  isDirty: boolean;
  saveStatusText?: string;
  viewMode: EditorViewMode;
  theme: ThemeMode;
  sidebarOpen: boolean;
  zoomPercent?: number;
  isZoomCustomized?: boolean;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  onToggleSidebar: () => void;
  onNewFile: () => void;
  onOpenFile: () => void;
  onSaveFile: () => void;
  onToggleViewMode: () => void;
  onToggleTheme: () => void;
  rightSlot?: React.ReactNode;
}

function getDisplayFileName(filePath: string | null): string {
  if (!filePath) {
    return '未命名文稿.md';
  }
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

export function TopBar({
  filePath,
  isDirty,
  saveStatusText,
  viewMode,
  theme,
  sidebarOpen,
  zoomPercent = 100,
  isZoomCustomized = false,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleSidebar,
  onNewFile,
  onOpenFile,
  onSaveFile,
  onToggleViewMode,
  onToggleTheme,
  rightSlot,
}: TopBarProps): React.ReactElement {
  const fileName = getDisplayFileName(filePath);
  const resolvedSaveText =
    saveStatusText && saveStatusText.trim().length > 0
      ? saveStatusText
      : isDirty
        ? '未保存'
        : filePath
          ? '已自动保存'
          : '草稿';

  return (
    <header className="lemma-topbar" role="banner">
      <div className="lemma-topbar-left">
        <button
          type="button"
          className={`lemma-icon-btn ${sidebarOpen ? 'is-active' : ''}`}
          onClick={onToggleSidebar}
          title={sidebarOpen ? '收起论文大纲 (Ctrl+Shift+L)' : '展开论文大纲 (Ctrl+Shift+L)'}
          aria-label={sidebarOpen ? '收起论文大纲' : '展开论文大纲'}
        >
          <PanelLeft size={16} strokeWidth={1.85} />
        </button>

        <span className="lemma-brand-mark" title="Lemma（引理）— LaTeX 学术文稿编辑器">
          LEMMA
        </span>

        <span className="lemma-topbar-divider" aria-hidden="true" />

        <button
          type="button"
          className="lemma-icon-btn"
          onClick={onNewFile}
          title="新建空白文稿 (Ctrl+N)"
          aria-label="新建空白文稿"
        >
          <FilePlus2 size={15} strokeWidth={1.85} />
          <span className="lemma-btn-label lemma-btn-label-hide-sm">新建</span>
        </button>

        <button
          type="button"
          className="lemma-icon-btn"
          onClick={onOpenFile}
          title="打开 Markdown 文稿 (Ctrl+O)"
          aria-label="打开 Markdown 文稿"
        >
          <FileUp size={15} strokeWidth={1.85} />
          <span className="lemma-btn-label lemma-btn-label-hide-sm">打开</span>
        </button>

        <button
          type="button"
          className="lemma-icon-btn"
          onClick={onSaveFile}
          title="保存当前文稿 (Ctrl+S)"
          aria-label="保存当前文稿"
        >
          <Save size={15} strokeWidth={1.85} />
          <span className="lemma-btn-label lemma-btn-label-hide-sm">保存</span>
        </button>
      </div>

      <div className="lemma-topbar-center">
        <span
          className="lemma-doc-title"
          title={filePath ?? '尚未保存至本地磁盘'}
        >
          {fileName}
        </span>
        <span
          className={`lemma-save-badge ${isDirty ? 'is-dirty' : ''}`}
          aria-live="polite"
        >
          <span className="lemma-save-dot" aria-hidden="true" />
          <span>{resolvedSaveText}</span>
        </span>
      </div>

      <div className="lemma-topbar-right">
        {rightSlot}

        {(onZoomIn || onZoomOut || onZoomReset) && (
          <div
            className="lemma-zoom-control"
            role="group"
            aria-label="版面与字体缩放控制"
          >
            <button
              type="button"
              className="lemma-zoom-step-btn"
              onClick={onZoomOut}
              title="缩小版面与字体 (Ctrl+- / Ctrl+滚轮下)"
              aria-label="缩小版面与字体"
            >
              <Minus size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              className={`lemma-zoom-readout-btn ${isZoomCustomized ? 'is-customized' : ''}`}
              onClick={onZoomReset}
              title="当前版面与字号总缩放比例（随窗口自动等比放大；点击恢复自动基准 Ctrl+0）"
              aria-label="重置手动缩放偏移"
            >
              {zoomPercent}%
            </button>
            <button
              type="button"
              className="lemma-zoom-step-btn"
              onClick={onZoomIn}
              title="放大版面与字体 (Ctrl++ / Ctrl+滚轮上)"
              aria-label="放大版面与字体"
            >
              <Plus size={13} strokeWidth={2} />
            </button>
          </div>
        )}

        <button
          type="button"
          className={`lemma-icon-btn ${viewMode === 'source' ? 'is-active' : ''}`}
          onClick={onToggleViewMode}
          title={
            viewMode === 'source'
              ? '返回所见即所得排版视图 (Ctrl+/)'
              : '切换 Markdown 源码模式 (Ctrl+/)'
          }
          aria-label="切换源码与排版视图"
        >
          {viewMode === 'source' ? (
            <>
              <BookOpen size={15} strokeWidth={1.85} />
              <span className="lemma-btn-label">排版视图</span>
            </>
          ) : (
            <>
              <Code2 size={15} strokeWidth={1.85} />
              <span className="lemma-btn-label">源码模式</span>
            </>
          )}
        </button>

        <button
          type="button"
          className="lemma-icon-btn"
          onClick={onToggleTheme}
          title={
            theme === 'dark'
              ? '切换至日间学术白纸模式'
              : '切换至夜间护眼暗色模式'
          }
          aria-label={theme === 'dark' ? '切换至日间模式' : '切换至夜间模式'}
        >
          {theme === 'dark' ? (
            <Sun size={15} strokeWidth={1.85} />
          ) : (
            <Moon size={15} strokeWidth={1.85} />
          )}
        </button>
      </div>
    </header>
  );
}

export default TopBar;
