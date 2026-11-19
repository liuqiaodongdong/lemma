import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Check,
  MessageSquareText,
  Pencil,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  DocumentComment,
  PendingCommentDraft,
} from '../../types/contract';

export interface CommentSidebarProps {
  isOpen: boolean;
  comments: DocumentComment[];
  activeCommentId: string | null;
  pendingDraft: PendingCommentDraft | null;
  hasAnyHighlights?: boolean;
  onSelectComment: (commentId: string) => void;
  onCommitDraft: (text: string) => void;
  onCancelDraft: () => void;
  onUpdateComment: (commentId: string, nextText: string) => void;
  onResolveComment: (commentId: string) => void;
  onClearAllComments: () => void;
  onClearAllHighlights?: () => void;
  onClose: () => void;
}

type ConfirmTarget = 'comments' | 'highlights' | null;

type OrderedCardItem =
  | { kind: 'draft'; draft: PendingCommentDraft }
  | { kind: 'comment'; comment: DocumentComment; index: number };

function formatCommentTimestamp(raw?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Format ISO-8601 timestamps concisely while preserving pre-formatted strings
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      const hours = String(parsed.getHours()).padStart(2, '0');
      const minutes = String(parsed.getMinutes()).padStart(2, '0');
      return `${month}-${day} ${hours}:${minutes}`;
    }
  }
  return trimmed;
}

function autoResizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  const nextHeight = Math.max(74, Math.min(el.scrollHeight, 220));
  el.style.height = `${nextHeight}px`;
}

interface PendingDraftCardProps {
  draft: PendingCommentDraft;
  onCommitDraft: (text: string) => void;
  onCancelDraft: () => void;
}

function PendingDraftCard({
  draft,
  onCommitDraft,
  onCancelDraft,
}: PendingDraftCardProps): React.ReactElement {
  const [text, setText] = useState<string>('');
  const latestTextRef = useRef<string>('');
  const settledRef = useRef<boolean>(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    settledRef.current = false;
    cardRef.current?.scrollIntoView?.({
      block: 'nearest',
      behavior: 'smooth',
    });
    const el = textareaRef.current;
    if (el) {
      el.focus();
      autoResizeTextarea(el);
    }
  }, []);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    latestTextRef.current = val;
    setText(val);
    autoResizeTextarea(e.target);
  };

  const commitIfValid = useCallback(() => {
    if (settledRef.current) return;
    const trimmed = latestTextRef.current.trim();
    if (!trimmed) return;
    settledRef.current = true;
    onCommitDraft(trimmed);
  }, [onCommitDraft]);

  const cancelDraft = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancelDraft();
  }, [onCancelDraft]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commitIfValid();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelDraft();
    }
  };

  const handleBlur = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = latestTextRef.current.trim();
    if (trimmed.length > 0) {
      onCommitDraft(trimmed);
    } else {
      onCancelDraft();
    }
  };

  return (
    <div
      ref={cardRef}
      className="lemma-comment-card is-draft"
      aria-label="新建批注卡片"
    >
      <div className="lemma-comment-card-header">
        <span className="lemma-comment-draft-badge">新建批注</span>
      </div>

      <div className="lemma-comment-quote" title={draft.quote}>
        “{draft.quote}”
      </div>

      <textarea
        ref={textareaRef}
        rows={3}
        className="lemma-comment-textarea"
        value={text}
        onChange={handleTextChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder="输入批注意见（按 Ctrl+Enter 保存，点击正文也会自动保存）…"
        aria-label="批注内容输入框"
      />

      <div className="lemma-comment-editor-footer">
        <button
          type="button"
          className="lemma-comment-btn-secondary"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            cancelDraft();
          }}
        >
          取消
        </button>
        <button
          type="button"
          className="lemma-comment-btn-primary"
          disabled={!text.trim()}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            commitIfValid();
          }}
        >
          保存
        </button>
      </div>
    </div>
  );
}

interface ExistingCommentCardProps {
  comment: DocumentComment;
  index: number;
  isActive: boolean;
  onSelectComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextText: string) => void;
  onResolveComment: (commentId: string) => void;
}

