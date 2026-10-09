/**
 * 访问写入路径上的**纯规则**，无 DB、无副作用。
 *
 * 这里只放能在内存里判完的规则：
 *   - 分组（适配器声明的镜像 → 同一个站点）与组内正则闸门
 *   - **命名捕获组抽取**（适配器：闸门 → 解析器，见 docs/adr/0007）
 *   - **作品身份键**的产出（任一路命中即归并）
 *   - 路径抽取、同组同路径的**去重判定**（谁算同一次访问）
 *   - 访问层每日计分与**作品层每日计分**（跨站累加）
 *
 * **身份判定不在这里**：把两次访问判成同一部作品的是身份键（identity.js）与
 * 归属（record-store.js），本模块只产出键，不下结论。
 *
 * 把这些规则按顺序串起来、并落库的那条链路只有一条，在
 * `RecordStore.recordVisit`：闸门 → 身份键 → 去重 → 当日计分 → 作品归属 → 落库。
 * 链路不在这里，因为「查重」与「落库」都要读库；把它们交给调用方做，
 * 就得到了一条谁也没测过的调用顺序。
 */

const { extractKeys } = require("./identity");
const { detectBySignature } = require("../shared/page-collect");
const { builtinFields, identityForFields } = require("./adapter");

/** 一个站点的显示名：登记条目上的 label 优先，认不出就用域名。分组不再看它。 */
function resolveGroupLabel(matchedRule, domain, watchlist) {
  const currentWatch = watchlist.find((w) => w.domain === matchedRule);
  return currentWatch ? currentWatch.label || domain : domain;
}

/**
 * 一个域名的镜像组：适配器 `mirrors` 里包含它的那一组。
 *
 * `mirrors` 是若干域名组，每组是一个站点的原站与镜像（`[["a.com","b.com"]]`）。
 * 没被任何适配器声明过的域名自成一组——它就是一个单域名站点。
 * 镜像关系来自适配器声明，不再来自 `watchlist.label` 字符串相等（#29）。
 * @param {string} domain
 * @param {Array<Object>} [adapters]
 * @returns {string[]}
 */
function mirrorGroupFor(domain, adapters) {
  for (const adapter of adapters || []) {
    for (const group of adapter.mirrors || []) {
      if (Array.isArray(group) && group.includes(domain)) return group.slice();
    }
  }
  return [domain];
}

/** 一个站点的规范键：镜像组里的第一个域名。同组镜像因此只算一个来源。 */
function siteKeyFor(domain, adapters) {
  return mirrorGroupFor(domain, adapters)[0];
}

function matchesRegex(rules, title, url) {
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.regexFilter.trim());
      const targetStr = rule.regexTarget === "title" ? title || "" : url;
      if (regex.test(targetStr)) return true;
    } catch (e) {
      // ignore invalid regex
    }
  }
  return false;
}

/**
 * 从规则里抽取**命名捕获组**。这是“闸门 → 解析器”的那一步：
 * 同一个 `regexFilter` 既决定这一页“算不算作品页”，也把作品身份抠出来。
 *
 * 没有命名捕获组的旧规则照常工作——它们只当闸门，抽不出任何东西，
 * 调用方据此降级到 (站点, 路径) 身份，**不丢弃记录**。
 *
 * @returns {Object} 字段名 → 值。同名只取第一次命中。
 */
function extractFromRules(rules, title, url) {
  const out = {};
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.regexFilter.trim(), "g");
      const targetStr = rule.regexTarget === "title" ? title || "" : url;
      let m;
      let guard = 0;
      while ((m = regex.exec(targetStr)) !== null && guard++ < 50) {
        if (m.groups) {
          for (const [k, v] of Object.entries(m.groups)) {
            if (v != null && v !== "" && out[k] === undefined) out[k] = v;
          }
        }
        if (m.index === regex.lastIndex) regex.lastIndex++; // 防空匹配死循环
      }
    } catch (e) {
      // ignore invalid regex
    }
  }
  return out;
}

/**
 * 按 label 取一组域名——**只用于界面的站点筛选**，不再用来判定镜像。
 * 镜像由适配器声明（`mirrorGroupFor`），label 只是显示名。
 */
function getGroupDomains(groupLabel, watchlist, fallbackDomain) {
  const domains = watchlist
    .filter((w) => (w.label || w.domain) === groupLabel)
    .map((w) => w.domain);
  if (domains.length === 0) domains.push(fallbackDomain);
  return domains;
}

/**
 * 一条访问落在哪一组：这一组的域名、规范键与规则。
 *
 * 「组」是镜像的落点：适配器 `mirrors` 声明了哪些域名互为镜像，组内域名即
 * 同一个站点。闸门与解析用的是同一份 `regexFilter`，所以域名和规则要一起取——
 * 分头去取，就落了一个「闸门用这一组的规则、去重用另一组的域名」的口子。
 *
 * @param {string} matchedRule 这条访问命中的登记域名
 * @param {string} domain 访问实际落在的域名
 * @param {Array<Object>} watchlist
 * @param {Array<Object>} [adapters] 镜像声明来自这里
 * @returns {{ label:string, key:string, domains:string[], rules:WatchlistEntry[] }}
 */
function resolveGroup(matchedRule, domain, watchlist, adapters) {
  const entry = watchlist.find((w) => w.domain === matchedRule);
  // 镜像按**登记域名**查：扩展会把 `m.example.com` 报成 domain、`example.com` 报成 matchedRule，
  // 拿实际主机名去查会漏拊镜像组与闸门。
  const domains = mirrorGroupFor(entry ? entry.domain : domain, adapters);
  return {
    label: resolveGroupLabel(matchedRule, domain, watchlist),
    key: domains[0],
    domains,
    rules: watchlist.filter(
      (w) =>
        domains.includes(w.domain) &&
        w.regexFilter &&
        w.regexFilter.trim() !== "",
    ),
  };
}

function extractPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch (e) {
    return url;
  }
}

/**
 * 同一个标签页在 60s 内重报同一页：还是那一次访问，不产生第二条。
 * 扩展在它自己那一层先挡了一道（tab-tracker），这里是权威的那一道。
 *
 * @param {Object|null} existing - 同组同路径的那条访问
 * @param {{tabId:number}} incoming
 * @param {number} now
 */
function isRepeatVisit(existing, incoming, now) {
  return (
    !!existing &&
    incoming.tabId === existing.tabId &&
    now - existing.timestamp < 60000
  );
}

function computeDailyScore(existing, now) {
  const todayStr = new Date(now).toDateString();
  const createdAt = existing.createdAt || existing.timestamp;
  const isCreatedToday = new Date(createdAt).toDateString() === todayStr;
  const isUpdatedToday = existing.updatedAt
    ? new Date(existing.updatedAt).toDateString() === todayStr
    : false;

  let newPinned = 1;
  let newScore = existing.score || 0;
  let newUpdatedAt = existing.updatedAt;

  if (!existing.pinned) {
    // First revisit today: pin and score 1
    newScore = 1;
    newUpdatedAt = now;
  } else if (!isCreatedToday && !isUpdatedToday) {
    // Not created today and not updated today: allow +1
    newScore += 1;
    newUpdatedAt = now;
  }

  return { newPinned, newScore, newUpdatedAt };
}

/**
 * 一条访问的作品身份键，两路信号合流：
 *
 *   适配器 —— 扩展回传的**页面签名**认出平台，回传的 collect 字段跑 parse
 *   旧规则 —— 站点登记上那个 `regexFilter` 的命名捕获组（既当闸门又当解析器）
 *
 * 适配器那一路是本轮（#26）之前没有的：没有用户正则的 MacCMS 站点也能拿到编号。
 * 两路同名时**用户自己写的规则优先**——装了适配器不该让已经写了规则的站点
 * 换一个解析结果（判定只做一次，见 docs/adr/0002）。
 *
 * 实时上报（RecordStore.recordVisit）与历史回填（RecordStore.backfillWorks）
 * 共用这一条路径。这里**不含闸门**——闸门只决定「这一页要不要收」，
 * 回填面对的是已经收下的历史，不能因为适配器今天不匹配就把旧访问判死。
 *
 * @param {Object} incoming 扩展上报的访问（可带 `pageSignature` / `pageFields`）
 * @param {Array<Object>} watchlist
 * @param {Array<Object>} [groupRules] 分组规则；不传则自己取（回填用）
 * @param {Array<Object>} [adapters] 适配器；没有就是今天的行为（只有旧规则那一路）
 * @returns {{ extracted: object, keys: Array<{kind:string,value:string,confidence:string}>,
 *            adapter: Object|null, parsed: Object }}
 *          `adapter` / `parsed` 供适配器健康度判断「认下的适配器有没有产出身份字段」。
 */
function identityKeysFor(incoming, watchlist, groupRules, adapters) {
  const rules =
    groupRules ||
    resolveGroup(incoming.matchedRule, incoming.domain, watchlist, adapters)
      .rules;
  const fromRules = extractFromRules(rules, incoming.title, incoming.url);
  const builtin = builtinFields(incoming);
  const adapter = detectBySignature(incoming.pageSignature, adapters);
  const adapted = adapter
    ? identityForFields(adapter, builtin, incoming.pageFields)
    : null;
  const keys = extractKeys({
    url: builtin.url,
    title: builtin.title,
    description: builtin.description,
    ogImage: builtin.ogImage,
    extracted: { ...(adapted ? adapted.extracted : {}), ...fromRules },
  });
  return {
    extracted: { ...(adapted ? adapted.parsed : {}), ...fromRules },
    keys,
    adapter,
    parsed: adapted ? adapted.parsed : {},
  };
}

/**
 * 作品层每日计分：同一部作品，一天最多 +1，**无论从哪个站点、哪个版本进入**。
 *
 * 这是「外部补全用户系统」真正生效的那一步（ADR-0004）：
 * A 站看 3 天 + B 站看 1 次 = 4 分一条，而不是 3 分和 1 分两个弱信号。
 *
 * @param {Object|null} existingWork - { score, createdAt, updatedAt } 或 null
 * @param {number} now
 * @returns {{ score:number, createdAt:number, updatedAt:number, created:boolean }}
 */
function resolveWorkScore(existingWork, now) {
  if (!existingWork) {
    return { score: 1, createdAt: now, updatedAt: now, created: true };
  }

  const todayStr = new Date(now).toDateString();
  const createdAt = existingWork.createdAt || existingWork.firstSeen || 0;
  const updatedAt = existingWork.updatedAt || 0;
  const createdToday = new Date(createdAt).toDateString() === todayStr;
  const updatedToday = updatedAt
    ? new Date(updatedAt).toDateString() === todayStr
    : false;

  // 今天已经计过一次（刚建的、或今天已更新过）——不再加
  if (createdToday || updatedToday) {
    return {
      score: existingWork.score || 0,
      createdAt,
      updatedAt: updatedAt || now,
      created: false,
    };
  }

  return {
    score: (existingWork.score || 0) + 1,
    createdAt,
    updatedAt: now,
    created: false,
  };
}

module.exports = {
  identityKeysFor,
  isRepeatVisit,
  resolveGroup,
  resolveWorkScore,
  extractFromRules,
  matchesRegex,
  computeDailyScore,
  resolveGroupLabel,
  getGroupDomains,
  mirrorGroupFor,
  siteKeyFor,
  extractPath,
};
