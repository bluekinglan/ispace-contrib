import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, PageTitle, Select, StatCard, Toast, fmtBytes, fmtDate, useConfirm,
} from '@ispace/ui';
import {
  CURRENT_EVENT_SLUG, EVENT_PHASES, derivePhase, phaseAtLeast,
  type EventAdminIdea, type EventAdminInput, type EventConfig, type EventPhase,
  type EventRankRow, type EventResponse,
} from '@ispace/contracts';
import { api, type AdminUser } from '../api';
import { finalistNo, moveAt, savedFinalistOrder } from '../event-admin';

/**
 * 1024 赛事管理。
 *
 * 这一屏替代的是 `docs/runbooks/event-1024.md` 里那些 curl 和手写 SQL：
 * 设评委、定入围名单、推进阶段、颁奖前核对名次。组织者是办活动的人，
 * 不该为了排八个作品的路演顺序去库里抄 uuid。
 *
 * 几块的分量不一样，排版也照这个分量来：**创意列表加定入围名单是这屏的主角**
 * （10.19 下午八个评委围着一块屏，读完全部创意当场排序提交），阶段与评委是
 * 活动前后各用一次的开关，排名是颁奖前看一眼的核对表。
 */

const PHASE_LABEL: Record<EventPhase, string> = {
  signup: '报名中',
  screening: '评委初筛',
  building: '入围制作',
  demo: '展示答辩',
  result: '结果公布',
  ended: '已结束',
};

const PHASE_DESC: Record<EventPhase, string> = {
  signup: '活动页显示怎么参加，底部可以交创意',
  screening: '创意已截止，等入围名单——创意此时只有评委和作者看得到',
  building: '入围名单公开，入围者交作品',
  demo: '现场路演，可投票，评委可打分',
  result: '获奖名单公开，分数与票数这时才对所有人可见',
  ended: '活动页与横幅下线',
};

/** config.deadlines 的六个时刻，按先后排。阶段就是照它们切的。 */
const DEADLINE_ROWS: { key: keyof EventConfig['deadlines']; label: string }[] = [
  { key: 'idea', label: '交创意截止' },
  /*
    投票截止比公布早半小时，中间那半小时留给评委就第 8 名同票线下商定。
    往届没有这一项（配置里可以缺），所以下面渲染时会跳过取不到值的行。
  */
  { key: 'screeningVote', label: '初筛投票截止' },
  { key: 'screening', label: '公布入围名单' },
  { key: 'work', label: '交作品截止' },
  { key: 'vote', label: '打分与投票锁定' },
  { key: 'award', label: '颁奖（结果公布）' },
  { key: 'end', label: '活动结束' },
];

