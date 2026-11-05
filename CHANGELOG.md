# 更新日志

本文件记录 `dsh-fish-atme` 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.3.0] - 2026-11-05

这一版解决「回得像插件，不像我」：**人格可以取 AGENT.md，记忆可以接 dsh-memory-vector。**

### 新增

- **`personaSource`：底稿人格从哪来**
  `agent-md`（默认）读 `<DSH_HOME>/AGENT.md`，`builtin` 用源码里的「小肥鱼」。
  按 mtime 缓存重读，改文件下一跳生效；文件不存在 / 为空 → 自动回落 `builtin`，
  不会因为「没人格」就停摆。
- **`personaMode`：`personaPrompt` 的用法**
  `append` 追加在底稿后（旧行为），`replace` **整份替换**底稿。
  `replace` + 空串会回落底稿 —— 宁可多说一句，也不给模型一个空 system。
- **记忆：接 `dsh-memory-vector`**
  回复前拿「他的评论 + 视频标题」查 `POST /api/memory-vector/search`，
  按 `memoryMinScore` 过滤、`memoryTopK` 限条、`memoryMaxChars` 限字，拼进 user prompt。
  相关参数：`memoryEnabled`（默认关）/ `memoryTopK` / `memoryMaxChars` /
  `memoryMinScore` / `memoryScope` / `memoryEndpoint`。
- **设置页两栏**：「人格」（底稿来源、AGENT.md 路径、append/replace、正文提示、读到多少字）
  「记忆」（开关、条数、字数、相似度、范围、检索地址、接口是否可达）；草稿预览多显示「人格来源 / 记忆条数 / 带了哪几条」。

### 修复

- **不再把 `AGENT.md` 尾部的 memory-vector 托管快照塞进 system**
  那段每 21 天变一次、纯给人看的，进 prompt 只烧 token。
- **记忆里的噪音会先洗掉**：`<compacted-summary>` 压缩摘要、「【记忆·自动回想】」旁注、
  `你：` / `我：` 回放前缀。
- **记忆检索失败不抛**：插件没装、接口 404、连接被拒 —— 一律当没有记忆，
  回复照发，日志最多每小时一行（否则每 5 分钟一行会把真正的问题淹掉）。

### 变更

- `generateReply(llm, system, info, signal)`：第二参改成**外面拼好的整份 system**，
  人格拼接从它内部搬到 `buildSystemPrompt()`，方便单独测。
- `bili_at_me_draft` 与 `POST /api/fish-atme/draft` 多返回
  `personaSource` / `personaChars` / `memoryCount` / `memories`（+ `memoryError`）。
- `bili_at_me_status` 多返回人格来源与记忆开关状态。

### 测试

- 新增：人格三态（builtin / agent-md / 读不到回落）、append 与 replace、
  托管块剔除、AGENT.md 读取缓存、记忆裁剪（阈值 / 压缩摘要 / 旁注 / 前缀 / 字符预算）、
  记忆接口请求形状、检索失败降级、记忆关着不发请求。

---

## [未发布]

### 新增

- **`scripts/sanitize-check.mjs`：推送前脱敏体检**
  扫一遍要提交的文件，拦 cookie / csrf / UID / 本机绝对路径 / 邮箱 / 明文密钥 /
  运行时产物。只读，不联网，不改文件。命中任意一条退出码 1。
  用法：`node scripts/sanitize-check.mjs`（默认查暂存区）、`--all`（查全部受控文件）。

- **`.githooks/pre-commit`：提交时自动体检**
  启用：`git config core.hooksPath .githooks`。规则改了只动 `scripts/sanitize-check.mjs` 一处。

### 变更

- `package.json` 补 `scripts`：`npm test`（跑 `tests/offline.mjs`）、`npm run sanitize`。
  之前 README 写了「或 npm test」，但 package.json 里没有这个脚本，跑起来是空的。

---

## [0.2.0] - 2026-11-02

这一版全是「设置页」的坑。触发场景很日常：**白名单明明填了，定时器却一条都不回。**

### 修复

- **设置页保存会把白名单清空**（最严重）
  设置页保存时提交的是**整份 config**，而页面拿的是打开那一刻的 state 副本。
  如果配置在别处被改过（手改 JSON、换机器同步、另一个窗口），点一下「保存并生效」，
  旧值就会把新值盖回去 —— 表现是 `allowUids` 变成 `[]`，而空数组的语义是
  「只回登录账号自己」，于是别人的 @ 一条都不回，日志还一直写「没有要回的」。
  现在改成：**只提交这一次真的改动过的字段**，并且保存前先重新拉一次最新状态再合并。

- **设置页接口读的是启动时的内存快照**
  手动编辑配置文件之后，`GET /state` 返回的仍是插件加载那会儿的配置，
  页面显示过期值 —— 进一步放大了上一条（看到的是旧值，保存回去的也是旧值）。
  现在每次进 `/api/**` 都先 `reloadConfig()` 重读文件。

- **文档里的生效方式写错了**
  实测：改完 `index.js` 并不会自动热重载，得在插件管理里把条目**关掉再打开**；
  改完 `client.js` 除了关/开，还要**刷新页面**。只有「第一次给插件加 `dsh.client` 声明」
  才需要重启整个应用。README 已按实测改写。

### 新增

- **白名单为空时的警告**：设置页在 `allowUids` 为空时标黄提示
  *「现在只会回「你自己 @ 自己」，别人的 @ 一条都不会回。要回谁就把他 UID 填进来。」*
  —— 这条语义太容易踩空，宁可吵一点。

### 文档

- README 补充「更新日志」章节与本节对应关系
- README 的安全设计表格新增三行：配置防呆、保存不误伤、配置热读
- 新增本文件 `CHANGELOG.md`

### 升级注意

- 无需迁移数据；配置、去重表、日志格式都没变。
- 升级后请在设置页确认一次「白名单 UID」不是空的。
- 如果你的配置长期没动过，建议先开 `dryRun` 跑一跳，看日志里回给谁、回了什么，再关掉。

---

## [0.1.0] - 2026-11-01

首个版本。

### 新增

- 定时轮询 B 站「@我的」（`/x/msgfeed/at`），命中白名单就让模型写一句回复并发在评论下面
- 三道安全闸：白名单（`allowUids`）、每日额度（`maxPerDay`）、最小间隔（`minGapMinutes`），加 `rpid` 去重
- `dryRun` 模式：只写日志不发评论
- 三个模型工具：`bili_at_me`（读 @ 列表）、`bili_at_me_draft`（生成草稿，不发）、`bili_reply`（发评论，默认被安全闸拦住）
- 13 个可改参数：设置页 / 配置文件 / 模型工具三条路都能改
- 设置页「B站 @我」：状态、开关、节奏与额度、白名单、语气、模型、凭证路径、数据目录、日志尾巴
- 离线测试 `tests/offline.mjs`：纯函数、请求形状、配置落盘、定时器装卸，全程不碰网络

[0.2.0]: #020---2026-11-02
[0.1.0]: #010---2026-11-01
