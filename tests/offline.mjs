/**
 * dsh-fish-atme 离线自测：不碰 B 站，只验纯逻辑 + 请求形状 + 配置接线。
 * 跑法：node tests/offline.mjs
 */
import { apply, Config, DEFAULTS, name as pluginName, normalizeConfig, __test__ } from '../index.js'

const { tidyReply, normalize, postReply, generateReply, resolveHome, allowSet } = __test__

let failed = 0
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${cond ? '' : `  ${extra}`}`)
  if (!cond) failed++
}
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)

// ── 插件身份：entry id 必须等于 name，否则设置页改不了参数 ──────────────────
eq('导出 name = fish-atme（要和 patch 里的 id 一致）', pluginName, 'fish-atme')
ok('导出 Config（有它设置页才认参数）', typeof Config === 'function' && Object.keys(Config.dict ?? {}).length > 0)

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

  // DSH 的 settings.update() 只写 volatile 字段；漏标记 = 设置页报错
  const keys = Object.keys(dict)
  const volatile = keys.filter((key) => dict[key]?.meta?.volatile === true)
  ok('每个字段都带 volatile（否则设置写不进去）', keys.length > 0 && volatile.length === keys.length, `volatile=${volatile.length}/${keys.length}`)
}

// ── tidyReply ────────────────────────────────────────────────────────────
eq('剥引号', tidyReply('“海底真好看”', 80), '海底真好看')
eq('剥 @ 前缀', tidyReply('@某个用户 海底真好看', 80), '海底真好看')
eq('压成一行', tidyReply('第一行\n\n第二行', 80), '第一行 第二行')
ok('超长截断', tidyReply('鱼'.repeat(50), 10).length === 10)
eq('纯空白给空串', tidyReply('  \n ', 80), '')

// ── normalize：字段映射（照 2026-11-01 实测）──────────────────────────────
const n = normalize({
  user: { mid: 123456789, nickname: '某个用户' },
  at_time: 1793522340,
  item: { subject_id: 100000000000001, source_id: 200000000001, source_content: '@机器人号 来看看', title: '某视频' },
})
eq('from', n.from, '某个用户')
eq('mid', n.mid, '123456789')
eq('rpid 取 source_id', n.rpid, '200000000001')
eq('aid 取 subject_id', n.aid, '100000000000001')
eq('text', n.text, '@机器人号 来看看')

// ── allowSet：白名单解析 ─────────────────────────────────────────────────
eq('空配置回落到登录账号自己', [...allowSet({ allowUids: [] }, '10000000')], ['10000000'])
eq('逗号/空格都能拆', [...allowSet({ allowUids: ['123456789, 12345 678'] }, '10000000')], ['123456789', '12345', '678'])
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
eq('home 没配时回落到默认目录', resolveHome({ home: '' }).endsWith('fish-atme'), true)
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

// ── generateReply：拼流 + persona 接线 ────────────────────────────────────
{
  let seenSystem = ''
  const fakeLlm = {
    stream: (options) => {
      seenSystem = options.system
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '海底' }
        yield { type: 'text-delta', index: 0, text: '真好看' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const text = await generateReply(fakeLlm, '更贱一点', { title: 'T', text: 'hi', provider: 'p', model: 'm' }, undefined)
  eq('拼接流', text, '海底真好看')
  ok('personaPrompt 接到了 system 后面', seenSystem.includes('更贱一点'))
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

// ── DEFAULTS 完整性 ─────────────────────────────────────────────────────
eq('DEFAULTS 覆盖关键参数', Object.keys(DEFAULTS).sort(), [
  'allowUids', 'credentialPath', 'dryRun', 'enabled', 'home', 'includeOthers',
  'intervalMinutes', 'maxChars', 'maxPerDay', 'minGapMinutes', 'model', 'personaPrompt', 'provider',
].sort())

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
