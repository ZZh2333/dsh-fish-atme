/**
 * dsh-fish-atme 离线自测：不碰 B 站，只验纯逻辑 + 请求形状 + 配置接线。
 * 跑法：node tests/offline.mjs
 */
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apply, Config, DEFAULTS, name as pluginName, normalizeConfig, createWatcher, __test__,
} from '../index.js'
import {
  extractSubtitleText, fetchVideoContext,
  normalizeVideoMode, clampSubtitle, flattenSubtitle, briefToolOf, subtitleToolOf, resetVideoWarn,
} from '../index.js'

/** 每个用例一个临时目录，跑完就删 */
const tmpRoot = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'fish-atme-test-'))

const {
  tidyReply, normalize, postReply, generateReply, resolveHome, allowSet,
  stripManagedBlock, buildSystemPrompt, readAgentMd, formatMemories, memoryEndpointOf, fetchMemories,
} = __test__

let failed = 0
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${cond ? '' : `  ${extra}`}`)
  if (!cond) failed++
}
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)

// ── 插件身份：entry id 必须等于 name，否则设置页改不了参数 ──────────────────
eq('导出 name = fish-atme（要和 patch 里的 id 一致）', pluginName, 'fish-atme')
// Config 要靠 @deepseek-ai/schemastery。宿主里解析得到才有字段 schema；纯 node 跑测试时
// 解析不到，插件按设计降级（设置面板走 /api/fish-atme，不依赖它）——这不算失败，
// 但「拿到了却不对」必须失败。
if (Config === undefined) {
  console.log('⚠️ 跳过 Config 结构检查：这个环境解析不到 @deepseek-ai/schemastery（插件已降级）')
} else {
  ok('导出 Config（有它设置页才认参数）', typeof Config === 'function' && Object.keys(Config.dict ?? {}).length > 0)
}

// ── Config：默认值 + volatile 标记 ────────────────────────────────────────
// ⚠️ 别用 Config({}) 取默认值：volatile 字段在 schemastery 里解析出来是个空壳，
//    真正的默认值挂在 schema.meta.default 上（DSH 的设置层就是读这个）。
if (Config !== undefined) {
  const dict = Config.dict ?? {}
  const def = (key) => dict[key]?.meta?.default
  eq('默认 intervalMinutes', def('intervalMinutes'), 5)
  eq('默认 maxPerDay', def('maxPerDay'), 3)
  eq('默认 minGapMinutes', def('minGapMinutes'), 10)
  eq('默认 dryRun', def('dryRun'), false)
  eq('默认 includeOthers（陌生人默认不碰）', def('includeOthers'), false)
  eq('默认 allowUids 是空数组', def('allowUids'), [])
  eq('默认 personaSource = agent-md', def('personaSource'), 'agent-md')
  eq('默认 personaMode = append', def('personaMode'), 'append')
  eq('默认记忆关着（不白烧 token）', def('memoryEnabled'), false)
  eq('默认 memoryTopK', def('memoryTopK'), 3)

  // DSH 的 settings.update() 只写 volatile 字段；漏标记 = 设置页报错
  const keys = Object.keys(dict)
  const volatile = keys.filter((key) => dict[key]?.meta?.volatile === true)
  ok('每个字段都带 volatile（否则设置写不进去）', keys.length > 0 && volatile.length === keys.length, `volatile=${volatile.length}/${keys.length}`)
}

// ── tidyReply ────────────────────────────────────────────────────────────
eq('剥引号', tidyReply('“海底真好看”', 80), '海底真好看')
eq('剥 @ 前缀', tidyReply('@测试用户 海底真好看', 80), '海底真好看')
eq('压成一行', tidyReply('第一行\n\n第二行', 80), '第一行 第二行')
ok('超长截断', tidyReply('鱼'.repeat(50), 10).length === 10)
eq('纯空白给空串', tidyReply('  \n ', 80), '')

// ── normalize：字段映射（照 2026-11-01 实测）──────────────────────────────
const n = normalize({
  user: { mid: 12345678, nickname: '测试用户' },
  at_time: 1790000000,
  item: { subject_id: 100000000000001, source_id: 318880000001, source_content: '@测试账号 来看看', title: '某视频' },
})
eq('from', n.from, '测试用户')
eq('mid', n.mid, '12345678')
eq('rpid 取 source_id', n.rpid, '318880000001')
eq('aid 取 subject_id', n.aid, '100000000000001')
eq('text', n.text, '@测试账号 来看看')

// ── allowSet：白名单解析 ─────────────────────────────────────────────────
eq('空配置回落到登录账号自己', [...allowSet({ allowUids: [] }, '10000000')], ['10000000'])
eq('逗号/空格都能拆', [...allowSet({ allowUids: ['12345678, 12345 678'] }, '10000000')], ['12345678', '12345', '678'])
eq('非数字会被丢掉', [...allowSet({ allowUids: ['abc', '999'] }, '10000000')], ['999'])

// ── normalizeConfig：volatile 占位对象必须回落默认（血泪教训）──────────────
{
  const soggy = { home: {}, enabled: {}, provider: {}, allowUids: {}, maxPerDay: {}, dryRun: {} }
  const cleaned = normalizeConfig(soggy)
  eq('占位对象 → 回落默认', [cleaned.home, cleaned.enabled, cleaned.provider, cleaned.maxPerDay, cleaned.dryRun],
    ['', true, 'ark-code-latest', 3, false])
  ok('home 不会变成 [object Object]', cleaned.home === '')
  const real = normalizeConfig({ home: 'D:/x', maxPerDay: 7, allowUids: ['1'], dryRun: true })
  eq('真值原样保留', [real.home, real.maxPerDay, real.allowUids, real.dryRun], ['D:/x', 7, ['1'], true])
}

// ── resolveHome ──────────────────────────────────────────────────────────
eq('home 没配时回落到默认目录', resolveHome({ home: '' }).endsWith('bili-duty'), true)
eq('home 配了就用配的', resolveHome({ home: 'D:/x' }), 'D:/x')

// ── postReply：请求形状（拦 fetch，不真发）────────────────────────────────
{
  let captured = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return { ok: true, json: async () => ({ code: 0, data: { rpid: 318900886817 } }) }
  }
  const rpid = await postReply({ cookie: 'SESSDATA=x', csrf: 'csrf-token', aid: 117, root: 318, message: '海底真好看', signal: undefined })
  globalThis.fetch = realFetch
  const body = new URLSearchParams(captured.init.body)
  eq('打到 /x/v2/reply/add', captured.url, 'https://api.bilibili.com/x/v2/reply/add')
  eq('方法 POST', captured.init.method, 'POST')
  eq('oid', body.get('oid'), '117')
  eq('root/parent 指向被回复的评论', [body.get('root'), body.get('parent')], ['318', '318'])
  eq('带 csrf', body.get('csrf'), 'csrf-token')
  eq('message', body.get('message'), '海底真好看')
  eq('返回 rpid', rpid, 318900886817)
}

// ── postReply：接口报错必须抛（不能假装成功）────────────────────────────
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 12002, message: '评论区已关闭' }) })
  let threw = false
  try {
    await postReply({ cookie: 'c', csrf: 't', aid: 1, root: 2, message: 'x' })
  } catch {
    threw = true
  }
  globalThis.fetch = realFetch
  ok('code!=0 时抛错', threw)
}

// ── generateReply：拼流 + system 原样透传 + 记忆接进 prompt ────────────────
{
  let seen = null
  const fakeLlm = {
    stream: (options) => {
      seen = options
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '海底' }
        yield { type: 'text-delta', index: 0, text: '真好看' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const text = await generateReply(fakeLlm, 'SYSTEM-整份', {
    title: 'T', text: 'hi', provider: 'p', model: 'm', memoryLines: ['他养了只鲸鱼', '他讨厌客套话'],
  }, undefined)
  const promptText = (seen?.messages?.[0]?.content ?? []).map((b) => b.text ?? '').join('')
  eq('拼接流', text, '海底真好看')
  eq('system 原样透传（人格在外面拼好）', seen?.system, 'SYSTEM-整份')
  ok('记忆进了 user prompt', promptText.includes('他养了只鲸鱼') && promptText.includes('他讨厌客套话'))
  ok('记忆块在正文之前', promptText.indexOf('他养了只鲸鱼') < promptText.indexOf('他在评论里写了'))
}

{
  let seen = null
  const fakeLlm = {
    stream: (options) => {
      seen = options
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '好' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  await generateReply(fakeLlm, '', { title: 'T', text: 'hi', provider: 'p', model: 'm' }, undefined)
  const promptText = (seen?.messages?.[0]?.content ?? []).map((b) => b.text ?? '').join('')
  ok('没有记忆时不留空块', !promptText.includes('你记得的相关旧事'))
  ok('system 空时回落内置底稿', String(seen?.system ?? '').includes('小肥鱼'))
}

// ── generateReply：模型吐出空正文必须抛，不能当成功 ──────────────────────
{
  const silentLlm = {
    stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })(),
  }
  let threw = null
  try {
    await generateReply(silentLlm, 'S', { title: 'T', text: 'hi', provider: 'p', model: 'm' }, undefined)
  } catch (error) {
    threw = error
  }
  ok('空正文抛错（否则会发空评论 / 给空草稿）', threw !== null, String(threw))
  ok('错误信息说清楚是空正文', String(threw?.message ?? '').includes('没返回任何正文'))
}

// ── 人格：stripManagedBlock / buildSystemPrompt ───────────────────────────
{
  const md = [
    '# 你是谁',
    '你是子非鱼。',
    '',
    '## 边界',
    '不编造。',
    '',
    '> 由 dsh-memory-vector 自动维护：按「命中次数 × 时间衰减」给记忆排序。',
    '- 一条记忆',
  ].join('\n')
  const stripped = stripManagedBlock(md)
  ok('切掉 memory-vector 托管块', !stripped.includes('自动维护') && !stripped.includes('一条记忆'))
  ok('保留正文', stripped.includes('你是子非鱼') && stripped.includes('不编造'))

  const builtin = buildSystemPrompt({ source: 'builtin' })
  eq('builtin 来源', builtin.source, 'builtin')
  ok('builtin 用内置底稿', builtin.system.includes('小肥鱼'))

  const fromAgent = buildSystemPrompt({ source: 'agent-md', agentText: md })
  eq('agent-md 来源', fromAgent.source, 'agent-md')
  ok('agent-md 用文件正文', fromAgent.system.includes('你是子非鱼') && !fromAgent.system.includes('小肥鱼'))

  const fallback = buildSystemPrompt({ source: 'agent-md', agentText: '' })
  eq('读不到 AGENT.md 回落 builtin', fallback.source, 'builtin')
  ok('回落时不炸', fallback.system.includes('小肥鱼'))

  const append = buildSystemPrompt({ source: 'builtin', personaPrompt: '更贱一点', personaMode: 'append' })
  ok('append：底稿还在', append.system.includes('小肥鱼') && append.system.includes('更贱一点'))
  const replace = buildSystemPrompt({ source: 'builtin', personaPrompt: '你是子非鱼', personaMode: 'replace' })
  ok('replace：底稿被顶掉', !replace.system.includes('小肥鱼') && replace.system.startsWith('你是子非鱼'))
  ok('replace：场景规则仍然在', replace.system.includes('60 字以内') && replace.system.includes('只输出回复正文'))
  const replaceEmpty = buildSystemPrompt({ source: 'builtin', personaPrompt: '   ', personaMode: 'replace' })
  ok('replace + 空串：不允许空 system（回落底稿）', replaceEmpty.system.includes('小肥鱼'))

  // 2026-11-05 的回归：agent-md 把底稿整份替换后，评论场景规则一度全丢，
  // B 站回复变成带小标题的分析报告。三种来源都必须带上场景规则。
  ok('builtin 也带场景规则', builtin.system.includes('60 字以内'))
  ok('agent-md 也带场景规则', fromAgent.system.includes('60 字以内') && fromAgent.system.includes('不要小标题'))
  ok('场景规则排在人格之后（后者权重更高）', fromAgent.system.indexOf('你是子非鱼') < fromAgent.system.indexOf('场景规则'))
  const noRules = buildSystemPrompt({ source: 'agent-md', agentText: md, keepReplyRules: false })
  ok('keepReplyRules=false 时才不加', !noRules.system.includes('60 字以内'))
}

// ── 视频内容：先看懂视频再回 ──────────────────────────────────────────────
{
  // 返回形状有好几种，都得能刨出正文
  eq('认 { text }', extractSubtitleText({ text: '大家好' }), '大家好')
  eq('认 JSON 字符串', extractSubtitleText('{"text":"字幕正文"}'), '字幕正文')
  eq('认裸字符串', extractSubtitleText('就是字幕'), '就是字幕')
  eq('认 content 块', extractSubtitleText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  eq('认 raw 包一层', extractSubtitleText({ raw: '{"text":"嵌套"}' }), '嵌套')
  eq('没字幕（只有 message）→ 空串', extractSubtitleText({ message: '该视频没有字幕' }), '')
  eq('null 不炸', extractSubtitleText(null), '')

  // ── 0.6.0：本插件只做「搬运 + 长度护栏」，不做理解 ──
  eq('模式识别：默认 brief', normalizeVideoMode(undefined), 'brief')
  eq('模式识别：老值 full 也当 brief', normalizeVideoMode('full'), 'brief')
  eq('模式识别：显式 subtitle 走原文', normalizeVideoMode('subtitle'), 'subtitle')
  eq('模式识别：head 老值降级成 subtitle', normalizeVideoMode('head'), 'subtitle')
  eq('模式识别：off', normalizeVideoMode('OFF'), 'off')

  // 护栏：短的原样、长的按字符截断，并如实报出「本来多长」
  {
    const short = clampSubtitle('第一句\n第二句', 100)
    eq('短字幕原样搬运（只接逗号）', [short.text, short.total], ['第一句，第二句', 7])
    const long = '一'.repeat(50)
    const cut = clampSubtitle(long, 10)
    eq('超预算就截断（不挑段）', cut.text, `${'一'.repeat(9)}…`)
    eq('报出原本多长', cut.total, 50)
    eq('预算 0 = 不带字幕', clampSubtitle('随便', 0).text, '')
  }

  // 关键点：同一段 5545 字字幕，只要预算够，**一个字都不许少**（理解归刷B站，不归这里）
  {
    const real = [
      '大家好我是娜娜，一个 AI 已经能帮你写代码查问题提交修改。',
      '一个人通常只能同时跟进三到五个活跃会话，实验里也反复提到会话这个词。',
      '，团队做了初步的调度实验，Super-agent 的任务完成时间中位数是 12.4 分钟，95 分位是 15.7 分钟；单会话的 95 分位达到 29.5 分钟。',
      '如果你喜欢本期视频记得订阅点赞，我们下期再见。',
    ].join('')
    const full = clampSubtitle(real, 12000)
    eq('预算够就原样全给', full.text, flattenSubtitle(real))
    ok('没有加任何省略号', !full.text.includes('…'), full.text.slice(-40))
    ok('结尾也在（没被截）', full.text.endsWith('我们下期再见。'))
    eq('total 与实际长度一致', full.total, full.text.length)
  }

  // 取字幕：工具在 → 拿到正文
  {
    const ctx = { tools: { get: (n) => n === 'bili_subtitle' ? { execute: async () => ({ text: '这条视频在讲用 DSH 装插件' }) } : null } }
    const got = await fetchVideoContext(ctx, { videoContext: 'full', videoContextMaxChars: 8000 }, 'BV1xx411c7mD', () => {})
    eq('拿到字幕', [got.source, got.chars > 0], ['subtitle', true])
    ok('字幕正文进得去', got.text.includes('装插件'))
  }
  // 长视频 + 预算不够 → 只做长度截断，并如实报出原长（不挑段）
  {
    const longText = `${'无关铺垫，'.repeat(800)}这段是结尾的答案。`
    const ctx = { tools: { get: () => ({ execute: async () => ({ text: longText }) }) } }
    const got = await fetchVideoContext(ctx, { videoContext: 'full', videoContextMaxChars: 3000 }, 'BV1xx411c7mD', () => {})
    eq('端到端：按预算截断', got.chars, 3000)
    ok('端到端：报出字幕原本多长', got.total > got.chars, `total=${got.total} chars=${got.chars}`)
    ok('端到端：截断处有省略号', got.text.endsWith('…'))
  }
  // 预算够 → 一个字都不许少（这是「不替刷B站做理解」的硬约束）
  {
    const text = '开头。中间。结尾。'
    const ctx = { tools: { get: () => ({ execute: async () => ({ text }) }) } }
    const got = await fetchVideoContext(ctx, { videoContext: 'full', videoContextMaxChars: 12000 }, 'BV1xx411c7mD', () => {})
    eq('预算够就全量搬运', got.text, flattenSubtitle(text))
    eq('总长一致', got.total, got.chars)
  }

  // ── 0.7.0：优先要「刷B站」的理解要点 ──
  {
    const brief = { ok: true, bvid: 'BV1xx411c7mD', title: 'T', brief: '视频讲调度实验：中位数 12.4 分钟。', chars: 20, subtitleChars: 5545 }
    const calls = []
    const tools = (n) => {
      if (n === 'bili_brief') return { execute: async (args) => { calls.push(['brief', args]); return brief } }
      if (n === 'bili_subtitle') return { execute: async () => { calls.push(['subtitle']); return { text: '字幕原文' } } }
      return null
    }
    const got = await fetchVideoContext({ tools: { get: tools } }, { videoContext: 'brief', videoBriefChars: 400 }, 'BV1xx411c7mD', () => {}, '差多少？')
    eq('优先走 bili_brief', got.source, 'brief')
    ok('要点原文进 prompt', got.text.includes('12.4'))
    eq('带上字幕原本多长', got.total, 5545)
    eq('调 brief 时把问题传过去了', calls[0][1].question, '差多少？')
    eq('没有多调一次字幕', calls.length, 1)
  }
  {
    // 老版本刷B站没有 bili_brief（或没 llm）→ 自动退回字幕原文
    const tools = (n) => {
      if (n === 'bili_brief') return { execute: async () => ({ ok: false, error: '这个宿主没有 llm 服务' }) }
      if (n === 'bili_subtitle') return { execute: async () => ({ text: '这里才是字幕原文' }) }
      return null
    }
    const logs = []
    resetVideoWarn()
    const got = await fetchVideoContext({ tools: { get: tools } }, { videoContext: 'brief' }, 'BV1xx411c7mD', (l) => logs.push(l))
    eq('brief 失败 → 退回字幕原文', got.source, 'subtitle')
    ok('退回时字幕正文在', got.text.includes('这里才是字幕原文'))
    ok('日志里说明了为什么退回', logs.some((l) => l.includes('退回字幕原文')), logs.join(' | '))
  }
  {
    // 明确指定 subtitle 档 → 连 brief 都不碰
    const calls = []
    const tools = (n) => {
      if (n === 'bili_brief') return { execute: async () => { calls.push('brief'); return { ok: true, brief: 'x' } } }
      if (n === 'bili_subtitle') return { execute: async () => ({ text: '原文' }) }
      return null
    }
    const got = await fetchVideoContext({ tools: { get: tools } }, { videoContext: 'subtitle' }, 'BV1xx411c7mD', () => {})
    eq('subtitle 档不调 brief', calls.length, 0)
    eq('subtitle 档拿原文', got.text, '原文')
  }
  {
    // 关掉 → 两个工具都不碰
    const tools = { get: () => ({ execute: async () => { throw new Error('不该被调用') } }) }
    const got = await fetchVideoContext({ tools }, { videoContext: 'off' }, 'BV1xx411c7mD', () => {})
    eq('关掉就不碰工具', [got.source, got.text], ['off', ''])
  }
  {
    const got = await fetchVideoContext({ tools: { get: () => null } }, {}, '', () => {})
    eq('没有 BV 号就直说', got.source, 'none')
  }
  {
    eq('工具查找：有就有', briefToolOf({ tools: { get: (n) => n === 'bili_brief' ? { execute() {} } : null } }) !== null, true)
    eq('工具查找：没有就是 null', [briefToolOf({}), subtitleToolOf({})], [null, null])
  }
  // 工具不在 → 只看标题，且不抛
  {
    const ctx = { tools: { get: () => null } }
    const got = await fetchVideoContext(ctx, { videoContext: 'full' }, 'BV1xx411c7mD', () => {})
    eq('没有刷B站 → 空内容', got.text, '')
    ok('报出原因', String(got.error ?? '').includes('未安装') || String(got.error ?? '').includes('未启用'))
  }
  // 工具抛错 → 吞掉
  {
    const ctx = { tools: { get: () => ({ execute: async () => { throw new Error('MCP 挂了') } }) } }
    const got = await fetchVideoContext(ctx, { videoContext: 'full' }, 'BV1xx411c7mD', () => {})
    eq('工具抛错不影响回复', got.text, '')
    ok('错误信息带出来', String(got.error ?? '').includes('MCP'))
  }
  // 超时 → 不卡住整轮
  {
    const ctx = { tools: { get: () => ({ execute: () => new Promise(() => {}) }) } }
    const started = Date.now()
    const got = await fetchVideoContext(ctx, { videoContext: 'full', videoContextTimeoutMs: 1200 }, 'BV1xx411c7mD', () => {})
    ok('超时会放弃（不死等）', Date.now() - started < 4000, `用了 ${Date.now() - started}ms`)
    eq('超时也算没内容', got.text, '')
  }
  // 关掉开关 → 连工具都不碰
  {
    let called = false
    const ctx = { tools: { get: () => ({ execute: async () => { called = true; return { text: 'x' } } }) } }
    const got = await fetchVideoContext(ctx, { videoContext: 'off' }, 'BV1xx411c7mD', () => {})
    eq('off 时不取字幕', [called, got.source], [false, 'off'])
  }
  // 没有 BV 号（动态）→ 静默跳过
  {
    const got = await fetchVideoContext({ tools: { get: () => null } }, { videoContext: 'full' }, '', () => {})
    ok('没有 BV 号不报错', got.text === '' && String(got.error ?? '').includes('动态'))
  }
}

// ── 记忆：formatMemories 裁剪规则 ─────────────────────────────────────────
{
  const hits = [
    { text: '主人喜欢大白饭', similarity: 0.9 },
    { text: '低分的一条', similarity: 0.05 },
    { text: '我：This is an automatically generated checkpoint condensing', similarity: 0.9 },
    { text: '你：主人养了只鲸鱼', similarity: 0.8 },
    { text: '   ', similarity: 0.9 },
  ]
  const lines = formatMemories(hits, { maxChars: 600, minScore: 0.3, topK: 5 })
  ok('低于阈值的丢掉', !lines.some((l) => l.includes('低分')))
  ok('压缩摘要不进 prompt', !lines.some((l) => l.includes('checkpoint')))
  ok('空白丢掉', lines.every((l) => l.trim().length > 0))
  ok('「你：」前缀剥掉', lines.includes('主人养了只鲸鱼'))
  // 纯关键词命中没有 similarity：默认当噪音丢掉，显式允许才进来
  const ftsOnly = [{ text: '只有关键词命中的旧事', ftsRank: 1 }]
  eq('默认不接受纯关键词命中', formatMemories(ftsOnly, { maxChars: 600, minScore: 0.3, topK: 3 }), [])
  eq('显式允许时才收', formatMemories(ftsOnly, { maxChars: 600, minScore: 0.3, topK: 3, allowFtsOnly: true }), ['只有关键词命中的旧事'])
  const withTail = formatMemories(
    [{ text: '正事要紧 【记忆·自动回想】以下是从过去对话里检索到的相关片段', similarity: 0.9 }],
    { maxChars: 600, minScore: 0, topK: 3 },
  )
  eq('切掉「自动回想」的旁注尾巴', withTail[0], '正事要紧')
  eq('topK 生效', formatMemories(hits, { maxChars: 600, minScore: 0.3, topK: 1 }).length, 1)
  const clipped = formatMemories([{ text: '鱼'.repeat(100), similarity: 0.9 }], { maxChars: 20, minScore: 0, topK: 3 })
  ok('按字符预算截断', clipped[0].length === 20 && clipped[0].endsWith('…'), `len=${clipped[0].length}`)
}

// ── 记忆：fetchMemories 走 HTTP，形状按 memory-vector 的 /search ────────────
{
  let called = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    called = { url: String(url), body: JSON.parse(init.body) }
    return { ok: true, json: async () => ({ hits: [{ text: '他养了只鲸鱼', similarity: 0.9 }] }) }
  }
  const quiet = { memoryEnabled: true, memoryTopK: 2, memoryMaxChars: 100, memoryMinScore: 0.3, memoryScope: 'global', memoryEndpoint: '' }
  const fakeCtx = { webServer: { getOrigin: () => 'http://127.0.0.1:9999' } }
  const got = await fetchMemories(fakeCtx, quiet, '海底真好看', () => {})
  globalThis.fetch = realFetch
  eq('默认地址 = 本机 origin + /api/memory-vector/search', called?.url, 'http://127.0.0.1:9999/api/memory-vector/search')
  eq('请求带 query/k/scope', [called?.body.query, called?.body.k, called?.body.scope], ['海底真好看', 2, 'global'])
  eq('拿回一条', got.lines, ['他养了只鲸鱼'])
}

{
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  const logs = []
  const got = await fetchMemories(
    { webServer: { getOrigin: () => 'http://127.0.0.1:9999' } },
    { memoryEnabled: true, memoryTopK: 3, memoryMaxChars: 100, memoryMinScore: 0, memoryScope: 'global' },
    'q',
    (line) => logs.push(line),
  )
  globalThis.fetch = realFetch
  eq('检索失败不抛、返回空', got.lines, [])
  ok('失败会写一行日志', logs.length === 1 && logs[0].includes('记忆检索'))
}

{
  const endpoint = memoryEndpointOf({ webServer: { getOrigin: () => 'http://127.0.0.1:9999/' } }, {})
  eq('origin 尾部斜杠不会拼出 //', endpoint, 'http://127.0.0.1:9999/api/memory-vector/search')
  eq('显式配了就用配的', memoryEndpointOf({}, { memoryEndpoint: 'http://127.0.0.1:1/x/' }), 'http://127.0.0.1:1/x')
  eq('没有 webServer 就返回空', memoryEndpointOf({}, {}), '')
  const off = await fetchMemories({}, { memoryEnabled: false }, 'q', () => {})
  eq('记忆关着时一次网络请求都不发', off.lines, [])
}

// ── 记忆：readAgentMd 缓存 + 读不到返回空 ─────────────────────────────────
{
  const fsSync = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const file = path.join(os.tmpdir(), `fish-atme-agent-${process.pid}.md`)
  fsSync.writeFileSync(file, '# 你是谁\n你是子非鱼。\n\n> 由 dsh-memory-vector 自动维护：x\n- 旧记忆\n')
  const first = readAgentMd(file)
  ok('读到正文且不含托管块', first.includes('你是子非鱼') && !first.includes('旧记忆'))
  eq('重复读走缓存（内容一致）', readAgentMd(file), first)
  eq('文件不存在返回空串', readAgentMd(path.join(os.tmpdir(), 'fish-atme-not-exist-xyz.md')), '')
  fsSync.rmSync(file, { force: true })
  eq('删掉后再读也返回空', readAgentMd(file), '')
}

// ── apply：注册三个工具 + 定时器按配置开关 ───────────────────────────────
const makeCtx = () => {
  const registered = []
  const tags = []
  return {
    registered,
    tags,
    ctx: {
      tools: { register: (def) => registered.push(def.name) },
      llm: { stream: () => (async function* () {})() },
      webServer: { register: () => () => {} },
      effect: (fn, tag) => {
        tags.push(tag ?? '')
        return fn()
      },
    },
  }
}

// 把 setInterval/setTimeout 换成假的，数一数到底起了几个表（免得测试里真跑起定时器）
const timersCreated = (fn) => {
  const realInterval = globalThis.setInterval
  const realTimeout = globalThis.setTimeout
  let count = 0
  const fake = () => {
    count++
    return { unref() {} }
  }
  globalThis.setInterval = fake
  globalThis.setTimeout = fake
  try {
    fn()
  } finally {
    globalThis.setInterval = realInterval
    globalThis.setTimeout = realTimeout
  }
  return count
}

{
  const h = makeCtx()
  const timers = timersCreated(() => apply(h.ctx, { enabled: false, home: process.env.TEMP || '/tmp' }))
  eq('注册了三个工具', h.registered, ['bili_at_me', 'bili_at_me_draft', 'bili_at_me_status'])
  eq('enabled=false 时一个表都不起', timers, 0)
  ok('设置页的 HTTP 路由照常挂上', h.tags.some((tag) => tag.includes('/api/fish-atme')), `tags=${JSON.stringify(h.tags)}`)
}

{
  const h = makeCtx()
  const timers = timersCreated(() => apply(h.ctx, { enabled: true, intervalMinutes: 5, home: process.env.TEMP || '/tmp' }))
  eq('enabled=true 时起了表（周期 + 首跳）', timers, 2)
  ok('定时器挂了可清理的 effect', h.tags.some((tag) => tag.includes('定时器')), `tags=${JSON.stringify(h.tags)}`)
}

// ── HTTP 接口（设置页用的那三个）走一遍：真的调路由处理函数，不碰网络 ──────────
{
  const os = await import('node:os')
  const fsSync = await import('node:fs')
  const path = await import('node:path')
  const home = path.join(os.tmpdir(), 'fish-atme-http-test')
  fsSync.rmSync(home, { recursive: true, force: true })
  fsSync.mkdirSync(home, { recursive: true })
  // 铺一份假凭证，省得读文件就炸
  fsSync.writeFileSync(path.join(home, 'bili_credential.json'), JSON.stringify({
    sessdata: 'SESSDATA-VALUE', bili_jct: 'CSRF', dedeuserid: '10000000',
  }))

  let route = null
  const h = makeCtx()
  h.ctx.webServer = { register: (def) => { route = def; return () => { route = null } } }
  timersCreated(() => apply(h.ctx, { enabled: false, home }))

  ok('路由登记成 prefix /api/fish-atme', route?.kind === 'prefix' && route?.path === '/api/fish-atme', JSON.stringify(route?.path))

  const call = async (method, pathname, body) => {
    const req = new (await import('node:events')).EventEmitter()
    req.method = method
    req.url = pathname
    req.headers = { host: '127.0.0.1:9954', origin: 'http://127.0.0.1:9954', 'content-type': 'application/json' }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(chunk) { this.body = chunk },
    }
    const done = new Promise((resolve) => { res.end = (chunk) => { res.body = chunk; resolve() } })
    Promise.resolve().then(() => {
      if (body !== undefined) req.emit('data', JSON.stringify(body))
      req.emit('end')
    })
    await route.handler(req, res)
    await done
    return { code: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
  }

  const state = await call('GET', '/api/fish-atme/state')
  eq('GET /state 200', state.code, 200)
  ok('GET /state 带 config/status', Boolean(state.json?.config && state.json?.status))
  eq('默认 maxPerDay 3', state.json?.config?.maxPerDay, 3)
  eq('白名单空 = 回自己（这里只是展示，实际判断在 allowSet）', state.json?.config?.allowUids, [])

  const saved = await call('POST', '/api/fish-atme/config', { config: { intervalMinutes: 7, maxPerDay: 2, dryRun: true } })
  eq('POST /config 200', saved.code, 200)
  eq('保存后 intervalMinutes=7', saved.json?.config?.intervalMinutes, 7)
  eq('保存后 maxPerDay=2', saved.json?.config?.maxPerDay, 2)
  eq('保存后 dryRun=true', saved.json?.config?.dryRun, true)
  ok('覆盖写进了配置文件', JSON.parse(fsSync.readFileSync(path.join(home, 'fish-atme-config.json'), 'utf8')).intervalMinutes === 7)

  const again = await call('GET', '/api/fish-atme/state')
  eq('再读一次，改动还在', again.json?.config?.intervalMinutes, 7)

  // BOM：Windows 记事本 / PowerShell 5.1 写出来的配置文件带 UTF-8 BOM，
  // JSON.parse 会直接抛，整份设置被静默丢掉 —— 2026-11-05 真踩到了
  fsSync.writeFileSync(path.join(home, 'fish-atme-config.json'), '\uFEFF' + JSON.stringify({ maxPerDay: 9 }), 'utf8')
  const afterBom = await call('GET', '/api/fish-atme/state')
  eq('带 BOM 的配置也能读', afterBom.json?.config?.maxPerDay, 9)

  const bad = await call('GET', '/api/fish-atme/nope')
  eq('未知路径 404', bad.code, 404)

  // 跨源要被挡
  {
    const req = new (await import('node:events')).EventEmitter()
    req.method = 'GET'
    req.url = '/api/fish-atme/state'
    req.headers = { host: '127.0.0.1:9954', origin: 'http://evil.example' }
    const res = { setHeader() {}, end(chunk) { this.body = chunk } }
    const done = new Promise((resolve) => { res.end = (chunk) => { res.body = chunk; resolve() } })
    await route.handler(req, res)
    await done
    eq('别的源来的请求 403', res.statusCode, 403)
  }

  fsSync.rmSync(home, { recursive: true, force: true })
}

// ── 定时器整条跑一遍：这个作用域里只有 cfg，写成 config 就会炸 ─────────────
// 2026-11-05 真炸过：`定时器异常：config is not defined`（createWatcher 里没有 config 这个变量），
// 表现是日志里一直「查了一次」，某次真有人 @ 时定时器直接报错、一条都不回。
{
  const home = path.join(tmpRoot(), 'watch-home')
  fsSync.rmSync(home, { recursive: true, force: true })
  fsSync.mkdirSync(home, { recursive: true })
  fsSync.writeFileSync(path.join(home, 'bili_credential.json'), JSON.stringify({
    sessdata: 'SESSDATA-VALUE', bili_jct: 'CSRF', dedeuserid: '10000000',
  }))

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/x/msgfeed/at')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            items: [{
              user: { nickname: '清涵', mid: 10000000 },
              item: { source_id: '999', subject_id: '117', uri: 'https://www.bilibili.com/video/av117', title: '旧标题' },
              reply: { content: { message: '这条视频讲了啥' } },
            }],
          },
        }),
      }
    }
    if (u.includes('/x/web-interface/view')) {
      return { ok: true, json: async () => ({ code: 0, data: { bvid: 'BV1xx411c7mD', title: '真标题', owner: { name: '某个UP' } } }) }
    }
    return { ok: true, json: async () => ({ code: 0, data: {} }) }
  }

  const cfg = {
    enabled: true, home, dryRun: true, maxPerDay: 5, minGapMinutes: 1, intervalMinutes: 60,
    maxChars: 80, allowUids: [], includeOthers: true, provider: 'p', model: 'm',
    personaSource: 'builtin', personaMode: 'append', personaPrompt: '', keepReplyRules: true,
    memoryEnabled: false, videoContext: 'subtitle', videoContextMaxChars: 800, videoContextTimeoutMs: 2000,
  }
  const ctx = {
    tools: { get: () => null },      // 没装刷B站 → 只看标题，不该炸
    effect: () => () => {},
    llm: {
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: '这条讲的是插件怎么装' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
  }
  const watcher = createWatcher(ctx, () => cfg)
  watcher.stop()                      // 别让它真起表
  let error = null
  try {
    await watcher.tick()
  } catch (thrown) {
    error = thrown
  }
  globalThis.fetch = realFetch

  ok('tick 能整条跑通（作用域里不许出现 config）', error === null, String(error?.message ?? error))
  // 日志是异步 append（appendFile），立刻读会漏掉最后一行
  await new Promise((resolve) => setTimeout(resolve, 250))
  const logText = fsSync.readFileSync(path.join(home, 'fish-atme.log'), 'utf8')
  ok('dryRun 下写出草稿日志', logText.includes('[dryRun]') || logText.includes('回了'), logText.slice(-300))
  ok('日志里没有「定时器异常」', !logText.includes('定时器异常'), logText.slice(-300))
  fsSync.rmSync(home, { recursive: true, force: true })
}

// ── DEFAULTS 完整性 ─────────────────────────────────────────────────────
eq('DEFAULTS 覆盖关键参数', Object.keys(DEFAULTS).sort(), [
  'agentMdPath', 'allowUids', 'credentialPath', 'dryRun', 'enabled', 'home', 'includeOthers',
  'intervalMinutes', 'keepReplyRules', 'maxChars', 'maxPerDay', 'memoryAllowFtsOnly', 'memoryEnabled', 'memoryEndpoint',
  'memoryMaxChars', 'memoryMinScore', 'memoryScope', 'memoryTopK', 'minGapMinutes', 'model',
  'personaMode', 'personaPrompt', 'personaSource', 'provider', 'videoBriefChars', 'videoContext', 'videoContextMaxChars',
  'videoContextTimeoutMs',
].sort())

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
