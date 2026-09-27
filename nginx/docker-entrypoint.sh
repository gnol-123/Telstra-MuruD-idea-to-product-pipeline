#!/bin/sh
set -e

# Compose service name locally; on Railway set BACKEND_HOST=<service>.railway.internal:<port>
export BACKEND_HOST="${BACKEND_HOST:-backend:8000}"

# The container's own DNS (Docker's 127.0.0.11, Railway's internal resolver); IPv6 needs brackets
RESOLVER=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
case "$RESOLVER" in *:*) RESOLVER="[$RESOLVER]" ;; esac
export RESOLVER

# Swap the vars into the template, then start nginx
envsubst '${PORT} ${BACKEND_HOST} ${RESOLVER}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
