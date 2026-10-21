import type { EngineMessage } from '@ispace/agent';
import { SUMMARY_MARK } from '@ispace/agent';

/**
 * 把库里存的模型对话还原成创建屏上的那条对话流（「历史版本」里点开一条会话时用）。
 *
 * 库里存的是**给模型看的**消息，不是给人看的：用户那句话前面可能垫着平台加的
 * 说明（「【本次要修改的是…】」「【工作区已切换…】」），后面可能挂着附件抽出来
 * 的整段文字；中间夹着工具调用与结果、平台补的截图消息、压缩留下的前情提要。
 * 原样摆出来，人会看到一堆他没说过的话。这里只留两样：他说的、模型说的。
 */

export interface ViewSay {
  me: boolean;
  text: string;
  files?: { name: string; mimeType: string; size: number; path: string }[];
}

/** 平台补的截图消息开头。与 packages/agent/src/session.ts 里那句保持一致。 */
const SCREENSHOT_NOTE = '（这是 screenshot_preview 截到的页面';
/** 附件说明块的开头（services/attachments.ts）。 */
const ATTACH_BLOCK = '\n\n【我附了';
/** 去掉图片字节后留的那句（services/agent-store.ts 的 stripImages）。 */
const IMAGE_GONE = /\n?（这里原本附了 \d+ 张图，已不在上下文里。）/g;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 用户那句话的原文：去掉开头平台垫的【…】行、结尾的附件块和去图说明。 */
export function userText(content: string): string {
  const cut = content.indexOf(ATTACH_BLOCK);
  let t = cut >= 0 ? content.slice(0, cut) : content;
  const lines = t.split('\n');
  while (lines.length > 1 && /^【[^\n]*】$/.test(lines[0]!.trim())) lines.shift();
  t = lines.join('\n').replace(IMAGE_GONE, '');
  return t.trim();
}

/** 从附件说明块里认出存进 _uploads/ 的文件，刷新之后对话里还点得开。 */
function userFiles(content: string): ViewSay['files'] {
  const cut = content.indexOf(ATTACH_BLOCK);
  if (cut < 0) return undefined;
  const files = [...content.slice(cut).matchAll(/存在 (_uploads\/[^）\s]+)/g)].map((m) => {
    const path = m[1]!;
    const name = path.slice('_uploads/'.length);
    return { name, path, size: 0, mimeType: MIME[name.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream' };
  });
  return files.length ? files : undefined;
}

export function toView(messages: EngineMessage[]): ViewSay[] {
  const out: ViewSay[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.startsWith(SCREENSHOT_NOTE) || m.content.startsWith(SUMMARY_MARK)) continue;
      const files = userFiles(m.content);
      out.push({ me: true, text: userText(m.content), ...(files ? { files } : {}) });
    } else if (m.role === 'assistant' && m.content.trim()) {
      /* 一轮里模型可能说好几段（夹着工具调用），界面上是同一个气泡 */
      const last = out[out.length - 1];
      if (last && !last.me) last.text = `${last.text}\n\n${m.content.trim()}`;
      else out.push({ me: false, text: m.content.trim() });
    }
  }
  return out;
}

/** 会话标题：第一句话的头一截，和创建屏 titleOf 同一个削法。 */
export function sessionTitle(first: string): string {
  const t = userText(first).replace(/^(请|帮我)?(做|写|搭)(一个|个)?/, '').split(/[：:，,。；;\s]/)[0];
  return (t || '没有标题的页面').slice(0, 20);
}
