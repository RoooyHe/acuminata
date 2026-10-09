/**
 * Unit tests for agent/cluster.js —— 写入路径上的**纯规则**。
 * Run with: node agent/cluster.test.js
 *
 * 链路本身（闸门 → 身份键 → 去重 → 计分 → 作品归属 → 落库）的测试
 * 在 agent/record-store.test.js 与 agent/visit.e2e.test.js：它现在只住在一个模块里。
 */

const {
  identityKeysFor,
  isRepeatVisit,
  computeDailyScore,
  resolveWorkScore,
  extractFromRules,
  matchesRegex,
  resolveGroup,
  resolveGroupLabel,
} = require('./cluster');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function makeWatchlist(entries) {
  return entries.map((e) => ({
    domain: e.domain,
    label: e.label || "",
    color: e.color || "#5b8dee",
    regexFilter: e.regexFilter || "",
    regexTarget: e.regexTarget || "url",
  }));
}

function makeRecord(overrides = {}) {
  return {
    id: "1",
    url: "https://example.com/video/123",
    title: "Video 123",
    domain: "example.com",
    matchedRule: "example.com",
    tabId: 1,
    timestamp: Date.now() - 100000,
    pinned: 0,
    score: 0,
    createdAt: Date.now() - 100000,
    updatedAt: null,
    ...overrides,
  };
}

