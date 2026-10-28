import { identityClaimsSchema, type AuthProvider, type IdentityClaims } from './provider.js';

/** Enterprise self-built Feishu application; all credentials stay on the server. */
export class FeishuAuthProvider implements AuthProvider {
  readonly name = 'feishu';
  constructor(private readonly cfg: { appId: string; appSecret: string; tenantKey: string }) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const query = new URLSearchParams({ client_id: this.cfg.appId, redirect_uri: redirectUri, state, response_type: 'code' });
    return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${query}`;
  }

  async exchange({ code, redirectUri }: { code: string; redirectUri: string }): Promise<IdentityClaims> {
    const tokens = await this.json('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: this.cfg.appId,
        client_secret: this.cfg.appSecret, code, redirect_uri: redirectUri }),
    });
    if (tokens.code !== 0 || typeof tokens.access_token !== 'string' || !tokens.access_token) {
      throw new Error('飞书授权码交换失败，请重新发起登录');
    }
    const response = await this.json('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const info = response.data as Record<string, unknown> | undefined;
    if (response.code !== 0 || !info || info.tenant_key !== this.cfg.tenantKey) {
      throw new Error('请使用本公司飞书账号登录');
    }
    if (typeof info.open_id !== 'string' || !info.open_id) throw new Error('飞书未返回有效用户标识');
    // open_id is scoped to this application. Include app and tenant to prevent collisions.
    const email = typeof info.enterprise_email === 'string' && info.enterprise_email
      ? info.enterprise_email : undefined;
    return identityClaimsSchema.parse({
      sub: `feishu|${this.cfg.appId}|${this.cfg.tenantKey}|${info.open_id}`,
      name: typeof info.name === 'string' && info.name ? info.name : '飞书员工',
      email, preferredUsername: email?.split('@')[0]?.toLowerCase(),
      role: 'employee', identity: 'user',
      raw: { provider: 'feishu', tenantKey: info.tenant_key, openId: info.open_id },
    });
  }

  private async json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    // Never include upstream responses: they may contain credentials or personal data.
    if (!response.ok) throw new Error('飞书授权服务暂时不可用，请稍后重试');
    return await response.json() as Record<string, unknown>;
  }
}
