#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD/artifacts/Agent Corp.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -parse-as-library -O mac-app/AgentCorp.swift -o "$APP/Contents/MacOS/AgentCorp" -framework SwiftUI -framework AppKit
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>Agent Corp</string><key>CFBundleIdentifier</key><string>local.agentcorp.worker</string><key>CFBundleExecutable</key><string>AgentCorp</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>
PLIST
printf 'Built %s\n' "$APP"
