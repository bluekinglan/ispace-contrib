import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 这个工作区能不能直接伺服出来看。
 *
 * ┌─ 为什么要有这个判定 ────────────────────────────────────────────────┐
 * │ 预览做的事只有一件：把工作区目录当静态站点伺服出去。能直接跑的页面  │
 * │ 这就够了（HTML/CSS/JS、three.js、canvas 游戏）；但有两类东西这么做  │
 * │ 出来的是**白屏或半截页面**，而白屏最糟——人会以为预览坏了，或者以为 │
 * │ 模型写的东西有问题，两个方向都是错的。                              │
 * │                                                                      │
 * │   带服务端的（Express / FastAPI…）：前端是起来了，但它要调的接口     │
 * │   没有进程在听，页面上该有数据的地方全是空的。                       │
 * │                                                                      │
 * │   要构建的（Vite / Next…）：index.html 里写的是                      │
 * │   `<script type="module" src="/src/main.tsx">`，浏览器拿到的是一份   │
 * │   没编译过的源码，当场白屏。                                         │
 * │                                                                      │
 * │ 这两类一律**不预览**，并在界面上说清楚是哪一类、下一步该干什么。     │
 * │ 平台决定不做容器运行时（见 docs/specs/2026-10-20-preview-runtime.md │
 * │ §6），所以这不是"暂时还没支持"，是定下来的边界。                     │
 * └──────────────────────────────────────────────────────────────────────┘
 */

export type PreviewKind =
  /** 能直接伺服出来跑。 */
  | 'static'
  /** 带服务端进程，预览跑不了。 */
  | 'server'
  /** 要先构建，源码直接伺服是白屏。 */
  | 'build'
  /** 还没有首页文件。 */
  | 'empty';

export interface KindVerdict {
  kind: PreviewKind;
  /** 给人看的一句话，直接显示在创建屏右栏。 */
  why: string;
  /** 据什么判的。显示在说明下面，让人能自己核对，而不是只能信结论。 */
  signals: string[];
}

/** 一眼就是服务端的文件。命中即判 server。 */
const SERVER_FILES = [
  'server.js', 'server.ts', 'server.mjs',
  'app.py', 'main.py', 'wsgi.py', 'asgi.py', 'manage.py',
  'requirements.txt', 'pyproject.toml', 'Pipfile',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'go.mod', 'Cargo.toml', 'pom.xml',
];

/** 一眼就是要构建的。命中即判 build。 */
const BUILD_FILES = [
  'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
  'webpack.config.js', 'rollup.config.js',
  'next.config.js', 'next.config.mjs', 'nuxt.config.ts',
  'svelte.config.js', 'angular.json',
];

/** package.json 的依赖里出现这些，就是服务端而不是纯前端。 */
const SERVER_DEPS = [
  'express', 'fastify', 'koa', 'hapi', '@nestjs/core',
  'next', 'nuxt', 'socket.io', 'ws', 'mongoose', 'pg', 'mysql2', 'prisma',
];

export function detectKind(workspaceDir: string): KindVerdict {
  const has = (f: string) => existsSync(join(workspaceDir, f));
  const signals: string[] = [];

  for (const f of SERVER_FILES) if (has(f)) signals.push(f);
  if (signals.length) {
    return {
      kind: 'server',
      why: '这个项目带服务端，预览只能伺服文件、起不了进程，所以不渲染它——'
        + '渲染出来也是个取不到数的半截页面。发布之后在正式地址上看；'
        + '服务端要另外在控制台「后端与数据」里开一个。',
      signals,
    };
  }

  for (const f of BUILD_FILES) if (has(f)) signals.push(f);

  /*
    package.json 本身不算信号——它可能只是一份 {name, version}。
    有依赖或有脚本才算：那说明这东西得先装、先构建，不是打开就能跑的页面。
  */
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(workspaceDir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const names = Object.keys(deps);
      const serverDep = names.find((n) => SERVER_DEPS.includes(n));
      if (serverDep) {
        return {
          kind: 'server',
          why: '这个项目带服务端，预览只能伺服文件、起不了进程，所以不渲染它。'
            + '发布之后在正式地址上看；服务端要另外在控制台「后端与数据」里开一个。',
          signals: [...signals, `package.json 依赖了 ${serverDep}`],
        };
      }
      const scripts = Object.keys(pkg.scripts ?? {});
      if (names.length) signals.push(`package.json 有 ${names.length} 个依赖`);
      if (scripts.some((s) => ['build', 'dev', 'start', 'serve'].includes(s))) {
        signals.push(`package.json 有 ${scripts.join(' / ')} 脚本`);
      }
    } catch {
      /* package.json 不是合法 JSON：当它不存在，别让一个坏文件改变判定 */
    }
  }

  if (signals.length) {
    return {
      kind: 'build',
      why: '这个项目要先构建才能跑（源码直接打开是白屏），预览不做构建，所以不渲染它。'
        + '想在预览里看见效果的话，让它改成能直接打开的单页面——'
        + '这个平台本来就推荐那种写法。',
      signals,
    };
  }

  if (!has('index.html')) {
    return {
      kind: 'empty',
      why: '工作区里还没有 index.html。等它写出来，这里会自动刷新。',
      signals: [],
    };
  }

  return { kind: 'static', why: '能直接打开的页面，照常预览。', signals: [] };
}
