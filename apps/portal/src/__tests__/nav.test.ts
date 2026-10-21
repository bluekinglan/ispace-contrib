import { describe, expect, it } from 'vitest';
import { isSpaPath } from '../nav';

/*
  门户里的链接点下去，是在页面里切还是交给浏览器整页去开，全看这一条。
  判错的两头都疼：该切的整页刷新就是"闪"；不该切的被拦下，控制台、已发布
  的页面就打不开了。
*/
describe('哪些地址在门户里切', () => {
  it('门户自己的几屏', () => {
    for (const p of ['/', '/foryou', '/create', '/mine', '/mine/', '/app/lixiao/paiban', '/lixiao']) {
      expect(isSpaPath(p), p).toBe(true);
    }
  });

  it('别的应用、已发布的页面、活动页，交给浏览器', () => {
    for (const p of [
      '/console', '/console/', '/1024', '/1024/judge', '/reset', '/deploy/api/me',
      '/lixiao/paiban/', '/lixiao/paiban/index.html', '/app/lixiao',
    ]) {
      expect(isSpaPath(p), p).toBe(false);
    }
  });
});
