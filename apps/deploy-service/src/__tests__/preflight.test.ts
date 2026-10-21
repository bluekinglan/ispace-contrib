import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preflight } from '../services/preflight.js';

/**
 * 发布前自检跑的就是发布链路那一套。这几条钉住"同一套"的几个容易走样的地方：
 * 草稿目录不算产物、产物根在 dist/ 时路径要换算回工作区、根绝对路径要给行号。
 */

const make = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'ispace-pre-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
};

describe('发布前自检', () => {
  it('干净的工作区没有命中', async () => {
    const r = await preflight(make({ 'index.html': '<h1>hi</h1><script src="./a.js"></script>', 'a.js': 'el.textContent = x;' }));
    expect(r).toEqual({ findings: [] });
  });

  it('tianqi 那一类：innerHTML = 变量，带回文件、行号、规则与改法', async () => {
    const r = await preflight(make({
      'index.html': '<h1>天气</h1>\n<script>\nconst box = document.body;\nbox.innerHTML = data.html;\n</script>',
    }));
    expect(r.findings).toEqual([{
      file: 'index.html', line: 4, rule: 'innerHTML-from-variable',
      advice: expect.stringContaining('textContent'),
    }]);
  });

  it('根绝对路径带行号报出来——发布时同样会因它被拒', async () => {
    const r = await preflight(make({ 'index.html': '<!doctype html>\n<script src="/assets/x.js"></script>' }));
    expect(r.findings).toEqual([expect.objectContaining({ file: 'index.html', line: 2, rule: 'base-path' })]);
  });

  it('_fanout 这类草稿不算产物，里面写了什么都不报', async () => {
    const r = await preflight(make({
      'index.html': '<h1>ok</h1>',
      '_fanout/ab/mono/index.html': '<script>x.innerHTML = y</script>',
    }));
    expect(r.findings).toEqual([]);
  });

  it('产物根是 dist/ 时，路径换算回相对工作区', async () => {
    const r = await preflight(make({
      'dist/index.html': '<h1>ok</h1>',
      'dist/app.js': 'const k = "AKIAIOSFODNN7EXAMPLE";',
    }));
    expect(r.findings[0]).toMatchObject({ file: 'dist/app.js', line: 1, rule: 'aws-access-key-id' });
  });

  it('认不出产物（还没有 index.html）时转述发布链路的那句话，不抛', async () => {
    const r = await preflight(make({ 'readme.md': '# 还没写' }));
    expect(r.findings).toEqual([]);
    expect(r.error).toContain('index.html');
    expect((await preflight('/nonexistent/ws')).error).toContain('空的');
  });
});
