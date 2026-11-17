# Flap-corla-swap · 多钱包 Mint / 领币 / 开盘买入

适用于 **BNB Smart Chain 主网（56）** 的 Corla catalog v4。Mint、领币和开盘狙击支持原生 BNB 与 Corla 项目链上指定的 ERC-20 支付币；买入走实际支付币与新币的 PancakeSwap V2 直连池（BNB 项目为 WBNB）。打开控制台先待机；只有你在页面确认并解锁钱包后，才会启动实盘。

## 可视化控制台（Windows）

双击 `Start-Corla-UI.wsf`，会在后台启动服务并打开 [本地控制台](http://127.0.0.1:3924)，不显示命令行窗口。旧的 `Start-Corla-UI.cmd` 入口也会转交后台启动器。需要在终端查看输出时，可执行 `npm.cmd run ui -- --open`。启动失败可查看 `state/ui-start.log`。控制台只监听本机回环地址。

顶部可切换**白天、夜间、护眼**三种主题（默认夜间），浏览器会记住上次选择。窄屏会改用底部导航和自适应卡片；移动布局不改变本机访问限制，也不会开启局域网访问。

1. **钱包管理**：在本机控制台导入专用钱包的私钥，多条可按行输入。首次导入设置至少 12 字符的钱包库密码；Windows 可用原密码开启「本机免密码」，同一 Windows 账号后续导入、移除和启动实盘都无需再输。移除只删除本地条目，不会转账或撤销链上交易。保留原始钱包与密码备份，换账号或换电脑仍需要原密码。
2. **Mint 工作区**：贴 Corla 链接，填写每钱包目标次数。参与钱包会显示项目支付币及 BNB 余额、已 Mint 的次数和地址剩余限额；可点「全选余额足够的钱包」，也可手动勾选，保存时固定名单。自动筛选按剩余批数、链上单价和 Gas 上限计算；开启自动领币会额外预留领取 Gas。每笔 Mint 一批，保存时记录链上单价作为价格保护。设为 `0` 时，只给有未领份额的钱包领币。
3. **开盘狙击**：使用独立项目列表。BNB 项目使用狙击参数里的统一买入额和最低 WBNB 储备；ERC-20 项目在「加入狙击／配置狙击目标」里分别填单钱包买入额和最低池储备，两项都用该项目支付币。默认勾选「没抢到开盘就不追」，并发次数默认 2 轮。「并发线程数」是每轮同一笔买单的 RPC 投递上限；「并发次数」是每项目、每钱包最多尝试的轮数。旧配置里的 `buyOnLaunch` 项目会迁移进狙击列表。
4. 在对应工作区点实盘启动，核对钱包、项目、动作和最坏支出，点击「确认并启动实盘」，网页不再要求手输 `BSC LIVE`。没有开启本机免密码时仍需输入一次钱包库密码，可在确认页选择以后免输。「策略设置」提供通用 Gas 和总预算上限。**同一时间只运行一个工作区**；切换执行前先停止当前任务。正式页面不提供模拟模式，发送前的链上模拟仍是交易检查。
5. 左下角「本地服务」显示待机、当前任务、重启中或已退出。点「重启」或「退出」并确认后，服务会先停止任务、等待运行记录收尾；已提交的交易仍可能上链。重启后当前页面自动重新连接并保持待机；退出后保留页面状态提示，可再双击启动器。**关闭浏览器不会停止实盘**。运行中禁止修改项目和钱包。
6. 如果另一个标签页修改了配置，或通过其他标签页或终端重启了本地服务，旧页面会要求重新连接并核对；不会用旧设置覆盖新设置，也不会自动重发保存或启动请求。

钱包库 `state/wallet-vault.json` 加密保存，密码不会写入配置。不要把私钥或密码贴到聊天、普通网站或其他共享位置。把钱包库的加密备份与密码分开保存；此工具不提供找回密码。控制台钱包库与下文 CLI 的 `wallets.local.json` 是两套独立入口，不会自动迁移。自定义 RPC 仍可通过终端的 `BSC_RPC_URL` 设置。不要用不同日志路径同时让 CLI 和控制台操作同一批钱包。

Windows 本机免密码通过 DPAPI 将凭据绑定到当前 Windows 用户，私钥仍保存在原加密钱包库，不改写为明文。选择此模式后，有权使用当前 Windows 账号的本机程序也可能使用该凭据；在「钱包管理 → 关闭本机免密码」可移除凭据，钱包库和原密码不变。

项目列表刷新优先读取同一区块的 Corla 进度和价格，通过独立的只读 HTTP RPC 池批量查询。展开「钱包份额」才读取地址的参与状态。代币名称、符号及官方 IPFS 图片独立加载，网关失败时保留默认图标和合约地址。这些页面查询不会加入狙击的开盘检测和买入流程。

开盘狙击页在前台可见时自动刷新筹资进度与剩余批数，实盘运行中也可手动点「刷新链上」。每次读完后，实盘运行时等 1.2 秒、待机时等 2.5 秒；任一狙击目标只剩最后 1–3 批且仍可筹集时，缩短到 350 毫秒，打满或结束后恢复常规间隔。节点落后或读取失败时保留较新的链上快照并延长到 3.8 秒后再读。切走时暂停这项显示轮询，返回立即补读；不会暂停后台狙击。狙击日志显示北京时间及毫秒。

网页每次接受实盘狙击启动后，都会把运行与测速事件保存到 `reports/snipe-runs/snipe-*.ndjson`，没有成交或后续启动失败也留档。「狙击状态」会显示最近一份记录的路径；`snipe_pending.pendingReceivedAtMs` 是本机收到对应待打包 Mint 的毫秒时间。

「狙击状态 → 待打包 WSS」单独显示每路完整推送和重连状态。连续 8 秒缺少完整交易会主动重连；主、备用订阅互不阻塞。全路暂不可用时，选了「没抢到开盘就不追」的任务会提醒此时开盘将跳过，不会自动切换为补买。

### 在工具内选币

打开 [代币看板](http://127.0.0.1:3924/#discover)，会按创建顺序从 BSC Corla v4 工厂分页加载，不必手动扫区块或打开 Flap。卡片展示链上 Mint 价格、份数、进度和状态，名称、简介与图片可随后补齐。可按筹资状态筛选、按创建时间或进度排序，或搜索已加载项目的名称、符号与地址；粘贴完整 Token / Mint 地址还可直接在工厂登记中定位。看板只覆盖当前支持的 Corla 工厂，不是全站所有 Flap 代币。

看板在前台可见时约每 3 秒自动查询新项目和筹资进度，保留搜索、筛选和已加载的分页。切走后暂停，回来立即补刷；RPC 暂时不可用时保留上次结果并自动重试。看板查询只读，不影响实盘狙击的独立监听。

看板按合约地址识别支付币并读取精度，不按简称或固定的 18 位推断。筹资中的 BNB、USDT 或其他已核验支付币项目可配置 Mint 或狙击；已开盘的项目可配置领币。代币余额用于本金，BNB 用于 Gas。ERC-20 额度不足时，只有在你确认启动实盘后，才按核对金额给 Corla 工厂（Mint）或 PancakeSwap V2 Router（买入）授权；不足的现有非零额度先清零，已有足额授权则跳过，停止任务不会自动撤销。读取失败时，单卡保留上次快照并自动重试。

点击「代币看板 → 底池目录」可区分 [Flap 创建页](https://flap.sh/apps/corla/create?lang=zh)的候选资产与 BSC 上实际开放的底池。目录以创建页发布的 IPFS 快照为候选范围，开放状态与精度通过同一区块的 [Flap Pool Launch Portal](https://docs.flap.sh/en/flap/v2/developers/pool-launch/build-an-indexer#quote-token-configuration-launchquoteconfig)、Corla 工厂和代币合约核验。区块 #133546461 的 104 个候选中有 7 个已开放：BNB、USDT、USD1、ZCASH、QQQB、BNCB、FXIon。当时还没有 ZCASH 的 Corla 项目；项目出现后会像其他币一样识别，无需再改交易代码。

如果弹窗提示「本地后台尚未加载底池接口」，说明浏览器已读到新版界面，本地 Node.js 服务仍在运行旧版本。先在控制台确认没有运行中的任务，再重新启动 Corla 并刷新页面。链上查询暂时失败时直接在弹窗内重试即可。

候选列表只用于展示，不参与签名或授权。若官方发布新版目录，可把核实后的原始 CID 设为 `FLAP_CORLA_QUOTE_CATALOG_CID` 后重启本地服务。即使新币尚未列入本地目录，已登记的 Corla 项目也会按合约地址读取：筹资阶段复核创建参数指定的 DEX、Portal 开放状态、Mint 记录的精度及实际代币精度；ERC-20 Mint 还核验工厂登记键明确指向该项目及支付币。未开放、不可验证或不是 PancakeSwap V2 直连的项目不启动相关交易。已开盘后的领币不受当前底池配置变动影响。

每张卡片从工厂登记的链上创建时间计算筹资用时。筹资中持续更新；未满自然到期时停在截止时间；打满后用达到总批数的 `Minted` 事件所在区块时间计算固定用时。历史证据在后台核验，暂未读到时显示「打满用时待核验」，不以网页发现时间或截止时间冒充打满时间。历史查询使用独立只读 RPC（可用 `BSC_CATALOG_HISTORY_RPC_URL` 和 `BSC_CATALOG_HISTORY_RPC_BACKUP_URLS` 覆盖），不阻塞进度刷新。

点卡片右上角的「Flap ↗」会在新标签页打开对应的 Flap 官方 Corla 代币详情。点卡片的「加入 Mint」或「加入狙击」会打开对应项目配置。只有保存才会加入对应列表，两个工作区相互独立；浏览、筛选或选币本身不会签名或发单。

### Chrome 桌面通知

从代币看板标题旁点「通知设置」，或进入 [预算与 Gas → 桌面通知](http://127.0.0.1:3924/#settings)，打开总开关并按页面提示允许 Chrome 通知。两类提醒可以独立关闭，设置保存在当前浏览器。可选择「异常 Mint」或「白名单 Mint」后点「发送测试通知」：分别用 [ai16z](https://bscscan.com/tx/0x5a6b54cddaa5afccb04b8ffaa558ec3b9bb912ec2f98f0a3bf58fd95527ba9c0#eventlog) 的 60 秒内新增 17/50 批和[比特币共建](https://bscscan.com/tx/0x45f8131203c7966c704d78e1b07b8bad5b3b55f9a137961492c57b8c1fa09fa2#eventlog)启用白名单的真实历史事件，按正式提醒样式预览，标题会加「测试」标记。点击测试或正式提醒都会返回代币看板，按合约地址定位项目。

- **白名单通知**：开启后监测 Corla v4 工厂新创建的白名单 Mint，以创建区块的合约配置为准，不补发启动前已有的项目，也不判断你的钱包是否在白名单内。
- **异常 Mint 通知**：以同一项目的链上 Mint 事件计算滚动 60 秒内的新增批数；严格超过总批数的三分之一就推送，不等满一分钟。恰好等于三分之一不提醒。此提醒表示筹集速度，不等于对项目安全性的判断。

测试和正式通知会显示对应代币的 Flap 头像。正式提醒优先用已有头像；项目资料或图片读取超时则照常发出文字提醒。每次点击「发送测试通知」都单独向 Chrome 提交，页面会显示本次提交状态。若页面显示已提交但没有横幅，可检查系统通知中心及 Windows 给 Chrome 的横幅、勿扰设置。测试通知不改变正式链上提醒的去重。

通知监控使用独立只读 RPC，和网页是否停留在代币看板无关，不会签名、发交易或访问钱包密钥。可以切到别的标签页，但至少留一个控制台标签页和本地服务运行；如果 Chrome 休眠/丢弃了标签页、关闭了页面或 Windows 勿扰拦截横幅，不能保证收到弹窗。可用 `BSC_NOTIFICATIONS_RPC_URL`、`BSC_NOTIFICATIONS_RPC_BACKUP_URLS` 为通知单独配置支持 `eth_getLogs` 的节点。

如果异常关机后提示钱包库写入锁未释放，先关闭所有 Corla 控制台进程，确认没有钱包写入在运行，再仅移除遗留的 `state/wallet-vault.json.lock`。不要删除加密钱包库或交易日志数据库。

### RPC 自动测速、备用切换

打开 [预算与 Gas → RPC 节点](http://127.0.0.1:3924/#settings) 查看各用途的主 RPC、当前节点、实测延迟和退避状态。节点先验证 BSC 主网（56）及区块高度，再按对应方法的平滑往返延迟排序（开盘补扫测 `eth_getLogs`，狙击测 `eth_simulateV1`，其余测 `eth_blockNumber`）；启用时测速，健康节点约每 30 秒复测。遇到限流（含 HTTP 429）、超时或节点故障，符合条件的读取自动走备用，故障节点冷却后重新探测；恢复并仍是最快合格节点时自动切回。

看板、元数据、Mint/领币、HTTP 开盘补扫和狙击买入各用独立节点池。HTTP 补扫只用实际通过 `eth_getLogs` 探测的节点（[BNB 官方公共节点禁用了该方法](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)）；狙击买入要求通过 `eth_simulateV1`。WebSocket 仍独立监听。某些公共备用当下可能限流或不可用，只有合格节点参与切换。测速不会打开钱包库或发送交易。

- 默认内置多个公共节点，不必手填。若使用自定义 RPC，不会擅自为它混入公共备用；在本机 `config.local.json` 用 `rpcBackupUrls` 设置最多 7 个可信备用 URL（`[]` 表示不加备用），或设置逗号分隔的 `BSC_RPC_BACKUP_URLS` 覆盖它。
- 只为某个工作区自定义时，使用 `BSC_WATCH_RPC_URL` / `BSC_WATCH_RPC_BACKUP_URLS`、`BSC_SNIPE_RPC_URL` / `BSC_SNIPE_RPC_BACKUP_URLS`，看板和元数据同理使用 `BSC_DASHBOARD_RPC_*` / `BSC_METADATA_RPC_*`。单独设某用途的 URL 时，该用途只用对应的备用列表，不继承通用备用。修改本机配置或环境变量后需重启服务。
- Mint 和领币的已签交易只在明确收到 HTTP 429 拒收时才可将同一份签名数据改投可信备用。**狙击每轮只签一笔交易**，默认投一个节点；并发线程数大于 1 时，将同一份签名同时投给狙击 RPC 池中的多个健康节点，并采用最先返回匹配哈希的应答。只要有结果不明的投递且没有有效应答，就保留原哈希待核对。竞争模式仍仅在上一轮明确未接收或链上回退后才可能开始新一轮。

## CLI：查询、模拟与故障排查

需要 Node.js 24 或更高版本，且包含 `node:sqlite`（实盘日志使用内置 SQLite）。在本目录打开 PowerShell：

```powershell
npm.cmd ci
npm.cmd start -- status
npm.cmd start -- watch --once
npm.cmd start -- quote --token 0x9b540b85d7dc7f3db4fbb7cebc45fb2214667777
npm.cmd start -- discover --blocks 12000
```

- `status`：显示实际 Mint 进度、是否开盘、交易池。填了 `watchWallets` 也会显示每个地址的批数和领取状态。
- `watch`：持续监控已配置的链接，按 Ctrl+C 停止。`--once` 只检查一轮。非实盘模式只使用 `watchWallets` 公共地址，绝不打开 keystore。留空即只读。
- `quote`：对**已经开盘**的指定样本做 PancakeSwap V2 买入→模拟授权→模拟卖出，不受开盘时限限制，不签名、不广播。BNB 样本可省略 `--wallet` 并使用模拟余额；ERC-20 样本须用 `--wallet` 指定已有该支付币和 Router 额度的公开地址。
- `discover`：从固定工厂的事件发现新项目并输出可用链接；不会自动添加项目或买入。扫描按区块数，不是分钟。

输出为 JSON Lines。金额通常以 wei 或 Token 最小单位输出，`buyTax`、`sellTax` 和 `priceImpactBps` 为基点（100 bps = 1%）。所有日志时间为 UTC；链上日期以区块时间为准。

## 配置

```powershell
Copy-Item config.example.json config.local.json
Copy-Item wallets.example.json wallets.local.json
```

| 配置 | 用途 |
|---|---|
| `targets[].url` | 粘贴 Corla Mint 链接。工具会复核工厂登记、Mint 合约实现、预期 Token 地址 |
| `mintBatches` | 每钱包在该项目的目标**累计批数**，0–32；0 不 Mint。控制台新建时，项目剩余份额够覆盖链上单地址上限则取该上限（最多 32），不足但还有份额时默认 1。已 Mint 的批数计入目标，执行时不超过合约上限 |
| `mintWallets` | 项目指定参与的钱包地址列表，Mint 和自动领币使用同一批钱包。控制台保存会记录所选地址；CLI 和旧配置省略时仍表示全部已加载钱包 |
| `maxMintPriceBnb` / `maxMintPriceQuote` | 按项目支付币选择其一作为发单单批保护价。ERC-20 Mint 另设 `quoteToken` 和 `quoteDecimals`；控制台自动填充并在执行时复核 |
| `autoClaim` | 已开盘后给持有未领取份额的钱包发 `claim()`，包括此前在网页上 Mint 的钱包 |
| `snipeTargets` | 独立狙击列表。BNB 项填 URL 字符串；ERC-20 项填对象 `{url, quoteToken, quoteDecimals, amountQuote, minLiquidityQuote}`，两个金额为十进制字符串。显式空数组表示不狙击任何项目 |
| `snipe.amountBnb` / `walletCount` | 单钱包买入额 / 从钱包清单前面取几个钱包买入 |
| `snipe.minLiquidityBnb` | 交易池最低 WBNB 储备 |
| `snipe.slippageBps` / `maxPriceImpactBps` | 额外滑点 / 最大报价价格冲击（包含 V2 交易费） |
| `snipe.maxOpeningPremiumBps` | 相对开盘初始池净报价允许的最高成交价溢价：0–1000 bps，默认 1000（10%）；0 表示不得高于开盘价，不是禁用 |
| `snipe.requirePreopen` | 新配置默认 `true`：「没抢到开盘就不追」，只允许网页提前路径，需要配置 2–20 轮。旧配置只保存了轮数时保留原来的确认后行为 |
| `snipe.maxBuyTaxBps` / `maxSellTaxBps` | 允许的最大链上买税 / 卖税 |
| `snipe.windowBlocks` / `deadlineSeconds` | 距开盘的区块窗口 / 从报价区块起算的链上交易有效期 |
| `snipe.scanMs` | 狙击工作区 HTTP 补扫目标间隔，默认 350ms；WSS 推送不等该间隔 |
| `snipe.broadcastConcurrency` | 网页「并发线程数」，1–8，默认 1。同一份签名每轮并行投递的健康狙击 RPC 上限，按实际可用节点数投递，不增加链上交易笔数 |
| `snipe.repeatAttempts` | 网页「并发次数」，每项目每钱包 1–20 轮；开启不追时默认 2 轮。关闭不追后可选 1 轮（确认后单轮）。Gas 按轮预留，与投递节点数无关 |
| `maxTotalBnb` | BNB 总上限，包括 BNB 项目本金和所有 Gas（每钱包、币种和授权对象最多额外预留两笔授权 Gas）。ERC-20 本金单独核对，不折算为 BNB |
| `maxGasPriceGwei` / `gasLimitCap` | Gas 单价 / 单笔 Gas 上限；不会自动加价。样本末笔 Mint 实际消耗约 **710 万 Gas**，不能按普通 Mint 上限设置 |
| `rpcUrl` / `rpcBackupUrls` / `pollMs` | BSC 节点 / 显式备用节点数组 / 轮询间隔，可用 `BSC_RPC_URL` 和 `BSC_RPC_BACKUP_URLS` 覆盖节点设置 |

示例配置只用于演示两个样本，不是买入建议。把需要模拟的地址填入 `watchWallets`，然后运行 `npm.cmd start -- watch --config config.local.json --once`。启用买入时，用长时间运行的 `watch` 监听后续事件：已在启动前开盘的币不会被追买。

## CLI 实盘开关（不是控制台的必需步骤）

1. 建议用专用小额钱包。已有兼容 EVM JSON keystore 时，在 `wallets.local.json` 填入相对该文件的 keystore 路径及对应的密码环境变量名。也可用离线脚本生成（只保存加密 keystore，不打印密钥）：

   ```powershell
   node src/keygen.mjs keystores/wallet-1.json
   # 如确有需要，本地导入专用钱包；输入不回显：
   node src/keygen.mjs keystores/wallet-2.json --import
   ```

2. 备份加密文件，记录地址，独立保管密码。钱包清单中的文件名和密码环境变量名要与实际对应。用本地 PowerShell 读取密码，不把密码写在配置、命令历史或聊天里。以下是一只钱包的例子，多只钱包按清单重复第一行；结束后清除临时变量。

   ```powershell
   $env:CORLA_WALLET_1_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Wallet 1 keystore 密码' -AsSecureString)).Password
   try {
       npm.cmd start -- watch --live --config config.local.json
   } finally {
       Remove-Item Env:CORLA_WALLET_1_PASSWORD -ErrorAction SilentlyContinue
   }
   ```

3. 核对终端中的网络、钱包、项目、金额、Gas 和总预算。只有输入 `BSC LIVE` 才会启用签名和广播。运行期间不要在另一个程序里同时操作同一批钱包。

CLI 实盘若配置了开盘买入，须显式设置 `snipe.requirePreopen: false`、`snipe.repeatAttempts: 1` 与 `snipe.broadcastConcurrency: 1`，使用确认后单轮、单节点。

## 触发条件和边界

- **Mint / 领取**：只在已核实的公开阶段发单，BNB 走 Mint 的 `mint([])`，ERC-20 走 Corla 工厂的 `mintQuote(deploymentKey, [])`，每笔一批。同钱包等上一批确认后再继续。签名前重查筹资阶段、截止时间、价格、份额和支付入口。白名单期、Agent-only、超价、售完、超时不参与；不生成白名单证明。开盘后按未领取份额发送 `claim()`，只需要 BNB Gas。
- **开盘买入**：不拿网页「100%」作触发。确认后路径要求 Corla Mint 的 `Launched`、官方 Portal 的 `FlapDirectLaunched` 和正额注资出现在同一成功回执；再校验工厂、Token、Corla 指向同一 Pancake V2 池。网页可选择下述竞争模式；CLI 实盘仍只支持单次。
- **竞争模式**：父块剩 1–3 批时，可用完整待打包交易模拟连续打满和开盘，不必等链上单独出现倒数一批的快照；等待不消耗轮数。候选够数且通过顺序买卖模拟后才提交有最低到手量的买单。提前提交可能被排在开盘前而回退并消耗 Gas，不保证同块或首笔。默认开启「没抢到开盘就不追」：收到开盘信号即暂停新发单，确认后不补买。关闭后才允许受开盘价上限约束的确认后买入。已发出的买单仍可能之后成交。两路不并行提交同一钱包项目；已验证回退或明确拒收后才允许下一笔，配置上限 20 轮，不调低第一次最低到手量。CLI 实盘仅单轮、单节点。详见 [竞争模式和测速记录](docs/snipe-race.md)。
- **买入安全检查**：用实际支付币分别计算当前池和初始池的净到账，取更严格的 `amountOutMin`。确认后路径从开盘回执核验初始储备，从开盘区块核验买税；提前路径用经验证的顺序模拟。仍须通过同一地址的买→模拟授权新币→模拟卖出连续检查，之后只签买入；模拟里的新币授权和卖出均不广播。支付币的有限授权是启动时的独立操作。模拟不保证成交顺序、收益或以后能卖出。
- **速度和竞争**：狙击工作区对目标 Corla Mint 地址订阅已上链开盘日志，HTTP 重叠补扫兜底；启动时预验项目，开盘时并发验回执、池子、报价，之后并发执行交易预检。默认开盘 WSS 用 PublicNode（可通过 `BSC_WSS_URL` 覆盖），提前路径另用完整待打包订阅，支持 `BSC_PENDING_WSS_BACKUP_URLS` 并行补充来源。HTTP 补扫和报价/模拟/提交由各自的 RPC 池选路。日志分开显示待打包候选、发现开盘、发出请求、RPC 接收和链上回执。详见 [RPC 架构与测速](docs/snipe-latency.md)；可运行 `node scripts/bench-snipe-rpc.mjs` 重测。RPC 接收不等于成交；公共 RPC 限流、拥堵、链重组、价格变化都会影响结果。
- **同块研究（只读）**：`node scripts/probe-corla-pending.mjs --ws wss://bsc-rpc.publicnode.com --seconds 120` 独立观测已保存且仍在筹资的狙击项目，也可用 `--target "<Corla 链接>"` 指定。它只测实际末笔 Mint 的哈希是否先于本地开盘通知出现，不会读钱包、修改实盘名单、构建买单或提交 Builder。没有开盘样本时不计算覆盖率。
- **交易状态**：SQLite 先持久化已签交易哈希，再发给 RPC。控制台与 CLI 都验证回执所属的主链区块，并要求达到 3 个确认才报告成功或失败。检测到近期重组时退回待核对；广播结果不明或 nonce 占用时不重签、不重发。重启保留同一 `journalPath`，同钱包不对接不同日志；不要删日志解锁。切勿把钱包清单、加密 keystore 或交易日志放入公开仓库。
- **版本范围**：适用于已复核的 Corla v4 工厂和 PancakeSwap V2 原生／ERC-20 直连池。其他工厂、未复核的合约升级和不同 DEX 路径不自动纳入。

测试：`npm.cmd test`。测试钱包只用于模拟，不广播。
