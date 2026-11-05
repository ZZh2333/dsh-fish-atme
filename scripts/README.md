# 上传（脱敏 + 推送）—— 一条命令走完

每次改完插件，更新就按这条流水线走：

```powershell
node scripts/sanitize-check.mjs --all     # 1. 体检（有命中就修，别硬提交）
git add -A
git commit -m "feat: ..."                  # 2. 提交（pre-commit 会再体检一次）
git push origin main                       # 3. 推送（走 ssh: git@github.com:ZZh2333/dsh-fish-atme.git）
```

## 一次性配置（新机器上）

```powershell
git config core.hooksPath .githooks        # 让 pre-commit 生效
git remote set-url --push origin git@github.com:ZZh2333/dsh-fish-atme.git
```

## 脱敏规则会拦什么

| 规则 | 拦什么 |
|---|---|
| `bili-sessdata` / `bili-csrf` | B 站登录态、能替你发言的 csrf |
| `bili-uid` | 硬编码的 UID、`space.bilibili.com/<uid>` |
| `cookie-literal` | 明文 cookie 串 |
| `local-path` | `%USERPROFILE%\...` 这类本机绝对路径（盘符 + 用户名） |
| `email` | 邮箱（github / semver / example 等公开域名除外） |
| `secret-assign` | `apiKey=` / `appSecret=` / `password=` 之类明文赋值 |
| `long-hex-token` | 32 位以上十六进制串（token / 哈希） |
| `runtime-artifact` | `bili_credential.json`、`fish-atme-*.json`、`*.log` |

体检是**只读**的：只报不改，也不会联网。
