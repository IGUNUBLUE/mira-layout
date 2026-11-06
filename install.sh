#!/bin/sh
# Installs the mira layout into a Herdr app home (default ~/.config/herdr-app).
#
#   ./install.sh              copy layouts/mira.json and mods/mira-* into Herdr
#   ./install.sh --watch      copy, then keep copying changes every second (development)
#   ./install.sh --keys       also merge keys.json into Herdr's keys.json
#   ./install.sh --uninstall  remove what this script installed
#
# Herdr does not hot-reload mods through symlinks, so files are copied.
set -eu

REPO=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
MARK=.mira-layout
WATCH=0 KEYS=0 UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    --keys) KEYS=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

[ -d "$HOME_DIR/mods" ] || { echo "Herdr app home not found: $HOME_DIR (start Herdr once first)" >&2; exit 1; }

if [ "$UNINSTALL" = 1 ]; then
  for dir in "$REPO"/mods/*/; do
    name=$(basename "$dir"); target="$HOME_DIR/mods/$name"
    if [ -f "$target/$MARK" ]; then rm -rf "$target"; echo "removed mods/$name"; fi
  done
  if [ -f "$HOME_DIR/layouts/mira.json" ] && grep -q '"mira-tabs"' "$HOME_DIR/layouts/mira.json"; then
    rm -f "$HOME_DIR/layouts/mira.json" "$HOME_DIR/layouts/mira.svg"; echo "removed layouts/mira.json"
  fi
  echo "keys.json was left as is; remove its \"layout:mira\" section by hand if you merged it."
  exit 0
fi

sync_once() {
  for dir in "$REPO"/mods/*/; do
    name=$(basename "$dir"); target="$HOME_DIR/mods/$name"
    if [ -e "$target" ] && [ ! -f "$target/$MARK" ]; then
      echo "mods/$name exists and was not installed by mira-layout; not overwriting it" >&2; exit 1
    fi
    mkdir -p "$target"
    # gpui-kit.d.ts and jsconfig.json are written there by Herdr itself: keep them.
    rsync -a --delete --exclude RECIPE.md --exclude preview.png \
      --filter 'P gpui-kit.d.ts' --filter 'P jsconfig.json' --filter "P $MARK" \
      "$dir" "$target/"
    [ -f "$target/$MARK" ] || : > "$target/$MARK"
  done
  layout="$HOME_DIR/layouts/mira.json"
  if [ -f "$layout" ] && ! grep -q '"mira-tabs"' "$layout"; then
    echo "layouts/mira.json exists and is not this layout; not overwriting it" >&2; exit 1
  fi
  rsync -a "$REPO/layouts/mira.json" "$REPO/layouts/mira.svg" "$HOME_DIR/layouts/"
}

merge_keys() {
  node - "$REPO/keys.json" "$HOME_DIR/keys.json" <<'EOF'
const fs = require("fs");
const [src, dst] = process.argv.slice(2);
const add = JSON.parse(fs.readFileSync(src, "utf8"));
const mine = fs.existsSync(dst) ? JSON.parse(fs.readFileSync(dst, "utf8")) : {};
let changed = false;
for (const [section, keys] of Object.entries(add)) {
  mine[section] ??= {};
  for (const [key, action] of Object.entries(keys)) {
    const now = mine[section][key];
    if (now === undefined) { mine[section][key] = action; changed = true; console.log(`added ${section} ${key} -> ${JSON.stringify(action)}`); }
    else if (JSON.stringify(now) !== JSON.stringify(action)) console.log(`kept ${section} ${key}: already bound to ${JSON.stringify(now)} (wanted ${JSON.stringify(action)})`);
  }
}
if (changed) fs.writeFileSync(dst, JSON.stringify(mine, null, 2) + "\n");
EOF
}

sync_once
[ "$KEYS" = 1 ] && merge_keys
echo "installed into $HOME_DIR. Switch with: herdr-app do layout.switch '{\"name\":\"mira\"}'"
if [ "$WATCH" = 1 ]; then
  echo "watching $REPO (Ctrl+C to stop)"
  while sleep 1; do sync_once; done
fi
