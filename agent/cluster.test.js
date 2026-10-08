/**
 * Unit tests for agent/cluster.js
 * Run with: node agent/cluster.test.js
 */

const { evaluateIncoming, resolveWorkScore, extractFromRules } = require('./cluster');

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

  // ── Drop: regex mismatch ──
  {
    console.log('Drop: regex mismatch');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "Videos", regexFilter: "^/video/", regexTarget: "url" },
    ]);
    const incoming = {
      url: "https://example.com/article/456",
      title: "Article",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const findExisting = () => null;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "drop", 'drops when regex does not match');
  }

  // ── Drop: regex match required ──
  {
    console.log('Drop: regex match required');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "Videos", regexFilter: "^/video/", regexTarget: "url" },
    ]);
    const incoming = {
      url: "https://example.com/article/456",
      title: "Article",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const findExisting = () => null;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "drop", 'drops when regex does not match');
  }

  // ── Pass: regex match ──
  {
    console.log('Pass: regex match');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "Videos", regexFilter: "example\\.com/video/", regexTarget: "url" },
    ]);
    const incoming = {
      url: "https://example.com/video/123",
      title: "Video 123",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const findExisting = () => null;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "insert", 'inserts when regex matches');
  }

  // ── Ignore: same tab within 60s ──
  {
    console.log('Ignore: same tab within 60s');
    const watchlist = makeWatchlist([{ domain: "example.com", label: "Videos" }]);
    const existing = makeRecord({ tabId: 1, timestamp: Date.now() - 30000 });
    const incoming = {
      url: "https://example.com/video/123",
      title: "Video 123",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const findExisting = () => existing;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "ignore", 'ignores duplicate within 60s on same tab');
  }

  // ── Update: different tab or >60s ──
  {
    console.log('Update: existing found');
    const watchlist = makeWatchlist([{ domain: "example.com", label: "Videos" }]);
    const existing = makeRecord({ tabId: 1, timestamp: Date.now() - 120000, pinned: 0, score: 0 });
    const incoming = {
      url: "https://example.com/video/123",
      title: "Video 123",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 2,
      timestamp: Date.now(),
    };
    const findExisting = () => existing;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "update", 'updates existing record');
    assert(result.record.pinned === 1, 'pins on first revisit');
    assert(result.record.score === 1, 'scores 1 on first revisit');
    assert(result.updates.url === incoming.url, 'updates url');
  }

  // ── Update: daily scoring cap ──
  {
    console.log('Update: daily scoring cap');
    const watchlist = makeWatchlist([{ domain: "example.com", label: "Videos" }]);
    const existing = makeRecord({
      tabId: 1,
      timestamp: Date.now() - 86400000,
      pinned: 1,
      score: 5,
      updatedAt: Date.now() - 86400000,
      createdAt: Date.now() - 86400000,
    });
    const incoming = {
      url: "https://example.com/video/123",
      title: "Video 123",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 2,
      timestamp: Date.now(),
    };
    const findExisting = () => existing;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "update", 'updates existing record');
    assert(result.record.score === 6, 'increments score by 1');
  }

  // ── Update: no double score same day ──
  {
    console.log('Update: no double score same day');
    const watchlist = makeWatchlist([{ domain: "example.com", label: "Videos" }]);
    const existing = makeRecord({
      tabId: 1,
      timestamp: Date.now() - 86400000,
      pinned: 1,
      score: 5,
      updatedAt: Date.now() - 3600000,
      createdAt: Date.now() - 86400000,
    });
    const incoming = {
      url: "https://example.com/video/123",
      title: "Video 123",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 2,
      timestamp: Date.now(),
    };
    const findExisting = () => existing;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "update", 'updates existing record');
    assert(result.record.score === 5, 'does not increment score when already updated today');
  }

  // ── Insert: no existing ──
  {
    console.log('Insert: no existing');
    const watchlist = makeWatchlist([{ domain: "example.com", label: "Videos" }]);
    const incoming = {
      url: "https://example.com/video/123",
      title: "Video 123",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
      favIconUrl: "https://example.com/favicon.ico",
      description: "A great video",
      ogImage: "https://example.com/og.jpg",
    };
    const findExisting = () => null;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "insert", 'inserts new record');
    assert(result.record.url === incoming.url, 'preserves url');
    assert(result.record.favIconUrl === incoming.favIconUrl, 'preserves favIconUrl');
    assert(result.record.description === incoming.description, 'preserves description');
    assert(result.record.ogImage === incoming.ogImage, 'preserves ogImage');
  }

  // ── Group resolution: fallback to domain ──
  {
    console.log('Group resolution: fallback to domain');
    const watchlist = makeWatchlist([{ domain: "example.com", label: "" }]);
    const incoming = {
      url: "https://example.com/video/123",
      title: "Video 123",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const findExisting = () => null;
    const result = evaluateIncoming(incoming, watchlist, findExisting);
    assert(result.action === "insert", 'inserts when groupLabel falls back to domain');
  }

  // ── 解析：命名捕获组从正则里抠出作品身份（闸门 → 解析器） ──
  {
    console.log('Parse: 命名捕获组');
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
    const result = evaluateIncoming(incoming, watchlist, () => null);
    assert(result.action === 'insert', '仍会插入');
    assert(result.extracted.code === '94425', '从 url 里抠出 code');
    const codeKey = result.keys.find((k) => k.kind === 'code');
    assert(!!codeKey, '产出了 code 身份键');
    assert(codeKey.confidence === 'high', 'code 是高可信度');
  }

  // ── 解析：只有标题时也能产出键（降级，不丢弃） ──
  {
    console.log('Parse: 没有捕获组时降级');
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
    const result = evaluateIncoming(incoming, watchlist, () => null);
    assert(result.action === 'insert', '旧规则（无捕获组）仍能插入，不被丢弃');
    assert(Object.keys(result.extracted).length === 0, '抠不出任何东西');
    assert(
      result.keys.some((k) => k.kind === 'title' && k.value === '某某剧'),
      '降级到标题键',
    );
    assert(
      !result.keys.some((k) => k.confidence === 'high'),
      '降级时没有高可信度键',
    );
  }

  // ── 丢弃要带原因（供适配器健康度统计） ──
  {
    console.log('Parse: 丢弃带原因');
    const watchlist = makeWatchlist([
      { domain: "example.com", label: "Videos", regexFilter: "/tv/", regexTarget: "url" },
    ]);
    const incoming = {
      url: "https://example.com/latest/",
      title: "最新更新",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
    };
    const result = evaluateIncoming(incoming, watchlist, () => null);
    assert(result.action === 'drop', '列表页被丢弃');
    assert(result.reason === 'no-rule-match', '带出丢弃原因');
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
