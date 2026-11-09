#!/usr/bin/env bash
# Install this checkout's desktop app for the current Linux user: the binaries in ~/.local/opt,
# the icon in every hicolor size and a .desktop entry that GNOME matches to the window.
# Build first and install: bash scripts/install-linux-app.sh --build
# Install what's already built: bash scripts/install-linux-app.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tauri="$repo/packages/mac/src-tauri"
id="io.github.kayraucklnc.beluga"
opt="${BELUGA_APP_DIR:-$HOME/.local/opt/beluga}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
icons="$data/icons/hicolor"
apps="$data/applications"
triple="$(rustc -vV | sed -n 's/^host: //p')"

if [ "${1:-}" = "--build" ]; then
  cd "$repo"
  npm install --no-audit --no-fund
  npm install --no-audit --no-fund --prefix packages/mac
  npm run build
  node scripts/build-sidecar.mjs
  (cd packages/mac && npx tauri build --no-bundle)
fi

app="$tauri/target/release/beluga-mac"
node="$tauri/binaries/beluga-node-$triple"
daemon="$tauri/resources/daemon"
[ -x "$app" ] || { echo "No build at $app. Run: bash scripts/install-linux-app.sh --build"; exit 1; }
[ -x "$node" ] || { echo "No sidecar at $node. Run: node scripts/build-sidecar.mjs"; exit 1; }
[ -f "$daemon/dist/cli.js" ] || { echo "No daemon at $daemon. Run: node scripts/build-sidecar.mjs"; exit 1; }

# The .deb's layout under $opt: Tauri finds an installed app's resources in ../lib/<productName>
# beside its binary (or /usr/lib/Beluga), and daemon.rs starts daemon/dist/cli.js from there.
bin="$opt/bin"
lib="$opt/lib/Beluga"

# Copy then rename, so a running Beluga keeps its old file and the next launch gets the new one.
mkdir -p "$bin" "$lib"
install -m 755 "$app" "$bin/beluga-mac.new" && mv -f "$bin/beluga-mac.new" "$bin/beluga-mac"
install -m 755 "$node" "$bin/beluga-node.new" && mv -f "$bin/beluga-node.new" "$bin/beluga-node"

rm -rf "$lib/daemon.new" "$lib/daemon.old"
cp -a "$daemon" "$lib/daemon.new"
[ -d "$lib/daemon" ] && mv "$lib/daemon" "$lib/daemon.old"
mv "$lib/daemon.new" "$lib/daemon"
rm -rf "$lib/daemon.old"
rm -rf "$opt/beluga-mac" "$opt/beluga-node" "$opt/daemon"

# The window's app id on Wayland (and WM_CLASS on X11) is the binary's name, beluga-mac.
for pair in 32x32:32x32.png 64x64:64x64.png 128x128:128x128.png 256x256:128x128@2x.png 512x512:icon.png; do
  install -Dm 644 "$tauri/icons/${pair#*:}" "$icons/${pair%%:*}/apps/$id.png"
done
rm -f "$icons/128x128/apps/beluga.png" "$icons/256x256/apps/beluga.png"

mkdir -p "$apps"
cat > "$apps/$id.desktop.new" <<EOF
[Desktop Entry]
Type=Application
Name=Beluga
GenericName=Agent Workspace
Comment=Every project and the Claude working in it, with friends
Exec=$bin/beluga-mac %U
TryExec=$bin/beluga-mac
Icon=$id
Terminal=false
Categories=Development;
Keywords=claude;agent;worktree;terminal;
StartupNotify=true
StartupWMClass=beluga-mac
MimeType=x-scheme-handler/beluga;x-scheme-handler/klaud;
EOF
mv -f "$apps/$id.desktop.new" "$apps/$id.desktop"

[ -f "$icons/icon-theme.cache" ] && gtk-update-icon-cache -q -f -t "$icons" 2>/dev/null || true
command -v update-desktop-database >/dev/null && update-desktop-database -q "$apps" || true
command -v xdg-mime >/dev/null && xdg-mime default "$id.desktop" x-scheme-handler/beluga x-scheme-handler/klaud || true

echo "Beluga installed in $opt ($("$bin/beluga-node" --version), $triple). Quit and reopen it to run the new build."
