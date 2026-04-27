#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}"

install_system_packages() {
  if command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs git python3 python3-pip
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs git python3 python3-pip
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y curl git python3 python3-pip ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    return
  fi

  echo "ERROR: unsupported package manager; install nodejs, git, python3, and python3-pip manually"
  exit 1
}

install_system_packages

npm install -g pm2

bash ec2/install-medium.sh

(
  cd ec2/runtime
  npm install
  npm run build
)

pm2 start ec2/ecosystem.medium.config.cjs
pm2 save
pm2 startup || true

echo "INFO: EC2 medium-tier services started"
echo "INFO: runtime health: curl http://127.0.0.1:3000/medium/health"
