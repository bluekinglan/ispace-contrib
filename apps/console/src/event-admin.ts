import type { EventAdminIdea } from '@ispace/contracts';

/**
 * 1024 赛事管理屏里与界面无关的那几件事。
 *
 * 单独拎出来是为了能测：这屏最怕的不是样式错位，而是**顺序错**——顺序就是
 * 编号，编号就是 10.23 的路演顺序和奖杯上刻的 NO.0x。排错了没人会在提交那
 * 一刻发现，等到路演开始才会。
 */

/**
 * 服务端已存的入围顺序。
 *
 * 按 `finalist_no` 排，不按提交时间：编号是组织者排出来的结果，创意的提交
 * 先后跟它没关系。数值比较而不是字符串比较——编号是补零的两位数，真有一天
 * 入围超过 99 个，字典序会把 '100' 排到 '99' 前面。
 */
export function savedFinalistOrder(ideas: EventAdminIdea[] | null): string[] {
  return (ideas ?? [])
    .filter((i) => i.finalist && i.no != null)
    .sort((a, b) => Number(a.no) - Number(b.no))
    .map((i) => i.id);
}

/**
 * 把第 i 项上移/下移一格。越界时原样返回——按住「上移」不放不该把第一项
 * 甩出列表，也不该悄悄把列表洗成另一个顺序。
 */
export function moveAt<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/**
 * 第 n 个（0 起）入围作品的编号。
 *
 * 与服务端 PATCH 里那段 `String(i + 1).padStart(2, '0')` 必须一致：屏上
 * 显示 NO.03 而库里写成 3，核对奖项时就会对不上。
 */
export function finalistNo(index: number): string {
  return String(index + 1).padStart(2, '0');
}
