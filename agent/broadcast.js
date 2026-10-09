// 服务端 → 客户端的广播信封：事件名加上载荷的具名字段，铺进顶层。
//
// 扩展（extend/background.ts）与渲染层（ui/renderer.js）都按 `type` 加
// `watchlist` / `record` / `enabled` / `health` 这些具名字段读。载荷必须是对象：
// 裸值（数组 / 布尔）铺开后只剩事件名，客户端读到 undefined，于是把 watchlist
// 清空、把 enabled 读反。主进程与广播契约测试都走这一处，契约只有一个实现。

function toClientMessage(type, payload) {
  return { type, ...(payload || {}) };
}

module.exports = { toClientMessage };
