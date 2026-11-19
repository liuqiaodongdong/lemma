import React from 'react';
import {
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { DiffReviewActions, DiffReviewState } from '../../types/contract';

export interface DiffReviewBarProps {
  state: DiffReviewState;
  actions: DiffReviewActions;
}

export function DiffReviewBar({
  state,
  actions,
}: DiffReviewBarProps): React.ReactElement | null {
  if (!state.hasChanges || state.hunks.length === 0) {
    return null;
  }

  const total = state.hunks.length;
  const activeDisplayIndex = Math.min(
    Math.max(state.activeHunkIndex + 1, 1),
    total
  );

  return (
    <div
      className="lemma-diff-bar"
      role="region"
      aria-label="外部修改审阅工具栏"
    >
      <span className="lemma-diff-bar-count">
        共 {total} 处修改 ({activeDisplayIndex}/{total})
      </span>

      <button
        type="button"
        className="lemma-diff-bar-btn"
        onClick={actions.goToPrevHunk}
        title="跳转至上一处修改"
        aria-label="上一处修改"
      >
        <ChevronUp size={14} strokeWidth={2} />
        <span>↑</span>
      </button>

      <button
        type="button"
        className="lemma-diff-bar-btn"
        onClick={actions.goToNextHunk}
        title="跳转至下一处修改"
        aria-label="下一处修改"
      >
        <ChevronDown size={14} strokeWidth={2} />
        <span>↓</span>
      </button>

      <button
        type="button"
        className="lemma-diff-bar-btn"
        onClick={actions.toggleShowDeletions}
        title={
          state.showDeletions
            ? '隐藏已删除文本与段落标记'
            : '显示已删除文本与段落标记'
        }
      >
        {state.showDeletions ? (
          <>
            <EyeOff size={13} strokeWidth={1.9} />
            <span>隐藏删除</span>
          </>
        ) : (
          <>
            <Eye size={13} strokeWidth={1.9} />
            <span>显示删除</span>
          </>
        )}
      </button>

      <button
        type="button"
        className="lemma-diff-bar-btn is-primary"
        onClick={actions.acceptAll}
        title="确认并接受全部修改，更新审阅基线"
      >
        <CheckCheck size={14} strokeWidth={1.95} />
        <span>全部已读</span>
      </button>
    </div>
  );
}

export default DiffReviewBar;
