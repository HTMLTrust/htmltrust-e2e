#!/bin/sh
set -eu

plugin_target=/var/www/html/wp-content/plugins/content-signing
if [ "${1:-}" = "apache2-foreground" ] || [ "${1:-}" = "php-fpm" ]; then
  rm -rf "$plugin_target"
  mkdir -p "$(dirname "$plugin_target")"
  cp -a /opt/htmltrust-content-signing "$plugin_target"
  chown -R www-data:www-data "$plugin_target"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
