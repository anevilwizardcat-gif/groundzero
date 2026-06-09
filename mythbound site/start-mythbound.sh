#!/usr/bin/env bash
cd "$(dirname "$(readlink -f "$0")")" || exit 1
echo "Starting MYTHBOUND server..."
echo "Once it boots, open http://localhost:3000 in your browser."
echo "(Close this window or press Ctrl+C to stop the server.)"
node server.js
