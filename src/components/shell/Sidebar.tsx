import React from 'react';
import { ListTree } from 'lucide-react';
import type { OutlineHeading } from '../../types/contract';

export interface SidebarProps {
  isOpen: boolean;
  outline: OutlineHeading[];
  onSelectHeading: (pos: number) => void;
}

export function Sidebar({
  isOpen,
  outline,
  onSelectHeading,
}: SidebarProps): React.ReactElement | null {
  if (!isOpen) {
    return null;
  }

  const minHeadingLevel =
    outline.length > 0
      ? Math.min(...outline.map((item) => Math.max(1, Math.min(6, item.level))))
      : 1;

  return (
    <aside className="lemma-sidebar" aria-label="论文大纲侧边栏">
      <div className="lemma-sidebar-header">
        <ListTree size={14} strokeWidth={1.85} />
        <span>论文大纲</span>
      </div>

      <div className="lemma-sidebar-content">
        {outline.length === 0 ? (
          <div className="lemma-sidebar-empty">
            <ListTree size={24} strokeWidth={1.5} />
            <div>当前文稿暂无章节标题（H1–H6）</div>
          </div>
        ) : (
          outline.map((heading) => {
            const clampedLevel = Math.max(1, Math.min(6, heading.level));
            const indent = 12 + (clampedLevel - minHeadingLevel) * 14;
            return (
              <button
                key={heading.id}
                type="button"
                className={`lemma-outline-row ${clampedLevel === 1 ? 'is-h1' : ''}`}
                style={{ paddingLeft: `${indent}px` }}
                onClick={() => onSelectHeading(heading.pos)}
                title={`H${clampedLevel}: ${heading.text}`}
              >
                <span className="lemma-outline-level-tag">H{clampedLevel}</span>
                <span className="lemma-outline-text">
                  {heading.text || '（无标题章节）'}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

export default Sidebar;
