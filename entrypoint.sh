#!/bin/sh

# Start the sync server in the background
cd /server
node dist/index.js &
SYNC_PID=$!

# Start nginx in the background
nginx -g "daemon off;" &
NGINX_PID=$!

# Wait for either process to die (POSIX-compatible, no `wait -n`)
while kill -0 $SYNC_PID 2>/dev/null && kill -0 $NGINX_PID 2>/dev/null; do
  sleep 1
done

# One process died — kill the other and exit
kill $SYNC_PID $NGINX_PID 2>/dev/null || true
exit 1