async function runTests() {
  console.log('\n── agent/cluster.js unit tests ──\n');

  // ── 闸门：同一个正则既决定哪一页算作品页，也是解析器 ──
  {
    console.log('闸门：正则决定这一页算不算作品页');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "Videos", regexFilter: "/video/", regexTarget: "url" },
    ]);
    const { rules } = resolveGroup("example.com", "example.com", watchlist);
    assert(rules.length === 1, '取到这一组的规则');
    assert(
      !matchesRegex(rules, "最新更新", "https://example.com/article/456"),
      '列表页被挡在闸门外',
    );
    assert(matchesRegex(rules, "某剧", "https://example.com/video/123"), '作品页通过闸门');
  }

  // ── 闸门：没有规则时不拦（未登记站点与只当闸门的旧适配器都靠这一条） ──
  {
    console.log('闸门：没有规则时不拦');
    const watchlist = makeWatchlist([{ domain: "example.com", label: "Videos" }]);
    const undecorated = resolveGroup("未登记.com", "未登记.com", watchlist);
    assert(undecorated.rules.length === 0, '没有 regexFilter 的条目不算规则');
    assert(
      matchesRegex(undecorated.rules, "随便", "https://x.com/a") === false,
      '空规则集不命中，所以调用方不会据此丢页面',
    );
  }

  // ── 去重判定：同组同路径 + 同一标签页 + 60s 内 = 同一次访问 ──
  {
    console.log('去重：同一标签页 60s 内重报');
    const nowTs = Date.now();
    const recent = makeRecord({ tabId: 1, timestamp: nowTs - 30000 });
    assert(isRepeatVisit(recent, { tabId: 1 }, nowTs) === true, '同一标签页 60s 内算重报');
    assert(
      isRepeatVisit(recent, { tabId: 2 }, nowTs) === false,
      '另一个标签页不是重报（是一次新的访问）',
    );
    assert(
      isRepeatVisit(makeRecord({ tabId: 1, timestamp: nowTs - 61000 }), { tabId: 1 }, nowTs) === false,
      '超过 60s 不算重报',
    );
    assert(isRepeatVisit(null, { tabId: 1 }, nowTs) === false, '没有同路径的访问时不是重报');
  }

  // ── 访问层每日计分 ──
  {
    console.log('访问层每日计分');
    const nowTs = Date.now();
    const dayAgo = nowTs - 86400000;

    const firstRevisit = computeDailyScore(
      makeRecord({ pinned: 0, score: 0, createdAt: dayAgo, timestamp: dayAgo }),
      nowTs,
    );
    assert(firstRevisit.newPinned === 1, '首次回访钉住这条访问');
    assert(firstRevisit.newScore === 1, '首次回访记 1 分');

    const sameDay = computeDailyScore(
      makeRecord({ pinned: 1, score: 5, createdAt: dayAgo, updatedAt: nowTs - 3600000 }),
      nowTs,
    );
    assert(sameDay.newScore === 5, '今天已经回访过就不再加分');

    const nextDay = computeDailyScore(
      makeRecord({ pinned: 1, score: 5, createdAt: dayAgo * 2, updatedAt: dayAgo }),
      nowTs,
    );
    assert(nextDay.newScore === 6, '隔天回访 +1');
  }

  // ── 分组：适配器声明的镜像归回一组（label 只是显示名） ──
  {
    console.log('分组：适配器 mirrors → 同组域名与规则');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "某站", regexFilter: "/video/" },
      { domain: "example-mirror.com", label: "某站的镜像", regexFilter: "/vod/" },
      { domain: "other.com" },
    ]);
    const adapters = [{ file: "site.json", mirrors: [["example.com", "example-mirror.com"]] }];
    const group = resolveGroup(
      "example-mirror.com",
      "example-mirror.com",
      watchlist,
      adapters,
    );
    assert(
      group.domains.join(",") === "example.com,example-mirror.com",
      '同组域名都取到（镜像算同一个站点）',
    );
    assert(group.key === 'example.com', '规范键是组里第一个域名（来源只此一个）');
    assert(group.rules.length === 2, '同组的规则都取到（闸门与解析共用同一份）');

    // 扩展报的是实际主机名 + 命中的登记域名；镜像按登记域名查
    const sub = resolveGroup(
      "example.com",
      "m.example.com",
      watchlist,
      adapters,
    );
    assert(
      sub.domains.join(",") === "example.com,example-mirror.com",
      '子域名访问按登记域名找到镜像组（不拆成新来源）',
    );
    assert(sub.rules.length === 2, '子域名访问的闸门/解析规则同样取到');

    // 同一 label 但没被适配器声明为镜像的两个域名，不该并成一组
    const labelOnly = makeWatchlist([
      { domain: "a.com", label: "同名" },
      { domain: "b.com", label: "同名" },
    ]);
    assert(
      resolveGroup("b.com", "b.com", labelOnly, []).domains.join(",") === "b.com",
      'label 相等不再分组（镜像只来自适配器声明）',
    );

    assert(
      resolveGroupLabel("other.com", "other.com", watchlist) === 'other.com',
      '没有 label 时退回域名',
    );
    assert(
      resolveGroup("unknown.com", "unknown.com", watchlist, []).label === 'unknown.com',
      '未登记站点退回域名',
    );
  }

  // ── 身份键：命名捕获组（闸门 → 解析器） ──
  {
    console.log('身份键：命名捕获组');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "Videos", regexFilter: "/tv/(?<code>[0-9]+)/", regexTarget: "url" },
    ]);
    const incoming = {
      url: "https://example.com/tv/94425/",
      title: "某某剧 - 第1集",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const { extracted, keys } = identityKeysFor(incoming, watchlist);
    assert(extracted.code === '94425', '从 url 里抠出 code');
    const codeKey = keys.find((k) => k.kind === 'code');
    assert(!!codeKey, '产出了 code 身份键');
    assert(codeKey.confidence === 'high', 'code 是高可信度');
  }

  // ── 身份键：只有标题时也能产出（降级，不丢弃） ──
  {
    console.log('身份键：没有捕获组时降级');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "Videos", regexFilter: "/tv/", regexTarget: "url" },
    ]);
    const incoming = {
      url: "https://example.com/tv/94425/",
      title: "某某剧 高清在线观看",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const { extracted, keys } = identityKeysFor(incoming, watchlist);
    assert(Object.keys(extracted).length === 0, '旧规则（无捕获组）抠不出任何东西');
    assert(
      keys.some((k) => k.kind === 'title' && k.value === '某某剧'),
      '降级到标题键',
    );
    assert(
      !keys.some((k) => k.confidence === 'high'),
      '降级时没有高可信度键',
    );
  }

  // ── 身份键不含闸门：回填面对的是已经收下的历史 ──
  {
    console.log('身份键：不受今天的闸门影响');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "Videos", regexFilter: "/voddetail/(?<code>[0-9]+)", regexTarget: "url" },
    ]);
    // 站点改版后这一页今天不匹配适配器了，但它是之前就已经收下的历史
    const incoming = {
      url: "https://example.com/play/94425.html",
      title: "某某剧 高清在线观看",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const { keys } = identityKeysFor(incoming, watchlist);
    assert(
      keys.some((k) => k.kind === 'title' && k.value === '某某剧'),
      '规则今天不匹配也照样产出身份键，旧访问不被判死',
    );
  }

  // ── extractFromRules 直接测 ──
  {
    console.log('extractFromRules');
    const rules = [
      { regexFilter: "/upload/vod/[0-9-]+/(?<coverHash>[0-9a-f]{32})\\.", regexTarget: "url" },
      { regexFilter: "(?<edition>中文字幕|无码)", regexTarget: "title" },
    ];
    const got = extractFromRules(
      rules,
      "某某剧 中文字幕",
      "https://x.com/upload/vod/20260101-1/c0a55b31c915cab3d80e9863f54f2ee0.webp",
    );
    assert(got.coverHash === 'c0a55b31c915cab3d80e9863f54f2ee0', '从 url 抠出封面哈希');
    assert(got.edition === '中文字幕', '从 title 抠出版本');
  }

  // ── 无效正则不能招死循环 ──
  {
    console.log('extractFromRules: 无效正则');
    const got = extractFromRules(
      [{ regexFilter: "(?<broken>[unclosed", regexTarget: "url" }],
      "t",
      "https://example.com/x",
    );
    assert(Object.keys(got).length === 0, '无效正则被忽略，不抛错');
  }

  // ── 作品层计分：这是本轮的钱测试 ──
  {
    console.log('resolveWorkScore: 跨站累加到同一个作品');
    const day1 = new Date('2026-03-01T10:00:00').getTime();
    const day1later = new Date('2026-03-01T22:00:00').getTime();
    const day2 = new Date('2026-03-02T10:00:00').getTime();
    const day3 = new Date('2026-03-03T10:00:00').getTime();

    const created = resolveWorkScore(null, day1);
    assert(created.created === true, '第一次见到就有作品');
    assert(created.score === 1, '新建作品分数为 1');

    const sameS = resolveWorkScore(created, day1later);
    assert(sameS.score === 1, '同一天再访问，不加分');

    const next = resolveWorkScore(sameS, day2);
    assert(next.score === 2, '隔天 +1');

    const third = resolveWorkScore(next, day3);
    assert(third.score === 3, '再隔一天再 +1');
  }

  {
    console.log('resolveWorkScore: 跨站合并 —— A 站 3 天 + B 站 1 次 = 4 分一条');
    const day = (n, h) => new Date(2026, 2, n, h).getTime();
    let work = null;
    work = resolveWorkScore(work, day(1, 10)); // A 站 day1
    work = resolveWorkScore(work, day(2, 10)); // A 站 day2
    work = resolveWorkScore(work, day(3, 10)); // A 站 day3
    work = resolveWorkScore(work, day(4, 10)); // B 站 day4（同一部作品，不同站点）
    assert(work.score === 4, '四个不同日子 = 4 分，落在同一条作品上');
  }

  {
    console.log('resolveWorkScore: 一天只加一次');
    const t0 = new Date(2026, 2, 1, 1).getTime();
    let work = resolveWorkScore(null, t0);
    for (let h = 2; h < 24; h++) {
      work = resolveWorkScore(work, new Date(2026, 2, 1, h).getTime());
    }
    assert(work.score === 1, '同一天内 23 次访问只算 1 分');
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
