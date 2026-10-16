/**
 * 活动页的版式样式表。
 *
 * ┌─ 为什么这一页用 class + <style>，而不是像其余页面那样内联 ──────────┐
 * │ 设计师这版的版面是**响应式**的：怎么参加四列、奖项三列领奖台、      │
 * │ 评选与日程两列，到 900 / 820 / 720px 逐级塌成一列。断点只能写在     │
 * │ 样式表里——内联 style 表达不了媒体查询。                            │
 * │                                                                    │
 * │ 所以这一页按设计稿自己的做法来：`ev-` 前缀的类名 + 一份样式表。     │
 * │ 其余页面（评委打分、大屏）仍是内联，它们没有断点。                  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 类名与数值照搬设计稿的 `ev-*`，改动只在于把写死的颜色换成平台 token。
 */
export function EventLayoutStyles() {
  return (
    <style>{`
/* ── 头图 ───────────────────────────────────────────────────────── */
/*
  左边文案、右边「当前阶段」卡，到 980px 以下换行成上下两段。
  字号也跟着断点走：设计稿的 46px 标题是照电脑屏画的，手机上放不下。
*/
.ev-hero-inner { position: relative; max-width: 1120px; margin: 0 auto; padding: 0 40px; }
.ev-hero-top { height: 64px; display: flex; align-items: center; gap: 12px; }
.ev-hero-main {
  display: flex; align-items: flex-end; gap: 40px; flex-wrap: wrap; padding: 36px 0 32px;
}
.ev-hero-copy { flex: 1 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.ev-hero-stage { flex: 0 1 340px; min-width: 280px; }
/*
  点阵与「程序员节」永远并排——设计稿两种屏宽下都是这个样子。
  nowrap 是关键：允许换行的话，点阵 365px + 标题列的 max-content 超过内容列
  宽度就会把标题甩到下一行。不换行时两者各自收缩到 min-content
  （公式那行自己折到方块下面），加起来放得下。
*/
.ev-hero-title-row { display: flex; align-items: flex-end; gap: 20px; flex-wrap: nowrap; }
.ev-hero-title-col { display: flex; flex-direction: column; padding-bottom: 2px; }
.ev-hero-cta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 6px; }
.ev-hero-title { font-size: 46px; font-weight: 800; line-height: 1; color: var(--text-heading); }
.ev-hero-sub { font-size: 22px; font-weight: 700; line-height: 1.4; color: var(--text-heading); }
.ev-hero-intro {
  max-width: 540px; font-size: 14px; line-height: 1.7; color: var(--text-heading);
}
.ev-hero-meta {
  display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
  font-size: 13px; font-weight: 600; color: var(--text-heading);
}
.ev-hero-steps {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px; padding-bottom: 32px;
}
.ev-hero-step { border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
.ev-hero-mark { position: absolute; right: -70px; bottom: -130px; font-size: 460px; }

@media (max-width: 980px) {
  .ev-hero-stage { flex: 1 1 100%; }
}
@media (max-width: 720px) {
  .ev-hero-inner { padding: 0 16px; }
  .ev-hero-top { height: 52px; }
  .ev-hero-main { gap: 20px; padding: 18px 0 20px; }
  .ev-hero-copy { gap: 12px; flex-basis: 100%; }
  .ev-hero-stage { min-width: 0; }
  .ev-hero-title-row { gap: 12px; }
  .ev-hero-cta { padding-top: 2px; }
  .ev-hero-title { font-size: 26px; }
  .ev-hero-sub { font-size: 18px; }
  .ev-hero-intro { font-size: 13px; line-height: 1.65; }
  .ev-hero-meta { gap: 14px; font-size: 12px; }
  .ev-hero-steps { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding-bottom: 18px; }
  .ev-hero-step { padding: 8px; gap: 2px; }
  .ev-hero-mark { right: -46px; bottom: auto; top: 150px; font-size: 230px; }
}

/* ── 内容列 ─────────────────────────────────────────────────────── */
.ev-page {
  max-width: 1120px; margin: 0 auto; padding: 44px 40px 56px;
  display: flex; flex-direction: column; gap: 52px;
}

/* ── 小节标题：居中，中文标题 + 英文副标题 ─────────────────────── */
.ev-section-block { display: flex; flex-direction: column; gap: 18px; }
.ev-section-block > .ev-section-head { margin-bottom: 12px; }
/* 作品/获奖那一节标题底下紧跟一行说明，间距挪到说明下面 */
.ev-section-block--works > .ev-section-head { margin-bottom: 0; }
.ev-section-block--works > .ev-section-caption { margin-bottom: 12px; }
.ev-section-head {
  position: relative; display: flex; align-items: center; justify-content: center;
  min-height: 64px; text-align: center;
}
.ev-section-heading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; padding: 0 4px;
}
.ev-section-primary { display: flex; align-items: baseline; justify-content: center; gap: 10px; }
.ev-section-number, .ev-section-title {
  color: var(--text-heading); font-size: 24px; font-weight: 700; line-height: 1.25;
}
.ev-section-number { flex: none; font-family: var(--font-mono); }
.ev-section-title { font-family: var(--font-sans); }
.ev-section-en {
  color: var(--tabby-orange); font-family: var(--font-mono); font-size: 11px;
  font-weight: 400; line-height: 1.5; letter-spacing: .12em; text-transform: uppercase;
}
.ev-section-note {
  max-width: 100%; color: var(--text-secondary); font-size: 12px;
  line-height: 1.6; text-align: center;
}
.ev-section-side {
  position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center; justify-content: flex-end; gap: 10px;
  max-width: 34%; padding-left: 16px;
  background: var(--surface-canvas); color: var(--text-secondary); font-size: 12px;
}
.ev-section-caption {
  display: block; margin-top: -8px; text-align: center;
  color: var(--text-tertiary); font-size: 12px; line-height: 1.6;
}

/* ── 作品卡 / 获奖卡：按可用宽度自动排列 ───────────────────────── */
.ev-card-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px;
}

/* ── 怎么参加：四格，每格一枚大水印图标 ────────────────────────── */
.ev-how-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.ev-how-card {
  position: relative; overflow: hidden; min-height: 146px;
  background: var(--tabby-orange-subtle); border: 1px solid rgba(251,146,60,.35);
  border-radius: var(--radius-16); padding: var(--space-10);
}
.ev-how-content { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 12px; }
.ev-how-icon {
  width: 36px; height: 36px; border-radius: 10px; color: var(--text-heading);
  display: flex; align-items: center; justify-content: center;
}
.ev-how-watermark {
  position: absolute; right: -30px; bottom: -38px;
  color: var(--tabby-orange); opacity: .14; pointer-events: none;
}

/* ── 奖项：三座领奖台，二在左、一居中更高、三在右 ──────────────── */
.ev-prize-showcase { display: flex; flex-direction: column; gap: 14px; }
.ev-main-prizes {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: end; gap: 18px; padding-top: 0;
}
.ev-main-prize {
  position: relative; isolation: isolate; min-height: 260px; overflow: hidden;
  border: 1px solid var(--tabby-orange-hover); border-radius: var(--radius-16); padding: 22px;
  background-color: var(--tabby-orange);
  background-image: radial-gradient(var(--tabby-orange-hover) 1.2px, transparent 1.2px);
  background-size: 22px 22px;
  color: var(--text-heading); display: flex; flex-direction: column;
}
/* order 只在塌成一列后起作用：那时一等奖要排最前 */
.ev-main-prize-rank-1 { grid-column: 2; grid-row: 1; min-height: 306px; order: 1; }
.ev-main-prize-rank-2 { grid-column: 1; grid-row: 1; order: 2; }
.ev-main-prize-rank-3 { grid-column: 3; grid-row: 1; order: 3; }
/* 给右上角那枚奖牌让出位置，文字不压上去 */
.ev-main-prize-meta {
  position: relative; z-index: 2; max-width: calc(100% - 138px);
  display: flex; align-items: center;
}
.ev-main-prize-icon {
  width: 42px; height: 42px; flex: none; border: 0;
  display: flex; align-items: center; justify-content: flex-start;
}
.ev-main-prize-name {
  position: relative; z-index: 2; max-width: calc(100% - 138px);
  margin-top: 12px; font-size: 20px; font-weight: 800; line-height: 1.3;
}
.ev-main-prize-value {
  position: relative; z-index: 2; margin-top: auto; margin-bottom: 20px; padding-top: 30px;
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
}
.ev-main-prize-label { font-size: 12px; color: rgba(0,18,23,.66); }
.ev-main-prize-money {
  font-family: var(--font-mono); font-size: 36px; font-weight: 800;
  line-height: 1.15; letter-spacing: -.03em;
}
.ev-main-prize-how { font-size: 12px; line-height: 1.5; color: rgba(0,18,23,.72); }
.ev-prize-medal {
  position: absolute; z-index: 2; top: -18px; right: 20px; width: 112px; height: auto;
  display: block; pointer-events: none; user-select: none;
}
.ev-main-prize-rank-1 .ev-prize-medal { top: -20px; right: 20px; width: 128px; }
.ev-prize-rank-deco {
  position: absolute; z-index: 0; right: -14px; bottom: -36px;
  color: var(--tabby-orange-hover); opacity: .26;
  font-family: var(--font-mono); font-size: 176px; font-weight: 800; line-height: 1;
  letter-spacing: -.04em; white-space: nowrap; pointer-events: none; user-select: none;
}
.ev-main-prize-rank-1 .ev-prize-rank-deco { font-size: 196px; }

/* ── 人气奖与入围奖：两格小卡 ──────────────────────────────────── */
.ev-mini-prizes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.ev-mini-prize {
  min-height: 94px; border: 1px solid rgba(251,146,60,.35); border-radius: 14px;
  padding: 16px 18px; background: var(--tabby-orange-subtle);
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px;
  color: var(--text-heading);
}
.ev-mini-prize-icon {
  width: 48px; height: 48px; border-radius: 12px; background: var(--tabby-orange);
  color: var(--text-heading); display: flex; align-items: center; justify-content: center;
}
.ev-mini-prize-copy { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.ev-mini-prize-name { font-size: 15px; font-weight: 700; line-height: 1.35; }
.ev-mini-prize-how { color: var(--text-secondary); font-size: 14px; line-height: 1.5; }
.ev-mini-prize-value { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; text-align: right; }
.ev-mini-prize-money {
  font-family: var(--font-mono); font-size: 24px; font-weight: 700;
  line-height: 1.2; letter-spacing: -.02em; white-space: nowrap;
}
.ev-mini-prize-count { color: var(--text-tertiary); font-size: 11px; white-space: nowrap; }

/* ── 参赛规则 ───────────────────────────────────────────────────── */
.ev-panel-card {
  background: var(--surface-1); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-16);
}
.ev-panel-title {
  color: var(--text-heading); font-size: 16px; font-weight: 600; line-height: 1.4; text-align: center;
}
.ev-rules-title { padding: 22px 24px 20px; }
.ev-rules-list { display: flex; flex-direction: column; gap: 22px; padding: 0 48px 26px; }
.ev-rule-row { display: flex; align-items: flex-start; gap: 10px; min-height: 0; }
.ev-rule-index {
  width: 40px; flex: none; color: var(--text-heading); font-family: var(--font-mono);
  font-size: 24px; font-weight: 700; line-height: 1.15; letter-spacing: .08em;
}
/*
  稿上是 #606266，平台没有完全等值的 token；--text-secondary(#545659) 最接近，
  肉眼分不出，按仓库惯例用 token 而不是写死色值。
*/
.ev-rule-text { flex: 1; min-width: 0; color: var(--text-secondary); font-size: 14px; line-height: 1.7; }

/* ── 评委 + 初筛/打分两栏 ──────────────────────────────────────── */
.ev-judge-panel {
  padding: 24px 22px 28px; display: flex; flex-direction: column; gap: 24px;
  border-bottom: 1px solid var(--border-subtle);
}
.ev-judge-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 18px; }
.ev-judge-cell { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.ev-criteria-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
/* 没有初筛那一栏时收成一列，否则右半边空着 */
.ev-criteria-grid--single { grid-template-columns: minmax(0, 1fr); }
.ev-criteria-grid--single .ev-criteria-panel-score { border-left: 0; }
.ev-criteria-panel { padding: 24px 22px 28px; display: flex; flex-direction: column; gap: 18px; }
.ev-criteria-panel > .ev-panel-title { margin-bottom: 15px; text-align: left; }
/* 说明钉在底部，两栏不等高时底线仍然齐平 */
.ev-criteria-panel > .ev-criteria-note { margin-top: auto; }
.ev-criteria-panel-score > .ev-criteria-note { padding-top: 15px; }
.ev-criteria-panel-score { border-left: 1px solid var(--border-subtle); }
.ev-screen-row { display: flex; align-items: baseline; gap: 14px; }
.ev-screen-key {
  width: 60px; flex: none; color: var(--text-heading);
  font-size: 14px; font-weight: 600; line-height: 1.6;
}
.ev-screen-desc { flex: 1; min-width: 0; color: var(--text-secondary); font-size: 14px; line-height: 1.6; }
.ev-score-row { display: flex; align-items: center; gap: 14px; }
.ev-score-label {
  width: 72px; flex: none; color: var(--text-heading);
  font-size: 14px; font-weight: 600; line-height: 1.6;
}
.ev-score-desc { flex: 0 1 auto; min-width: 0; color: var(--text-secondary); font-size: 14px; line-height: 1.6; }
/* 说明与分值之间那根引导虚线 */
.ev-score-leader { flex: 1 1 28px; min-width: 20px; border-top: 1px dashed var(--border-hover); }
.ev-score-weight {
  flex: none; color: var(--text-heading); font-family: var(--font-mono);
  font-size: 14px; font-weight: 600;
}
.ev-criteria-note { color: var(--text-tertiary); font-size: 14px; line-height: 1.7; }

/* ── 日程：两栏 ─────────────────────────────────────────────────── */
.ev-schedule-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; gap: 28px; }
.ev-schedule-column {
  --ev-schedule-pad-left: 37px; --ev-schedule-pad-right: 57px;
  --ev-schedule-time-width: 52px; --ev-schedule-time-center: 26px;
  --ev-schedule-icon-size: 42px; --ev-schedule-gap: 16px;
  min-width: 0;
}
.ev-schedule-column + .ev-schedule-column { border-left: 0; }
.ev-schedule-header {
  min-height: 58px;
  padding: 16px var(--ev-schedule-pad-right) 14px var(--ev-schedule-pad-left);
  display: grid; grid-template-columns: var(--ev-schedule-time-width) minmax(0, 1fr);
  align-items: flex-start; column-gap: var(--ev-schedule-gap);
}
.ev-schedule-title { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.ev-schedule-code {
  width: 44px; min-width: 44px; height: 44px; justify-self: center;
  border-radius: 6px; padding: 0; background: var(--tabby-orange); color: var(--text-heading);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-mono); font-size: 16px; font-weight: 700; line-height: 1; text-align: center;
}
.ev-schedule-name { color: var(--text-heading); font-size: 16px; font-weight: 800; line-height: 1.4; }
.ev-schedule-time { color: var(--text-secondary); font-family: var(--font-mono); font-size: 12px; line-height: 1.5; text-align: left; }
.ev-schedule-item {
  position: relative; display: grid;
  grid-template-columns: var(--ev-schedule-time-width) var(--ev-schedule-icon-size) minmax(0, 1fr);
  align-items: start; column-gap: var(--ev-schedule-gap);
  padding: 14px var(--ev-schedule-pad-right) 14px var(--ev-schedule-pad-left);
}
/* 把每一项串起来的那根虚线，最后一项不画 */
.ev-schedule-item:not(:last-child)::after {
  content: ""; position: absolute; top: 42px; bottom: -8px;
  left: calc(var(--ev-schedule-pad-left) + var(--ev-schedule-time-center));
  border-left: 1px dashed var(--border-hover); opacity: .72; pointer-events: none;
}
.ev-schedule-item-time {
  position: relative; z-index: 1; width: var(--ev-schedule-time-width);
  color: var(--text-heading); font-family: var(--font-mono);
  font-size: 16px; font-weight: 700; line-height: 22px; text-align: center;
}
.ev-schedule-item-icon {
  position: relative; z-index: 1;
  width: var(--ev-schedule-icon-size); height: var(--ev-schedule-icon-size);
  flex: none; border-radius: 10px; display: flex; align-items: center; justify-content: center;
}
.ev-schedule-item-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ev-schedule-item-title { color: var(--text-heading); font-size: 14px; font-weight: 600; line-height: 20px; }
.ev-schedule-item-desc { color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.ev-schedule-column > .ev-schedule-item:last-child { padding-bottom: 28px; }

/* 两栏并排时错开各自的起始高度；塌成一列后不再错开 */
@media (min-width: 901px) {
  .ev-schedule-grid > .ev-schedule-column:first-child > .ev-schedule-header { padding-top: 37px; }
  .ev-schedule-grid > .ev-schedule-column:nth-child(2) > .ev-schedule-header { padding-top: 31px; }
}

/* ── 断点：逐级塌成一列 ─────────────────────────────────────────── */
@media (max-width: 900px) {
  .ev-how-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ev-main-prizes { gap: 12px; }
  .ev-main-prize { padding: 18px; }
  .ev-main-prize-money { font-size: 30px; }
  .ev-section-side { max-width: 30%; }
  .ev-schedule-column {
    --ev-schedule-pad-left: 16px; --ev-schedule-pad-right: 16px;
    --ev-schedule-time-width: 48px; --ev-schedule-time-center: 24px;
    --ev-schedule-icon-size: 38px; --ev-schedule-gap: 12px;
  }
  .ev-schedule-code { width: 36px; min-width: 36px; height: 36px; font-size: 15px; }
}
@media (max-width: 820px) {
  .ev-criteria-grid { grid-template-columns: minmax(0, 1fr); }
  /* :not(--single) ——只有一栏时它本来就没有左边框，再补条上边框是凭空多一条线 */
  .ev-criteria-grid:not(.ev-criteria-grid--single) .ev-criteria-panel-score {
    border-left: 0; border-top: 1px solid var(--border-subtle);
  }
}
@media (max-width: 720px) {
  /*
    容器的左右留白设计稿没有给断点——它是照着电脑屏画的，40px 到手机上
    两边各吃掉 40，375 的屏只剩 295 可用。这一页会被转发到群里，多数人
    是在手机上点开的，所以窄屏收到 16px。
  */
  .ev-page { padding: 32px 16px 40px; gap: 40px; }
  .ev-hero-inner { padding: 0 16px; }
  .ev-hero-top { height: 52px; }
  .ev-hero-main { gap: 20px; padding: 18px 0 20px; }
  .ev-hero-copy { gap: 12px; flex-basis: 100%; }
  .ev-hero-stage { min-width: 0; }
  .ev-hero-title-row { gap: 12px; }
  .ev-hero-cta { padding-top: 2px; }
  .ev-hero-title { font-size: 26px; }
  .ev-hero-sub { font-size: 18px; }
  .ev-hero-intro { font-size: 13px; line-height: 1.65; }
  .ev-hero-meta { gap: 14px; font-size: 12px; }
  .ev-hero-steps { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding-bottom: 18px; }
  .ev-hero-step { padding: 8px; gap: 2px; }
  .ev-hero-mark { right: -46px; bottom: auto; top: 150px; font-size: 230px; }
  .ev-section-head { flex-direction: column; gap: 12px; }
  .ev-section-side {
    position: static; max-width: none; padding-left: 0;
    transform: none; background: transparent;
  }
  .ev-how-grid, .ev-main-prizes, .ev-mini-prizes, .ev-criteria-grid, .ev-schedule-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .ev-main-prize,
  .ev-main-prize-rank-1, .ev-main-prize-rank-2, .ev-main-prize-rank-3 {
    grid-column: 1; grid-row: auto; min-height: 238px;
  }
  .ev-rules-list { padding: 0 20px 24px; }
  .ev-criteria-panel { padding: 22px 18px 26px; }
  .ev-score-row { gap: 10px; }
  .ev-score-leader { min-width: 12px; }
  .ev-schedule-column + .ev-schedule-column { border: 0; }
}

/* ── 提交弹层 ───────────────────────────────────────────────────── */
/*
  同一个组件两种形态，断点沿用这一页其余部分的 720px：

  电脑上居中。鼠标和视线都在窗口中间，把表单贴到屏幕底边等于让人把注意力
  甩到角落去，而且 27 寸屏上那段距离很远。
  手机上仍然从底部升起——表单要贴着拇指，这是原来那版的本意，不改。

  为什么写在这儿而不是内联 style：内联优先级高于媒体查询，写在组件里就
  没法按宽度切换。所以凡是两档不同的属性（对齐、圆角、最大高度、入场动画）
  都挪到这里，组件只留两档共用的那些。
*/
.ev-sheet-backdrop {
  position: fixed; inset: 0; z-index: 60; box-sizing: border-box;
  background: rgba(0, 18, 23, .42);
  display: flex; justify-content: center;
  align-items: center; padding: 24px;
}
.ev-sheet-panel {
  border-radius: 18px;
  /* 居中时四角都是圆的，底部那条带上边框的按钮栏会探出圆角，裁掉 */
  overflow: hidden;
  /* 86vh + 上下各 24px 的留白，在高于 343px 的窗口里都不会超出一屏 */
  max-height: 86vh;
  animation: evSheetIn .22s cubic-bezier(.16, 1, .3, 1) both;
}
@keyframes evSheetIn { from { transform: scale(.97); opacity: 0 } to { transform: none; opacity: 1 } }

@media (max-width: 720px) {
  .ev-sheet-backdrop { align-items: flex-end; padding: 0; }
  .ev-sheet-panel {
    /* 贴着屏幕底边，所以只有上面两个角是圆的 */
    border-radius: 18px 18px 0 0;
    max-height: 92vh;
    animation: evSheetUp .28s cubic-bezier(.16, 1, .3, 1) both;
  }
}
@keyframes evSheetUp { from { transform: translateY(16px); opacity: .6 } to { transform: none; opacity: 1 } }
`}</style>
  );
}
