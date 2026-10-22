import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, Dimensions, Image, Keyboard, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { pickImage, session } from '../runtime/bridge';
import { useVoiceInput } from '../runtime/voice';
import { VoicePanel } from './VoicePanel';
import { BrandMark, Icon } from './Icon';
import { API_BASE } from '../config';
import { absCover, api, type Listing } from '../api';

/**
 * 助手（移动端 v2 稿 · 07，底栏左边那颗圆钮）。
 *
 * ┌─ 和改版前的差别 ──────────────────────────────────────────────────┐
 * │ 旧：一屏对话页，顶上写「做个新页面 / 要做的是」，中间一句「说一句你  │
 * │     想改什么」。打开它的人得先想好要说什么。                        │
 * │ 新：先问一句「今天想做点什么」，给两条路（做一个 / 找一个），再摆几  │
 * │     个同事做过的页面当灵感——点一个就把它的做法带进输入框。说了第一  │
 * │     句之后，这一块才换成对话。                                      │
 * │                                                                    │
 * │ 它是整屏的，不压底栏：稿上这一屏没有底栏，右上角那颗 ⌄ 收起回去。   │
 * │ 底栏浮在上面时，输入框正好被它盖住（实测荣耀机上就是这样）。       │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 三件改版前就有、照旧保留的事：
 *   - 改动摘要而非 diff 原文：手机屏太小，贴 diff 没人看
 *   - 部署必须二次确认：Agent 只能拿到待确认令牌，点「部署上线」才生效
 *   - 截图随 prompt 传：门店走动时拍一张比打字快
 */

interface Msg {
  /** note：壳自己插的一句说明（连接断了、还在后台做），不是谁说的话。 */
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  toolName?: string;
}

interface PendingDeploy {
  confirmToken: string;
  site: string;
  summary: string;
}

/** 这次对话在改哪个页面。null 表示要做一个新的。 */
export interface EditTarget {
  slug: string;
  name: string;
  letter: string;
}

