#!/bin/sh
set -eu

# Bind mounts hide the ownership created in the image. Prepare the dedicated
# avatar directory while privileged, then always run the server as node.
avatar_dir="${AVATAR_DIR:-./data/avatars}"
if [ -z "$avatar_dir" ] || [ "$avatar_dir" = "/" ]; then
  echo "AVATAR_DIR must point to a dedicated writable directory" >&2
  exit 1
fi

mkdir -p "$avatar_dir"
chown node:node "$avatar_dir"
find "$avatar_dir" -mindepth 1 -maxdepth 1 -type f -exec chown node:node {} +
chmod 0750 "$avatar_dir"

exec gosu node:node "$@"
