/**
 * Viewport-first KaTeX scheduler (`IntersectionObserver` + idle background trickle).
 *
 * Ensures Screen-1 formulas and interactive user edits mount KaTeX synchronously with
 * zero flash, while off-screen formulas during progressive tail hydration or large
 * bulk updates mount as lightweight 1-node text previews and upgrade either immediately
 * on approaching the viewport (`rootMargin: '900px 0px'`) or quietly during idle time.
 */

export const SYNC_MATH_BUDGET_PER_BURST = 20;
const IDLE_SLICE_BUDGET_MS = 3.5;
const IDLE_FALLBACK_DELAY_MS = 24;

export interface ScheduleMathOptions {
  dom: HTMLElement;
  renderTarget: HTMLElement;
  latex: string;
  displayMode: boolean;
  mountFn: () => void;
}

interface PendingMathEntry {
  dom: HTMLElement;
  renderTarget: HTMLElement;
  mountFn: () => void;
}

const pendingMap = new Map<HTMLElement, PendingMathEntry>();

let sharedObserver: IntersectionObserver | null = null;
let syncCountInBurst = 0;
let burstResetQueued = false;
let hydrationActive = false;
let hydrationSliceDepth = 0;

type IdleTimerHandle =
  | { kind: 'ric'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

let idleTimerHandle: IdleTimerHandle | null = null;

function ensureSharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') {
    return null;
  }
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            upgradeMathElementNow(entry.target as HTMLElement);
          }
        }
      },
      {
        root: null,
        rootMargin: '900px 0px',
      }
    );
  }
  return sharedObserver;
}

function queueBurstCounterReset(): void {
  if (burstResetQueued) return;
  burstResetQueued = true;
  queueMicrotask(() => {
    burstResetQueued = false;
    syncCountInBurst = 0;
  });
}

function cancelScheduledIdleTrickle(): void {
  if (!idleTimerHandle) return;
  const handle = idleTimerHandle;
  idleTimerHandle = null;
  if (
    handle.kind === 'ric' &&
    typeof window !== 'undefined' &&
    typeof window.cancelIdleCallback === 'function'
  ) {
    window.cancelIdleCallback(handle.id);
  } else if (handle.kind === 'timeout') {
    clearTimeout(handle.id);
  }
}

function runIdleTrickleTurn(): void {
  idleTimerHandle = null;
  if (hydrationActive || pendingMap.size === 0) {
    return;
  }

  const turnStart = performance.now();
  const keysIter = pendingMap.keys();

  while (pendingMap.size > 0) {
    const next = keysIter.next();
    if (next.done) break;
    upgradeMathElementNow(next.value);
    if (performance.now() - turnStart >= IDLE_SLICE_BUDGET_MS) {
      break;
    }
  }

  if (pendingMap.size > 0 && !hydrationActive) {
    scheduleIdleTrickle();
  }
}

function scheduleIdleTrickle(): void {
  if (idleTimerHandle !== null || hydrationActive || pendingMap.size === 0) {
    return;
  }

  if (
    typeof window !== 'undefined' &&
    typeof window.requestIdleCallback === 'function'
  ) {
    const id = window.requestIdleCallback(() => runIdleTrickleTurn(), {
      timeout: 120,
    });
    idleTimerHandle = { kind: 'ric', id };
  } else {
    const id = setTimeout(() => runIdleTrickleTurn(), IDLE_FALLBACK_DELAY_MS);
    idleTimerHandle = { kind: 'timeout', id };
  }
}

export function beginBulkMathMountWindow(): void {
  syncCountInBurst = 0;
}

export function endBulkMathMountWindow(): void {
  queueBurstCounterReset();
  if (!hydrationActive && pendingMap.size > 0) {
    scheduleIdleTrickle();
  }
}

export function beginHydrationSliceMount(): void {
  hydrationSliceDepth++;
}

export function endHydrationSliceMount(): void {
  if (hydrationSliceDepth > 0) {
    hydrationSliceDepth--;
  }
}

export function isHydrationSliceMounting(): boolean {
  return hydrationSliceDepth > 0;
}

export function setHydrationActive(active: boolean): void {
  hydrationActive = active;
  if (active) {
    cancelScheduledIdleTrickle();
  } else if (pendingMap.size > 0) {
    scheduleIdleTrickle();
  }
}

export function isHydrationActive(): boolean {
  return hydrationActive;
}

export function getPendingDeferredMathCount(): number {
  return pendingMap.size;
}

export function scheduleOrMountMath(options: ScheduleMathOptions): void {
  const { dom, renderTarget, latex, displayMode, mountFn } = options;

  // Clean up any prior registration on the same DOM element
  unobserveMathElement(dom);

  // In headless test environments without IntersectionObserver (e.g. default jsdom),
  // always mount synchronously so unit assertions see `.katex` immediately.
  if (typeof IntersectionObserver === 'undefined') {
    renderTarget.classList.remove(
      'lemma-math-deferred',
      'lemma-math-block-deferred'
    );
    mountFn();
    return;
  }

  const inTailSlice = hydrationSliceDepth > 0;
  if (!inTailSlice && syncCountInBurst < SYNC_MATH_BUDGET_PER_BURST) {
    syncCountInBurst++;
    queueBurstCounterReset();
    renderTarget.classList.remove(
      'lemma-math-deferred',
      'lemma-math-block-deferred'
    );
    mountFn();
    return;
  }

  // Defer off-screen / overflow formula to a single lightweight text node
  const trimmed = latex.trim();
  if (displayMode) {
    renderTarget.classList.add('lemma-math-block-deferred');
    renderTarget.textContent = trimmed || '点击输入 LaTeX 数学公式…';
  } else {
    renderTarget.classList.add('lemma-math-deferred');
    renderTarget.textContent = trimmed || '□';
  }

  pendingMap.set(dom, {
    dom,
    renderTarget,
    mountFn,
  });

  const observer = ensureSharedObserver();
  observer?.observe(dom);

  if (!hydrationActive) {
    scheduleIdleTrickle();
  }
}

export function upgradeMathElementNow(dom: HTMLElement): void {
  const entry = pendingMap.get(dom);
  if (!entry) return;
  pendingMap.delete(dom);
  sharedObserver?.unobserve(dom);
  entry.renderTarget.classList.remove(
    'lemma-math-deferred',
    'lemma-math-block-deferred'
  );
  entry.mountFn();
  if (pendingMap.size === 0) {
    cancelScheduledIdleTrickle();
  }
}

export function unobserveMathElement(dom: HTMLElement): void {
  const entry = pendingMap.get(dom);
  if (!entry) return;
  pendingMap.delete(dom);
  sharedObserver?.unobserve(dom);
  if (pendingMap.size === 0) {
    cancelScheduledIdleTrickle();
  }
}

export function resetMathSchedulerForTests(): void {
  cancelScheduledIdleTrickle();
  if (sharedObserver) {
    sharedObserver.disconnect();
    sharedObserver = null;
  }
  pendingMap.clear();
  syncCountInBurst = 0;
  burstResetQueued = false;
  hydrationActive = false;
  hydrationSliceDepth = 0;
}
