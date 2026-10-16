import { describe, expect, it } from 'vitest';
import { adminSetPasswordRequestSchema, adminUpdateUserRequestSchema } from '../api.js';

/**
 * 管理员替别人改资料、设密码。
 *
 * 这两张 schema 决定了「管理员能动别人账号的哪些部分」，是一条权限边界。
 * 往里加字段很容易——加之前先看一眼这里钉住的东西为什么在这儿。
 */

describe('管理员改资料', () => {
  it('显示名和邮箱可以分开改，只传要改的那个', () => {
    expect(adminUpdateUserRequestSchema.parse({ displayName: '李骁' }))
      .toEqual({ displayName: '李骁' });
    expect(adminUpdateUserRequestSchema.parse({ email: 'lixiao@example.com' }))
      .toEqual({ email: 'lixiao@example.com' });
  });

  it('邮箱统一转小写——登录是按 lower(email) 查的', () => {
    expect(adminUpdateUserRequestSchema.parse({ email: 'LiXiao@Example.COM' }).email)
      .toBe('lixiao@example.com');
  });

  it('邮箱可以清成 null，那样这个人只能靠管理员发链接进来', () => {
    expect(adminUpdateUserRequestSchema.parse({ email: null })).toEqual({ email: null });
  });

  /*
    username 不在这张表里，而且不是疏忽：它派生出 Postgres schema
    u_{username}、/srv/sites/{username}/ 和所有对外链接 /{username}/{app}/。
    改名要把三样一起搬，搬 schema 还要动 pgrst.db_schemas——那一步出错会让
    PostgREST 对所有人返回 503。夹带进来也不会生效，这条测试是给将来想
    「顺手加一个」的人看的。
  */
  it('夹带 username 不会生效', () => {
    expect(adminUpdateUserRequestSchema.parse({ displayName: '李骁', username: 'other' }))
      .toEqual({ displayName: '李骁' });
  });

  it('什么都不传要报错，而不是悄悄发一个空更新', () => {
    expect(adminUpdateUserRequestSchema.safeParse({}).success).toBe(false);
  });

  it('空白显示名、坏邮箱都不收', () => {
    expect(adminUpdateUserRequestSchema.safeParse({ displayName: '  ' }).success).toBe(false);
    expect(adminUpdateUserRequestSchema.safeParse({ email: '不是邮箱' }).success).toBe(false);
  });
});

describe('管理员直接设密码', () => {
  it('收一个密码字符串', () => {
    expect(adminSetPasswordRequestSchema.parse({ password: 'Corre!tHorse9' }))
      .toEqual({ password: 'Corre!tHorse9' });
  });

  /*
    这里只做形态校验，长度和复杂度交给处理器里的 checkPasswordStrength，
    因为真正的下限来自平台设置（platform_policy.password_min_length），
    管理员在控制台能改。在 schema 里写死一个数字，就等于让那个设置对这条
    路径失效——注册那条路上已经因为写死 12 踩过一次，报的还是句英文。
  */
  it('长度下限不写在这里：它来自平台设置，由处理器判', () => {
    expect(adminSetPasswordRequestSchema.safeParse({ password: 'ab' }).success).toBe(true);
    expect(adminSetPasswordRequestSchema.safeParse({ password: '' }).success).toBe(false);
  });
});
