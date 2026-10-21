import { describe, expect, it } from 'vitest';
import { inline, parseMarkdown, safeHref } from '../md';

describe('对话里的 Markdown', () => {
  it('标题、段落、换行保留', () => {
    expect(parseMarkdown('## 改了什么\n第一行\n第二行')).toEqual([
      { t: 'h', level: 2, c: [{ t: 'text', v: '改了什么' }] },
      { t: 'p', c: [{ t: 'text', v: '第一行' }, { t: 'br' }, { t: 'text', v: '第二行' }] },
    ]);
  });

  it('行内：粗体、斜体、代码、删除线', () => {
    expect(inline('把 **标题** 改成 `h2`，*顺便* ~~删掉~~')).toEqual([
      { t: 'text', v: '把 ' },
      { t: 'strong', c: [{ t: 'text', v: '标题' }] },
      { t: 'text', v: ' 改成 ' },
      { t: 'code', v: 'h2' },
      { t: 'text', v: '，' },
      { t: 'em', c: [{ t: 'text', v: '顺便' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: '删掉' }] },
    ]);
  });

  it('代码块；流式输出时还没收尾的 ``` 也当代码块', () => {
    expect(parseMarkdown('```js\nconst a = 1;\n```\n后话')).toEqual([
      { t: 'code', lang: 'js', v: 'const a = 1;' },
      { t: 'p', c: [{ t: 'text', v: '后话' }] },
    ]);
    expect(parseMarkdown('看这段：\n```html\n<div>')).toEqual([
      { t: 'p', c: [{ t: 'text', v: '看这段：' }] },
      { t: 'code', lang: 'html', v: '<div>' },
    ]);
  });

  it('有序/无序列表，一层嵌套', () => {
    const b = parseMarkdown('1. 第一步\n2. 第二步\n   - 细节\n3. 第三步');
    expect(b).toHaveLength(1);
    const list = b[0] as Extract<typeof b[0], { t: 'list' }>;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(3);
    expect(list.items[1]![1]).toMatchObject({ t: 'list', ordered: false });
  });

  it('表格与对齐', () => {
    const [t] = parseMarkdown('| 城市 | 数量 |\n|:--|--:|\n| 杭州 | 42 |\n| 宁波 | 7 |');
    expect(t).toMatchObject({
      t: 'table',
      align: ['left', 'right'],
      head: [[{ t: 'text', v: '城市' }], [{ t: 'text', v: '数量' }]],
    });
    expect((t as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it('引用与分隔线', () => {
    expect(parseMarkdown('> 注意\n\n---')).toEqual([
      { t: 'quote', c: [{ t: 'p', c: [{ t: 'text', v: '注意' }] }] },
      { t: 'hr' },
    ]);
  });

  it('链接只放行 http(s)、mailto 与相对路径；javascript: 原样当文字', () => {
    expect(inline('[看](https://a.com)')).toEqual([{ t: 'link', href: 'https://a.com', c: [{ t: 'text', v: '看' }] }]);
    expect(inline('[点我](javascript:alert(1))')[0]).toMatchObject({ t: 'text' });
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('//evil.com')).toBeNull();
    expect(safeHref('./assets/a.png')).toBe('./assets/a.png');
  });

  it('裸网址自动成链接，不吞掉后面的中文标点', () => {
    expect(inline('打开 https://ispace.example.com/lixiao/zhoubao/。')).toEqual([
      { t: 'text', v: '打开 ' },
      { t: 'link', href: 'https://ispace.example.com/lixiao/zhoubao/', c: [{ t: 'text', v: 'https://ispace.example.com/lixiao/zhoubao/' }] },
      { t: 'text', v: '。' },
    ]);
  });

  it('HTML 只是文字：解析结果里没有任何能被当成标签执行的东西', () => {
    expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([
      { t: 'p', c: [{ t: 'text', v: '<img src=x onerror=alert(1)>' }] },
    ]);
  });

  it('snake_case 里的下划线不当斜体', () => {
    expect(inline('改 user_name_field')).toEqual([{ t: 'text', v: '改 user_name_field' }]);
  });
});
