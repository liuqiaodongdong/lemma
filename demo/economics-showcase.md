# 信贷约束缓解、跨期消费平滑与总需求传导机制研究

> **摘要（Abstract）**：本文构建了一个包含异质性信贷约束与边际消费倾向（$\text{MPC}_i$）分化的代表性家庭跨期最优化动态模型，从微观层面严密刻画普惠信贷扩张政策对居民当期消费需求及市场一般均衡价格乘数的传导路径。实证部分基于县域准自然实验与多期双重差分（Staggered DID）识别策略，验证了放松流动性约束对中低资产家庭消费增长率的显著促进效应。本文稿同时演示 **Lemma（引理）** 编辑器的原生 $\LaTeX$ 期刊排版、多行对齐数理推导、出版级 SVG 供需均衡图解与 Booktabs 学术三线表。

## 一、代表性家庭跨期最优化

考虑一个无限期界离散时间经济体。代表性家庭在每一期期初持有净金融资产 $A_t$，获得外生劳动收入 $Y_t$，并在当期消费 $C_t$ 与下一期资产储蓄 $A_{t+1}$ 之间进行跨期配置。假设瞬时效用函数服从常相对风险厌恶（CRRA）形式，家庭的目标函数为最大化终身期望贴现效用之和：

$$
\max_{\{C_t, A_{t+1}\}_{t=0}^{\infty}} \mathbb{E}_0 \sum_{t=0}^{\infty} \beta^t \frac{C_t^{1-\sigma} - 1}{1 - \sigma}
$$

其中 $\beta \in (0.95, 0.99)$ 表示季度校准下的主观贴现因子，<span data-comment="这里建议补充校准参数来源文献（如坡度估计或微观家庭调查校准值），并说明对 σ 取值做敏感性检验的结果。" data-id="c-demo-1" data-time="2026-11-15 19:40">$\sigma > 1$ 为常相对风险厌恶系数（其倒数 $\psi \equiv 1/\sigma$ 度量跨期替代弹性</span>，且反映家庭平滑消费波动的意愿强度）。家庭在每一期面临如下序列预算约束：

$$
C_t + A_{t+1} = (1 + r_t) A_t + Y_t, \quad \forall t \ge 0
$$

其中 $r_t$ 为第 $t$ 期实际无风险利率，且终端资产满足无蓬齐博弈条件（No-Ponzi-Game Condition）$\lim_{T \to \infty} \mathbb{E}_t \left[ \prod_{s=1}^{T} (1 + r_{t+s})^{-1} A_{t+T+1} \right] \ge 0$。设 $\beta^t \lambda_t$ 为第 $t$ 期预算约束对应的拉格朗日乘子（即财富的当期影子价格），构造跨期拉格朗日函数 $\mathcal{L}$ 如下：

$$
\mathcal{L} = \mathbb{E}_0 \sum_{t=0}^{\infty} \beta^t \left\{ \frac{C_t^{1-\sigma} - 1}{1 - \sigma} + \lambda_t \Big[ (1 + r_t) A_t + Y_t - C_t - A_{t+1} \Big] \right\}
$$

分别对控制变量 $C_t$ 与状态转移变量 $A_{t+1}$ 求一阶必要条件（First-Order Conditions），并消去影子价格 $\lambda_t$，可得标准消费欧拉方程推导过程：

$$
\begin{aligned}
\frac{\partial \mathcal{L}}{\partial C_t} &= C_t^{-\sigma} - \lambda_t = 0 \\
\frac{\partial \mathcal{L}}{\partial A_{t+1}} &= -\lambda_t + \beta \mathbb{E}_t \left[ \lambda_{t+1} (1 + r_{t+1}) \right] = 0 \\
C_t^{-\sigma} &= \beta \mathbb{E}_t \left[ (1 + r_{t+1}) C_{t+1}^{-\sigma} \right]
\end{aligned}
$$

> [!IMPORTANT]
> **引理 1（欧拉方程最优性条件）**：在完备资本市场且借贷约束不紧（Slack Borrowing Constraint）的内点解条件下，代表性家庭沿最优跨期路径必使当期消费边际效用等于下一期贴现期望边际效用，即 $1 = \mathbb{E}_t \left[ M_{t+1} (1 + r_{t+1}) \right]$，其中随机折现因子定义为 $M_{t+1} \equiv \beta (C_{t+1} / C_t)^{-\sigma}$。当确定性等价近似成立且 $\beta (1 + r) > 1$ 时，最优消费路径呈现平稳正增长 $C_{t+1} / C_t = [\beta (1 + r)]^{1/\sigma}$。

## 二、动态规划与贝尔曼方程