export function AdminEvent() {
  const slug = CURRENT_EVENT_SLUG;
  const [data, setData] = useState<EventResponse | null>(null);
  // null = 还没加载上，空数组才是"确实没有"。混为一谈的话接口挂了会显示成
  // "还没有人交创意"——把故障说成了正常。
  const [ideas, setIdeas] = useState<EventAdminIdea[] | null>(null);
  const [ranking, setRanking] = useState<EventRankRow[] | null>(null);
  /** 初筛得票：ideaId → 票数。定名单的依据，不是名单本身。 */
  const [tally, setTally] = useState<{
    votes: Record<string, number>; judgesVoted: number; judgeCount: number;
  } | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  /*
    三块数据各记自己的错误：挂在页顶一句笼统的「没取到」，下面那张卡仍然
    显示「还没有人交创意」——故障会被说成正常。
  */
  const [evErr, setEvErr] = useState<string | null>(null);
  const [ideasErr, setIdeasErr] = useState<string | null>(null);
  const [rankErr, setRankErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' } | null>(null);
  const [confirmUI, ask] = useConfirm();

  const load = () => {
    setEvErr(null); setIdeasErr(null); setRankErr(null);
    void api.event(slug).then(setData).catch((e: Error) => setEvErr(e.message));
    void api.eventIdeas(slug).then((r) => setIdeas(r.ideas))
      .catch((e: Error) => { setIdeas([]); setIdeasErr(e.message); });
    /*
      得票汇总拉不到就当没有：它是定名单时的参考，接口抽风不该让整屏
      打不开——勾选和推进阶段比它要紧。
    */
    void api.screeningTally(slug)
      .then((r) => setTally({
        votes: Object.fromEntries(r.rows.map((x) => [x.ideaId, x.votes])),
        judgesVoted: r.judgesVoted, judgeCount: r.judgeCount,
      }))
      .catch(() => setTally(null));
    void api.eventRanking(slug).then((r) => setRanking(r.ranking))
      .catch((e: Error) => { setRanking([]); setRankErr(e.message); });
    // 评委从用户名单里挑，不手敲用户名——敲错一个字母整条请求都会被拒。
    void api.adminUsers().then((r) => setUsers(r.users.filter((u) => u.status === 'active')))
      .catch(() => undefined);
  };
  useEffect(load, [slug]);

  /** 一次写入的统一出口：报结果、刷新、把错误摆到用户眼前。 */
  const patch = async (input: EventAdminInput, okMsg: string): Promise<boolean> => {
    try {
      await api.patchEvent(slug, input);
      setToast({ message: okMsg, tone: 'info' });
      load();
      return true;
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'error' });
      return false;
    }
  };

  if (!data) {
    return (
      <>
        <PageTitle title="1024 赛事管理" subtitle={slug} />
        <Card>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: evErr ? 'var(--danger)' : 'var(--text-tertiary)' }}>
            {evErr ? `没能取到本届活动：${evErr}` : '载入中…'}
          </p>
        </Card>
      </>
    );
  }

  const ev = data.event;
  const serverNow = new Date(ev.now);
  const judgeTotal = data.judges.length;

  return (
    <>
      <PageTitle
        title="1024 赛事管理"
        subtitle={`${ev.title}${ev.edition ? ` · ${ev.edition}` : ''} · ${slug}`}
      />

      {/*
        三个前台页面的入口。组织者在这屏做完一步，下一秒就要去看它在活动页上
        长什么样——让他自己在地址栏拼 /1024/screen 是没必要的。
      */}
      <div style={{ display: 'flex', gap: 'var(--space-8)', marginBottom: 'var(--space-10)', flexWrap: 'wrap' }}>
        {[
          ['/1024', '活动页'],
          ['/1024/judge', '评委打分页'],
          ['/1024/screen', '会议室大屏'],
        ].map(([href, label]) => (
          <a key={href} href={href} target="_blank" rel="noreferrer"
            style={{ fontSize: 'var(--text-sm)', color: 'var(--accent)', textDecoration: 'none' }}>
            {label} <span className="mono" style={{ color: 'var(--text-tertiary)' }}>{href}</span>
          </a>
        ))}
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 'var(--space-10)' }}>
        <StatCard label="收到创意" value={String(data.stats.ideaCount)} unit="条" />
        <StatCard label="入围" value={String(data.stats.finalistCount)} unit="个" />
        <StatCard label="已交作品" value={String(data.stats.workCount)} unit="个" />
        <StatCard label="评委" value={String(judgeTotal)} unit="位" />
      </div>

      <PhaseCard ev={ev} serverNow={serverNow} onPatch={patch} ask={ask} />

      <FinalistsCard
        /*
          key 挂在服务端那份名单上：别处的改动（比如改评委）会触发整屏重载，
          但只要入围名单本身没变，这块就不该重挂——那会把组织者刚排好还没
          提交的顺序丢掉。
        */
        key={finalistSig(ideas)}
        ideas={ideas}
        ideasErr={ideasErr}
        tally={tally}
        phase={ev.phase}
        hasScores={(ranking ?? []).some((r) => r.judged > 0)}
        onPatch={patch}
        ask={ask}
      />

      <JudgesCard
        key={data.judges.map((j) => j.username).join(',')}
        judges={data.judges}
        users={users}
        onPatch={patch}
        ask={ask}
      />

      <RankingCard ranking={ranking} rankErr={rankErr} judgeTotal={judgeTotal} />

      {confirmUI}
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}

