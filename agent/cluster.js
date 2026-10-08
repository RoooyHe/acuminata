/**
 * Record clustering module — pure logic, no DB or side effects.
 *
 * Responsibilities:
 *   - Regex validation for grouped watchlist entries
 *   - **命名捕获组抽取**（适配器：闸门 → 解析器，见 docs/adr/0007）
 *   - **作品身份键**的产出（任一路命中即归并）
 *   - Group resolution (label → domains)
 *   - Path extraction from URLs
 *   - Dedup: same path within a group
 *   - 访问层每日计分（保留）与**作品层每日计分**（新增，跨站累加）
 *
 * @param {Object} incoming
 * @param {string} incoming.url
 * @param {string} incoming.title
 * @param {string} incoming.domain
 * @param {string} incoming.matchedRule
 * @param {number} incoming.tabId
 * @param {number} incoming.timestamp
 * @param {WatchlistEntry[]} watchlist
 * @param {Function} findExisting - (groupDomains: string[], path: string) => Record | null
 * @returns {{ action: "drop"|"ignore"|"update"|"insert",
 *             record?: any, updates?: object, reason?: string,
 *             extracted?: object, keys?: Array<{kind:string,value:string,confidence:string}> }}
 */

const { extractKeys } = require("./identity");

function resolveGroupLabel(matchedRule, domain, watchlist) {
  const currentWatch = watchlist.find((w) => w.domain === matchedRule);
  return currentWatch ? currentWatch.label || domain : domain;
}

function getGroupRules(groupLabel, watchlist) {
  return watchlist.filter(
    (w) =>
      (w.label || w.domain) === groupLabel &&
      w.regexFilter &&
      w.regexFilter.trim() !== "",
  );
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

function getGroupDomains(groupLabel, watchlist, fallbackDomain) {
  const domains = watchlist
    .filter((w) => (w.label || w.domain) === groupLabel)
    .map((w) => w.domain);
  if (domains.length === 0) domains.push(fallbackDomain);
  return domains;
}

function extractPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch (e) {
    return url;
  }
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

function evaluateIncoming(incoming, watchlist, findExisting) {
  const now = incoming.timestamp || Date.now();

  // 1. Resolve group
  const groupLabel = resolveGroupLabel(incoming.matchedRule, incoming.domain, watchlist);

  // 2. 闸门 + 解析（同一个正则）
  const groupRules = getGroupRules(groupLabel, watchlist);
  if (groupRules.length > 0 && !matchesRegex(groupRules, incoming.title, incoming.url)) {
    // 这一页不是作品页，丢弃是有意的。
    // 但若适配器写错（正则改版失效），这里会静默丢历史——
    // 调用方必须统计 no-rule-match 的次数并告警（ADR-0003）。
    return { action: "drop", reason: "no-rule-match" };
  }

  // 2b. 从命名捕获组里抠出作品身份，并汇总成身份键
  const extracted = extractFromRules(groupRules, incoming.title, incoming.url);
  const keys = extractKeys({
    url: incoming.url,
    title: incoming.title,
    description: incoming.description,
    ogImage: incoming.ogImage,
    extracted,
  });

  // 3. Group domains
  const groupDomains = getGroupDomains(groupLabel, watchlist, incoming.matchedRule);

  // 4. Extract path
  const incomingPath = extractPath(incoming.url);

  // 5. Find existing by path in group
  const existing = findExisting(groupDomains, incomingPath);

  if (existing) {
    // 6. Dedup: same tab within 60s
    if (incoming.tabId === existing.tabId && now - existing.timestamp < 60000) {
      return { action: "ignore" };
    }

    // 7. Daily scoring
    const { newPinned, newScore, newUpdatedAt } = computeDailyScore(existing, now);

    const updated = {
      ...existing,
      url: incoming.url,
      domain: incoming.domain,
      matchedRule: incoming.matchedRule,
      pinned: newPinned,
      score: newScore,
      timestamp: now,
      updatedAt: newUpdatedAt,
    };

    return {
      action: "update",
      record: updated,
      extracted,
      keys,
      updates: {
        url: incoming.url,
        domain: incoming.domain,
        matchedRule: incoming.matchedRule,
        pinned: newPinned,
        score: newScore,
        timestamp: now,
        updatedAt: newUpdatedAt,
      },
    };
  }

  // 8. New record
  const record = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    url: incoming.url,
    title: incoming.title || "",
    domain: incoming.domain,
    matchedRule: incoming.matchedRule,
    tabId: incoming.tabId,
    timestamp: now,
    favIconUrl: incoming.favIconUrl || "",
    description: incoming.description || "",
    ogImage: incoming.ogImage || "",
  };

  return { action: "insert", record, extracted, keys };
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
  evaluateIncoming,
  resolveWorkScore,
  extractFromRules,
  matchesRegex,
  computeDailyScore,
  resolveGroupLabel,
};
