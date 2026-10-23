# 大肥鱼 · 服务器常驻计划

把 DeepSeek Harness（`dsh`）放到一台 Linux 服务器上 24 小时不下线。QQ 接入是第二阶段，等这台机器跑稳了再接。

## 现在到哪一步了

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | Windows 本机环境修复（工作区权限） | ✅ 完成 |
| 1 | 服务器选型 + 部署包（国内 / 香港海外两套方案） | ✅ 部署包已就绪，等你买机器 |
| 2 | Linux 24/7 常驻（systemd 保活） | ✅ 2026-10-23 完成 |
| 2.5 | 装鲸鱼（`dsh-bili-whale` 插件） | ✅ 已装并常驻 · 只差 B站 cookie |
| 3 | 接入 QQ 群（真号 NapCat + OneBot，非官方 Bot） | ✅ 2026-10-23 完成 |
| 4 | 锦鲤彩票预测插件（`dsh-koi`，双色球/大乐透/排列三） | 🚧 代码就绪 + 测试通过，待部署 |

## 现在跑在哪

- 阿里云杭州 · Ubuntu 26.04 LTS · 2 核 2G · 40G · `root@120.55.184.195`
- systemd 服务 `dsh`：开机自启、崩溃 5 秒自动重拉、日志进 journald
- 只监听 `127.0.0.1:3080`，通过 SSH 隧道访问
- **每次重启 token 会变**，在服务器上执行 `dsh-url` 取最新地址
- 鲸鱼插件 `dsh-bili-whale` 0.4.5 常驻：生物钟每 60 秒 tick，窗口 20:00–24:00
- QQ 通道常驻：NapCat 容器（`restart=always`，带 `ACCOUNT=983605373`）+ `dsh-onebot-qq`，三个端口都只绑 `127.0.0.1`

## 你要做的两件事（鲸鱼上线）

1. **给我一份 B站 cookie**：登录后 `F12 → Application → Cookies → bilibili.com`，抄 `SESSDATA`、`bili_jct`、`buvid3` 三个值。
2. **给我你的 mid + 昵称**（空间地址里那串数字），分享评论要 @ 你。

细节和验收命令见 [`docs/03-养鲸鱼.md`](docs/03-养鲸鱼.md)。

## 部署包里有什么

```
deploy/
├── install.sh        # 一键装：Node 24 + pnpm + dsh + systemd 服务
├── dsh.service       # 开机自启、崩溃自动拉起
├── dsh.env.example   # 环境变量模板（API Key、端口）
└── uninstall.sh      # 卸载（--purge 连数据一起清）
```

安装脚本是幂等的：跑第二遍只会补齐缺的部分，不会重复下载。

插件单独放一份源码克隆：

```
plugins/
└── dsh-bili-whale/   # 鲸鱼插件 0.4.5，服务器上装在 /opt/dsh-plugins/ 后用 link 挂进 web profile
```

改插件代码的流程：在 `plugins/dsh-bili-whale` 里改 → `scp` 覆盖 `/opt/dsh-plugins/dsh-bili-whale` → `systemctl restart dsh`。
只改配置/人设不用重启。

## 为什么选这条路线

- **服务器上不用装桌面版**。桌面版是 Electron 壳，服务器没显示器；`dsh web` 起一个本地 Web 服务，用 SSH 隧道在浏览器里操作，和桌面版是同一套内核。
- **只监听 127.0.0.1**。不开放 3080 端口，不做域名，不用备案；访问靠 SSH 隧道，公网扫不到。
- **systemd 保活**。崩了 5 秒自动重启，服务器重启也自动拉起，真正做到不下线。
- **海外机只为内容访问**。香港节点能同时通 B站 和 YouTube；国内机 YouTube 完全不通。代价是第二阶段接 QQ 要实测——QQ 开放平台对境外 IP 没有官方承诺，不通就加一台国内小机器做中转。

## QQ 通道（真号，不是官方 Bot）

她用 **983605373** 这个空闲号登录，在「沉睡森林公会」里被 @ 时说话。链路是 NapCat（协议端，Docker）→ OneBot 11 WebSocket → `dsh-onebot-qq` 插件 → dsh agent。

```bash
docker ps | grep napcat                                   # 协议端在不在
journalctl -u dsh -n 50 --no-pager | grep onebot          # 桥接连上没
curl -s -X POST http://127.0.0.1:3000/get_login_info -d '{}'   # 登录态
```

掉线会退回扫码：双击 `打开鲸鱼面板.cmd` → `http://127.0.0.1:8099/` → 点「换一张」→ 手机扫。

> 这条路走的是第三方协议，违反 QQ 用户协议，掉线和封号都是固有代价，所以用空闲号。完整说明、排障和容器重建参数见 [`docs/04-QQ真号通道.md`](docs/04-QQ真号通道.md)。