当劳动收入过程 $\{Y_t\}$ 服从一阶马尔可夫过程（First-Order Markov Process）时，上述无限期序列最优化问题可等价转化为递归动态规划形式。记期初状态向量为 $(A_t, Y_t)$，定义最优值函数 $V(A_t, Y_t)$ 满足如下贝尔曼方程（Bellman Equation）：

$$
\begin{aligned}
V(A_t, Y_t) &= \max_{C_t, A_{t+1}} \left\{ \frac{C_t^{1-\sigma} - 1}{1 - \sigma} + \beta \mathbb{E}_t \Big[ V(A_{t+1}, Y_{t+1}) \,\Big|\, Y_t \Big] \right\} \\
\text{s.t.} \quad A_{t+1} &\ge -\underline{B}_t, \quad C_t + A_{t+1} = (1 + r_t) A_t + Y_t
\end{aligned}
$$

将预算约束 $C_t = (1 + r_t) A_t + Y_t - A_{t+1}$ 代入值函数右端，对下一期资产 $A_{t+1}$ 求一阶条件可得 $C_t^{-\sigma} = \beta \mathbb{E}_t [ V_A(A_{t+1}, Y_{t+1}) \mid Y_t ]$。进一步由包络定理（Benveniste-Scheinkman Envelope Theorem）对状态变量 $A_t$ 求偏导，得到 $V_A(A_t, Y_t) = (1 + r_t) C_t^{-\sigma}$。将包络条件前推一期代回一阶条件，即可在递归均衡框架下严格复现跨期消费欧拉方程，从而为数值策略函数迭代（Policy Function Iteration）提供了理论依据。

## 三、市场供需冲击均衡图解

