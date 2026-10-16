import { describe, expect, it } from 'vitest';
import { mergeMarketResults, type MarketItem, type MarketResult } from '../market-state';

const item = (kind: MarketItem['kind'], id: string, installs = 1) => ({
  kind, id, install_count: installs, published_at: '2026-01-01',
}) as MarketItem;
const ok = (value: MarketItem[]): MarketResult => ({ status: 'fulfilled', value });
const failed: MarketResult = { status: 'rejected', reason: new Error('offline') };

describe('market loading state', () => {
  it('distinguishes a failed first load from a successful empty market', () => {
    expect(mergeMarketResults([], failed, failed)).toEqual({
      items: [], errors: ['页面市场加载失败', '后端市场加载失败'],
    });
    expect(mergeMarketResults([], ok([]), ok([]))).toEqual({ items: [], errors: [] });
  });

  it.each(['app', 'backend'] as const)('keeps cached %s entries when that source fails', (kind) => {
    const cached = item(kind, 'cached');
    const fresh = item(kind === 'app' ? 'backend' : 'app', 'fresh', 5);
    const result = mergeMarketResults([cached],
      kind === 'app' ? failed : ok([fresh]), kind === 'backend' ? failed : ok([fresh]));
    expect(result.items).toEqual([fresh, cached]);
    expect(result.errors).toHaveLength(1);
  });

  it('clears old data and errors after a successful empty retry', () => {
    expect(mergeMarketResults([item('app', 'old')], ok([]), ok([])))
      .toEqual({ items: [], errors: [] });
  });

  it('retains all cached data when both refreshes fail', () => {
    const previous = [item('app', 'a', 3), item('backend', 'b')];
    expect(mergeMarketResults(previous, failed, failed).items).toEqual(previous);
  });

  it('merges and sorts successful sources by installs then publish date', () => {
    const older = item('app', 'old');
    const newer = { ...item('backend', 'new'), published_at: '2026-02-01' };
    expect(mergeMarketResults([], ok([older]), ok([newer])).items).toEqual([newer, older]);
  });
});
