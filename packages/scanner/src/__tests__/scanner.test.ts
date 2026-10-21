import { describe, expect, it } from 'vitest';
import { adviceFor, basePathFindings, checkBasePath, scanContent } from '../index.js';

describe('密钥扫描', () => {
  it('拦下 AWS Access Key ID', () => {
    const r = scanContent('const k = "AKIAIOSFODNN7EXAMPLE";');
    expect(r.ok).toBe(false);
    expect(r.findings[0]?.rule).toBe('aws-access-key-id');
  });

  it('拦下私钥块', () => {
    const r = scanContent('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
    expect(r.ok).toBe(false);
  });

  it('拦下数据库连接串中的口令', () => {
    const r = scanContent('DATABASE_URL=postgres://admin:s3cr3tpw@db:5432/app');
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.rule === 'postgres-url-with-password')).toBe(true);
  });

  it('命中片段被遮蔽——审计日志里不能留明文密钥', () => {
    const r = scanContent('const k = "AKIAIOSFODNN7EXAMPLE";');
    const excerpt = r.findings[0]!.excerpt;
    expect(excerpt).not.toContain('IOSFODNN7EXAM');
    expect(excerpt).toMatch(/^AKIA\*+MPLE$/);
  });
});

describe('Supabase key 的区别对待', () => {
  // 这一对是本平台最关键的规则：anon key 出现在前端产物里是正常的，
  // service_role key 出现则等于交出整个数据 schema 的写权限。
  const makeJwt = (role: string) => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
  };

  it('放行 anon key', () => {
    const r = scanContent(`const key = "${makeJwt('anon')}";`);
    expect(r.findings.some((f) => f.rule === 'jwt-with-service-role')).toBe(false);
  });

  it('拦下 service_role key', () => {
    const r = scanContent(`const key = "${makeJwt('service_role')}";`);
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.rule === 'jwt-with-service-role')).toBe(true);
  });
});

describe('误报抑制', () => {
  it('放行明显的占位值', () => {
    for (const line of [
      'password: "your-password-here"',
      'apiKey: "xxxxxxxxxxxx"',
      'token: "<YOUR_TOKEN>"',
      'secret: "changeme123"',
    ]) {
      const r = scanContent(line);
      expect(r.findings.some((f) => f.rule === 'generic-password-assignment'), line).toBe(false);
    }
  });

  it('但真实口令仍要拦', () => {
    const r = scanContent('password: "Kx9#mQ2vLp8w"');
    expect(r.ok).toBe(false);
  });
});

describe('XSS 基础规则', () => {
  it('拦下从变量赋值的 innerHTML', () => {
    const r = scanContent('el.innerHTML = userInput;');
    expect(r.findings.some((f) => f.rule === 'innerHTML-from-variable')).toBe(true);
  });

  it('放行常量赋值的 innerHTML——模板拼静态 HTML 很常见，一律拦会误伤', () => {
    const r = scanContent('el.innerHTML = "<b>hello</b>";');
    expect(r.findings.some((f) => f.rule === 'innerHTML-from-variable')).toBe(false);
  });

  it('拦下内联事件里的 eval', () => {
    const r = scanContent('<button onclick="eval(x)">go</button>');
    expect(r.ok).toBe(false);
  });
});

describe('base path 校验', () => {
  it('放行相对路径——这是脚手架模板注入 base 后的正确形态', () => {
    const html = '<script src="./assets/main.js"></script><link href="assets/x.css">';
    expect(checkBasePath(html).ok).toBe(true);
  });

  it('拦下根绝对路径——子路径部署下会 404', () => {
    const html = '<script src="/assets/main.js"></script>';
    const r = checkBasePath(html);
    expect(r.ok).toBe(false);
    expect(r.offenders).toEqual(['/assets/main.js']);
  });

  it('放行外链', () => {
    const html = '<script src="https://cdn.example.com/x.js"></script><img src="//cdn/y.png">';
    expect(checkBasePath(html).ok).toBe(true);
  });
});

describe('扫描不会因异常输入卡死', () => {
  it('零宽匹配不造成死循环', () => {
    const r = scanContent('a'.repeat(5000));
    expect(r.ok).toBe(true);
  });

  it('多行内容逐行定位准确', () => {
    const r = scanContent('line1\nline2\nconst k="AKIAIOSFODNN7EXAMPLE";');
    expect(r.findings[0]?.line).toBe(3);
  });
});

describe('给发布前自检用的两样东西', () => {
  it('每条内置规则都有一句改法——只给规则名，模型会去骗正则而不是修', () => {
    const r = scanContent([
      'el.innerHTML = data.name;',
      'document.write(html);',
      'const k = "AKIAIOSFODNN7EXAMPLE";',
    ].join('\n'));
    for (const f of r.findings) {
      expect(adviceFor(f.rule)).not.toMatch(/按规则名检查/);
    }
    expect(adviceFor('innerHTML-from-variable')).toContain('textContent');
  });

  it('gitleaks 的规则与未知规则都有兜底的话，不会是空串', () => {
    expect(adviceFor('gitleaks:generic-api-key')).toContain('连接器');
    expect(adviceFor('something-new')).toBeTruthy();
  });

  it('根绝对路径带回行号，外链与相对路径不算', () => {
    const html = [
      '<!doctype html>',
      '<link href="./a.css" rel="stylesheet">',
      '<script src="/assets/main.js"></script>',
      '<img src="//cdn/x.png"><img src="/logo.png">',
    ].join('\n');
    const fs = basePathFindings(html);
    expect(fs.map((f) => `${f.line}:${f.excerpt}`)).toEqual(['3:/assets/main.js', '4:/logo.png']);
    expect(fs.every((f) => f.rule === 'base-path')).toBe(true);
  });
});