export function AgentChat({
  token, displayName, target, onClearTarget, onKeyboard, onClose, onOpenPage, onExplore,
  seed, onSeedUsed,
}: {
  token: string | null;
  displayName: string;
  target: EditTarget | null;
  onClearTarget: () => void;
  /** 键盘起落。外层据此决定别的浮层要不要让开。 */
  onKeyboard?: (up: boolean) => void;
  /** 右上角 ⌄ 与实体返回键：收起助手，回到刚才那一格。 */
  onClose: () => void;
  /** 灵感卡上的「预览」：在壳里打开那个页面。 */
  onOpenPage: (path: string, name: string) => void;
  /** 「找一个」与「从这里开始做同款」：去探索（找一个时顺手打开搜索）。 */
  onExplore: (search: boolean) => void;
  /**
   * 「照这个做一个」带过来的那句话：填进输入框，**不自动发送**。
   *
   * 不自动发是因为这句话是别人写的——用户多半要改几个字（换个名字、
   * 加一条自己的规矩）。直接发出去，他第一步要做的就是打断它。
   */
  seed?: string | null | undefined;
  onSeedUsed?: (() => void) | undefined;
}) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  /*
    自己盯键盘高度，不靠 KeyboardAvoidingView。

    Expo 54 起安卓默认 edge-to-edge，manifest 里的 adjustResize 不再真的
    缩窗口——窗口尺寸不变，输入框被键盘整个盖住，而 KeyboardAvoidingView
    在安卓上本来就是关着的（behavior undefined）。两边一叠，就是"打字时
    看不见自己在打什么"。
  */
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => {
      /*
        用「屏幕高 − 键盘顶边」而不是 endCoordinates.height。

        edge-to-edge 下 height 报的是键盘自己那块，不含候选词条等另开的
        窗口，也不含导航栏——按它算会差个几十像素，输入框底边正好压在
        候选栏下面（实测荣耀 + 系统输入法就是这样）。screenY 是键盘顶边
        在屏幕坐标里的绝对位置，减出来就是"屏幕底部被挡了多少"，与是谁
        挡的无关。
      */
      const occluded = Dimensions.get('screen').height - e.endCoordinates.screenY;
      setKb(Math.max(0, occluded));
      onKeyboard?.(true);
    });
    const b = Keyboard.addListener(hideEvt, () => { setKb(0); onKeyboard?.(false); });
    return () => { a.remove(); b.remove(); };
  }, [onKeyboard]);

  // 实体返回键收起助手，否则一按就退出整个 App
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [onClose]);

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');

  /* 带过来的那句话落进输入框，然后立刻清掉外面那份，免得回来又填一次 */
  useEffect(() => {
    if (!seed) return;
    setInput(seed);
    onSeedUsed?.();
  }, [seed, onSeedUsed]);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<{ mimeType: string; dataBase64: string }[]>([]);

  // 语音识别结果**追加**而非覆盖：用户可能先打了一半字再改用说的，
  // 覆盖会把已经输入的内容吃掉。
  const voice = useVoiceInput(
    (text) => setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text)),
    { apiBase: API_BASE, token },
  );
  /** 点了用不了的话筒才说一句为什么，不常驻占一行。 */
  const [voiceHint, setVoiceHint] = useState(false);
  const [pending, setPending] = useState<PendingDeploy | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const scroller = useRef<ScrollView>(null);

  /* ── 灵感：同事做过、留了做法的页面 ─────────────────────────────── */
  const [ideas, setIdeas] = useState<Listing[]>([]);
  useEffect(() => {
    void api.marketplace(token)
      .then((r) => {
        /*
          有封面的排前面——这一块是看图挑的；有提示词的再往前，点了才有
          "做法"可带。两样都没有的不摆：一块空卡什么也启发不了。
        */
        const score = (l: Listing) => (l.cover_path ? 2 : 0) + (l.source_prompt ? 1 : 0);
        setIdeas(r.listings.filter((l) => !l.mine && score(l) > 0)
          .sort((a, b) => score(b) - score(a) || b.like_count - a.like_count)
          .slice(0, 2));
      })
      .catch(() => setIdeas([]));
  }, [token]);

  const remix = (l: Listing) => {
    setInput(l.source_prompt ?? `做一个和「${l.name}」类似的页面：`);
    inputRef.current?.focus();
  };

  /* ── 历史 ─────────────────────────────────────────────────────── */
  const [history, setHistory] = useState<{ id: string; title: string; updatedAt: number }[] | null>(null);
  const openHistory = () => {
    setHistory([]);
    void api.agentSessions(token).then((r) => setHistory(r.items)).catch(() => setHistory([]));
  };
  const resume = async (id: string) => {
    setHistory(null);
    try {
      const v = await api.agentSessionView(token, id);
      sessionId.current = v.id;
      setPending(null);
      setMsgs(v.says.map((m) => ({ role: m.me ? 'user' : 'assistant', text: m.text })));
      setTimeout(() => scroller.current?.scrollToEnd({ animated: false }), 60);
    } catch { /* 拿不回来就停在原地，别把当前的对话清掉 */ }
  };

  const fresh = () => {
    sessionId.current = undefined;
    setMsgs([]);
    setPending(null);
    setInput('');
    setImages([]);
    onClearTarget();
  };

  /* 收起助手之后，后台恢复那段轮询就别再往 state 里写了 */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /** 一个事件落进对话。流式和恢复两条路都走这里。 */
  const onEvent = useCallback((e: Record<string, unknown>) => {
    if (e.type === 'session') sessionId.current = e.id as string;
    else if (e.type === 'text') {
      setMsgs((m) => {
        const last = m[m.length - 1];
        /*
          工具行之后的话另起一个气泡。之前是"最后一条不是助手就丢掉"——
          模型调完工具再说的那句总结，一个字都显示不出来。
        */
        if (last?.role !== 'assistant') return [...m, { role: 'assistant', text: e.delta as string }];
        return [...m.slice(0, -1), { ...last, text: last.text + (e.delta as string) }];
      });
    } else if (e.type === 'tool_start') {
      setMsgs((m) => [...m, { role: 'tool', text: '', toolName: e.name as string }]);
    } else if (e.type === 'error') {
      setMsgs((m) => [...m, { role: 'assistant', text: `出错了：${e.message as string}` }]);
    }
  }, []);

  /**
   * 连接断了之后去把结果找回来。
   *
   * 服务端那一轮不会因为手机断线而停：它照样跑完、存库。这里每 3 秒问一次
   * 这条会话还在不在跑，跑完了就把库里那份对话整个摆回来。最多等 12 分钟，
   * 再久就让人自己从「历史」里打开——那时候多半是真出事了，不该一直转圈。
   */
  const recover = useCallback(async (t: string, sid: string) => {
    setMsgs((m) => [...m, { role: 'note', text: '连接断了。AI 还在后台接着做，做完会显示在这里。' }]);
    let lastSig = '';
    let same = 0;
    for (let i = 0; i < 240 && alive.current; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      let v: Awaited<ReturnType<typeof api.agentSessionView>>;
      try { v = await api.agentSessionView(t, sid); } catch { continue; }
      /*
        老的服务端不带 busy：那就看对话两次（6 秒）没变，且最后一句是助手的。
        猜得到的只有这么多，宁可多等一轮也别把半截结果当成做完了。
      */
      const tail = v.says[v.says.length - 1];
      const sig = `${v.says.length}:${tail?.text.length ?? 0}`;
      if (sig === lastSig) same += 1; else { lastSig = sig; same = 0; }
      const done = v.busy === false || (v.busy === undefined && same >= 2 && tail !== undefined && !tail.me);
      if (done) {
        if (alive.current) setMsgs(v.says.map((x) => ({ role: x.me ? 'user' : 'assistant', text: x.text })));
        return;
      }
    }
    if (alive.current) {
      setMsgs((m) => [...m, { role: 'note', text: '还没做完。过一会儿从左上角「历史」里打开这条对话看结果。' }]);
    }
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    setMsgs((m) => [...m, { role: 'user', text }]);
    setInput('');
    setBusy(true);
    const imgs = images;
    setImages([]);

    try {
      const t = await session.get();
      if (!t) {
        setMsgs((m) => [...m, { role: 'assistant', text: '登录状态失效，请重新登录。' }]);
        return;
      }

      /*
        先开会话拿到 id 再发。之前是发出去之后等流里的第一个事件才知道 id——
        而 fetch 要等整段回复收完才交出任何东西，连接一断，连"去哪儿找结果"
        都不知道。
      */
      if (!sessionId.current) sessionId.current = (await api.agentNewSession(t)).sessionId;
      const sid = sessionId.current;

      const r = await streamAsk(t, {
        sessionId: sid, text, images: imgs,
        // 让模型不必从话里猜「改一改」指的是哪个页面。服务端会把它
        // 变成一条上下文：发布时覆盖这个 slug，而不是新建一个。
        ...(target ? { targetSlug: target.slug } : {}),
      }, onEvent);

      if (r.kind === 'http') setMsgs((m) => [...m, { role: 'assistant', text: r.message }]);
      if (r.kind === 'dropped') await recover(t, sid);

      // 拉取待确认的发布请求
      const p = await fetch(`${API_BASE}/deploy/api/agent/pending`, {
        headers: { authorization: `Bearer ${t}` },
      }).then((x) => x.json() as Promise<{ items: PendingDeploy[] }>).catch(() => ({ items: [] }));
      if (alive.current) setPending(p.items[0] ?? null);
    } catch (e) {
      setMsgs((m) => [...m, {
        role: 'assistant',
        text: `连接失败：${e instanceof Error ? e.message : String(e)}`,
      }]);
    } finally {
      if (alive.current) {
        setBusy(false);
        setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 60);
      }
    }
  }, [input, busy, images, target, onEvent, recover]);

  const confirmDeploy = useCallback(async () => {
    if (!pending) return;
    const t = await session.get();
    if (!t) return;
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/deploy/api/agent/confirm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmToken: pending.confirmToken }),
      }).then((x) => x.json() as Promise<{ ok?: boolean; next?: string; message?: string }>);
      setMsgs((m) => [...m, { role: 'assistant', text: r.ok ? (r.next ?? '已确认') : (r.message ?? '确认失败') }]);
      setPending(null);
    } finally { setBusy(false); }
  }, [pending]);

  const talking = msgs.length > 0;
  const hasText = input.trim().length > 0;

  return (
    <View style={[s.root, { paddingTop: insets.top + 14 }]}>
      <View style={s.topBar}>
        <Pressable onPress={openHistory} hitSlop={10} accessibilityLabel="历史对话">
          <Icon name="history" size={24} />
        </Pressable>
        <Pressable onPress={fresh} hitSlop={10} accessibilityLabel="新对话">
          <Icon name="pen" size={24} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="收起">
          <Icon name="chevDown" size={24} />
        </Pressable>
      </View>

      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={talking ? s.list : s.intro}
        keyboardShouldPersistTaps="handled"
      >
        {talking ? msgs.map((m, i) =>
          m.role === 'tool' ? (
            <Text key={i} style={s.toolLine}>· {toolLabel(m.toolName)}</Text>
          ) : m.role === 'note' ? (
            <Text key={i} style={s.noteLine}>{m.text}</Text>
          ) : !m.text ? null : (
            <View key={i} style={[s.bubble, m.role === 'user' ? s.bubbleUser : s.bubbleBot]}>
              <Text style={m.role === 'user' ? s.bubbleUserText : s.bubbleBotText}>{m.text}</Text>
            </View>
          ),
        ) : null}
        {/* 还在等下一个字（刚发出去、或者正在调工具）：补一个省略号，别让人以为卡住了 */}
        {talking && busy && msgs[msgs.length - 1]?.role !== 'assistant' && (
          <View style={[s.bubble, s.bubbleBot]}><Text style={s.bubbleBotText}>…</Text></View>
        )}
        {!talking && (
          <>
            <Text style={s.hello}>{displayName}，今天想做点什么？</Text>
            <View style={s.paths}>
              <Pressable style={s.path} onPress={() => { onClearTarget(); inputRef.current?.focus(); }}>
                <Icon name="plusCircle" size={20} color="#181715" />
                <Text style={s.pathLabel}>做一个</Text>
                <Text style={s.pathHint} numberOfLines={1}>做个小工具解决手头的事</Text>
              </Pressable>
              <Pressable style={s.path} onPress={() => onExplore(true)}>
                <Icon name="compass" size={20} color="#181715" />
                <Text style={s.pathLabel}>找一个</Text>
                <Text style={s.pathHint} numberOfLines={1}>订会议室、查工位、算报销…</Text>
              </Pressable>
            </View>

            <Text style={s.ideasTitle}>做同款灵感</Text>
            <View style={s.ideas}>
              <View style={s.ideasCol}>
                <Pressable style={s.startCard} onPress={() => onExplore(false)}>
                  <BrandMark size={38} />
                  <Text style={s.startText}>从这里开始{'\n'}做同款</Text>
                </Pressable>
                {ideas[1] && (
                  <IdeaCard
                    item={ideas[1]} height={150}
                    onRemix={() => remix(ideas[1]!)}
                    onPreview={() => onOpenPage(`/${ideas[1]!.owner_username}/${ideas[1]!.slug}/`, ideas[1]!.name)}
                  />
                )}
              </View>
              <View style={s.ideasCol}>
                {ideas[0] ? (
                  <IdeaCard
                    item={ideas[0]} height={310}
                    onRemix={() => remix(ideas[0]!)}
                    onPreview={() => onOpenPage(`/${ideas[0]!.owner_username}/${ideas[0]!.slug}/`, ideas[0]!.name)}
                  />
                ) : (
                  <View style={[s.ideaCard, s.ideaEmpty, { height: 310 }]}>
                    <Text style={s.ideaEmptyText}>同事分享到全公司的页面会出现在这里</Text>
                  </View>
                )}
              </View>
            </View>
          </>
        )}
      </ScrollView>

      {/* 二次确认卡：Agent 无权直接发布，必须由人点这一下 */}
      {pending && (
        <View style={s.confirm}>
          <Text style={s.confirmTitle}>要把改动发布到 /{pending.site} 吗</Text>
          <Text style={s.confirmBody}>{pending.summary}</Text>
          <View style={s.confirmActions}>
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setPending(null)}>
              <Text style={s.btnGhostText}>继续改</Text>
            </Pressable>
            <Pressable style={[s.btn, s.btnPrimary]} disabled={busy} onPress={() => void confirmDeploy()}>
              <Text style={s.btnPrimaryText}>部署上线</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={{ paddingBottom: kb > 0 ? 8 : insets.bottom + 18, marginBottom: kb }}>
        {/*
          「在改哪个」。这条是整段对话的主语：不指明的话，用户说「把标题改大
          一点」，模型只能猜他指的是哪个页面。选中之后 slug 随每条消息发给
          服务端，发布时覆盖同一个 slug——这才是"编辑"，而不是"又做了一个"。
        */}
        {target && (
          <View style={s.targetChip}>
            <Text style={s.targetText} numberOfLines={1}>正在改「{target.name}」</Text>
            <Pressable onPress={onClearTarget} hitSlop={10} accessibilityLabel="不改它了，做新的">
              <Icon name="x" size={15} color="#72706a" />
            </Pressable>
          </View>
        )}
        {images.length > 0 && <Text style={s.note}>已附 {images.length} 张截图</Text>}
        {voiceHint && <Text style={s.note}>这台设备没有可用的语音识别服务，语音输入不可用</Text>}

        <View style={s.bar}>
          <Pressable
            hitSlop={8}
            accessibilityLabel="附截图"
            onPress={() => {
              void pickImage().then((r) => {
                if (r?.base64) setImages((x) => [...x, { mimeType: 'image/jpeg', dataBase64: r.base64! }]);
              }).catch(() => { /* 闸门关闭或用户取消，静默 */ });
            }}
          >
            <Icon name="plus" size={22} color="#181715" />
          </Pressable>
          <TextInput
            ref={inputRef}
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="说说你想做什么…"
            placeholderTextColor="#a2a09b"
            multiline
            editable={!busy}
          />
          {/*
            右边那颗黑钮：没字时是话筒（稿上就是它），有字了换成发送——
            不再另摆一颗发送键，两颗挤在胶囊里谁都点不准。
          */}
          <Pressable
            style={[s.go, voice.listening && s.goOn, (busy || (!hasText && !voice.available)) && { opacity: 0.35 }]}
            disabled={busy}
            accessibilityLabel={hasText ? '发送' : '语音输入'}
            onPress={() => {
              if (hasText) { void send(); return; }
              if (!voice.available) { setVoiceHint(true); setTimeout(() => setVoiceHint(false), 3000); return; }
              void voice.start();
            }}
          >
            {busy
              ? <ActivityIndicator color="#fff" size="small" />
              : <Icon name={hasText ? 'send' : voice.listening ? 'stop' : 'mic'} size={21} color="#fff" />}
          </Pressable>
        </View>
      </View>

      <VoicePanel voice={voice} />

      <Modal visible={history !== null} transparent animationType="slide" onRequestClose={() => setHistory(null)}>
        <Pressable style={s.sheetMask} onPress={() => setHistory(null)} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={s.sheetTitle}>最近的对话</Text>
          <ScrollView style={{ maxHeight: 420 }}>
            {history?.length === 0 && <Text style={s.sheetEmpty}>还没有对话。说一句想做什么就开始了。</Text>}
            {history?.map((h) => (
              <Pressable key={h.id} style={s.sheetRow} onPress={() => void resume(h.id)}>
                <Icon name="history" size={18} color="#72706a" />
                <Text style={s.sheetRowText} numberOfLines={1}>{h.title}</Text>
                <Text style={s.sheetRowWhen}>{ago(h.updatedAt)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

/** 灵感卡：整张点下去是"照这个做"，右上角那颗才是"先看看"。 */
function IdeaCard({
  item, height, onRemix, onPreview,
}: { item: Listing; height: number; onRemix: () => void; onPreview: () => void }) {
  const cover = absCover(item.cover_path);
  return (
    <Pressable style={[s.ideaCard, { height }]} onPress={onRemix} accessibilityLabel={`照「${item.name}」做一个`}>
      {cover
        ? <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        : <Text style={s.ideaName}>{item.name}</Text>}
      <Pressable style={s.previewChip} onPress={onPreview} hitSlop={6} accessibilityLabel={`预览 ${item.name}`}>
        <Icon name="expand" size={13} color="#181715" />
        <Text style={s.previewText}>预览</Text>
      </Pressable>
    </Pressable>
  );
}

/** 工具名转成人话。设计稿要求的是"改动摘要"，不是把工具调用原样抛给用户。 */
function toolLabel(name?: string): string {
  switch (name) {
    case 'list_files': return '看了一眼项目结构';
    case 'read_file': return '读了文件';
    case 'write_file': return '改了文件';
    case 'delete_file': return '删了文件';
    case 'get_quota': return '查了配额';
    case 'list_apps': return '看了已部署的应用';
    case 'request_deploy': return '请求发布';
    default: return name ?? '处理中';
  }
}

function ago(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return d === 1 ? '昨天' : `${d} 天前`;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 18 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 20 },

  intro: { flexGrow: 1, justifyContent: 'flex-end', paddingTop: 40 },
  hello: { fontSize: 26, fontWeight: '700', color: '#181715', letterSpacing: -0.3 },
  paths: { gap: 10, paddingTop: 18, paddingBottom: 22 },
  path: {
    flexDirection: 'row', alignItems: 'center', gap: 10, height: 54, paddingHorizontal: 18,
    borderRadius: 27, backgroundColor: '#f3f1ec', overflow: 'hidden',
  },
  pathLabel: { fontSize: 16, fontWeight: '700', color: '#181715' },
  pathHint: { flex: 1, fontSize: 14, color: '#72706a' },

  ideasTitle: { fontSize: 22, fontWeight: '800', color: '#181715', paddingBottom: 12 },
  ideas: { flexDirection: 'row', gap: 10 },
  ideasCol: { flex: 1, gap: 10 },
  startCard: {
    height: 150, padding: 16, borderRadius: 24, backgroundColor: '#f3f1ec',
    justifyContent: 'space-between',
  },
  startText: { fontSize: 19, fontWeight: '800', lineHeight: 25, color: '#181715' },
  ideaCard: {
    borderRadius: 24, overflow: 'hidden', backgroundColor: '#ffede0',
    alignItems: 'center', justifyContent: 'center',
  },
  ideaName: { fontSize: 15, fontWeight: '700', color: 'rgba(24,23,21,.55)', padding: 12, textAlign: 'center' },
  ideaEmpty: { backgroundColor: '#f6f4ee', padding: 18 },
  ideaEmptyText: { fontSize: 13, lineHeight: 20, color: '#a2a09b', textAlign: 'center' },
  previewChip: {
    position: 'absolute', top: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 4,
    height: 30, paddingHorizontal: 10, borderRadius: 15, backgroundColor: 'rgba(255,255,255,.88)',
  },
  previewText: { fontSize: 13, fontWeight: '700', color: '#181715' },

  list: { paddingVertical: 16, gap: 10 },
  bubble: { maxWidth: '86%', borderRadius: 20, paddingHorizontal: 15, paddingVertical: 11 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#181715' },
  bubbleBot: { alignSelf: 'flex-start', backgroundColor: '#f3f1ec' },
  bubbleUserText: { color: '#fff', fontSize: 15, lineHeight: 22 },
  bubbleBotText: { color: '#181715', fontSize: 15, lineHeight: 22 },
  toolLine: { fontSize: 12.5, color: '#a2a09b', marginLeft: 4 },
  noteLine: { fontSize: 13, lineHeight: 20, color: '#ee5c2a', marginLeft: 4 },

  confirm: {
    marginTop: 8, padding: 16, borderRadius: 22, backgroundColor: '#fbe4da', gap: 4,
  },
  confirmTitle: { fontSize: 15, fontWeight: '700', color: '#181715' },
  confirmBody: { fontSize: 13, color: '#54524e', lineHeight: 20 },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: { flex: 1, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: 'rgba(255,255,255,.75)' },
  btnGhostText: { fontSize: 14, fontWeight: '600', color: '#181715' },
  btnPrimary: { backgroundColor: '#ee5c2a' },
  btnPrimaryText: { fontSize: 14, color: '#fff', fontWeight: '700' },

  targetChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    height: 32, paddingHorizontal: 12, marginBottom: 8, borderRadius: 16, backgroundColor: '#f3f1ec',
  },
  targetText: { maxWidth: 240, fontSize: 13, fontWeight: '600', color: '#54524e' },
  note: { fontSize: 12.5, color: '#ee5c2a', marginBottom: 8, marginLeft: 6 },

  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, minHeight: 60,
    paddingLeft: 18, paddingRight: 6, paddingVertical: 6, borderRadius: 30, backgroundColor: '#fff',
    boxShadow: '0 10px 26px -14px rgba(24,23,21,.35), 0 0 0 1px rgba(24,23,21,.06)',
  },
  input: {
    flex: 1, maxHeight: 120, paddingVertical: 6, fontSize: 16, lineHeight: 22, color: '#181715',
    // 安卓 multiline 垂直居中的唯一开关，缺了就顶在上边
    textAlignVertical: 'center',
  },
  go: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: '#181715',
    alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end',
  },
  goOn: { backgroundColor: '#ee5c2a' },

  sheetMask: { flex: 1, backgroundColor: 'rgba(0,0,0,.42)' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: 20, paddingTop: 20, gap: 6,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: '#181715', marginBottom: 6 },
  sheetEmpty: { fontSize: 14, color: '#72706a', lineHeight: 22, paddingVertical: 14 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
  sheetRowText: { flex: 1, fontSize: 15, color: '#181715' },
  sheetRowWhen: { fontSize: 12.5, color: '#a2a09b' },
});

/**
 * 发一句、边收边处理。
 *
 * 用 XMLHttpRequest 而不是 fetch：React Native 的 fetch 要等整段回复收完
 * 才交出 body，一轮动辄一两分钟，这期间屏幕上什么都没有，连接一断就全丢。
 * RN 的 XHR 挂了 onprogress 会把收到的部分一段段递上来，SSE 正好按块解析。
 *
 * 结果三种：done 正常收完；http 服务端回了错误码（带着它的那句话）；
 * dropped 连接断在半路（切后台、网络抖、网关掐了长连接）——调用方去恢复。
 */
function streamAsk(
  token: string,
  body: Record<string, unknown>,
  onEvent: (e: Record<string, unknown>) => void,
): Promise<{ kind: 'done' } | { kind: 'http'; message: string } | { kind: 'dropped' }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let buf = '';
    const pump = () => {
      if (xhr.status !== 200) return;
      const text = xhr.responseText ?? '';
      buf += text.slice(seen);
      seen = text.length;
      // 一个事件以空行结尾；最后一段可能是半截，留到下一次
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue; // `: ping` 心跳之类的注释行
          try { onEvent(JSON.parse(line.slice(5)) as Record<string, unknown>); } catch { /* 半条丢掉 */ }
        }
      }
    };
    xhr.open('POST', `${API_BASE}/deploy/api/agent/ask`);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.onprogress = pump;
    xhr.onload = () => {
      if (xhr.status === 200) { pump(); resolve({ kind: 'done' }); return; }
      let message = `请求失败（${xhr.status}）`;
      try { message = (JSON.parse(xhr.responseText) as { message?: string }).message ?? message; } catch { /* 不是 JSON */ }
      resolve({ kind: 'http', message });
    };
    xhr.onerror = () => { pump(); resolve({ kind: 'dropped' }); };
    xhr.ontimeout = () => { pump(); resolve({ kind: 'dropped' }); };
    xhr.send(JSON.stringify(body));
  });
}
