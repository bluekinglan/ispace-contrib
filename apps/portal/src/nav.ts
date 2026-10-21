import { isReservedPath } from '@ispace/contracts';

/**
 * 这个地址是不是这个单页应用自己的一屏。
 *
 * 是的话点链接就在页面里切，不整页刷新；不是的（控制台、已发布的页面
 * `/{user}/{slug}/`、1024 活动页、重置密码）照常让浏览器去开——它们是别的
 * 应用，或者要在 App 顶上重新分流。
 */
export function isSpaPath(pathname: string): boolean {
  const seg = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (seg.length === 0) return true;
  if (seg.length === 1) {
    if (seg[0] === 'foryou' || seg[0] === 'create' || seg[0] === 'mine') return true;
    /* 单段又不是保留字的，就是作者主页 */
    return !isReservedPath(seg[0]!);
  }
  return seg.length === 3 && seg[0] === 'app';
}
