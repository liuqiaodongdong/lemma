import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type {
  ExternalChangeEvent,
  FileSnapshot,
  FileTreeNode,
  LemmaBridge,
  SavedAssetResult,
} from '../types/contract';

const EXTERNAL_CHANGE_EVENT = 'lemma://external-file-change';
const DEMO_FILE_PATH = '/demo/economics-showcase.md';
const MEMFS_STORAGE_PREFIX = 'lemma:memfs:';

const FALLBACK_ECONOMICS_MARKDOWN = `# Equilibrium Selection in Dynamic Games

> [!NOTE]
> **Lemma 1 (Single-Crossing & Monotone Comparative Statics).** Let $u(x, \\theta)$ satisfy increasing differences in $(x, \\theta) \\in X \\times \\Theta$. Then every selection $x^*(\\theta) \\in \\arg\\max_{x \\in X} u(x, \\theta)$ is non-decreasing in $\\theta$.

## 1. Household Intertemporal Problem

Consider a representative household maximizing discounted lifetime utility over consumption $\{c_t\}_{t=0}^{\\infty}$:

$$
\\max_{\\{c_t, k_{t+1}\\}_{t=0}^{\\infty}} \\sum_{t=0}^{\\infty} \\beta^t \\frac{c_t^{1 - \\sigma} - 1}{1 - \\sigma} \\quad \\text{s.t.} \\quad c_t + k_{t+1} = f(k_t) + (1 - \\delta) k_t
$$

The Euler equation characterizes the optimal intertemporal path:

$$
c_t^{-\\sigma} = \\beta \\, c_{t+1}^{-\\sigma} \\left[ f'(k_{t+1}) + 1 - \\delta \\right]
$$
`;

const inMemoryFiles = new Map<string, FileSnapshot>();
const inMemoryAssets = new Map<string, string>();
const browserExternalListeners = new Set<(event: ExternalChangeEvent) => void>();
let browserWatchedPath: string | null = null;

function detectTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Pure TypeScript SHA-256 fallback (FIPS 180-4) used when `crypto.subtle` is unavailable
 * (e.g. non-HTTPS dev origins or lightweight test environments).
 */
function sha256PureHex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (n: number, x: number): number => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

async function computeSha256Browser(content: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const data = new TextEncoder().encode(content);
      const hashBuf = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback to pure-TS SHA-256 below
  }
  return sha256PureHex(content);
}

