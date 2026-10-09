// rank() 是纯函数：候选 → 推荐（带理由）。不需要 DB，也不需要网络。
// 覆盖 issue #31 的验收：排序结果、理由生成、已访问排除、画像驱动、
// 以及元数据取不到时的廉价信号兜底（ADR-0008）。
const assert = require("assert");
const { rank, buildProfile, candidateKeys, recommendationReason } = require("./rank");

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

// 与内置 MacCMS 适配器同形的 parse：内容编号就是封面 URL 里的那串哈希。
const adapters = [
  {
    file: "maccms.json",
    parse: { code: { from: ["cover"], regex: `/upload/vod/[0-9-]+/(?<code>[0-9a-f]{32})\\.` } },
  },
];

function candidate(url, title, cover, extra = {}) {
  return {
    url,
    title,
    domain: "www.mgtvtv.com",
    matchedRule: "mgtvtv.com",
    groupLabel: "芒果",
    adapterFile: "maccms.json",
    fields: JSON.stringify({ url, title, cover }),
    updatedAt: 1,
    ...extra,
  };
}

const cover = (hash) => `https://x/upload/vod/1-1/${hash}.webp`;

// ── ① 已经访问过的作品不作为推荐出现 ──
{
  const profile = buildProfile();
  const rows = rank(
    [
      candidate("https://www.mgtvtv.com/tv/1/", "看过的甲", cover(A)),
      candidate("https://www.mgtvtv.com/tv/2/", "没看过的乙", cover(B)),
    ],
    profile,
    { adapters, seenKeys: [`code:${A}`, `cover_hash:${A}`] },
  );
  assert.deepStrictEqual(rows.map((r) => r.title), ["没看过的乙"], "内容编号命中就排除");

  // 归一化标题命中同样排除（键值已经归一化）。
  const byTitle = rank(
    [candidate("https://www.mgtvtv.com/tv/3/", "看过的甲 高清在线观看", cover(C))],
    profile,
    { adapters, seenKeys: ["title:看过的甲"] },
  );
  assert.deepStrictEqual(byTitle, [], "归一化标题命中就排除");
}

// ── ② 排序输入是兴趣画像，不是站点最新更新 ──
{
  const profile = buildProfile({
    works: [
      { title: "悬疑刑侦剧", score: 7 },
      { title: "古装宫斗剧", score: 3 },
    ],
    keys: [{ kind: "title", value: "悬疑刑侦剧" }],
    sites: [{ site: "mgtvtv.com", visits: 12 }],
    memories: [{ type: "preference", key: "刑侦", value: "刑侦", weight: 0.8 }],
  });

  const rows = rank(
    [
      // 同站点、更新的条目：只有兜底信号
      candidate("https://www.mgtvtv.com/tv/9/", "普通过日子", cover(B), { updatedAt: 99 }),
      // 画像关键词命中
      candidate("https://www.mgtvtv.com/tv/8/", "重案组 刑侦", cover(C)),
      // 与看过的作品同系列
      candidate("https://www.mgtvtv.com/tv/7/", "古装宫斗剧 第二季", cover(A)),
    ],
    profile,
    { adapters },
  );

  assert.strictEqual(rows[0].title, "重案组 刑侦", "画像关键词命中的排最前");
  assert.ok(rows[0].reason.includes("刑侦"), "理由写出命中的兴趣词：" + rows[0].reason);
  assert.strictEqual(rows[1].title, "古装宫斗剧 第二季", "同系列第二");
  assert.ok(rows[1].reason.includes("古装宫斗剧"), "理由写出同系列的原作：" + rows[1].reason);
  assert.strictEqual(rows[2].title, "普通过日子", "没有画像命中的靠后");
  assert.ok(rows[2].reason.includes("芒果"), "兜底理由写清来源站点：" + rows[2].reason);
  assert.ok(
    rows.every((r) => r.reason.length > 0),
    "每条推荐都带理由",
  );
}

// ── ③ 元数据：有就用内容特征，没有就退回廉价信号，不卡住 ──
{
  const profile = buildProfile({
    works: [{ title: "看过的作品", score: 2 }],
    sites: [{ site: "mgtvtv.com", visits: 3 }],
    memories: [{ type: "preference", key: "赵今麦", value: "赵今麦", weight: 0.8 }],
  });

  const rows = rank(
    [
      candidate("https://www.mgtvtv.com/tv/1/", "列表页里的模糊标题甲", cover(A)),
      candidate("https://www.mgtvtv.com/tv/2/", "列表页里的模糊标题乙", cover(B)),
    ],
    profile,
    {
      adapters,
      // 只有第一条能取到元数据；第二条取不到，管线照走（ADR-0008）。
      metadata: { "https://www.mgtvtv.com/tv/1/": { name: "无可替代", actors: "赵今麦 魏大勋" } },
    },
  );
  assert.strictEqual(rows[0].title, "无可替代", "有元数据时用归一化标题");
  assert.ok(rows[0].reason.includes("赵今麦"), "演员命中画像：" + rows[0].reason);
  assert.strictEqual(rows[1].title, "列表页里的模糊标题乙", "取不到元数据仍然排出来");
  assert.ok(rows[1].reason.includes("芒果"), "退回站点兜底理由：" + rows[1].reason);
}

// ── ④ 画像构建 ──
{
  const profile = buildProfile({
    works: [{ title: "现在就出发 高清在线观看", score: 5 }],
    keys: [
      { kind: "code", value: A },
      { kind: "title", value: "现在就出发" },
    ],
    sites: [{ site: "mgtvtv.com", visits: 4 }],
    memories: [
      { type: "preference", key: "tvmao.com", value: "tvmao.com", weight: 0.9 }, // 域名不是内容词
      { type: "insight", key: "x", value: JSON.stringify({ insight: "偏爱综艺", profileUpdate: "" }) },
      { type: "anti_pattern", key: "恐怖片", value: "恐怖片", weight: 1 }, // 排斥过的不进画像
    ],
  });
  assert.ok(
    profile.titles.some((t) => t.value === "现在就出发" && t.weight === 5),
    "作品标题进画像并带分数权重",
  );
  assert.ok(profile.codes.includes(A), "内容编号进画像");
  assert.ok(profile.keywords.some((k) => k.value === "偏爱综艺"), "记忆里的内容词进画像");
  assert.ok(!profile.keywords.some((k) => k.value === "tvmao.com"), "域名不当内容词");
  assert.ok(!profile.keywords.some((k) => k.value === "恐怖片"), "排斥过的不进画像");
  assert.deepStrictEqual(profile.sites, [{ value: "mgtvtv.com", weight: 4 }], "站点亲和度进画像");
}

// ── ⑤ 候选身份键与访问同源 ──
{
  const keys = candidateKeys(candidate("https://www.mgtvtv.com/tv/1/", "甲", cover(A)), adapters);
  assert.ok(
    keys.some((k) => k.kind === "code" && k.value === A),
    "候选的内容编号来自适配器 parse",
  );
  assert.ok(
    keys.some((k) => k.kind === "cover_hash" && k.value === A),
    "候选的封面哈希与访问同源",
  );
}

// ── ⑥ 理由只由 recommendationReason 生成，未知站点也有话说 ──
{
  assert.strictEqual(
    recommendationReason({ groupLabel: "", score: 0 }),
    "「」最新更新",
    "没有分组也能给出兜底理由",
  );
}

console.log("rank tests passed");
