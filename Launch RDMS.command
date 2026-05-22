#!/bin/zsh
# SDBA RDMS launcher. Starts the Vite dev server detached from this
# Terminal window so the window can auto-close without killing the
# server. Vite is configured with server.open: true, so it'll launch
# http://localhost:3000 in the browser by itself.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "$(dirname "$0")/rdms"

mkdir -p "$HOME/Library/Logs/SDBA-RDMS"
LOG="$HOME/Library/Logs/SDBA-RDMS/rdms.log"

echo "Starting SDBA RDMS in the background…"
echo "Logs: tail -f \"$LOG\""
echo "(This window will close automatically in ~3 seconds.)"
echo ""

# Detach Vite from this shell. nohup ignores SIGHUP so the child
# survives our exit; & runs in background; disown removes the job
# from the shell's table so the parent really can exit cleanly.
nohup npm run dev > "$LOG" 2>&1 &
disown

# Schedule the window to close after a short delay. We use a
# detached subshell so it survives our `exit` below — by the time
# the AppleScript fires, our shell is gone and Terminal won't
# prompt "process still running?".
if [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
  ( sleep 3 ; osascript -e 'tell application "Terminal" to close (front window) saving no' >/dev/null 2>&1 ) &
  disown
fi

exit 0
