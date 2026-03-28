#!/bin/bash
set -e

# ─── Network lockdown (runs as root) ───
# Default: DROP all outbound, allow only Anthropic endpoints + DNS + loopback.
# Additional hosts can be passed via CRUCIBLE_NETWORK_ALLOWLIST (space-separated).

ALLOWED_HOSTS="api.anthropic.com claude.ai statsigapi.net ${CRUCIBLE_NETWORK_ALLOWLIST:-}"

# Only apply iptables if we have NET_ADMIN capability
if iptables -L -n >/dev/null 2>&1; then
  # Default policy: drop outbound
  iptables -P OUTPUT DROP 2>/dev/null || true

  # Allow loopback
  iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true

  # Allow established/related connections (responses to allowed requests)
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true

  # Allow DNS (needed to resolve allowed hosts)
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true

  # Resolve each allowed host and add rules
  for host in $ALLOWED_HOSTS; do
    for ip in $(dig +short "$host" 2>/dev/null); do
      # Skip non-IP lines (CNAME records etc)
      if echo "$ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        iptables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true
      fi
    done
  done
else
  echo "[crucible-entrypoint] Warning: iptables not available, running without network lockdown" >&2
fi

# ─── Drop to non-root user and exec the command ───
exec gosu agent "$@"
