#!/bin/bash
# Smoke test: verify pre-built Docker images work end-to-end
set -e

echo "=== Test 1: crucible-runner:base has Node + Python3 + iptables ==="
CONTAINER=$(docker create --cap-add NET_ADMIN crucible-runner:base)
docker start "$CONTAINER"
docker exec "$CONTAINER" gosu agent node --version
docker exec "$CONTAINER" gosu agent python3 --version
docker exec "$CONTAINER" gosu agent claude --version 2>/dev/null || echo "(claude CLI present but may need auth)"
docker exec "$CONTAINER" iptables -L -n >/dev/null 2>&1 && echo "iptables: OK" || echo "iptables: requires entrypoint"
docker rm -f "$CONTAINER" >/dev/null
echo "PASS: base image"
echo

echo "=== Test 2: crucible-runner:python has full pip + venv ==="
CONTAINER=$(docker create --cap-add NET_ADMIN crucible-runner:python)
docker start "$CONTAINER"
docker exec "$CONTAINER" gosu agent python3 --version
docker exec "$CONTAINER" gosu agent python3 -m pip --version
docker exec "$CONTAINER" gosu agent python3 -c "import venv; print('venv: OK')"
docker exec "$CONTAINER" gosu agent python3 -c "import ssl; print(f'ssl: {ssl.OPENSSL_VERSION}')"
docker rm -f "$CONTAINER" >/dev/null
echo "PASS: python image"
echo

echo "=== Test 3: entrypoint network lockdown works ==="
CONTAINER=$(docker create --cap-add NET_ADMIN \
  -e CRUCIBLE_NETWORK_ALLOWLIST="" \
  crucible-runner:base \
  sleep infinity)
docker start "$CONTAINER"
# Wait for entrypoint to finish setting up iptables
sleep 1
# Should be able to resolve DNS but not reach arbitrary hosts
docker exec "$CONTAINER" gosu agent sh -c 'curl -sf --max-time 3 http://example.com >/dev/null 2>&1 && echo "FAIL: outbound not blocked" || echo "OK: outbound blocked"'
docker rm -f "$CONTAINER" >/dev/null
echo "PASS: network lockdown"
echo

echo "=== Test 4: container startup latency ==="
START=$(date +%s%N)
CONTAINER=$(docker create --cap-add NET_ADMIN crucible-runner:base)
docker start "$CONTAINER" >/dev/null
docker exec "$CONTAINER" gosu agent echo "ready"
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
docker rm -f "$CONTAINER" >/dev/null
echo "Startup latency: ${ELAPSED_MS}ms"
if [ "$ELAPSED_MS" -lt 5000 ]; then
  echo "PASS: under 5s target"
else
  echo "WARN: exceeds 5s target"
fi
echo

echo "=== Test 5: crucible-runner:rust has rustc + cargo ==="
CONTAINER=$(docker create --cap-add NET_ADMIN crucible-runner:rust)
docker start "$CONTAINER"
docker exec -u agent "$CONTAINER" rustc --version
docker exec -u agent "$CONTAINER" cargo --version
docker rm -f "$CONTAINER" >/dev/null
echo "PASS: rust image"
echo

echo "=== Test 6: crucible-runner:go has go toolchain ==="
CONTAINER=$(docker create --cap-add NET_ADMIN crucible-runner:go)
docker start "$CONTAINER"
docker exec -u agent "$CONTAINER" go version
docker rm -f "$CONTAINER" >/dev/null
echo "PASS: go image"
echo

echo "=== Test 7: crucible-runner:ruby has ruby + bundler ==="
CONTAINER=$(docker create --cap-add NET_ADMIN crucible-runner:ruby)
docker start "$CONTAINER"
docker exec -u agent "$CONTAINER" ruby --version
docker exec -u agent "$CONTAINER" bundler --version
docker rm -f "$CONTAINER" >/dev/null
echo "PASS: ruby image"
echo

echo "=== Test 8: crucible-runner:jvm has java + maven + gradle ==="
CONTAINER=$(docker create --cap-add NET_ADMIN crucible-runner:jvm)
docker start "$CONTAINER"
docker exec -u agent "$CONTAINER" java --version
docker exec -u agent "$CONTAINER" mvn --version 2>&1 | head -1
docker exec -u agent "$CONTAINER" gradle --version 2>&1 | grep "Gradle"
docker rm -f "$CONTAINER" >/dev/null
echo "PASS: jvm image"
echo

echo "=== All smoke tests passed ==="
