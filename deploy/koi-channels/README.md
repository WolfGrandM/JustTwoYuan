# deploy/koi-channels —— 锦鲤私有渠道适配器（不随市场包分发）

市场版 dsh-koi（0.4.x）按 BC-103 把 `lib/push.mjs` 从插件包里物理删除，QQ 推送下沉为
「作者私有适配器」，由渠道层从 `$DSH_HOME/koi/channels/*.js` 发现（docs/16 §8.6 / D-002 / D-005）。

| 文件 | 作用 |
| --- | --- |
| `qq.js` | NapCat HTTP 私聊适配器；FZ-4 回环围栏逐字保留（3000 端口无鉴权，只许本机回环） |
| `selftest.mjs` | 零外联自检：本机 stub NapCat + 渠道层集成，13 项断言 |

## 部署（服务器）

```bash
# 本机上传
scp -i _deepseekharness.pem deploy/koi-channels/qq.js root@120.55.184.195:/tmp/qq.js

# 服务器落位（凭证侧车由 koi.mjs migrate-v2 自动生成）
install -d -o dsh -g dsh /home/dsh/.dsh/koi/channels
install -o dsh -g dsh -m 0644 /tmp/qq.js /home/dsh/.dsh/koi/channels/qq.js
```

## 自检（本机，无需服务器与网络）

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  deploy/koi-channels/selftest.mjs
# 期望：qq.js 适配器自检：13 pass / 0 fail
```

## 注意

- 本目录**不属于** dsh-koi 市场包（不在 `files[]`、不在 hygiene 扫描范围），改这里不影响市场包卫生门。
- 适配器契约变更（`send(event,cfg)` / `test(cfg)` 形状）时，`qq.js` 与自检要同步改。
- 部署与晋升顺序见 `docs/24-v0.2收尾-灰度复盘与晋升执行单.md` §5（先落 qq.js，再切代码、再迁移）。
