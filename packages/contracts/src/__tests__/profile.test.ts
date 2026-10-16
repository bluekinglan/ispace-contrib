import { describe, expect, it } from 'vitest';
import { avatarUrlFor, updateProfileRequestSchema } from '../api.js';

/**
 * 头像地址与「自己能改哪些资料」。
 *
 * 这两件事都靠约定而不是类型保证：地址里那个 ?v= 没人盯着就会被顺手去掉，
 * 而「能改哪些字段」是一张随时可能被加一行的 schema。所以钉在测试里。
 */

describe('头像地址', () => {
  it('没传过头像就是 null，调用方据此回落到首字母', () => {
    expect(avatarUrlFor('lixiao', null)).toBeNull();
    expect(avatarUrlFor('lixiao', undefined)).toBeNull();
    // 空串也算没有：生成列算不出空内容的 md5，真出现说明数据是坏的
    expect(avatarUrlFor('lixiao', '')).toBeNull();
  });

  it('带上内容指纹，换了头像地址就不一样', () => {
    const a = avatarUrlFor('lixiao', 'aaaa1111');
    const b = avatarUrlFor('lixiao', 'bbbb2222');
    expect(a).toBe('/deploy/api/users/lixiao/avatar?v=aaaa1111');
    expect(a).not.toBe(b);
  });

  /*
    这一条是整个缓存策略的支点：响应头写的是 immutable + 一年，
    地址里没有版本号的话，换了头像一年之内都刷不出来。
  */
  it('同样的内容给同样的地址——否则每次渲染都要重新下载', () => {
    expect(avatarUrlFor('lixiao', 'aaaa1111')).toBe(avatarUrlFor('lixiao', 'aaaa1111'));
  });
});

describe('自己能改的资料', () => {
  it('只收显示名', () => {
    const r = updateProfileRequestSchema.parse({ displayName: '李骁' });
    expect(r).toEqual({ displayName: '李骁' });
  });

  /*
    username 改了会让所有已发布页面的地址失效，email 是登录和找回密码认的
    那一个——两者都只能由管理员在控制台改。zod 默认丢掉未声明的键，所以
    多传也不会生效；这条测试钉的是"将来有人往 schema 里加字段时要先看见
    这段注释"。
  */
  it('夹带 username / email 不会生效', () => {
    const r = updateProfileRequestSchema.parse({
      displayName: '李骁', username: 'someone-else', email: 'other@example.com',
    });
    expect(r).toEqual({ displayName: '李骁' });
  });

  it('空白名字不收——顶栏会变成一个没有字的圆圈', () => {
    expect(updateProfileRequestSchema.safeParse({ displayName: '   ' }).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ displayName: '' }).success).toBe(false);
  });

  it('前后空格去掉再存', () => {
    expect(updateProfileRequestSchema.parse({ displayName: '  李骁  ' }).displayName).toBe('李骁');
  });

  it('超过 64 字不收', () => {
    expect(updateProfileRequestSchema.safeParse({ displayName: 'x'.repeat(65) }).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ displayName: 'x'.repeat(64) }).success).toBe(true);
  });
});
