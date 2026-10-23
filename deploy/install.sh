#!/usr/bin/env bash
# ============================================================
# DSH 一键安装（Ubuntu / Debian，x86_64 / arm64）
#
#   用法：  sudo bash install.sh
#   幂等：  重复执行只补齐缺失部分，不会重复下载 Node。
#   卸载：  sudo bash uninstall.sh   （加 --purge 连数据一起删）
# ============================================================
set -euo pipefail

DSH_USER="${DSH_USER:-dsh}"
NODE_VERSION="${NODE_VERSION:-24.21.0}"
DSH_PACKAGE="${DSH_PACKAGE:-@deepseek-ai/dsh}"
DSH_VERSION="${DSH_VERSION:-latest}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_PORT="${WEB_PORT:-3080}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"

# Node 是解压部署的，npm 默认会把全局包塞进 Node 自己的目录（不在 PATH 里），
# 这里显式固定到 /usr/local，bin 才会落到 /usr/local/bin。
export NPM_CONFIG_PREFIX=/usr/local
# npm 11+ 默认拦截依赖的安装脚本；这几个包的脚本必须跑，否则 spawn helper 和 node-pty 会缺失。
NPM_ALLOW_SCRIPTS="${NPM_ALLOW_SCRIPTS:-@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,pnpm}"
export NPM_CONFIG_ALLOW_SCRIPTS="${NPM_ALLOW_SCRIPTS}"

log()  { printf '\033[32m[dsh]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[dsh]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[dsh]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "请用 root 运行：sudo bash $0"
command -v apt-get >/dev/null 2>&1 || die "目前只支持 Debian/Ubuntu（没找到 apt-get）"

if grep -q $'\r' "$0" 2>/dev/null; then
  die "脚本是 CRLF 换行，先在服务器上执行： sed -i 's/\r$//' $0"
fi

case "$(uname -m)" in
  x86_64|amd64)  NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) die "不支持的 CPU 架构：$(uname -m)" ;;
esac

DSH_HOME_DIR="/home/${DSH_USER}/.dsh"
WORKSPACE_DIR="/home/${DSH_USER}/workspace"
NODE_DIR="/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${NODE_ARCH}"

# ---------- 1. 基础依赖 ----------
log "安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils git >/dev/null

# ---------- 1.5 时区 ----------
TZ_NAME="${TZ_NAME:-Asia/Shanghai}"
if command -v timedatectl >/dev/null 2>&1; then
  if timedatectl set-timezone "${TZ_NAME}" 2>/dev/null; then
    log "时区设为 ${TZ_NAME}"
  else
    warn "时区设置失败（容器环境常见），跳过"
  fi
fi

# ---------- 2. 运行用户 ----------
if id -u "${DSH_USER}" >/dev/null 2>&1; then
  log "用户 ${DSH_USER} 已存在"
else
  log "创建用户 ${DSH_USER}"
  useradd --create-home --shell /bin/bash "${DSH_USER}"
fi

# ---------- 3. Node ----------
need_node=1
if [[ -x /usr/local/bin/node ]]; then
  current="$(/usr/local/bin/node -v 2>/dev/null || true)"
  [[ "${current}" == "v${NODE_VERSION}" ]] && need_node=0
fi

if [[ "${need_node}" -eq 1 ]]; then
  log "下载 Node v${NODE_VERSION} (${NODE_ARCH})"
  tmp="$(mktemp -d)"
  url="${NODE_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL "${url}" -o "${tmp}/node.tar.xz" \
    || die "Node 下载失败：${url} （可换 NODE_MIRROR=https://nodejs.org/dist 重试）"
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "${tmp}/node.tar.xz" -C /usr/local/lib/nodejs
  ln -sf "${NODE_DIR}/bin/node" /usr/local/bin/node
  ln -sf "${NODE_DIR}/bin/npm"  /usr/local/bin/npm
  ln -sf "${NODE_DIR}/bin/npx"  /usr/local/bin/npx
  rm -rf "${tmp}"
  log "Node 安装完成：$(node -v)"
else
  log "Node 已就绪：$(node -v)"
fi

# ---------- 4. pnpm（dsh plugin 命令依赖它） ----------
if command -v pnpm >/dev/null 2>&1; then
  log "pnpm 已就绪：$(pnpm -v)"
else
  log "安装 pnpm"
  npm install -g pnpm --registry="${NPM_REGISTRY}" >/dev/null
  log "pnpm 安装完成：$(pnpm -v)"
