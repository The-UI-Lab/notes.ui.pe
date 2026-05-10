#!/bin/sh
set -e

# Start the sync server in the background
cd /server
node dist/index.js &
SYNC_PID=$!

# Start nginx in the foreground
nginx -g "daemon off;" &
NGINX_PID=$!

# Wait for either process to exit
wait -n $SYNC_PID $NGINX_PID

# If one exits, kill the other
kill $SYNC_PID $NGINX_PID 2>/dev/null || true
exit 1
