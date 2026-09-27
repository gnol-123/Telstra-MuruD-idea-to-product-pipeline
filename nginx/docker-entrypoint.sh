#!/bin/sh
set -e

# Swap ${PORT} in the template for the real value Railway injects, then start nginx
envsubst '${PORT}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
