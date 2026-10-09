/**
 * Adapter health — 每个适配器的命中 / 丢弃计数。
 *
 * 站点改版会让适配器静默失效，丢掉整段历史（docs/adr/0003、0006）。判定这件事
 * 本身必须可测，所以它住在这里，而不是散在 main.js 的闭包里。
 *
 * 记的是**适配器**，不是站点：内置的平台适配器不绑域名（ADR-0006），只有按
 * 适配器记，「一个从没产出过身份键的适配器」才是可见的。已加载的适配器先各占一行，
 * 从未见过的也能在界面上被看见。
 *
 * 一次访问记到谁头上：
 *   - 适配器认下了 → 看它有没有解析出**身份字段**（站点改版打坏 parse 正是这一路）
 *   - 没有适配器认下，但这个域名以前被某个适配器认过 → 归到那个适配器
 *     （平台签名被改掉后 detect 落空，不这么归因，「签名被改掉」就静默了，ADR-0006）
 *   - 其余 → 按站点记（用户自己写的正则闸门）
 *
 * ponytail: 计数只在内存里，重启即清零。要求是可见，不是跨重启的历史；
 * 要留存时再加一张表。
 */

// 连续丢弃达到这个数（含从未命中过的），就认为适配器已失效。
const SUSPECT_DROPPED = 20;

// `identity.js` 的 extractKeys 只从这几个字段产出**可合并**的身份键；
// 适配器其余字段（如 edition）在不在，不代表它还能认出作品。
const IDENTITY_FIELDS = ["code", "cover", "desc"];

/**
 * @param {Array<Object>} [adapters] 已加载的适配器（`file` / `name`）；先各占一行
 */
function createAdapterHealth(adapters = []) {
  /** @type {Map<string, {key:string, label:string, kind:string, matched:number, dropped:number, sinceHit:number}>} */
  const stats = new Map();
  /** 域名 → 上次认下它的适配器。签名被改掉后仍能把失败归因（ADR-0006）。 */
  const lastAdapterByDomain = new Map();

  function ensure(key, label, kind) {
    let s = stats.get(key);
    if (!s) {
      s = { key, label: label || key, kind: kind || "site", matched: 0, dropped: 0, sinceHit: 0 };
      stats.set(key, s);
    }
    return s;
  }

  for (const a of adapters) {
    if (a && a.file) ensure(a.file, a.name || a.file, "adapter");
  }

  function note(key, matched, kind) {
    const k = key || "(unknown)";
    const s = ensure(k, undefined, kind);
    if (matched) {
      s.matched++;
      s.sinceHit = 0;
    } else {
      s.dropped++;
      s.sinceHit++;
    }
  }

  return {
    /** 记一次适配器结果。matched=false 表示这一页被闸门丢弃或适配器没解析出东西。 */
    note,

    /**
     * 一条 `RecordStore.recordVisit` 的结果怎么记。
     * @param {Object} result recordVisit 的返回值
     * @param {string} domain 上报的域名（没有适配器时的 key）
     */
    noteVisit(result, domain) {
      if (result && result.adapter) {
        const parsed = result.parsed || {};
        const produced = IDENTITY_FIELDS.some((f) => parsed[f] != null && parsed[f] !== "");
        note(result.adapter.file, produced, "adapter");
        if (domain) lastAdapterByDomain.set(domain, result.adapter.file);
        return;
      }
      // 没有适配器认下：这个域名以前被某个适配器认过 → 签名被改版打掉了，算它的账。
      // 闸门丢弃（用户自己写的正则）不算适配器的账，仍按站点记。
      const remembered =
        domain && result && result.action !== "drop" ? lastAdapterByDomain.get(domain) : null;
      if (remembered) note(remembered, false, "adapter");
      else note(domain, !!result && result.action !== "drop");
    },

    /** 按丢弃数降序的只读快照；suspect 表示**连续**丢弃达到 SUSPECT_DROPPED 条。 */
    snapshot() {
      return Array.from(stats.values())
        .map((s) => ({
          key: s.key,
          label: s.label,
          kind: s.kind,
          matched: s.matched,
          dropped: s.dropped,
          suspect: s.sinceHit >= SUSPECT_DROPPED,
        }))
        .sort((a, b) => b.dropped - a.dropped || a.key.localeCompare(b.key));
    },
  };
}

module.exports = { createAdapterHealth, SUSPECT_DROPPED };
