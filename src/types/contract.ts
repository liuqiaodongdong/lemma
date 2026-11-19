/**
 * Shared architectural contracts across all Lemma modules:
 * - Agent 1: src-tauri/** & src/services/tauriBridge.ts
 * - Agent 2: src/styles/** & src/components/shell/** & src/components/source/**
 * - Agent 3: src/editor/**
 * - Agent 4: src/diff/**
 */

export type ThemeMode = 'light' | 'dark';
export type EditorViewMode = 'wysiwyg' | 'source';
export type SidebarTab = 'files' | 'outline';
export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
  'yellow',
  'green',
  'blue',
  'pink',
] as const;

export interface DocumentComment {
  id: string;
  text: string;
  /** Short quoted excerpt of the anchored document text (including `$...$` for inline math) */
  quote: string;
  createdAt?: string;
  /** First ProseMirror position covered by this comment mark */
  from: number;
  /** End ProseMirror position covered by this comment mark */
  to: number;
}

export interface PendingCommentDraft {
  from: number;
  to: number;
  quote: string;
}

export interface FileSnapshot {
  path: string;
  content: string;
  sha256: string;
  modifiedMs: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
}

export interface ExternalChangeEvent {
  path: string;
  content: string;
  sha256: string;
  modifiedMs: number;
}

export interface SavedAssetResult {
  /** Relative path stored inside Markdown, e.g. "assets/paste-20261114-225000.png" */
  relativePath: string;
  /** Full disk path where the image was written */
  absolutePath: string;
}

export interface OutlineHeading {
  id: string;
  level: number;
  text: string;
  /** ProseMirror position for smooth scrolling in WYSIWYG mode */
  pos: number;
}

export type DiffHunkKind =
  | 'text-modified'
  | 'block-added'
  | 'block-deleted'
  | 'math-modified'
  | 'svg-modified'
  | 'table-modified'
  | 'block-modified';

export interface InlineDiffSegment {
  type: 'equal' | 'insert' | 'delete';
  text: string;
  isInlineMath?: boolean;
}

export interface DiffHunk {
  id: string;
  index: number;
  kind: DiffHunkKind;
  summary: string;
  /** Start position in current ProseMirror doc (for block-deleted, insertion anchor pos) */
  newFrom: number;
  /** End position in current ProseMirror doc */
  newTo: number;
  /** Serialized ProseMirror JSON array of original node(s) from baseline doc (empty if purely added) */
  oldNodesJson: Record<string, unknown>[];
  /** Optional raw LaTeX strings for before/after KaTeX comparison */
  oldLatex?: string;
  newLatex?: string;
  /** Optional raw SVG code strings for before/after vector diagram comparison */
  oldSvg?: string;
  newSvg?: string;
  /** Optional markdown/text preview for deleted or modified blocks */
  oldPreviewText?: string;
  newPreviewText?: string;
  /** Character/word diff segments within a text block */
  segments?: InlineDiffSegment[];
}

export interface DiffReviewState {
  hasChanges: boolean;
  hunks: DiffHunk[];
  activeHunkIndex: number;
  showDeletions: boolean;
}

export interface DiffReviewActions {
  goToPrevHunk: () => void;
  goToNextHunk: () => void;
  toggleShowDeletions: () => void;
  acceptHunk: (hunkId: string) => void;
  acceptAll: () => void;
  revertHunk: (hunkId: string) => void;
}

export interface WordCountStats {
  /** Word / Typora 标准总字数 = 中文字符数 + 英文/数字词数 */
  totalWords: number;
  /** 中文汉字数 */
  cjkChars: number;
  /** 英文与数字单词数 */
  latinWords: number;
  /** 字符数（不计空格） */
  charsNoSpaces: number;
  /** 字符数（计空格，不含换行符） */
  charsWithSpaces: number;
  /** 非空段落/块数 */
  paragraphs: number;
  /** 数学公式数量（行内 + 块级） */
  mathCount: number;
  /** 预计阅读分钟数 */
  readingMinutes: number;
}

export interface LemmaBridge {
  isTauri(): boolean;
  getCliInitialPath(): Promise<string | null>;
  consumeBootDocument?: () => Promise<FileSnapshot | null>;
  pickMarkdownFile(): Promise<string | null>;
  pickSaveMarkdownFile(defaultName?: string): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  readMarkdownFile(path: string): Promise<FileSnapshot>;
  writeMarkdownFile(path: string, content: string): Promise<FileSnapshot>;
  listDirectoryTree(rootPath: string): Promise<FileTreeNode[]>;
  saveClipboardImage(
    mdFilePath: string,
    base64Data: string,
    ext?: string
  ): Promise<SavedAssetResult>;
  watchFile(path: string): Promise<void>;
  unwatchFile(): Promise<void>;
  onExternalFileChange(
    handler: (event: ExternalChangeEvent) => void
  ): Promise<() => void>;
  resolveLocalAssetUrl(mdFilePath: string | null, rawSrc: string): string;
}
