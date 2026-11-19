import React from 'react';
import { BookOpenCheck, FilePlus2, FileUp } from 'lucide-react';

export interface WelcomeScreenProps {
  onOpenFile: () => void;
  onNewFile: () => void;
  onLoadDemo: () => void;
}

export function WelcomeScreen({
  onOpenFile,
  onNewFile,
  onLoadDemo,
}: WelcomeScreenProps): React.ReactElement {
  return (
    <div className="lemma-welcome-wrap">
      <section className="lemma-welcome-card" aria-labelledby="lemma-welcome-heading">
        <div className="lemma-welcome-kicker">
          AI-AGENT NATIVE ACADEMIC EDITOR
        </div>
        <h1 id="lemma-welcome-heading" className="lemma-welcome-title">
          Lemma（引理）
        </h1>
        <div className="lemma-welcome-rule" aria-hidden="true" />
        <p className="lemma-welcome-subtitle">
          专为经济学与数理科学打造的所见即所得 Markdown 学术排版环境。原生搭载 TeX Live{' '}
          <strong>Latin Modern</strong> 字族、<code>ctexart</code> 中文首行缩进规范、
          Booktabs 学术三线表与外部 Agent 修改实时 Diff 审阅。
        </p>

        <div className="lemma-welcome-actions">
          <button
            type="button"
            className="lemma-welcome-btn is-featured"
            onClick={onLoadDemo}
          >
            <BookOpenCheck size={18} strokeWidth={1.9} />
            <span>打开经济学示例文稿</span>
          </button>

          <button
            type="button"
            className="lemma-welcome-btn"
            onClick={onNewFile}
          >
            <FilePlus2 size={16} strokeWidth={1.85} />
            <span>新建空白文稿</span>
          </button>

          <button
            type="button"
            className="lemma-welcome-btn"
            onClick={onOpenFile}
          >
            <FileUp size={16} strokeWidth={1.85} />
            <span>打开本地文件…</span>
          </button>
        </div>

        <div className="lemma-welcome-features">
          <div className="lemma-welcome-feature-item">
            <h4>纯正 LaTeX 期刊质感</h4>
            <p>A4 纸张卡片、2 字符智能缩进、定理标注框与 Booktabs 三线表即写即现。</p>
          </div>
          <div className="lemma-welcome-feature-item">
            <h4>数理公式与矢量图表</h4>
            <p>支持行内与多行对齐 KaTeX 公式编辑，以及出版级原生 SVG 供需均衡图解。</p>
          </div>
          <div className="lemma-welcome-feature-item">
            <h4>Agent 协同逐处审阅</h4>
            <p>外部 AI 改稿自动触发增删高亮与公式前后对照卡片，支持逐处接受或回退。</p>
          </div>
        </div>
      </section>
    </div>
  );
}

export default WelcomeScreen;
