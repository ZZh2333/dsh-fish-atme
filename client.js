/**
 * dsh-fish-atme —— 浏览器半端（设置里的一页）
 * ============================================================================
 * 约定（跟 dsh-bili-scroll 一样，2026-11-01 从它的 client.js 挖出来的）：
 *   client bundle **不是 ESM，是自注册脚本**：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *   id 必须等于 package.json 的 name。
 *
 * 进「设置」的办法：
 *   slots.inject('settings.section', () => slots.register({ name:'settings.section', id, order, label }, () => h(Panel)))
 *   label 就是左侧导航那一项 —— 跟「刷B站」并排。
 *
 * 参数读写走宿主半端的 /api/fish-atme：
 *   GET  /state  → { config, status, logTail }
 *   POST /config → 存盘并就地重启定时器
 *   POST /draft  → 生成一条草稿（不发），用来调语气
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-fish-atme',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/fish-atme'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, body) => asJson(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }))

    const CSS = `
[data-fa-page]{display:flex;flex-direction:column;gap:18px;max-width:640px;padding:2px 2px 8px;}
[data-fa-sec]{display:flex;flex-direction:column;gap:8px;}
[data-fa-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fa-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-fa-grow]{flex:1;min-width:0;}
[data-fa-label]{font-size:13px;}
[data-fa-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fa-note][data-warn]{color:#f59e0b;}
[data-fa-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-fa-sw][data-on]{background:#3b82f6;}
[data-fa-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-fa-sw][data-on] i{left:19px;}
[data-fa-sw][disabled]{opacity:.45;cursor:default;}
[data-fa-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.2));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-fa-input]:focus{outline:none;border-color:#3b82f6;}
[data-fa-num]{width:88px;text-align:center;}
[data-fa-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-fa-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-fa-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-fa-btn][disabled]{opacity:.5;cursor:default;}
[data-fa-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fa-msg][data-bad]{color:#ef4444;}
[data-fa-msg][data-good]{color:#22c55e;}
[data-fa-pre]{margin:0;padding:8px 10px;border-radius:8px;font-size:11px;line-height:16px;overflow:auto;max-height:180px;
  white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-secondary,#6b7280);}
[data-fa-card]{border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.2));border-radius:10px;padding:10px 12px;
  display:flex;flex-direction:column;gap:6px;}
`

    const Switch = ({ on, onChange, disabled }) => h('button', {
      type: 'button',
      'data-fa-sw': '',
      ...(on ? { 'data-on': '' } : {}),
      ...(disabled ? { disabled: '' } : {}),
      onClick: () => { if (!disabled) onChange(!on) },
    }, h('i'))

    const Num = ({ value, onChange, min = 0, max = 999 }) => h('input', {
      'data-fa-input': '',
      'data-fa-num': '',
      type: 'number',
      value: Number.isFinite(Number(value)) ? Number(value) : '',
      min,
      max,
      onChange: (e) => {
        const n = Number(e.target.value)
        onChange(Number.isFinite(n) ? n : 0)
      },
    })

    const Text = ({ value, onChange, placeholder, multiline }) => multiline
      ? h('textarea', {
        'data-fa-input': '',
        rows: 3,
        value: String(value ?? ''),
        placeholder: placeholder ?? '',
        onChange: (e) => onChange(e.target.value),
      })
      : h('input', {
        'data-fa-input': '',
        type: 'text',
        value: String(value ?? ''),
        placeholder: placeholder ?? '',
        onChange: (e) => onChange(e.target.value),
      })

    const Panel = () => {
      const [state, setState] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [draft, setDraft] = React.useState(null)

      const load = async () => {
        try {
          setState(await jget('/state'))
        } catch (e) {
          setMsg({ text: '读取状态失败：' + String(e?.message ?? e), bad: true })
        }
      }

      React.useEffect(() => { load() }, [])

      const cfg = state?.config ?? {}
      const status = state?.status ?? {}
      const patch = (key, value) => setState((s) => (s ? { ...s, config: { ...s.config, [key]: value } } : s))

      const save = async () => {
        setBusy('save')
        setMsg(null)
        try {
          const next = await jpost('/config', { config: { ...cfg, allowUids: cfg.allowUids ?? [] } })
          setState(next)
          setMsg({ text: '已保存并生效（定时器按新参数重启）', good: true })
        } catch (e) {
          setMsg({ text: '保存失败：' + String(e?.message ?? e), bad: true })
        } finally {
          setBusy('')
        }
      }

      const tryDraft = async () => {
        setBusy('draft')
        setMsg(null)
        setDraft(null)
        try {
          const r = await jpost('/draft')
          if (!r?.ok) setMsg({ text: '没生成出来：' + (r?.error ?? '未知原因'), bad: true })
          else setDraft(r)
        } catch (e) {
          setMsg({ text: '生成失败：' + String(e?.message ?? e), bad: true })
        } finally {
          setBusy('')
        }
      }

      return h('div', { 'data-fa-page': '' },
        // ── 状态 ──
        h('div', { 'data-fa-sec': '' },
          h('div', { 'data-fa-h': '' }, '现在的状态'),
          h('div', { 'data-fa-card': '' },
            h('div', { 'data-fa-row': '' },
              h('span', { 'data-fa-label': '' }, status.timerRunning ? '定时器：运行中' : '定时器：没在跑'),
              h('span', { 'data-fa-grow': '' }),
              h('span', { 'data-fa-note': '' }, `今天已处理 ${status.count ?? 0}/${cfg.maxPerDay ?? 0} 条 · 去重表 ${status.seenCount ?? 0} 条`),
            ),
            status.lastText
              ? h('div', { 'data-fa-note': '' }, '最近一条：' + status.lastText)
              : h('div', { 'data-fa-note': '' }, '还没回过东西'),
            state?.files?.logFile ? h('div', { 'data-fa-note': '' }, '日志：' + state.files.logFile) : null,
          ),
        ),

        // ── 基本开关 ──
        h('div', { 'data-fa-sec': '' },
          h('div', { 'data-fa-h': '' }, '开关'),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '启用定时器（关掉只是不自动回，工具还能手动用）'),
            h(Switch, { on: cfg.enabled !== false, onChange: (v) => patch('enabled', v) }),
          ),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '只写草稿、不真的发（dryRun）'),
            h(Switch, { on: cfg.dryRun === true, onChange: (v) => patch('dryRun', v) }),
          ),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '连陌生人的 @ 也回（危险，默认关）'),
            h(Switch, { on: cfg.includeOthers === true, onChange: (v) => patch('includeOthers', v) }),
          ),
          cfg.includeOthers === true
            ? h('div', { 'data-fa-note': '', 'data-warn': '' }, '⚠️ 开了之后，任何人 @ 你都会收到一条自动回复；公开场合说错话没人兜。')
            : null,
        ),

        // ── 节奏与额度 ──
        h('div', { 'data-fa-sec': '' },
          h('div', { 'data-fa-h': '' }, '节奏与额度'),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '多久查一次「@我的」（分钟）'),
            h(Num, { value: cfg.intervalMinutes, min: 1, max: 120, onChange: (v) => patch('intervalMinutes', v) }),
          ),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '一天最多自动回几条'),
            h(Num, { value: cfg.maxPerDay, min: 0, max: 50, onChange: (v) => patch('maxPerDay', v) }),
          ),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '两条之间至少隔几分钟'),
            h(Num, { value: cfg.minGapMinutes, min: 1, max: 240, onChange: (v) => patch('minGapMinutes', v) }),
          ),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '单条回复最多多少字'),
            h(Num, { value: cfg.maxChars, min: 20, max: 300, onChange: (v) => patch('maxChars', v) }),
          ),
          h('div', { 'data-fa-note': '' }, '建议：3–10 分钟查一次、一天 3–5 条、间隔 ≥10 分钟、单条 ≤80 字。'),
        ),

        // ── 回复谁 ──
        h('div', { 'data-fa-sec': '' },
          h('div', { 'data-fa-h': '' }, '回复谁'),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '白名单 UID（逗号分隔，留空 = 登录账号自己）'),
            h('span', { 'data-fa-num': '' },
              h(Text, {
                value: (cfg.allowUids ?? []).join(','),
                placeholder: '123456789',
                onChange: (v) => patch('allowUids', String(v).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)),
              })),
          ),
        ),

        // ── 语气 ──
        h('div', { 'data-fa-sec': '' },
          h('div', { 'data-fa-h': '' }, '语气'),
          h(Text, {
            value: cfg.personaPrompt,
            multiline: true,
            placeholder: '追加人格，比如：更贱一点，每条带一个 emoji',
            onChange: (v) => patch('personaPrompt', v),
          }),
          h('div', { 'data-fa-note': '' }, '接在默认口吻后面。默认口吻：简洁、先给结论、不客套、不提插件名。'),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-label': '' }, '模型'),
            h('span', { 'data-fa-grow': '' },
              h(Text, { value: cfg.provider, placeholder: 'ark-code-latest', onChange: (v) => patch('provider', v) })),
            h('span', { 'data-fa-num': '' },
              h(Text, { value: cfg.model, placeholder: 'ark-code-latest', onChange: (v) => patch('model', v) })),
          ),
        ),

        // ── 高级 ──
        h('div', { 'data-fa-sec': '' },
          h('div', { 'data-fa-h': '' }, '高级（一般不用动）'),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '凭证文件'),
            h('span', { 'data-fa-grow': '' },
              h(Text, { value: cfg.credentialPath, placeholder: '留空 = <数据目录>/bili_credential.json', onChange: (v) => patch('credentialPath', v) })),
          ),
          h('div', { 'data-fa-row': '' },
            h('span', { 'data-fa-grow': '', 'data-fa-label': '' }, '数据目录'),
            h('span', { 'data-fa-grow': '' },
              h(Text, { value: cfg.home, placeholder: '留空 = ~/.dsh/fish-atme', onChange: (v) => patch('home', v) })),
          ),
        ),

        // ── 操作 ──
        h('div', { 'data-fa-row': '' },
          h('button', { 'data-fa-btn': '', 'data-primary': '', disabled: busy !== '', onClick: save },
            busy === 'save' ? '保存中…' : '保存并生效'),
          h('button', { 'data-fa-btn': '', disabled: busy !== '', onClick: tryDraft },
            busy === 'draft' ? '生成中…' : '试一条草稿（不发）'),
          h('button', { 'data-fa-btn': '', disabled: busy !== '', onClick: load }, '刷新状态'),
        ),
        msg ? h('div', { 'data-fa-msg': '', ...(msg.bad ? { 'data-bad': '' } : msg.good ? { 'data-good': '' } : {}) }, msg.text) : null,

        draft ? h('div', { 'data-fa-card': '' },
          h('div', { 'data-fa-h': '' }, '草稿预览'),
          h('div', { 'data-fa-note': '' }, `《${draft.video ?? '未知视频'}》`),
          h('div', { 'data-fa-label': '' }, '他写的：' + (draft.hisText ?? '')),
          h('div', { 'data-fa-msg': '' }, '我会回：' + (draft.tidied ?? draft.draft ?? '')),
          h('div', { 'data-fa-note': '' },
            (draft.willSend ? '现在点保存后它会真的发。' : 'dryRun 开着，只写草稿。')
            + (draft.alreadyReplied ? '（这条之前已经回过）' : '')),
        ) : null,

        // ── 日志 ──
        h('div', { 'data-fa-sec': '' },
          h('div', { 'data-fa-h': '' }, '最近的日志'),
          h('pre', { 'data-fa-pre': '' }, (state?.logTail ?? []).join('\n') || '(还没有日志)'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-fish-atme')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-fish-atme: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'fish-atme', order: 31, label: 'B站 @我' },
          () => h(Panel),
        ))
      },
    }
  },
})
