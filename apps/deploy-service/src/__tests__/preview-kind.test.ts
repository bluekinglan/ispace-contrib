import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectKind } from '../services/preview-kind.js';

/**
 * 「这个工作区能不能直接伺服出来看」的判定。
 *
 * 平台决定不做容器运行时（见 docs/specs/2026-10-20-preview-runtime.md §6），
 * 所以预览只伺服文件。带服务端的、要构建的，伺服出去是半截页面或白屏——
 * 白屏最糟，人会以为预览坏了或者模型写的东西有问题，两个方向都是错的。
 * 这一组钉住判定的边界，免得以后"顺手放宽一点"又把白屏放进来。
 */
describe('工作区类型判定', () => {
  /** 建一个临时工作区，files 是 {相对路径: 内容}。 */
  const ws = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ispace-kind-'));
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    }
    return dir;
  };

  it('纯 HTML/JS/CSS 就是能直接跑的那种', () => {
    const d = ws({
      'index.html': '<h1>hi</h1>',
      'main.js': 'console.log(1)',
      'style.css': 'body{}',
    });
    expect(detectKind(d).kind).toBe('static');
  });

  it('three.js 这类带资源的也照样是 static——它只是文件多', () => {
    const d = ws({
      'index.html': '<canvas></canvas>',
      'app.js': 'new THREE.Scene()',
      'models/ship.glb': 'binary',
    });
    expect(detectKind(d).kind).toBe('static');
  });

  it('还没写出首页 → empty，不是报错', () => {
    const d = ws({ 'notes.txt': '想法' });
    const v = detectKind(d);
    expect(v.kind).toBe('empty');
    expect(v.why).toContain('index.html');
  });

  it.each([
    'server.js', 'app.py', 'main.py', 'requirements.txt',
    'pyproject.toml', 'Dockerfile', 'docker-compose.yml', 'go.mod',
  ])('带服务端的信号 %s → server', (f) => {
    const d = ws({ 'index.html': '<h1>hi</h1>', [f]: 'x' });
    const v = detectKind(d);
    expect(v.kind).toBe('server');
    expect(v.signals).toContain(f);
    // 话里必须说清楚下一步干什么，不能只说"不支持"
    expect(v.why).toContain('发布之后');
  });

  it('package.json 依赖了 express → server，哪怕没有 server.js', () => {
    const d = ws({
      'index.html': '<h1>hi</h1>',
      'package.json': JSON.stringify({ dependencies: { express: '^4' } }),
    });
    const v = detectKind(d);
    expect(v.kind).toBe('server');
    expect(v.signals.join()).toContain('express');
  });

  it.each(['vite.config.ts', 'webpack.config.js', 'next.config.js'])(
    '要构建的信号 %s → build',
    (f) => {
      const d = ws({ 'index.html': '<script src="/src/main.tsx"></script>', [f]: 'x' });
      const v = detectKind(d);
      expect(v.kind).toBe('build');
      expect(v.why).toContain('白屏');
    },
  );

  it('有依赖或有脚本的 package.json → build（装都没装，直接伺服是白屏）', () => {
    const d = ws({
      'index.html': '<h1>hi</h1>',
      'package.json': JSON.stringify({ dependencies: { react: '^18' }, scripts: { build: 'vite build' } }),
    });
    expect(detectKind(d).kind).toBe('build');
  });

  it('只写了名字版本的 package.json 不算信号——它可能只是一份元数据', () => {
    const d = ws({
      'index.html': '<h1>hi</h1>',
      'package.json': JSON.stringify({ name: 'my-page', version: '1.0.0' }),
    });
    expect(detectKind(d).kind).toBe('static');
  });

  it('package.json 不是合法 JSON 时当它不存在——一个坏文件不该改变判定', () => {
    const d = ws({ 'index.html': '<h1>hi</h1>', 'package.json': '{ 这不是 json' });
    expect(detectKind(d).kind).toBe('static');
  });

  it('服务端信号压过构建信号——两样都有时说的是更要紧的那件事', () => {
    const d = ws({
      'index.html': '<h1>hi</h1>',
      'vite.config.ts': 'x',
      'server.js': 'require("express")',
    });
    expect(detectKind(d).kind).toBe('server');
  });

  it('工作区目录根本不存在时不抛，按 empty 处理', () => {
    expect(detectKind(join(tmpdir(), 'ispace-kind-does-not-exist-12345')).kind).toBe('empty');
  });
});
