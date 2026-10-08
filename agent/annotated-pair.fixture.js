/**
 * 真实实测的已标注跨站配对（docs/adr/0007、docs/adr/0008）。
 * 用户人工标注：这两条是同一部《无可替代》。
 *
 *   A = aiqiyi.ai /voddetail/237486.html   MacCMS 站，有内容编号与封面哈希
 *   B = tvmao.com  /kanju/YmFfZmsg         元数据站，没有封面，只有文本
 *
 * 实时上报（works.e2e.test.js）与历史回填（backfill.e2e.test.js）共用这份夹具，
 * 两边的结论才可比。
 */

const AIQIYI = {
  url: "https://www.aiqiyi.ai/voddetail/237486.html",
  title:
    "《无可替代》高清在线观看 - 国产剧 - 爱奇艺|在线视频网站-海量正版高清视频在线观看",
  description:
    "《无可替代》讲述的是：讲述禀承“这一生绝对不能被别人替代”理念的女白领徐迟，在职场上过关斩将，与公司合伙人叶信之一路携手厮杀，最终成为无可替代之人的故事。 “黑莲花”徐迟与“精狐狸”叶信之互相扶持又相爱相杀！金牌编剧张巍全...",
  ogImage:
    "https://www.mdzypic.com/upload/vod/20260928-1/7a3d015c806b178380a48da94e6254ec.webp",
  domain: "aiqiyi.ai",
  matchedRule: "aiqiyi.ai",
  tabId: 1,
};

const TVMAO = {
  url: "https://www.tvmao.com/kanju/YmFfZmsg",
  title: "无可替代剧情介绍（1-20全集）大结局_电视剧_电视猫",
  description:
    "电视剧无可替代剧情介绍：讲述禀承“这一生绝对不能被别人替代”理念的女白领徐迟，在职场上过关斩将，与公司合伙人叶信之一路携手厮杀，最终成为无可替代之人的故事。 “黑莲花”徐迟与“精狐狸”叶信之互相扶持又相爱相杀！金牌编剧张巍全新都市力作，快节奏短剧模式，直击当下年轻人痛点。",
  ogImage: "",
  domain: "tvmao.com",
  matchedRule: "tvmao.com",
  tabId: 2,
};

// A 站：作品页 URL 里抠出站内 id（命名捕获组 = 闸门变解析器）
// B 站：元数据站，规则只当闸门，没有捕获组 → 走降级，靠文本指纹归属
const WATCHLIST = [
  {
    domain: "aiqiyi.ai",
    label: "爱奇艺镜像",
    color: "#fff",
    regexFilter: "/voddetail/(?<siteId>[0-9]+)\\.html",
    regexTarget: "url",
  },
  {
    domain: "tvmao.com",
    label: "电视猫",
    color: "#fff",
    regexFilter: "/kanju/",
    regexTarget: "url",
  },
];

module.exports = { AIQIYI, TVMAO, WATCHLIST };