/** 服务端那份入围名单的指纹（顺序敏感）。用来决定 FinalistsCard 要不要重挂。 */
function finalistSig(ideas: EventAdminIdea[] | null): string {
  return savedFinalistOrder(ideas).join(',');
}

type Patch = (input: EventAdminInput, okMsg: string) => Promise<boolean>;
type Ask = ReturnType<typeof useConfirm>[1];

// ── 一、阶段 ──────────────────────────────────────────────────────────

/**
 * 阶段：显示现在是哪一阶段、它是时钟推出来的还是被人钉住的，并提供两个动作。
 *
 * 默认交给时钟是刻意的（没人该在 10.19 12:00 整守着点一下），所以这块的
 * 重点不是"切换阶段"，而是**让人看清现在归谁管**——钉死之后忘记交还，
 * 活动页会一直停在路演那一屏。
 */
function PhaseCard({
  ev, serverNow, onPatch, ask,
}: { ev: EventResponse['event']; serverNow: Date; onPatch: Patch; ask: Ask }) {
  const [pick, setPick] = useState<EventPhase>(ev.phase);
  const [busy, setBusy] = useState(false);

  // 时钟此刻会推出哪一阶段。钉死时它就是「交还给时钟会落回哪里」的答案——
  // 用的是服务端随响应带回的 now，不是浏览器本地时间。
  const byClock = derivePhase(ev.config?.deadlines, serverNow);
  const deadlines = ev.config?.deadlines;

  const pinTo = async () => {
    const ok = await ask({
      title: `把阶段钉死在「${PHASE_LABEL[pick]}」`,
      description: `活动页会立刻按这个阶段显示，并且不再跟着时间走——${PHASE_DESC[pick]}。`
        + '结束后记得交还给时钟；真忘了也不会一直挂着，过了配置里的结束时刻会自动下线。',
      confirmLabel: '钉死',
    });
    if (!ok) return;
    setBusy(true);
    await onPatch({ phase: pick }, `阶段已钉死在「${PHASE_LABEL[pick]}」`);
    setBusy(false);
  };

  const unpin = async () => {
    setBusy(true);
    await onPatch({ phase: null }, `已交还给时钟，现在是「${PHASE_LABEL[byClock]}」`);
    setBusy(false);
  };

  return (
    <Card style={{ marginBottom: 'var(--space-8)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-8)' }}>
        <strong style={{ fontSize: 'var(--text-md)' }}>阶段</strong>
        <Badge tone={ev.phasePinned ? 'warning' : 'success'} dot>
          {ev.phasePinned ? '人工钉死' : '按时间自动'}
        </Badge>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-6)', marginBottom: 'var(--space-4)' }}>
        <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
          {PHASE_LABEL[ev.phase]}
        </span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{PHASE_DESC[ev.phase]}</span>
      </div>
      <p style={{ margin: '0 0 var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
        {ev.phasePinned
          ? `时钟此刻在「${PHASE_LABEL[byClock]}」。交还给时钟就会回到那里。`
          : '阶段按下面的时刻自动切换，不需要有人盯着。'}
        {' '}服务端时间 <span className="num">{fmtDate(ev.now)}</span>
      </p>

      {deadlines && (
        <div style={{ display: 'grid', gap: 'var(--space-4)', marginBottom: 'var(--space-10)' }}>
          {DEADLINE_ROWS.map((row) => {
            const iso = deadlines[row.key];
            /* 本届没配这个时刻就不占一行——显示成空白比不显示更让人以为是坏了 */
            if (!iso) return null;
            const passed = Date.parse(iso) <= serverNow.getTime();
            return (
              <div key={row.key} style={{
                display: 'flex', gap: 'var(--space-6)', alignItems: 'baseline',
                fontSize: 'var(--text-sm)', color: passed ? 'var(--text-tertiary)' : 'var(--text-secondary)',
              }}>
                <span className="num" style={{ width: 128, flex: 'none' }}>{fmtDate(iso)}</span>
                <span>{row.label}</span>
                {passed && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>已过</span>}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
        <Select
          value={pick}
          onChange={setPick}
          items={EVENT_PHASES.map((p) => ({ value: p, label: PHASE_LABEL[p] }))}
          style={{ width: 160 }}
        />
        <Button size="sm" disabled={busy} onClick={() => void pinTo()}>钉死到这一阶段</Button>
        <Button size="sm" variant="ghost" disabled={busy || !ev.phasePinned} onClick={() => void unpin()}>
          交还给时钟
        </Button>
      </div>
      <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
        只有当天路演延时、或要提前/推迟宣布时才需要钉死。
      </p>
    </Card>
  );
}

// ── 二、定入围名单 + 三、创意列表 ─────────────────────────────────────

/**
 * 勾选并排序出入围名单，顺序即编号即路演顺序。
 *
 * 这块与创意列表合成一个组件而不是两个：勾选状态和顺序是同一份数据，
 * 拆开就要把它提到屏级，而这一屏别的地方都不关心它。
 *
 * 提交前不落库——组织者会在讨论里反复改顺序，每拖一下发一个请求等于让
 * 活动页在初筛会议中途闪过十几版名单。
 */
function FinalistsCard({
  ideas, ideasErr, tally, phase, hasScores, onPatch, ask,
}: {
  ideas: EventAdminIdea[] | null;
  ideasErr: string | null;
  /** 初筛得票。拉不到就是 null，卡片上不显示票数，其余照常。 */
  tally: { votes: Record<string, number>; judgesVoted: number; judgeCount: number } | null;
  phase: EventPhase;
  hasScores: boolean;
  onPatch: Patch;
  ask: Ask;
}) {
  const saved = useMemo(() => savedFinalistOrder(ideas), [ideas]);
  const [picks, setPicks] = useState<string[]>(saved);
  const [busy, setBusy] = useState(false);

  const list = ideas ?? [];
  const byId = useMemo(() => new Map(list.map((i) => [i.id, i])), [list]);
  const dirty = picks.join(',') !== saved.join(',');

  const toggle = (id: string) => {
    setPicks((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };
  const move = (i: number, d: -1 | 1) => setPicks((cur) => moveAt(cur, i, d));

  const submit = async () => {
    const ok = await ask({
      title: picks.length === 0 ? '清空入围名单' : `提交 ${picks.length} 个入围创意`,
      description: picks.length === 0
        ? '本届将没有入围作品，入围者会失去交作品的入口。'
        : `编号按当前顺序生成 01…${finalistNo(picks.length - 1)}，它同时是 10.23 的路演顺序。`
          + (hasScores ? ' 已经有评委打过分了——重排编号不会丢分数，但作品卡上的编号会跟着变。' : '')
          + ' 名单是整批替换，不在列表里的创意会被取消入围。',
      confirmLabel: picks.length === 0 ? '清空' : '提交名单',
      danger: picks.length === 0 || hasScores,
    });
    if (!ok) return;
    setBusy(true);
    await onPatch({ finalists: picks }, picks.length === 0 ? '入围名单已清空' : `已定下 ${picks.length} 个入围创意`);
    setBusy(false);
  };

  return (
    <>
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>入围名单</strong>
          {dirty
            ? <Badge tone="warning" dot>未提交</Badge>
            : saved.length > 0 && <Badge tone="success" dot>已提交</Badge>}
        </div>
        <p style={{ margin: '0 0 var(--space-6)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          在下面的创意里点「入围」，再用箭头排出路演顺序——顺序就是编号，也是作品卡上的 NO.0x。
        </p>
        {/*
          投票进度，不是投票结果。

          写明「还有几位没投」是因为差一票就可能换一个人入围：在八个人投完
          之前按当前票数拍板，等于拿一份还没数完的票定名单。但也只是提示——
          有人请假、临时换人都可能让它永远到不了满额，所以不拦着提交。
        */}
        {tally && tally.judgeCount > 0 && (
          <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            初筛投票：{tally.judgeCount} 位评委里已有 {tally.judgesVoted} 位投过
            {tally.judgesVoted < tally.judgeCount
              ? `，还差 ${tally.judgeCount - tally.judgesVoted} 位——票还没数完，先别急着定`
              : '，票数已齐'}
            。得票显示在下面每张创意卡上。
          </p>
        )}

        {picks.length === 0 ? (
          <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            还没勾选。初筛讨论完，按路演顺序一个个点「入围」即可。
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-4)', marginBottom: 'var(--space-8)' }}>
            {picks.map((id, i) => {
              const idea = byId.get(id);
              return (
                <div key={id} style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
                  padding: 'var(--space-4) var(--space-6)',
                  background: 'var(--surface-2)', borderRadius: 'var(--radius-8)',
                }}>
                  <span className="num" style={{
                    width: 24, flex: 'none', fontWeight: 'var(--weight-bold)',
                    color: 'var(--text-heading)',
                  }}>
                    {finalistNo(i)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-base)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {idea?.name ?? '（这条创意已不在本届）'}
                    <span style={{ color: 'var(--text-tertiary)' }}>{idea ? ` · ${idea.who}` : ''}</span>
                  </span>
                  <Button size="sm" variant="ghost" disabled={i === 0} aria-label="上移" onClick={() => move(i, -1)}>↑</Button>
                  <Button size="sm" variant="ghost" disabled={i === picks.length - 1} aria-label="下移" onClick={() => move(i, 1)}>↓</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle(id)}>移除</Button>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
          <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => void submit()}>
            {busy ? '提交中…' : `提交入围名单（${picks.length}）`}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => setPicks(saved)}>
            还原
          </Button>
          {!phaseAtLeast(phase, 'building') && saved.length > 0 && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              名单在「入围制作」阶段开始后才对所有人可见。
            </span>
          )}
        </div>
      </Card>

      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-8)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>本届创意</strong>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            {ideas === null ? '载入中…' : `${list.length} 条，已勾 ${picks.length}`}
          </span>
        </div>

        {ideasErr ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
            没能取到创意列表：{ideasErr}
          </p>
        ) : ideas !== null && list.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            还没有人交创意。员工在活动页 /1024 底部点「提交创意」即可报名。
          </p>
        ) : (
          /*
            一屏摊开，不做折叠：初筛是八个人围着一块屏读完全部创意，
            「点开看详情」在那个场景里等于把讨论变成轮流操作鼠标。
          */
          <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {list.map((idea) => {
              const at = picks.indexOf(idea.id);
              return (
                <IdeaCard
                  key={idea.id}
                  idea={idea}
                  no={at < 0 ? null : finalistNo(at)}
                  votes={tally?.votes[idea.id] ?? null}
                  onToggle={() => toggle(idea.id)}
                />
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

/** 一条创意。作者、名称、想解决的问题、打算怎么做、形态、附件——初筛要看的全在这。 */
function IdeaCard({
  idea, no, votes, onToggle,
}: {
  idea: EventAdminIdea; no: string | null;
  /** 初筛得票。null = 还没有人投，或者汇总没拉到。 */
  votes: number | null;
  onToggle: () => void;
}) {
  const picked = no !== null;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 'var(--space-5)',
      padding: 'var(--space-8)',
      border: `1px solid ${picked ? 'var(--accent)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-12)',
      background: picked ? 'var(--tabby-orange-subtle)' : 'var(--surface-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
        {picked && (
          <span className="num" style={{
            flex: 'none', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-bold)',
            color: 'var(--tabby-orange-hover)',
          }}>
            NO.{no}
          </span>
        )}
        <strong style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-base)' }}>{idea.name}</strong>
        {/* 初筛得票：勾选时的依据，摆在名字边上才看得见 */}
        {votes !== null && votes > 0 && (
          <Badge tone="brand">{votes} 票</Badge>
        )}
        {idea.submitted && <Badge tone="success">已交作品</Badge>}
      </div>

      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        {idea.who}
        <span className="mono" style={{ color: 'var(--text-tertiary)' }}> · {idea.username}</span>
        <span style={{ color: 'var(--text-tertiary)' }}> · {idea.form}</span>
      </div>

      {[['想解决什么问题', idea.problem], ['打算怎么做', idea.plan]].map(([label, text]) => (
        <div key={label}>
          <div style={{
            fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)',
            letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
          }}>
            {label}
          </div>
          <p style={{
            margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.7,
            color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
          }}>
            {text}
          </p>
        </div>
      ))}

      {idea.files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-5)' }}>
          {idea.files.map((f) => (
            <a key={f.url} href={f.url} target="_blank" rel="noreferrer"
              style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)', textDecoration: 'none' }}>
              {f.name} <span className="num" style={{ color: 'var(--text-tertiary)' }}>{fmtBytes(f.size)}</span>
            </a>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginTop: 'auto' }}>
        <Button size="sm" variant={picked ? 'secondary' : 'primary'} onClick={onToggle}>
          {picked ? '取消入围' : '入围'}
        </Button>
        <span className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
          {fmtDate(idea.createdAt)}
        </span>
      </div>
    </div>
  );
}

// ── 四、评委名单 ──────────────────────────────────────────────────────

/**
 * 评委是**本届**的属性，不是账号角色——今年的 TL 明年可能不当评委。
 *
 * 顺序落到 event_judges.sort_order，活动页的评委头像照它排。整批替换：
 * 提交的就是最终名单。
 */
function JudgesCard({
  judges, users, onPatch, ask,
}: {
  judges: { username: string; displayName: string }[];
  users: AdminUser[];
  onPatch: Patch;
  ask: Ask;
}) {
  const saved = useMemo(() => judges.map((j) => j.username), [judges]);
  const [list, setList] = useState<string[]>(saved);
  const [addPick, setAddPick] = useState('');
  const [busy, setBusy] = useState(false);

  const nameOf = useMemo(() => {
    const m = new Map(judges.map((j) => [j.username, j.displayName]));
    for (const u of users) if (!m.has(u.username)) m.set(u.username, u.displayName);
    return m;
  }, [judges, users]);

  const dirty = list.join(',') !== saved.join(',');
  const candidates = users.filter((u) => !list.includes(u.username));

  const move = (i: number, d: -1 | 1) => setList((cur) => moveAt(cur, i, d));

  const submit = async () => {
    const ok = await ask({
      title: list.length === 0 ? '清空评委名单' : `提交 ${list.length} 位评委`,
      description: list.length === 0
        ? '没有评委就没人能打开打分页，也排不出名次。'
        : '名单是整批替换，不在列表里的人会失去评委身份与打分页入口；已经打出的分数不会被删。',
      confirmLabel: list.length === 0 ? '清空' : '提交名单',
      danger: list.length === 0,
    });
    if (!ok) return;
    setBusy(true);
    await onPatch({ judges: list }, list.length === 0 ? '评委名单已清空' : `已设 ${list.length} 位评委`);
    setBusy(false);
  };

  return (
    <Card style={{ marginBottom: 'var(--space-8)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
        <strong style={{ fontSize: 'var(--text-md)' }}>评委名单</strong>
        {dirty && <Badge tone="warning" dot>未提交</Badge>}
      </div>
      <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        评委身份只对本届有效。顺序是活动页上头像的排列顺序。
      </p>

      {list.length === 0 ? (
        <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          还没设评委。活动开始前设好，他们才能打开 /1024/judge。
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--space-4)', marginBottom: 'var(--space-8)' }}>
          {list.map((username, i) => (
            <div key={username} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
              padding: 'var(--space-4) var(--space-6)',
              background: 'var(--surface-2)', borderRadius: 'var(--radius-8)',
            }}>
              <span className="num" style={{ width: 24, flex: 'none', color: 'var(--text-tertiary)' }}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-base)' }}>
                {nameOf.get(username) ?? username}
                <span className="mono" style={{ color: 'var(--text-tertiary)' }}> · {username}</span>
              </span>
              <Button size="sm" variant="ghost" disabled={i === 0} aria-label="上移" onClick={() => move(i, -1)}>↑</Button>
              <Button size="sm" variant="ghost" disabled={i === list.length - 1} aria-label="下移" onClick={() => move(i, 1)}>↓</Button>
              <Button size="sm" variant="ghost" onClick={() => setList((cur) => cur.filter((x) => x !== username))}>
                移除
              </Button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
        <Select
          value={addPick}
          onChange={setAddPick}
          items={[
            { value: '', label: candidates.length > 0 ? '选一位员工…' : '没有可加的员工' },
            ...candidates.map((u) => ({ value: u.username, label: `${u.displayName} · ${u.username}` })),
          ]}
          style={{ width: 240 }}
        />
        <Button
          size="sm"
          disabled={!addPick}
          onClick={() => { setList((cur) => [...cur, addPick]); setAddPick(''); }}
        >
          加为评委
        </Button>
        <div style={{ flex: 1 }} />
        <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => void submit()}>
          {busy ? '提交中…' : '提交评委名单'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => setList(saved)}>还原</Button>
      </div>
    </Card>
  );
}

// ── 五、排名 ──────────────────────────────────────────────────────────

/**
 * 颁奖前的核对表。
 *
 * 一、二、三等奖按评委已提交分数的平均分排，最佳人气奖按票数排——所以
 * 这张表把「几个评委打了」一并摆出来：不足全员时名次只是暂定的，而
 * 「暂定名次」和「最终名次」在颁奖那一刻是两件事。
 */
function RankingCard({
  ranking, rankErr, judgeTotal,
}: { ranking: EventRankRow[] | null; rankErr: string | null; judgeTotal: number }) {
  const rows = ranking ?? [];
  const partial = rows.some((r) => r.judged > 0 && r.judged < judgeTotal);
  const topVotes = rows.length > 0
    ? [...rows].sort((a, b) => b.votes - a.votes)[0]!
    : null;

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', padding: 'var(--space-10) var(--space-10) var(--space-8)' }}>
        <strong style={{ fontSize: 'var(--text-md)' }}>汇总排名</strong>
        {partial && <Badge tone="warning">名次暂定</Badge>}
      </div>

      {rankErr ? (
        <p style={{ margin: '0 var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
          没能取到排名：{rankErr}
        </p>
      ) : ranking === null ? (
        <p style={{ margin: '0 var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          载入中…
        </p>
      ) : rows.length === 0 ? (
        <p style={{ margin: '0 var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          入围名单定下来之后，这里会按评委平均分排出名次。
        </p>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  {['名次', '编号', '作品', '作者', '评委平均分', '已打分', '票数'].map((h) => (
                    <th key={h} style={{
                      padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-2xs)',
                      fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                      letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ideaId} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontWeight: 'var(--weight-bold)', whiteSpace: 'nowrap' }}>
                      {r.rank ?? '—'}
                    </td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {r.no}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)' }}>
                      {r.name}
                      {topVotes?.ideaId === r.ideaId && r.votes > 0 && (
                        <span style={{ marginLeft: 'var(--space-5)' }}><Badge tone="brand">票王</Badge></span>
                      )}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.who}</td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontWeight: 'var(--weight-semibold)', whiteSpace: 'nowrap' }}>
                      {r.judgeScore ?? '—'}
                    </td>
                    <td className="num" style={{
                      padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap',
                      /* 与 Badge 的 warning 前景同色：这一格要能在一列里被扫到 */
                      color: r.judged < judgeTotal ? '#8a6d00' : 'var(--text-tertiary)',
                    }}>
                      {r.judged} / {judgeTotal}
                    </td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>{r.votes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ margin: 'var(--space-8) var(--space-10) var(--space-10)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            一、二、三等奖按评委平均分名次，最佳人气奖按票数。只有已提交的分数进汇总，草稿不算；
            打分与投票在「打分与投票锁定」那一刻冻结，名次按那一刻的分数定。
          </p>
        </>
      )}
    </Card>
  );
}