在宏观一般均衡层面，当普惠信贷政策外生缓解家庭部门的借贷约束上限时，<mark data-color="green">受约束家庭的边际消费倾向（MPC）显著释放</mark>，推动总需求曲线由初始位置 $D_0$ 向右上方平移至 $D_1$。给定短期具有正向斜率的总供给曲线 $S_0$，<span data-comment="图形直观清晰！建议在实证部分进一步检验价格指数 P* 是否存在显著粘性，以区分粘性价格与弹性价格下的产出乘数差异。" data-id="c-demo-2" data-time="2026-11-15 19:42">产品市场均衡点由 $E_0(Q_0^*, P_0^*)$ 跃迁至新均衡 $E_1(Q_1^*, P_1^*)$</span>，表现为均衡产出扩张（$Q_1^* > Q_0^*$）与温和价格回升（$P_1^* > P_0^*$）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 430" width="660" height="430" role="img" aria-label="市场供需冲击比较静态均衡图">
  <defs>
    <marker id="axis-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#141414" />
    </marker>
    <marker id="shift-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 1.8 L 8 5 L 0 8.2 z" fill="#7a1c1c" />
    </marker>
  </defs>

  <!-- Crisp Academic Paper Plate -->
  <rect x="0" y="0" width="660" height="430" fill="#ffffff" rx="2" />

  <!-- Comparative Statics Welfare / Price-Quantity Increment Wash -->
  <rect x="95" y="197" width="260" height="48" fill="#0b3d91" fill-opacity="0.045" />
  <rect x="275" y="197" width="80" height="158" fill="#7a1c1c" fill-opacity="0.045" />

  <!-- Dashed Equilibrium Projection Lines: E0(275, 245) & E1(355, 197) -->
  <g stroke="#64748b" stroke-width="1.25" stroke-dasharray="5,4" fill="none">
    <line x1="95" y1="245" x2="275" y2="245" />
    <line x1="275" y1="245" x2="275" y2="355" />
    <line x1="95" y1="197" x2="355" y2="197" />
    <line x1="355" y1="197" x2="355" y2="355" />
  </g>

  <!-- Coordinate Axes -->
  <g stroke="#141414" stroke-width="1.65" fill="none">
    <line x1="95" y1="355" x2="95" y2="42" marker-end="url(#axis-arrow)" />
    <line x1="95" y1="355" x2="592" y2="355" marker-end="url(#axis-arrow)" />
  </g>

  <!-- Supply Curve S0: y = 245 - 0.6*(x - 275) -->
  <line x1="135" y1="329" x2="505" y2="107" stroke="#1e293b" stroke-width="2.2" stroke-linecap="round" />

  <!-- Long-Run Elastic Supply Curve S1 (Capacity Expansion): y = 221 - 0.35*(x - 395) -->
  <line x1="165" y1="301" x2="545" y2="168" stroke="#1b6535" stroke-width="2.1" stroke-dasharray="6,4" stroke-linecap="round" />

  <!-- Initial Demand Curve D0: y = 245 + 0.6*(x - 275) -->
  <line x1="135" y1="161" x2="435" y2="341" stroke="#0b3d91" stroke-width="2.2" stroke-linecap="round" />

  <!-- Shifted Demand Curve D1: y = 197 + 0.6*(x - 355) -->
  <line x1="195" y1="101" x2="535" y2="305" stroke="#7a1c1c" stroke-width="2.3" stroke-linecap="round" />

  <!-- Demand Shift Indicator Arrow (D0 -> D1) -->
  <line x1="348" y1="281" x2="478" y2="281" stroke="#7a1c1c" stroke-width="1.5" stroke-dasharray="3,2" marker-end="url(#shift-arrow)" />

  <!-- Equilibrium Points E0, E1 & Long-Run E2 -->
  <circle cx="275" cy="245" r="4.8" fill="#0b3d91" stroke="#ffffff" stroke-width="1.8" />
  <circle cx="355" cy="197" r="5.2" fill="#7a1c1c" stroke="#ffffff" stroke-width="1.8" />
  <circle cx="395" cy="221" r="5.0" fill="#1b6535" stroke="#ffffff" stroke-width="1.8" />

  <!-- Typography Labels (Latin Modern Roman + Chinese Serif) -->
  <g font-family="Latin Modern Roman, Times New Roman, Noto Serif SC, Songti SC, serif" fill="#141414" font-size="15">
    <!-- Axis Titles -->
    <text x="82" y="34" text-anchor="end" font-style="italic" font-weight="700">P</text>
    <text x="106" y="34" font-size="13" fill="#475569">（价格水平）</text>
    <text x="598" y="360" font-style="italic" font-weight="700">Q</text>
    <text x="588" y="382" text-anchor="end" font-size="13" fill="#475569">（均衡产出 / 消费量）</text>
    <text x="80" y="372" font-style="italic">O</text>

    <!-- Price Ticks on Vertical Axis -->
    <text x="84" y="250" text-anchor="end" font-style="italic" fill="#0b3d91">
      P<tspan dy="4" font-size="11" font-style="normal">0</tspan><tspan dy="-9" font-size="11" font-style="normal">*</tspan>
    </text>
    <text x="84" y="202" text-anchor="end" font-style="italic" fill="#7a1c1c" font-weight="700">
      P<tspan dy="4" font-size="11" font-style="normal">1</tspan><tspan dy="-9" font-size="11" font-style="normal">*</tspan>
    </text>

    <!-- Quantity Ticks on Horizontal Axis -->
    <text x="275" y="376" text-anchor="middle" font-style="italic" fill="#0b3d91">
      Q<tspan dy="4" font-size="11" font-style="normal">0</tspan><tspan dy="-9" font-size="11" font-style="normal">*</tspan>
    </text>
    <text x="355" y="376" text-anchor="middle" font-style="italic" fill="#7a1c1c" font-weight="700">
      Q<tspan dy="4" font-size="11" font-style="normal">1</tspan><tspan dy="-9" font-size="11" font-style="normal">*</tspan>
    </text>

    <!-- Curve Labels -->
    <text x="514" y="106" font-style="italic" font-weight="700" fill="#1e293b">
      S<tspan dy="4" font-size="11" font-style="normal">0</tspan>
    </text>
    <text x="553" y="170" font-style="italic" font-weight="700" fill="#1b6535">
      S<tspan dy="4" font-size="11" font-style="normal">1</tspan><tspan dy="-4" font-size="11" font-style="normal">（长期产能响应）</tspan>
    </text>
    <text x="443" y="344" font-style="italic" font-weight="700" fill="#0b3d91">
      D<tspan dy="4" font-size="11" font-style="normal">0</tspan>
    </text>
    <text x="543" y="309" font-style="italic" font-weight="700" fill="#7a1c1c">
      D<tspan dy="4" font-size="11" font-style="normal">1</tspan>
    </text>

    <!-- Equilibrium Point Annotations -->
    <text x="262" y="233" text-anchor="end" font-size="13.5" fill="#0b3d91" font-weight="700">
      E<tspan dy="3" font-size="10.5">0</tspan><tspan dy="-3">(Q</tspan><tspan dy="3" font-size="10.5">0</tspan><tspan dy="-6" font-size="10.5">*</tspan><tspan dy="3">, P</tspan><tspan dy="3" font-size="10.5">0</tspan><tspan dy="-6" font-size="10.5">*</tspan><tspan dy="3">)</tspan>
    </text>
    <text x="366" y="187" text-anchor="start" font-size="13.5" fill="#7a1c1c" font-weight="700">
      E<tspan dy="3" font-size="10.5">1</tspan><tspan dy="-3">(Q</tspan><tspan dy="3" font-size="10.5">1</tspan><tspan dy="-6" font-size="10.5">*</tspan><tspan dy="3">, P</tspan><tspan dy="3" font-size="10.5">1</tspan><tspan dy="-6" font-size="10.5">*</tspan><tspan dy="3">)</tspan>
    </text>
    <text x="406" y="226" text-anchor="start" font-size="13.5" fill="#1b6535" font-weight="700">
      E<tspan dy="3" font-size="10.5">2</tspan><tspan dy="-3">（长期均衡）</tspan>
    </text>

    <!-- Shift Caption -->
    <text x="413" y="272" text-anchor="middle" font-size="12" fill="#7a1c1c">
      信贷约束缓解冲击
    </text>
    <text x="330" y="414" text-anchor="middle" font-size="12.5" fill="#555555">
      图 1：正需求冲击（D₀ → D₁）下的产品市场一般均衡比较静态分析
    </text>
  </g>
