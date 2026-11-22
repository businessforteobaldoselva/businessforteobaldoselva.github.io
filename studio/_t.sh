#!/bin/bash
export NODE_PATH="C:/Users/teoba/AppData/Local/Temp/claude/96e92cc10739e5df/f8189f02-2f0e-4358-b028-5b37c350db18/scratchpad/pptr2/node_modules"; export STUDIO_PUPPETEER_DIR="C:/Users/teoba/AppData/Local/Temp/claude/96e92cc10739e5df/f8189f02-2f0e-4358-b028-5b37c350db18/scratchpad/pptr2"; export STUDIO_PUPPETEER="C:/Users/teoba/AppData/Local/Temp/claude/96e92cc10739e5df/f8189f02-2f0e-4358-b028-5b37c350db18/scratchpad/pptr2/node_modules/puppeteer-core"; export STUDIO_CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe"; export CHROME_PATH="$STUDIO_CHROME"
files=$(find "$@" -name '*.test.js' | sort)
node --require ./studio/guards/no-network.js --test --test-concurrency=4 $files
