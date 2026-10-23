#!/usr/bin/env bash
# DSH 卸载脚本
#   sudo bash uninstall.sh            # 只停服务、删单元，保留数据
#   sudo bash uninstall.sh --purge    # 连用户、数据、Node 一起删
set -euo pipefail

[[ "${EUID}" -eq 0 ]] || { echo "请用 root 运行：sudo bash $0" >&2; exit 1; }

echo "[dsh] 停止并禁用服务"
systemctl disable --now dsh 2>/dev/null || true
rm -f /etc/systemd/system/dsh.service
systemctl daemon-reload
systemctl reset-failed dsh 2>/dev/null || true

if [[ "${1:-}" == "--purge" ]]; then
  echo "[dsh] 删除数据与运行时"
  rm -rf /home/dsh /etc/dsh /usr/local/lib/nodejs
  rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx
  userdel -r dsh 2>/dev/null || true
  echo "[dsh] 已彻底清理（Git 等系统包保留）"
else
  echo "[dsh] 已卸载服务；数据仍在 /home/dsh 和 /etc/dsh"
fi