</svg>
```

## 四、双重差分（DID）基准回归结果

为检验上述理论引理的微观经验含义，本文利用普惠金融信贷扩容试点构造准自然实验，采用双向固定效应双重差分模型（Two-Way Fixed Effects DID）估计政策冲击对居民实际消费支出的因果效应：

$$
\ln C_{it} = \alpha + \delta \left( \text{Treat}_i \times \text{Post}_t \right) + \boldsymbol{\gamma}' \mathbf{X}_{it} + \mu_i + \tau_t + \varepsilon_{it}
$$

其中 $\ln C_{it}$ 为家庭 $i$ 在第 $t$ 年的实际非耐用品消费对数，$\text{Treat}_i \times \text{Post}_t$ 为核心政策处理交互项，$\mu_i$ 与 $\tau_t$ 分别代表家庭个体固定效应与年份固定效应，$\varepsilon_{it}$ 为聚类在县区层面的随机扰动项。

> [!NOTE]
> **平行趋势识别假设**：双重差分估计量 $\hat{\delta}$ 获得无偏平均处理效应（ATT）的核心识别前提是满足平行趋势假设（Parallel Trends Assumption），即在不存在信贷扩容政策冲击的反事实状态下，试点地区家庭（$\text{Treat}_i = 1$）与非试点地区家庭（$\text{Treat}_i = 0$）的对数消费变动趋势不存在系统性差异：$\mathbb{E}[\Delta \ln C_{it}(0) \mid \text{Treat}_i = 1] = \mathbb{E}[\Delta \ln C_{it}(0) \mid \text{Treat}_i = 0]$。事件研究法（Event Study）事前动态系数均围绕零值波动且在 10% 水平上不显著，支持该识别假设成立。

表 1 汇报了基准双重差分模型的逐步回归结果。第 `(1)` 列仅控制家庭与年份双向固定效应；第 `(2)` 列引入家庭可支配收入与人口结构特征；第 `(3)` 列进一步纳入流动性资产占比及省份—年份交互固定效应以吸收区域宏观冲击：

| 变量名称 | (1) | (2) | (3) |
| :--- | :---: | :---: | :---: |
| 政策交互项 $\text{Treat}_i \times \text{Post}_t$ | 0.086*** | 0.074*** | 0.072*** |
|  | (0.016) | (0.014) | (0.013) |
| 家庭可支配收入对数 $\ln Y_{it}$ | — | 0.412*** | 0.398*** |
|  |  | (0.028) | (0.026) |
| 金融流动性资产占比 $\text{Liq}_{it}$ | — | — | 0.168*** |
|  |  |  | (0.047) |
| 家庭特征控制变量 | 未控制 | 控制 | 控制 |
| 家庭个体固定效应 | 控制 | 控制 | 控制 |
| 年份固定效应 | 控制 | 控制 | 控制 |
| 省份×年份交互固定效应 | 未控制 | 未控制 | 控制 |
| 样本观测值 $N$ | 18,640 | 18,640 | 18,452 |
| 调整后 $R^2$ | 0.584 | 0.672 | 0.731 |

*注：括号内汇报县区层面聚类稳健标准误（Clustered Standard Errors）；\*\*\*、\*\*、\* 分别表示在 1%、5%、10% 水平上统计显著。*

> [!TIP]
> **稳健性检验补充（安慰剂与工具变量估计）**：为排除试点地区非观测信贷需求冲击的潜在内生性偏误，进一步以各县域至中心城市历史邮政驿站球面距离与全国普惠信贷增长率的交互项构造工具变量（Shift-Share IV），两阶段最小二乘（2SLS）估计系数为 $\hat{\delta}_{\text{IV}} = 0.079^{***}$（标准误 $0.019$），第一阶段 Kleibergen-Paap $F = 34.6 > 10$，证实核心结论稳健可靠。