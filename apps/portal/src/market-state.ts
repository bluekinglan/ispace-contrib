import type { Listing, BackendListing } from './api';

export type MarketItem = ({ kind: 'app' } & Listing) | ({ kind: 'backend' } & BackendListing);
export type MarketResult = PromiseSettledResult<MarketItem[]>;

export function mergeMarketResults(previous: MarketItem[], apps: MarketResult, backends: MarketResult) {
  const errors: string[] = [];
  const items = ([['app', apps, '页面'], ['backend', backends, '后端']] as const)
    .flatMap(([kind, result, label]) => {
      if (result.status === 'fulfilled') return result.value;
      errors.push(`${label}市场加载失败`);
      return previous.filter((item) => item.kind === kind);
    })
    .sort((a, b) => b.install_count - a.install_count
      || +new Date(b.published_at) - +new Date(a.published_at));
  return { items, errors };
}
