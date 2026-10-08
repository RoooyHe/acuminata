/**
 * Adapter health — 每个站点的适配器命中 / 丢弃计数。
 *
 * 站点改版会让适配器正则静默失效，丢掉整段历史（docs/adr/0003、0006）。
 * 判定「连续丢弃且从未命中」这件事本身必须可测，所以它住在这里，
 * 而不是散在 main.js 的闭包里。
 *
 * ponytail: 计数只在内存里，重启即清零。要求是可见，不是跨重启的历史；
 * 要留存时再加一张表。
 */

// 从未命中、且丢弃达到这个数，就认为适配器已失效。
const SUSPECT_DROPPED = 20;

function createAdapterHealth() {
  /** @type {Map<string, {matched:number, dropped:number}>} */
  const stats = new Map();

  return {
    /** 记一次适配器结果。matched=false 表示这一页被闸门丢弃（no-rule-match）。 */
    note(domain, matched) {
      const key = domain || "(unknown)";
      let s = stats.get(key);
      if (!s) {
        s = { matched: 0, dropped: 0 };
        stats.set(key, s);
      }
      if (matched) s.matched++;
      else s.dropped++;
    },

    /** 按丢弃数降序的只读快照；suspect 表示从未命中且已连续丢弃 SUSPECT_DROPPED 条。 */
    snapshot() {
      return Array.from(stats.entries())
        .map(([domain, s]) => ({
          domain,
          matched: s.matched,
          dropped: s.dropped,
          suspect: s.matched === 0 && s.dropped >= SUSPECT_DROPPED,
        }))
        .sort((a, b) => b.dropped - a.dropped || a.domain.localeCompare(b.domain));
    },
  };
}

module.exports = { createAdapterHealth, SUSPECT_DROPPED };
