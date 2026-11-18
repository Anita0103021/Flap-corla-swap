# Corla 开盘狙击 · 隔离实验

用于回答两个不同的问题：**有没有在确认开盘前看到真正的末笔**，以及**拿到已签末笔后，是否能把那笔 Mint 和有价格保护的买单按顺序提交**。UI 实时刷新、RPC ping 和 Builder 接收回执都不能回答这两个问题。现有实盘服务不调用此实验适配器。

## 离线对抗

```powershell
node scripts/replay-corla-opening.mjs --json --seed 42
npm.cmd test
$until = (Get-Date).Date.AddDays(1).AddHours(9).ToString('yyyy-MM-ddTHH:mm:sszzz')
node scripts/run-corla-adversarial-night.mjs --until $until --interval-ms 180000
```

- 回归锚点：构造末笔 Pending 比本机 WSS 开盘信号晚 459 ms 的情况；缺这笔输入时不可能组相同交易的预开盘包。发布版使用脱敏的合成区块、交易标识、时间、账户及 Mock RPC/Builder，不包含私人运行报告，**不是历史 EVM 分叉或真实 Builder 实测**。
- 每轮回放用可复现的 `uint32` seed 改变 Pending 领先时间、跨源重复、截止边界和插队成交的大小。另覆盖 nonce 替换或已使用、父块重组、模拟期间先收到开盘信号、签名哈希不匹配、ACK 但未入块、投递结果不明且不重发。schema 2 保存每场景的变体、门控、提交与回执结果；`simulatedTimingsMs` 明确是注入的模拟时钟，不是 RPC 实测延迟。
- schema 2 的运行 manifest 固定并核对源码、测试、运行脚本、依赖锁文件的 SHA256 和 Node 版本，每轮前后检测热变。缺场景、重复场景、伪布尔值或汇总矛盾不算通过；发现版本变化立即停止，不把不同版本默默混在同一轮统计。旧 schema 1 的昨夜报告不改写，也不能作为新版本恢复入口。
- 本地 `reports/snipe-adversarial/<run-id>/` 里的 `manifest.json`、`summary.md` 和 `rounds.ndjson` 分别用于断点、人工查看和逐轮分析。失败时保留有界日志；截止或中断的未完成轮次不算通过。只读报告所有时间用 UTC 存档，摘要显示北京时间。机器睡眠或关机期间不会补跑历史轮次。
- Windows 可选 `scripts/keep-corla-test-awake.ps1 -RunId <id> -WorkerPid <pid>` 只在当前 worker 存活且未到截止时阻止空闲休眠，不保持屏幕点亮、不改电源计划。不能阻止主动关机、休眠、合盖或系统更新。

## 多路 Pending 只读观察

```powershell
node scripts/probe-corla-pending-compare.mjs --target '<正在筹资的 Corla v4 链接>' --source wss://bsc-rpc.publicnode.com --source-env OTHER_PENDING_WSS --seconds 120
```

`--target` 和 `--source` / `--source-env` 可以重复。脚本不读取项目实盘配置、钱包、签名库或日志；有访问凭据的 WSS 地址通过环境变量名称传入，不把 URL、原始交易或签名写入结果。

分母是通过主链核验的真实开盘交易，分别量各源的「哈希」「匹配完整对象」「能还原且核验签名的交易」；仅最后一项可作为组包输入。`earlyCoveragePct` 为正提前量的占比；正值是本机先见差，**不是**领先封块的时间；无核验过的开盘时是 `null`，不是 `0%`。样本少于 20 个时，最近秩 p95 就是最大样本值；应一起看样本数和缓存淘汰数。此脚本不按每个 Pending 哈希额外去查交易。

## 有序适配器边界

- 使用计划中的准确签名哈希及 Pancake V2 直接买入 calldata 校验，最多 1–3 笔 Mint 后面接一笔买单。最后重读同一父块，按 [NodeReal 官方 Send Bundle](https://docs.nodereal.io/docs/send-bundle) 设置 `maxBlockNumber = parent + 1`、时间上限 `maxTimestamp`、`noMerge` 和空回退白名单；不带 tip、授权或卖单，不放宽 `amountOutMin`。
- `maxBlockNumber` 是服务端区块上界，并不是父哈希链上绑定；`accepted` 只说明收到带 Bundle hash 的 ACK，不说明入块或排名。投递结果不明时不公开降级或再签。
- 2026-11-18 补充 `openSnipeBundleJournal({ directory, fileName? })` 和适配器可选 `journal`：显式打开独立 SQLite 文件，在 handoff 前 FULL-sync 原子预留项目/钱包意图、钱包 nonce 和买单哈希；重启、过期或明确拒收也不自动释放记录。写库失败不投递，ACK 后结果写库失败降为 unknown。不提供默认实盘路径、不保存 raw、签名或节点凭据。
- 无 journal 模式仅供隔离回放，不是重启安全的实盘通道。该独立 journal 尚未与现有公开发单的 `execution.mjs` 共用 nonce 仲裁，真实多通道接入前必须统一意图和资金预留，再用 receipt + blockHash + `transactionIndex` 独立确认。当前服务没有调用实验适配器。
- 正常的下一步是先收集真实、只读的多路样本，再验证付费/授权 Builder 的覆盖、接收耗时和成交顺序。单个 Builder 不覆盖所有区块；私有末笔、多路都迟到、nonce 变化和价格超过限制时，允许错过，不追涨。
