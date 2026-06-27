#!/bin/zsh
# SDBA RDMS launcher. Starts the Vite dev server detached from this
# Terminal window so the window can auto-close without killing the
# server. Vite is configured with server.open: true, so a fresh start
# launches http://localhost:3000 in the browser by itself.
#
# Idempotent: if RDMS is already running on port 3000 (e.g. a previous
# session's server is still alive in the background), this just reopens
# the browser instead of failing with "Port 3000 is already in use" and
# never opening anything — the bug where the launcher "ran but didn't
# launch".

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "$(dirname "$0")/rdms"

mkdir -p "$HOME/Library/Logs/SDBA-RDMS"
LOG="$HOME/Library/Logs/SDBA-RDMS/rdms.log"

# Schedule this Terminal window to close after a short delay. Detached
# subshell so it survives our `exit` — by the time the AppleScript fires
# our shell is gone and Terminal won't prompt "process still running?".
close_window() {
  if [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
    ( sleep 3 ; osascript -e 'tell application "Terminal" to close (front window) saving no' >/dev/null 2>&1 ) &
    disown
  fi
}

# Already serving on port 3000? Don't start a second instance (it would
# fail on the port and Vite's auto-open would never fire). Just reopen
# the browser on the existing server.
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "SDBA RDMS is already running — opening http://localhost:3000 …"
  echo "(This window will close automatically in ~3 seconds.)"
  open "http://localhost:3000"
  close_window
  exit 0
fi

echo "Starting SDBA RDMS in the background…"
echo "Logs: tail -f \"$LOG\""
echo "(This window will close automatically in ~3 seconds.)"
echo ""

# Detach Vite from this shell. nohup ignores SIGHUP so the child
# survives our exit; & runs in background; disown removes the job
# from the shell's table so the parent really can exit cleanly.
nohup npm run dev > "$LOG" 2>&1 &
disown

close_window
exit 0
