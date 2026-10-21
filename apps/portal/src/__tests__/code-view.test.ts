import { describe, expect, it } from 'vitest';
import { badgeOf, highlightLines, langOf, type Tok } from '../code-view';
import { treeRows } from '../workbench';

/** 把一行 token 写成 "种类:文字" 的数组，只留有种类的，方便断言。 */
const kinds = (line: Tok[]) => line.filter((t) => t.k).map((t) => `${t.k}:${t.v}`);
/** 拼回去必须和原文一字不差——高亮只能加颜色，不能吃字。 */
const joined = (lines: Tok[][]) => lines.map((l) => l.map((t) => t.v).join('')).join('\n');

describe('语法高亮', () => {
  it('HTML：标签、属性、属性值、注释各有颜色，拼回去一字不差', () => {
    const src = '<!-- 顶栏 -->\n<div class="topbar" hidden>\n  <h1>年会抽奖</h1>\n</div>';
    const lines = highlightLines(src, 'html');
    expect(joined(lines)).toBe(src);
    expect(kinds(lines[0]!)).toEqual(['com:<!-- 顶栏 -->']);
    expect(kinds(lines[1]!)).toEqual(['punc:<', 'tag:div', 'attr:class', 'punc:=', 'str:"topbar"', 'attr:hidden', 'punc:>']);
    expect(kinds(lines[3]!)).toEqual(['punc:</', 'tag:div', 'punc:>']);
  });

  it('HTML 里的 <style> 按 CSS、<script> 按 JS 高亮', () => {
    const src = '<style>.a{color:#fff}</style><script>const n = 1;</script>';
    const line = highlightLines(src, 'html')[0]!;
    expect(kinds(line)).toEqual(expect.arrayContaining(['sel:.a', 'prop:color', 'num:#fff', 'kw:const', 'num:1']));
    expect(joined([line])).toBe(src);
  });

  it('CSS：选择器、属性、数值单位、颜色、@规则、注释；伪类不被当成属性', () => {
    const src = '/* 主色 */\n@media (max-width: 600px) {\n  a:hover { margin: 0 12px; color: #b93b07 !important; }\n}';
    const lines = highlightLines(src, 'css');
    expect(joined(lines)).toBe(src);
    expect(kinds(lines[0]!)).toEqual(['com:/* 主色 */']);
    expect(kinds(lines[1]!)).toContain('at:@media');
    expect(kinds(lines[2]!)).toEqual(expect.arrayContaining(['sel:a:hover ', 'prop:margin', 'num:12px', 'num:#b93b07', 'kw:!important']));
  });

  it('JS：关键字、字符串、数字、注释、函数名、字面量；块注释跨行也对', () => {
    const src = 'async function draw(n) {\n  /* 抽 n 个\n     人 */\n  return list.slice(0, n) ?? null; // 完\n}';
    const lines = highlightLines(src, 'js');
    expect(joined(lines)).toBe(src);
    expect(kinds(lines[0]!)).toEqual(['kw:async', 'kw:function', 'fn:draw']);
    expect(kinds(lines[1]!)).toEqual(['com:/* 抽 n 个']);
    expect(kinds(lines[2]!)).toEqual(['com:     人 */']);
    expect(kinds(lines[3]!)).toEqual(['kw:return', 'fn:slice', 'num:0', 'lit:null', 'com:// 完']);
  });

  it('JSON：键与值分开颜色', () => {
    const line = highlightLines('{"name": "抽奖", "n": 3, "ok": true}', 'json')[0]!;
    expect(kinds(line)).toEqual(['prop:"name"', 'str:"抽奖"', 'prop:"n"', 'num:3', 'prop:"ok"', 'lit:true']);
  });

  it('Markdown：标题、行内代码、粗体、链接、代码块', () => {
    const lines = highlightLines('# 周报\n用 `npm` 跑，**注意**看[文档](x)\n```\ncode\n```', 'md');
    expect(kinds(lines[0]!)).toEqual(['hd:# 周报']);
    expect(kinds(lines[1]!)).toEqual(['code:`npm`', 'em:**注意**', 'link:[文档](x)']);
    expect(kinds(lines[3]!)).toEqual(['code:code']);
  });

  it('没闭合的字符串、注释、标签不让它卡死或吃字（模型写到一半时就是这样）', () => {
    for (const [src, lang] of [['const a = "没写完', 'js'], ['/* 没写完', 'css'], ['<div class="x', 'html']] as const) {
      expect(joined(highlightLines(src, lang))).toBe(src);
    }
  });

  it('按扩展名认语言与角标', () => {
    expect(langOf('index.html')).toBe('html');
    expect(langOf('src/app.tsx')).toBe('js');
    expect(langOf('data.json')).toBe('json');
    expect(langOf('a.bin')).toBe('text');
    expect(badgeOf('style.css').label).toBe('CSS');
    expect(badgeOf('assets/hero.webp').label).toBe('IMG');
    expect(badgeOf('README').label).toBe('TXT');
  });
});

describe('文件树', () => {
  const entries = [
    { path: '_fanout', dir: true, size: 0 },
    { path: '_fanout/a', dir: true, size: 0 },
    { path: '_fanout/a/index.html', dir: false, size: 1 },
    { path: 'assets', dir: true, size: 0 },
    { path: 'assets/logo.png', dir: false, size: 1 },
    { path: 'app.js', dir: false, size: 1 },
    { path: 'index.html', dir: false, size: 1 },
  ];

  it('目录在前、按层缩进；收起的目录不展开子孙', () => {
    const rows = treeRows(entries, new Set(['_fanout']));
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`)).toEqual([
      '_fanout', 'assets', '  logo.png', 'app.js', 'index.html',
    ]);
  });

  it('全展开时嵌套目录也摆对', () => {
    expect(treeRows(entries, new Set()).map((r) => r.path)).toEqual([
      '_fanout', '_fanout/a', '_fanout/a/index.html', 'assets', 'assets/logo.png', 'app.js', 'index.html',
    ]);
  });
});