fi

# ---------- 5. dsh ----------
log "安装 ${DSH_PACKAGE}@${DSH_VERSION}（首次约 1-3 分钟）"
npm install -g "${DSH_PACKAGE}@${DSH_VERSION}" --registry="${NPM_REGISTRY}" >/dev/null
log "dsh 安装完成：$(dsh --version 2>/dev/null || echo '版本未知')"

# ---------- 5.2 校验 node-pty（终端能力依赖它，包内自带 linux 预编译产物） ----------
DSH_NM="$(npm root -g)/@deepseek-ai/dsh"
if ! find "${DSH_NM}/node_modules/node-pty" -name '*.node' -print -quit 2>/dev/null | grep -q .; then
  warn "node-pty 缺少原生二进制，安装编译工具后重建"
  apt-get install -y -qq build-essential python3 >/dev/null
  ( cd "${DSH_NM}" && npm rebuild node-pty >/dev/null 2>&1 ) || warn "node-pty 重建失败，终端功能可能不可用"
fi

# ---------- 5.5 可选：yt-dlp（读 B站/YouTube 的视频信息与字幕） ----------
if [[ "${WITH_YTDLP:-0}" == "1" ]]; then
  case "${NODE_ARCH}" in
    x64)   YT_ASSET=yt-dlp_linux ;;
    arm64) YT_ASSET=yt-dlp_linux_aarch64 ;;
  esac
  log "安装 yt-dlp"
  if curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YT_ASSET}" -o /usr/local/bin/yt-dlp; then
    chmod 0755 /usr/local/bin/yt-dlp
    log "yt-dlp 安装完成：$(yt-dlp --version 2>/dev/null || echo '版本未知')"
  else
    rm -f /usr/local/bin/yt-dlp
    warn "yt-dlp 下载失败（GitHub 不可达），跳过，不影响 dsh"
  fi
fi

# ---------- 6. 目录 ----------
install -d -o "${DSH_USER}" -g "${DSH_USER}" -m 0755 "${DSH_HOME_DIR}" "${WORKSPACE_DIR}"

# ---------- 7. 环境变量文件 ----------
if [[ ! -f /etc/dsh/dsh.env ]]; then
  install -d -m 0755 /etc/dsh
  cat > /etc/dsh/dsh.env <<EOF
# DSH 运行环境（仅 root 可读，权限 600）
# 模型与联网搜索共用这把 key，去 https://platform.deepseek.com 申请
DEEPSEEK_API_KEY=

# Web 服务监听地址：默认只监听本机，靠 SSH 隧道访问，不要直接改成 0.0.0.0
DSH_WEB_HOST=${WEB_HOST}
DSH_WEB_PORT=${WEB_PORT}
EOF
  chmod 600 /etc/dsh/dsh.env
  warn "已生成 /etc/dsh/dsh.env，稍后把 DEEPSEEK_API_KEY 填进去"
else
  log "/etc/dsh/dsh.env 已存在，保持不变"
fi

# ---------- 8. systemd ----------
log "安装 systemd 服务"
svc_tmp="$(mktemp)"
sed -e "s/^User=dsh$/User=${DSH_USER}/" \
    -e "s/^Group=dsh$/Group=${DSH_USER}/" \
    -e "s#/home/dsh#/home/${DSH_USER}#g" \
    "$(dirname "$0")/dsh.service" > "${svc_tmp}"
install -m 0644 "${svc_tmp}" /etc/systemd/system/dsh.service
rm -f "${svc_tmp}"
systemctl daemon-reload
systemctl enable dsh >/dev/null 2>&1
systemctl restart dsh

# ---------- 9. 自检 ----------
sleep 2
if systemctl is-active --quiet dsh; then
  log "服务已启动 ✔"
else
  warn "服务没有起来，看日志： journalctl -u dsh -n 60 --no-pager"
fi

echo
echo "================ 下一步 ================"
echo "1) 填 key：   nano /etc/dsh/dsh.env   然后  systemctl restart dsh"
echo "2) 取地址：   journalctl -u dsh -n 60 --no-pager | grep -Eo 'http://[^ ]+'"
echo "3) 建隧道：   ssh -N -L ${WEB_PORT}:127.0.0.1:${WEB_PORT} root@<服务器IP>"
echo "4) 浏览器打开第 2 步打印的地址（带 token 的那串）"
echo "========================================"
