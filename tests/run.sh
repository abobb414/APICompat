#!/usr/bin/env bash
# APICompat 自测台：起 mock → 跑断言 → 收工时把 mock 关掉。
#
#   bash tests/run.sh              # 默认端口 8788
#   PORT=9000 bash tests/run.sh
#
# 依赖：python3（只用标准库）、node、Playwright（npm i -D playwright && npx playwright install chromium）
set -euo pipefail

PORT="${PORT:-8788}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 本机常挂着 HTTP_PROXY，会让无头浏览器访问 127.0.0.1 走代理隧道而超时
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

python3 "$HERE/mock.py" "$PORT" >/tmp/apicompat-mock.log 2>&1 &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT

# 等端口就绪
for _ in $(seq 1 40); do
  if curl -sf --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/v1/models"; then break; fi
  sleep 0.25
done
curl -sf --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/v1/models" \
  || { echo "mock 未能在 127.0.0.1:$PORT 起来，见 /tmp/apicompat-mock.log"; exit 1; }

BASE="http://127.0.0.1:$PORT" node "$HERE/smoke.mjs"