function ExistingCommentCard({
  comment,
  index,
  isActive,
  onSelectComment,
  onUpdateComment,
  onResolveComment,
}: ExistingCommentCardProps): React.ReactElement {
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editText, setEditText] = useState<string>(comment.text);
  const latestEditTextRef = useRef<string>(comment.text);
  const editSettledRef = useRef<boolean>(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync external comment updates when not actively editing
  useEffect(() => {
    if (!isEditing) {
      latestEditTextRef.current = comment.text;
      setEditText(comment.text);
    }
  }, [comment.text, isEditing]);

  // Smoothly scroll active card into view when selected from either paper or sidebar
  useEffect(() => {
    if (isActive && cardRef.current) {
      cardRef.current.scrollIntoView?.({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [isActive]);

  // Focus textarea at the end when entering inline edit mode
  useEffect(() => {
    if (!isEditing) return;
    editSettledRef.current = false;
    const el = editTextareaRef.current;
    if (el) {
      el.focus();
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // Ignore selectionRange unsupported errors
      }
      autoResizeTextarea(el);
    }
  }, [isEditing]);

  const startEditing = useCallback(() => {
    latestEditTextRef.current = comment.text;
    setEditText(comment.text);
    editSettledRef.current = false;
    setIsEditing(true);
  }, [comment.text]);

  const saveEdit = useCallback(() => {
    if (editSettledRef.current) return;
    const trimmed = latestEditTextRef.current.trim();
    if (!trimmed) return;
    editSettledRef.current = true;
    if (trimmed !== comment.text) {
      onUpdateComment(comment.id, trimmed);
    }
    setIsEditing(false);
  }, [comment.id, comment.text, onUpdateComment]);

  const cancelEdit = useCallback(() => {
    editSettledRef.current = true;
    latestEditTextRef.current = comment.text;
    setEditText(comment.text);
    setIsEditing(false);
  }, [comment.text]);

  const handleEditBlur = () => {
    if (editSettledRef.current) return;
    editSettledRef.current = true;
    const trimmed = latestEditTextRef.current.trim();
    if (trimmed.length > 0 && trimmed !== comment.text) {
      onUpdateComment(comment.id, trimmed);
    } else if (trimmed.length === 0) {
      latestEditTextRef.current = comment.text;
      setEditText(comment.text);
    }
    setIsEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  };

  const formattedTime = useMemo(
    () => formatCommentTimestamp(comment.createdAt),
    [comment.createdAt]
  );

  return (
    <div
      ref={cardRef}
      className={`lemma-comment-card${isActive ? ' is-active' : ''}${
        isEditing ? ' is-editing' : ''
      }`}
      onClick={() => onSelectComment(comment.id)}
      role="article"
      aria-label={`批注 #${index + 1}`}
    >
      <div className="lemma-comment-card-header">
        <div className="lemma-comment-card-meta">
          <span className="lemma-comment-index-badge">#{index + 1}</span>
          {formattedTime && (
            <span className="lemma-comment-timestamp">{formattedTime}</span>
          )}
        </div>

        <div className="lemma-comment-card-actions">
          <button
            type="button"
            className="lemma-comment-action-icon-btn"
            title="编辑批注"
            aria-label="编辑批注"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectComment(comment.id);
              startEditing();
            }}
          >
            <Pencil size={12.5} strokeWidth={1.9} />
          </button>

          <button
            type="button"
            className="lemma-comment-resolve-btn"
            title="标记已解决并移除批注"
            aria-label="标记已解决并移除批注"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              editSettledRef.current = true;
              onResolveComment(comment.id);
            }}
          >
            <Check size={12.5} strokeWidth={2.2} />
            <span>已解决</span>
          </button>
        </div>
      </div>

      <div className="lemma-comment-quote" title={comment.quote}>
        “{comment.quote}”
      </div>

      {isEditing ? (
        <div
          className="lemma-comment-inline-editor"
          onClick={(e) => e.stopPropagation()}
        >
          <textarea
            ref={editTextareaRef}
            rows={3}
            className="lemma-comment-textarea"
            value={editText}
            onChange={(e) => {
              const val = e.target.value;
              latestEditTextRef.current = val;
              setEditText(val);
              autoResizeTextarea(e.target);
            }}
            onKeyDown={handleEditKeyDown}
            onBlur={handleEditBlur}
            aria-label={`编辑批注 #${index + 1}`}
          />
          <div className="lemma-comment-editor-footer">
            <button
              type="button"
              className="lemma-comment-btn-secondary"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                cancelEdit();
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="lemma-comment-btn-primary"
              disabled={!editText.trim()}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                saveEdit();
              }}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <div
          className="lemma-comment-body"
          title="双击可编辑批注"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onSelectComment(comment.id);
            startEditing();
          }}
        >
          {comment.text}
        </div>
      )}
    </div>
  );
}