function readPersistedMemFile(path: string): FileSnapshot | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(`${MEMFS_STORAGE_PREFIX}${path}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FileSnapshot>;
    if (
      typeof parsed.path === 'string' &&
      typeof parsed.content === 'string' &&
      typeof parsed.sha256 === 'string' &&
      typeof parsed.modifiedMs === 'number'
    ) {
      return parsed as FileSnapshot;
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

function persistMemFile(snapshot: FileSnapshot): void {
  inMemoryFiles.set(snapshot.path, snapshot);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        `${MEMFS_STORAGE_PREFIX}${snapshot.path}`,
        JSON.stringify(snapshot)
      );
    }
  } catch {
    // Ignore quota / security errors in sandboxed contexts
  }
}

async function fetchDemoOrFallbackMarkdown(requestedPath: string): Promise<string> {
  if (typeof fetch !== 'function') {
    return FALLBACK_ECONOMICS_MARKDOWN;
  }

  const urlsToTry: string[] = [];
  if (requestedPath.startsWith('/') || /^https?:\/\//i.test(requestedPath)) {
    urlsToTry.push(requestedPath);
  }
  if (!urlsToTry.includes(DEMO_FILE_PATH)) {
    urlsToTry.push(DEMO_FILE_PATH);
  }

  for (const url of urlsToTry) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) continue;
      const text = await response.text();
      if (text.trimStart().toLowerCase().startsWith('<!doctype html')) continue;
      return text;
    } catch {
      // Try next fallback URL
    }
  }

  return FALLBACK_ECONOMICS_MARKDOWN;
}

function safeDecodeUriPath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isPassThroughUrl(src: string): boolean {
  return /^(https?:|data:|blob:|asset:|tauri:|mailto:|#)/i.test(src);
}

function isWindowsStylePath(pathStr: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(pathStr) || pathStr.startsWith('\\\\');
}

/**
 * Join `relativeOrAbsSrc` against the parent directory of `mdFilePath`, normalizing `.`, `..`,
 * and `/` vs `\` separators cleanly on both Windows and POSIX paths.
 */
function resolvePathAgainstMarkdownFile(
  mdFilePath: string,
  decodedSrc: string
): { resolvedPath: string; windowsMode: boolean } {
  const cleanMd = mdFilePath.replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
  const windowsMode = isWindowsStylePath(cleanMd) || isWindowsStylePath(decodedSrc);

  let workingSrc = decodedSrc;
  if (/^file:\/\//i.test(workingSrc)) {
    workingSrc = safeDecodeUriPath(workingSrc.replace(/^file:\/\/\/?/i, ''));
    if (!windowsMode && !workingSrc.startsWith('/')) {
      workingSrc = `/${workingSrc}`;
    }
  }

  const srcSlashed = workingSrc.replace(/\\/g, '/');

  // If `src` is already an absolute Windows drive path or UNC path, normalize directly.
  if (/^[a-zA-Z]:\//.test(srcSlashed) || srcSlashed.startsWith('//')) {
    return {
      resolvedPath: normalizeJoinedPath(srcSlashed, true),
      windowsMode: true,
    };
  }

  // If `src` is POSIX-absolute and `mdFilePath` is not a Windows path, normalize directly.
  if (srcSlashed.startsWith('/') && !windowsMode) {
    return {
      resolvedPath: normalizeJoinedPath(srcSlashed, false),
      windowsMode: false,
    };
  }

  const mdSlashed = cleanMd.replace(/\\/g, '/');
  const lastSlash = mdSlashed.lastIndexOf('/');
  const parentDir = lastSlash >= 0 ? mdSlashed.slice(0, lastSlash) : '.';

  const strippedRel = srcSlashed.replace(/^(?:\.\/)+/, '');
  const combined = `${parentDir}/${strippedRel}`;
  return {
    resolvedPath: normalizeJoinedPath(combined, windowsMode),
    windowsMode,
  };
}

function normalizeJoinedPath(slashedPath: string, windowsMode: boolean): string {
  let rootPrefix = '';
  let remainder = slashedPath;

  const uncMatch = remainder.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/);
  const driveMatch = remainder.match(/^([a-zA-Z]:)(?:\/(.*))?$/);

  if (uncMatch) {
    rootPrefix = uncMatch[1];
    remainder = uncMatch[2] ?? '';
  } else if (driveMatch) {
    rootPrefix = driveMatch[1];
    remainder = driveMatch[2] ?? '';
  } else if (remainder.startsWith('/')) {
    rootPrefix = '/';
    remainder = remainder.slice(1);
  }

  const stack: string[] = [];
  for (const part of remainder.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!rootPrefix) {
        stack.push('..');
      }
    } else {
      stack.push(part);
    }
  }

  const sep = windowsMode ? '\\' : '/';
  const normalizedRoot = windowsMode ? rootPrefix.replace(/\//g, '\\') : rootPrefix;

  if (!normalizedRoot) {
    return stack.join(sep);
  }
  if (normalizedRoot === '/') {
    return `/${stack.join('/')}`;
  }
  return stack.length > 0
    ? `${normalizedRoot}${sep}${stack.join(sep)}`
    : `${normalizedRoot}${sep}`;
}

function sanitizeImageExt(ext?: string, dataHeader?: string): string {
  let candidate = ext?.trim().replace(/^\.+/, '') ?? '';
  if (!candidate && dataHeader?.startsWith('data:image/')) {
    const mimeSub = dataHeader.slice('data:image/'.length).split(/[;,]/)[0]?.toLowerCase() ?? '';
    candidate = mimeSub === 'jpeg' ? 'jpg' : mimeSub === 'svg+xml' ? 'svg' : mimeSub;
  }
  const cleaned = candidate.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return cleaned || 'png';
}

// Optional browser-mode hook allowing dev tools or tests to simulate an external AI file edit.
if (typeof window !== 'undefined' && !detectTauriRuntime()) {
  window.addEventListener('lemma:external-file-change', (ev: Event) => {
    const custom = ev as CustomEvent<ExternalChangeEvent>;
    if (custom.detail && (!browserWatchedPath || custom.detail.path === browserWatchedPath)) {
      persistMemFile({
        path: custom.detail.path,
        content: custom.detail.content,
        sha256: custom.detail.sha256,
        modifiedMs: custom.detail.modifiedMs,
      });
      for (const listener of browserExternalListeners) {
        listener(custom.detail);
      }
    }
  });
}

export const tauriBridge: LemmaBridge = {
  isTauri(): boolean {
    return detectTauriRuntime();
  },

  async consumeBootDocument(): Promise<FileSnapshot | null> {
    if (detectTauriRuntime()) {
      return await invoke<FileSnapshot | null>('consume_boot_document');
    }
    return null;
  },

  async getCliInitialPath(): Promise<string | null> {
    if (detectTauriRuntime()) {
      return await invoke<string | null>('get_cli_initial_path');
    }
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const queryPath = params.get('file');
      if (queryPath) return queryPath;
    }
    return null;
  },

  async pickMarkdownFile(): Promise<string | null> {
    if (detectTauriRuntime()) {
      const selected = await open({
        multiple: false,
        directory: false,
        title: 'Open Markdown Document',
        filters: [
          {
            name: 'Markdown Document',
            extensions: ['md', 'markdown'],
          },
        ],
      });
      return typeof selected === 'string' ? selected : null;
    }

    // Browser dev fallback: use File System Access API if supported, otherwise load demo file.
    if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
      try {
        const picker = (
          window as Window & {
            showOpenFilePicker: (opts?: unknown) => Promise<
              Array<{
                name: string;
                getFile: () => Promise<File>;
              }>
            >;
          }
        ).showOpenFilePicker;
        const handles = await picker({
          multiple: false,
          types: [
            {
              description: 'Markdown Document',
              accept: { 'text/markdown': ['.md', '.markdown'] },
            },
          ],
        });
        if (handles.length === 0) return null;
        const file = await handles[0].getFile();
        const content = await file.text();
        const virtualPath = `/browser/${file.name}`;
        const sha256 = await computeSha256Browser(content);
        persistMemFile({
          path: virtualPath,
          content,
          sha256,
          modifiedMs: file.lastModified || Date.now(),
        });
        return virtualPath;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return null;
        }
      }
    }

    return DEMO_FILE_PATH;
  },

  async pickSaveMarkdownFile(defaultName?: string): Promise<string | null> {
    const suggested = defaultName?.trim() || 'untitled.md';
    const normalizedName = /\.(md|markdown)$/i.test(suggested)
      ? suggested
      : `${suggested}.md`;

    if (detectTauriRuntime()) {
      return await save({
        title: 'Save Markdown Document',
        defaultPath: normalizedName,
        filters: [
          {
            name: 'Markdown Document',
            extensions: ['md', 'markdown'],
          },
        ],
      });
    }

    return normalizedName.startsWith('/') ? normalizedName : `/demo/${normalizedName}`;
  },

  async pickFolder(): Promise<string | null> {
    if (detectTauriRuntime()) {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Open Workspace Folder',
      });
      return typeof selected === 'string' ? selected : null;
    }
    return '/demo';
  },

  async readMarkdownFile(path: string): Promise<FileSnapshot> {
    if (detectTauriRuntime()) {
      return await invoke<FileSnapshot>('read_markdown_file', { path });
    }

    const memHit = inMemoryFiles.get(path) ?? readPersistedMemFile(path);
    if (memHit) {
      inMemoryFiles.set(path, memHit);
      return { ...memHit };
    }

    const content = await fetchDemoOrFallbackMarkdown(path);
    const sha256 = await computeSha256Browser(content);
    const snapshot: FileSnapshot = {
      path,
      content,
      sha256,
      modifiedMs: Date.now(),
    };
    persistMemFile(snapshot);
    return { ...snapshot };
  },

  async writeMarkdownFile(path: string, content: string): Promise<FileSnapshot> {
    if (detectTauriRuntime()) {
      return await invoke<FileSnapshot>('write_markdown_file', { path, content });
    }

    const sha256 = await computeSha256Browser(content);
    const snapshot: FileSnapshot = {
      path,
      content,
      sha256,
      modifiedMs: Date.now(),
    };
    persistMemFile(snapshot);
    return { ...snapshot };
  },

  async listDirectoryTree(rootPath: string): Promise<FileTreeNode[]> {
    if (detectTauriRuntime()) {
      return await invoke<FileTreeNode[]>('list_directory_tree', { rootPath });
    }

    const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/demo';
    const knownPaths = new Set<string>([DEMO_FILE_PATH, ...inMemoryFiles.keys()]);
    const nodes: FileTreeNode[] = [];

    for (const filePath of knownPaths) {
      const clean = filePath.replace(/\\/g, '/');
      if (clean.startsWith(`${normalizedRoot}/`)) {
        const rel = clean.slice(normalizedRoot.length + 1);
        if (rel && !rel.includes('/')) {
          nodes.push({
            name: rel,
            path: clean,
            isDir: false,
          });
        }
      }
    }

    if (nodes.length === 0) {
      nodes.push({
        name: 'economics-showcase.md',
        path: DEMO_FILE_PATH,
        isDir: false,
      });
    }

    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    return nodes;
  },

  async saveClipboardImage(
    mdFilePath: string,
    base64Data: string,
    ext?: string
  ): Promise<SavedAssetResult> {
    if (detectTauriRuntime()) {
      return await invoke<SavedAssetResult>('save_clipboard_image', {
        mdFilePath,
        base64Data,
        ext,
      });
    }

    const sanitizedExt = sanitizeImageExt(ext, base64Data);
    const filename = `paste-${Date.now()}.${sanitizedExt}`;
    const relativePath = `assets/${filename}`;
    const { resolvedPath: absolutePath } = resolvePathAgainstMarkdownFile(
      mdFilePath || DEMO_FILE_PATH,
      relativePath
    );

    const dataUrl = base64Data.trim().startsWith('data:')
      ? base64Data.trim()
      : `data:image/${sanitizedExt === 'jpg' ? 'jpeg' : sanitizedExt};base64,${base64Data.trim()}`;

    inMemoryAssets.set(relativePath, dataUrl);
    inMemoryAssets.set(absolutePath, dataUrl);
    inMemoryAssets.set(absolutePath.replace(/\\/g, '/'), dataUrl);

    return {
      relativePath,
      absolutePath,
    };
  },

  async watchFile(path: string): Promise<void> {
    if (detectTauriRuntime()) {
      await invoke<void>('watch_file', { path });
      return;
    }
    browserWatchedPath = path;
  },

  async unwatchFile(): Promise<void> {
    if (detectTauriRuntime()) {
      await invoke<void>('unwatch_file');
      return;
    }
    browserWatchedPath = null;
  },

  async onExternalFileChange(
    handler: (event: ExternalChangeEvent) => void
  ): Promise<() => void> {
    if (detectTauriRuntime()) {
      const unlisten = await listen<ExternalChangeEvent>(
        EXTERNAL_CHANGE_EVENT,
        (event) => {
          handler(event.payload);
        }
      );
      return unlisten;
    }

    browserExternalListeners.add(handler);
    return () => {
      browserExternalListeners.delete(handler);
    };
  },

  resolveLocalAssetUrl(mdFilePath: string | null, rawSrc: string): string {
    const trimmed = rawSrc.trim();
    if (!trimmed || isPassThroughUrl(trimmed)) {
      return rawSrc;
    }

    // Separate optional query/hash suffix so percent-decoding applies cleanly to the file path.
    const suffixMatch = trimmed.match(/^([^?#]*)(.*)$/);
    const rawPathPart = suffixMatch ? suffixMatch[1] : trimmed;
    const suffixPart = suffixMatch ? suffixMatch[2] : '';

    const decodedPathPart = safeDecodeUriPath(rawPathPart);
    const strippedRel = decodedPathPart.replace(/^(?:\.\/)+/, '');

    if (!mdFilePath) {
      const memDirect =
        inMemoryAssets.get(decodedPathPart) ?? inMemoryAssets.get(strippedRel);
      if (memDirect) return memDirect;

      if (
        detectTauriRuntime() &&
        (isWindowsStylePath(decodedPathPart) ||
          decodedPathPart.startsWith('/') ||
          /^file:\/\//i.test(decodedPathPart))
      ) {
        const { resolvedPath } = resolvePathAgainstMarkdownFile('', decodedPathPart);
        return `${convertFileSrc(resolvedPath)}${suffixPart}`;
      }
      return rawSrc;
    }

    const { resolvedPath } = resolvePathAgainstMarkdownFile(mdFilePath, decodedPathPart);

    if (detectTauriRuntime()) {
      return `${convertFileSrc(resolvedPath)}${suffixPart}`;
    }

    const memAsset =
      inMemoryAssets.get(resolvedPath) ??
      inMemoryAssets.get(resolvedPath.replace(/\\/g, '/')) ??
      inMemoryAssets.get(strippedRel);
    if (memAsset) {
      return memAsset;
    }

    return `${resolvedPath.replace(/\\/g, '/')}${suffixPart}`;
  },
};
