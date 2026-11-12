# 开盘狙击：RPC 架构与测速

- 开盘监听使用 WSS 日志推送和有重叠窗口的 HTTP 补扫；页面进度刷新独立，不决定买入触发。
- 节点按用途分池，先检查链 ID、区块高度和必要方法，再按实测延迟选路。HTTP 补扫要求可用的 eth_getLogs，执行侧要求 eth_simulateV1。
- 确认路径并发核验开盘回执、区块头和市场；可用时用核验过的 Multicall3 聚合。同一报价区块固定市场读取，并在签名前复核主链与模拟。
- 提前路径只有在捕捉并核验真实末笔 Mint、且顺序模拟成功时才可提交，公开待打包流不保证覆盖。

## 只读工具

- `node scripts/bench-snipe-rpc.mjs`：测试公共节点的区块、过滤日志、回执和历史报价。可加 `--skip-sim` 或 `--split-head-only`；`--custom` 从本地环境变量读节点，不打印 URL。
- `node scripts/probe-corla-pending.mjs --seconds 120`：测公开 pending 流能否在本地收到开盘通知之前匹配最终 Mint；无样本时不推断覆盖率。
- `node scripts/inspect-corla-first-buy.mjs <launch-hash> <buy-hash>`：用公开链上回执核对区块及块内顺序。

这些工具不打开钱包库、不签名、不广播。RPC 接收不是上链回执，链上顺序以区块和交易索引为准。