export function CommentSidebar({
  isOpen,
  comments,
  activeCommentId,
  pendingDraft,
  hasAnyHighlights = false,
  onSelectComment,
  onCommitDraft,
  onCancelDraft,
  onUpdateComment,
  onResolveComment,
  onClearAllComments,
  onClearAllHighlights,
  onClose,
}: CommentSidebarProps): React.ReactElement | null {
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null);

  // Auto-reset 2-step bulk confirmation after 4 seconds
  useEffect(() => {
    if (!confirmTarget) return;
    const timer = setTimeout(() => {
      setConfirmTarget(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [confirmTarget]);

  // Clear stale confirmation state if items become empty or panel closes
  useEffect(() => {
    if (!isOpen) {
      setConfirmTarget(null);
    } else if (confirmTarget === 'comments' && comments.length === 0) {
      setConfirmTarget(null);
    } else if (confirmTarget === 'highlights' && !hasAnyHighlights) {
      setConfirmTarget(null);
    }
  }, [isOpen, confirmTarget, comments.length, hasAnyHighlights]);

  const orderedItems = useMemo<OrderedCardItem[]>(() => {
    const sorted = [...comments].sort(
      (a, b) => a.from - b.from || a.to - b.to
    );
    const items: OrderedCardItem[] = [];
    let draftInserted = false;

    sorted.forEach((comment, idx) => {
      if (
        pendingDraft &&
        !draftInserted &&
        pendingDraft.from <= comment.from
      ) {
        items.push({ kind: 'draft', draft: pendingDraft });
        draftInserted = true;
      }
      items.push({ kind: 'comment', comment, index: idx });
    });

    if (pendingDraft && !draftInserted) {
      items.push({ kind: 'draft', draft: pendingDraft });
    }

    return items;
  }, [comments, pendingDraft]);

  if (!isOpen) {
    return null;
  }

  const showClearHighlightsControl =
    Boolean(hasAnyHighlights) && Boolean(onClearAllHighlights);
  const isEmpty = comments.length === 0 && !pendingDraft;

  return (
    <aside className="lemma-comment-rail" aria-label="论文批注栏">
      <div className="lemma-comment-rail-header">
        <div className="lemma-comment-rail-title-group">
          <MessageSquareText size={14} strokeWidth={1.9} />
          <span className="lemma-comment-rail-title">批注</span>
          <span className="lemma-comment-count-pill">{comments.length}</span>
        </div>

        <div className="lemma-comment-rail-controls">
          {confirmTarget === 'comments' ? (
            <div className="lemma-comment-confirm-inline">
              <button
                type="button"
                className="lemma-comment-confirm-danger-btn"
                onClick={() => {
                  setConfirmTarget(null);
                  onClearAllComments();
                }}
              >
                确认清除 ({comments.length})？
              </button>
              <button
                type="button"
                className="lemma-comment-confirm-cancel-btn"
                onClick={() => setConfirmTarget(null)}
              >
                取消
              </button>
            </div>
          ) : confirmTarget === 'highlights' ? (
            <div className="lemma-comment-confirm-inline">
              <button
                type="button"
                className="lemma-comment-confirm-danger-btn"
                onClick={() => {
                  setConfirmTarget(null);
                  onClearAllHighlights?.();
                }}
              >
                确认清高亮？
              </button>
              <button
                type="button"
                className="lemma-comment-confirm-cancel-btn"
                onClick={() => setConfirmTarget(null)}
              >
                取消
              </button>
            </div>
          ) : (
            <>
              {showClearHighlightsControl && (
                <button
                  type="button"
                  className="lemma-comment-header-text-btn"
                  title="清除全文所有荧光笔高亮"
                  onClick={() => setConfirmTarget('highlights')}
                >
                  清除高亮
                </button>
              )}

              {comments.length > 0 && (
                <button
                  type="button"
                  className="lemma-comment-header-text-btn"
                  title="清除全部批注"
                  onClick={() => setConfirmTarget('comments')}
                >
                  清除全部
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="lemma-comment-close-btn"
            title="收起批注栏"
            aria-label="收起批注栏"
            onClick={onClose}
          >
            <X size={15} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div className="lemma-comment-rail-list">
        {isEmpty ? (
          <div className="lemma-comment-empty-state">
            <div className="lemma-comment-empty-card">
              <div className="lemma-comment-empty-icon">
                <Sparkles size={18} strokeWidth={1.75} />
              </div>
              <div className="lemma-comment-empty-title">暂无审阅批注</div>
              <ol className="lemma-comment-empty-tips">
                <li>
                  选中正文中任意句子或公式，可一键添加{' '}
                  <strong>4 色荧光笔高亮</strong> 或 <strong>批注</strong>
                </li>
                <li>
                  批注直接保存在当前 <code>.md</code> 文件中，发给学生或交给 AI
                  改稿都不会丢失
                </li>
              </ol>
            </div>
          </div>
        ) : (
          orderedItems.map((item) =>
            item.kind === 'draft' ? (
              <PendingDraftCard
                key={`draft-${item.draft.from}-${item.draft.to}-${item.draft.quote}`}
                draft={item.draft}
                onCommitDraft={onCommitDraft}
                onCancelDraft={onCancelDraft}
              />
            ) : (
              <ExistingCommentCard
                key={item.comment.id}
                comment={item.comment}
                index={item.index}
                isActive={item.comment.id === activeCommentId}
                onSelectComment={onSelectComment}
                onUpdateComment={onUpdateComment}
                onResolveComment={onResolveComment}
              />
            )
          )
        )}
      </div>
    </aside>
  );
}

export default CommentSidebar;
