/**
 * SDBA RDMS — User Guide Tab (rendered within Setup page)
 */

export function renderUserGuideTab(container) {
  container.innerHTML = `
    <div style="margin-top:16px; max-width:800px;">
      <div class="card" style="padding:24px;">

        <h3 style="font-size:18px; font-weight:700; margin-bottom:16px; color:var(--brand);">SDBA RDMS — User Guide</h3>

        <!-- TOC -->
        <div style="background:var(--bg-input); border-radius:var(--radius-md); padding:12px 16px; margin-bottom:24px;">
          <strong style="font-size:12px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-tertiary);">Contents</strong>
          <ol style="margin:8px 0 0 20px; font-size:13px; line-height:2; color:var(--accent);">
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-nav').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Navigation & Pages</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-setup').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Pre-Race Day Setup</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-raceday').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Race Day Workflow</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-race').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Processing a Race</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-photo').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Photo Finish Viewer</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-signals').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Signals & Automation</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-multi').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Multi-Tab & Multi-Window</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-config').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Config Reference</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-scoring').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Scoring</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-nextround').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Next Round Draws</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-export').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Result Export (bundled template)</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-archive').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Past Events Archive</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-lock').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Event Lock</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-auth').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Login, Roles & Default Mode</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-trouble').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Troubleshooting</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-folders').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Folder Structure</a></li>
          </ol>
        </div>

        <!-- 1. Navigation -->
        <div id="g-nav" class="gs">
          <h4>1. Navigation & Pages</h4>
          <table class="gt">
            <tr><th style="width:50px;">Icon</th><th style="width:100px;">Page</th><th>Description</th></tr>
            <tr><td>${ic('dashboard')}</td><td><strong>Dashboard</strong></td><td>Progress overview: summary cards, current/next race, delay tracking (+N min behind with ETA), digital flag panel, next race signal control, alerts for missing exports/sends. Sort by race # or division.</td></tr>
            <tr><td>${ic('timer')}</td><td><strong>Race</strong></td><td>Race processing sheet: input grid (arrow keys, Excel-like), start/restart, Joyi import, batch adjustment, validation, export, send, print. Open in multiple tabs.</td></tr>
            <tr><td>${ic('schedule')}</td><td><strong>TimeSheet</strong></td><td>Timing log: start, restart, export, send times + inter-race intervals. Summary stats.</td></tr>
            <tr><td>${ic('emoji_events')}</td><td><strong>Scoring</strong></td><td>Multi-round scoring tables. Per-division tabs. Points + tiebreaker weights + overall rank.</td></tr>
            <tr><td>${ic('account_tree')}</td><td><strong>Flowchart</strong></td><td>Visual DAG of division progressions. Filter by division or team. Single line = tournament, double line = scored. Colour-coded by race status.</td></tr>
            <tr><td>${ic('swap_horiz')}</td><td><strong>Im/Export</strong></td><td>Import draws (drag-drop, scan <code>01 Input_Draw/</code>, or auto-watch the folder), import Joyi results, generate start lists, and generate next-round draws by resolving R{n}P{n} placeholders.</td></tr>
            <tr><td>${ic('settings')}</td><td><strong>Setup</strong></td><td>Admin: event config, divisions, schedule, Next Race manual override, users, user guide. Editor: Next Race + user guide only. Viewer: user guide only.</td></tr>
            <tr><td>${ic('archive')}</td><td><strong>Archive</strong></td><td>Read-only browser of past events (admin + editor). Pulls from Supabase. Each row links to the event's Drive folder.</td></tr>
            <tr><td>${ic('storage')}</td><td><strong>DB</strong></td><td>Admin only: browse/edit/backup/restore the IndexedDB database.</td></tr>
          </table>

          <p style="margin-top:12px;"><strong>Top navigation bar:</strong></p>
          <table class="gt">
            <tr><th style="width:50px;"></th><th style="width:130px;">Element</th><th>Description</th></tr>
            <tr><td>${ic('folder_open')}</td><td><strong>Connect Folder</strong></td><td>Grants browser permission to read/write your event folder. Click once per session. Turns green when connected. Required for file operations.</td></tr>
            <tr><td><span style="background:var(--accent); color:#fff; padding:1px 6px; border-radius:10px; font-size:10px; font-weight:600;">2026TN</span></td><td><strong>Event Badge</strong></td><td>Shows event short ref in event colour. On web: clickable to switch between events.</td></tr>
            <tr><td style="font-size:15px; font-weight:600; font-variant-numeric:tabular-nums;">14:32</td><td><strong>Clock</strong></td><td>Live clock. Always visible.</td></tr>
            <tr><td>${ic('login')}</td><td><strong>Login/Logout</strong></td><td>Web version only. Local is always admin.</td></tr>
            <tr><td>${ic('dark_mode')}</td><td><strong>Theme</strong></td><td>Light/dark mode toggle.</td></tr>
          </table>
        </div>

        <!-- 2. Pre-Race Day Setup -->
        <div id="g-setup" class="gs">
          <h4>2. Pre-Race Day Setup</h4>
          <ol>
            <li><strong>Configure Event</strong> — Setup &rarr; Event tab. Fill in all mandatory fields (name, ref, date, lanes, colour, scoring, event folder, shared results folder). Optionally tick <em>Export scoring results</em> + <em>Auto-prompt to generate next round draws</em> + <em>Auto-generate Joyi start list after draw import</em>.</li>
            <li><strong>Optional Config</strong> — Shared Joyi/draws folders, WhatsApp group, next race signal API, Supabase sync, Google Drive API.</li>
            <li><strong>Connect Folder</strong> — Two equivalent paths: click ${ic('folder_open')} in the top nav, OR click <em>Connect event folder</em> directly inside Setup &rarr; Event (under the Event Folder input). Pick the <strong>root</strong> event folder (e.g. <code>2026WU/</code>) — RDMS finds <code>01 Input_Draw/</code>, <code>12 Output_Results/</code>, etc. inside it automatically.</li>
            <li><strong>Import Draws</strong> — Im/Export &rarr; Import Draws. Either drag-drop the <code>.xls</code> files or click <em>"Import all from <code>01 Input_Draw/</code>"</em>. Race numbers detected from filename (<code>1.xls</code>, <code>Second Round - 27.xls</code>).</li>
            <li><strong>Configure Divisions</strong> — Setup &rarr; Divisions. "Auto-Populate from Draws" or manual setup. The Flowchart page surfaces an audit panel with detected conflicts + missing-data findings — fix those before race day.</li>
            <li><strong>Set Scoring Flags</strong> — Setup &rarr; Schedule. Set R1/R2/RFinal for scored races.</li>
            <li><strong>Generate Start Lists</strong> — Im/Export &rarr; Generate Start Lists. Copy to Joyi + SprintTimer systems. (Or tick <em>Auto-generate Joyi start list after draw import</em> in Setup so this happens automatically every time draws change.)</li>
            <li><strong>Verify</strong> — Dashboard shows all races with ${ic('check_circle')} draw marks.</li>
          </ol>
          <div class="gtip">Config is synced to Supabase immediately on save (if configured), so web users see it right away.</div>
        </div>

        <!-- 3. Race Day Workflow -->
        <div id="g-raceday" class="gs">
          <h4>3. Race Day Workflow</h4>
          <ol>
            <li><strong>Launch</strong> — Double-click "Launch RDMS.command" or <code>cd rdms && npx vite</code>.</li>
            <li><strong>Connect Folder</strong> — Click ${ic('folder_open')} once per session. (Optional: also authorise Drive in Setup if you want the Joyi/Draw auto-watch on the "drive" backend.)</li>
            <li><strong>Open Dashboard</strong> — Keep one tab on Dashboard for monitoring.</li>
            <li><strong>Open Race Tabs</strong> — Open race sheets in separate tabs (right-click "Open" &rarr; New Tab).</li>
            <li><strong>Start the Joyi watcher</strong> (optional) — Im/Export &rarr; Import Joyi Results &rarr; Start watching. New <code>.xls</code> / <code>.jyd</code> results auto-import as Joyi drops them; each import fires the Lambda + Firebase signals (§6).</li>
            <li><strong>Start the Draw watcher</strong> (optional) — Im/Export &rarr; Import Draws &rarr; Start watching. Auto-imports any new or revised <code>.xls</code> in <code>01 Input_Draw/</code>. Useful when RMS pushes a corrected draw mid-event via Drive sync. Each import broadcasts <code>draw-imported</code> so the dashboard updates and (if enabled) the Joyi start list regenerates.</li>
            <li><strong>Station Operators</strong> — Dashboard has RC/ST/FN/VO buttons to open station views in new tabs.</li>
            <li><strong>After the last race</strong> — see §13 Event Lock. Dashboard's <em>Lock event</em> button (admin only) freezes all writes once race day is wrapped up.</li>
          </ol>
        </div>

        <!-- 4. Processing a Race -->
        <div id="g-race" class="gs">
          <h4>4. Processing a Race</h4>
          <table class="gt">
            <tr><th>Step</th><th>Action</th><th>Notes</th></tr>
            <tr><td>1</td><td>${ic('play_arrow')} <strong>START RACE</strong></td><td>Click when race begins. Millisecond precision. Click again to restart. The original start time is preserved when restarting.</td></tr>
            <tr><td>1b</td><td>${ic('undo')} <strong>Reset start</strong></td><td>Ghost button next to FINISH, visible only when race was started but not yet exported. Clears start_time / joyi_start_time / restart_time / p1_finish and returns the race to PENDING. Use only for misclicks.</td></tr>
            <tr><td>1c</td><td>${ic('delete_forever')} <strong>Reset race</strong> <span style="color:var(--danger); font-size:11px;">danger</span></td><td>Draconian — clears EVERYTHING (start times, every lane's raw_time / penalty / remarks / position / Joyi data, AND export_time / export_version / send_time so the race returns to PENDING). Available at any state except <em>cancelled</em>, including after export or send. Preserves the team draw + export_history audit trail. Gated behind type-the-race-number confirmation. Use for confirmed re-races OR to redo a wrongly-exported race from scratch.</td></tr>
            <tr><td>1d</td><td>${ic('backspace')} <strong>Clear inputs</strong></td><td>Sits next to <em>Import Joyi</em> on the Results Input card. Wipes only the entered cells (Lane, Time, TP, Remarks) for every row. Preserves team draws, start/joyi/export times, status, Joyi-imported result columns. Use when you want to re-key the times without nuking the whole race.</td></tr>
            <tr><td>1e</td><td>${ic('restart_alt')} <strong>Revive Race</strong></td><td>Replaces the Cancel button only when status = cancelled. Restores status to where it logically should be based on what's been recorded — pending (no times yet), started (has start_time), exported / sent (has export_time). Lane results stay untouched.</td></tr>
            <tr><td>2a</td><td><strong>Manual Input</strong></td><td>Type lane + time (mss00: 05591 = 0:55.91) in yellow grid. Enter in finishing order. Arrow keys / Tab / Enter to navigate. <strong>First non-empty entry</strong> auto-fires the next-race signal + flips the digital flag red (see §6).</td></tr>
            <tr><td>2b</td><td>${ic('cloud_download')} <strong>Import Joyi</strong></td><td>Auto-finds <code>.jyd</code> + <code>.xls</code> + <code>.lcd</code> together in the Joyi folder (Drive preferred); falls back to a single-zone drag-drop modal accepting any of the three. Same auto-signal as manual entry. When the <code>.lcd</code> is present, RDMS also derives <code>joyi_start_time</code> from it in the background (see also the start-time panel below).</td></tr>
            <tr><td>2c</td><td>${ic('photo_camera')} <strong>Photo Finish</strong></td><td>Opens the line-scan image viewer. Auto-loads <code>{event_ref}.{race_number}.lcd</code> + <code>.jyd</code> from the Joyi folder if both are present (Drive preferred); otherwise drops a two-zone drag-and-drop picker. Both files are <strong>required</strong> — the .jyd carries the reach points needed to anchor the time axis. See §5.</td></tr>
            <tr><td>2d</td><td>${ic('auto_fix_high')} <strong>Resolve from prior results</strong></td><td>Appears in the nav row only when the current race has <code>R{n}P{n}</code> placeholders (e.g. <code>R16P3</code> in lane 1). Replaces every placeholder with the actual team from the source race's results. <strong>Disabled with a tooltip "Awaiting Race X, Y"</strong> until every referenced source race is exported. Lane assignments stay as they are — only team names + codes change. See §10 Next Round Draws for the full flow.</td></tr>
            <tr><td>3</td><td><strong>Penalties/Remarks</strong></td><td>TP column for penalty seconds. Remarks dropdown: DNF/DSQ/DNS/DQ.</td></tr>
            <tr><td>4</td><td><strong>Verify</strong></td><td>${ic('check_circle')} green = passed. ${ic('error')} red = fix before export. Errors covering several lanes are grouped onto one line, e.g. "Lanes 1, 2, 3: has a team but no time and no remark".</td></tr>
            <tr><td>5</td><td>${ic('save')} <strong>Export</strong></td><td>If WhatsApp configured: "Export & Send" (primary) + "Export Only" + "Send Only". If not: "Export Only" only.</td></tr>
            <tr><td>6</td><td>${ic('cell_tower')} <strong>Next Race Signal</strong></td><td>Prompted after export (if signal API configured). Skips cancelled races. Won't re-prompt if already signaled. Auto-fires earlier on first result entry (§6).</td></tr>
            <tr><td>7</td><td>${ic('print')} <strong>Print / Open</strong></td><td>Print result (landscape, 1 per page). Open draw/result .xls from source folder.</td></tr>
          </table>
          <div class="gtip"><strong>Batch Adjustment:</strong> Enter P1 backup time to shift all boats by a delta.</div>
          <div class="gtip"><strong>Revision:</strong> Re-exporting? Choose "Revision" (version increments, note stamped on .xls header) or "Re-export" (same version).</div>
          <div class="gtip"><strong>Auto-Backup:</strong> Database saved to <code>20 Database Backup/</code> after every draw import and race export.</div>
          <div class="gtip"><strong>Previous Race Reminders:</strong> After export/send, warns about earlier races not yet exported or sent. Race numbers are concatenated, e.g. "Reminder: Races 12, 13 NOT sent".</div>

          <p style="margin-top:14px;"><strong>Joyi-derived start time (preferred when available)</strong></p>
          <p>When a Joyi result is imported (manual click, auto-watch, or Photo Finish), RDMS also fetches the matching <code>.lcd</code> file in the background and derives the wall-clock race start from <code>file.lastModified − last_scanline_µs/1000</code>. The result lands in a separate field <code>joyi_start_time</code>; the live display, the running timer, the validation, and the FINISH-backup elapsed-time delta all prefer it over the operator-clicked <code>start_time</code>.</p>
          <p>Why: the operator sometimes forgets to click START. The Joyi-derived value is anchored to the actual signal-box trigger via the camera clock, so it's typically accurate to ≈100–300 ms (Drive-for-Desktop) or ≈1 s (browser-uploaded files with second-precision mtime).</p>
          <table class="gt">
            <tr><th>UI cue</th><th>Meaning</th></tr>
            <tr><td><span style="display:inline-block; font-size:9px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; color:#7dd3fc; background:rgba(125,211,252,0.18); padding:1px 5px; border-radius:3px;">JOYI</span> badge next to the Start time</td><td>Showing the Joyi-derived value. Hover for the drift vs the manual click (if any).</td></tr>
            <tr><td><span style="color:#7dd3fc;">●</span> "Joyi start time loading…" chip</td><td>Lazy LCD download in flight (Drive ranged-read = ~30 bytes, typically &lt; 1 s). Other work is not blocked.</td></tr>
            <tr><td>Shaded overlay "Waiting for Joyi start time…"</td><td>Only appears when the operator clicks FINISH while the LCD fetch is still pending — blocks the click momentarily so the elapsed-time delta uses the right baseline.</td></tr>
          </table>
          <div class="gtip"><strong>Status auto-set:</strong> the race flips from PENDING to STARTED the moment a <code>joyi_start_time</code> lands, even if the operator never clicked START. Reset start clears both sources so a re-import re-derives.</div>
          <div class="gtip"><strong>Two-machine clock sync:</strong> if the Joyi laptop and the RDMS laptop are on different machines, both should be NTP-synced. The Joyi-derived start carries Joyi's wall clock; any skew between machines becomes an additive error on FINISH elapsed times.</div>
        </div>

        <!-- 5. Photo Finish Viewer -->
        <div id="g-photo" class="gs">
          <h4>5. Photo Finish Viewer</h4>
          <p>Opens from the Race page via ${ic('photo_camera')} <strong>Photo Finish</strong>. Renders the Joyi line-scan image (<code>.lcd</code>) with overlay metadata from the matching <code>.jyd</code>.</p>

          <p><strong>Opening files</strong></p>
          <ul>
            <li><strong>Both <code>.lcd</code> AND <code>.jyd</code> are required.</strong> The .jyd carries the reach points that anchor the time axis on race-start; without it the axis would be off by the capture-start delay (typically 60+ s).</li>
            <li><strong>Auto-find:</strong> if the Joyi folder is connected (Drive preferred, local fallback) and contains <code>{event_ref}.{race_number}.lcd</code> + <code>.jyd</code>, the viewer opens immediately with both files loaded.</li>
            <li><strong>Drop-zone picker:</strong> otherwise a small modal with two drop zones appears, pre-filled with whichever file we did find. Drag-and-drop sorts by extension automatically; click-to-pick also works. The "Open" button stays disabled until both files are loaded.</li>
          </ul>

          <p><strong>Header controls</strong></p>
          <table class="gt">
            <tr><th>Control</th><th>What it does</th></tr>
            <tr><td><strong>Render</strong></td><td>Channel-order selector for the trilinear RGB sensor. "Colour (RGB)" is correct for the current Joyi cameras; the others (BGR/GRB/...) are escape hatches if the colours look wrong.</td></tr>
            <tr><td><strong>Frame rate (fps)</strong></td><td>Defaults to the rate computed from the .lcd's per-scanline microsecond timestamps (e.g. 510.75). Label next to it reads "metadata + JYD agree" when both sources match. Override with a manual value if needed.</td></tr>
            <tr><td><strong>Offset (s)</strong></td><td>Seconds from race start to the camera's first captured column. Auto-derived from the .jyd's reach points.</td></tr>
            <tr><td><strong>Zoom (compression ratio)</strong></td><td>Dropdown: <code>1× · ¾× · ½× · ⅓× · ¼× · ⅕×</code>. Image compresses horizontally on screen and in the export PNG. Text labels (lane#, finish time, axis ticks) stay at their natural pixel size regardless of zoom. Changing zoom auto-scrolls to the first finisher.</td></tr>
            <tr><td>${ic('restart_alt')} <strong>Reset</strong></td><td>Snap render mode, fps, offset, and zoom back to auto-derived defaults.</td></tr>
            <tr><td><strong>Floating time</strong> (top-right)</td><td>Live read-out of the time at the mouse cursor's column, in <code>mm:ss.mmm</code> race-elapsed time.</td></tr>
            <tr><td>${ic('crop')} <strong>Crop & Save</strong></td><td>Enter crop mode (see below).</td></tr>
            <tr><td>${ic('close')} <strong>Close</strong></td><td>Or press Esc.</td></tr>
          </table>

          <p><strong>Metadata side panel (left of image)</strong></p>
          <p>A 320 px white panel pinned to the left carries the race identity:</p>
          <ul>
            <li><strong>Event banner</strong> — full slab in the event's brand colour with the event name in white. Uses the optional <code>event_official_name_en</code> / <code>event_official_name_tc</code> (Setup → Event), falling back to the short Event Name → event short ref.</li>
            <li><strong>Date</strong> — formatted <code>YYYY-MM-DD</code> from the event config.</li>
            <li><strong>Division</strong> — uses the optional <code>div_main_name_en</code> / <code>div_main_name_tc</code> (Setup → Divisions), falling back to the short division name.</li>
            <li><strong>Race</strong> — race number large, with a small division-colour swatch to its left when configured. Race title beneath the number.</li>
            <li><strong>Lanes</strong> — draw list (lane # + team name). Lanes with blank team / <code>---</code> / DNS remarks are skipped. Up to 13 lanes; the font auto-shrinks (13 → 9 px floor) if multi-line team names would overflow.</li>
          </ul>
          <p>The same panel is baked into the exported PNG. Empty optional fields are simply omitted.</p>

          <p><strong>Overlays on the image</strong></p>
          <ul>
            <li><strong>Red reach lines</strong> — hairline (0.75 px) translucent red bars marking each boat's bow crossing. Two-pass render: every line is drawn first, then every label, so a later reach's line never paints over an earlier reach's label.</li>
            <li><strong>Lane number + time labels</strong> in a clean sans-serif with a dark halo for legibility against any boat colour. Top-3 finishers wear <span style="color:#fbbf24; font-weight:600;">gold</span> / <span style="color:#e5e7eb; font-weight:600; text-shadow:0 0 1px #888;">silver</span> / <span style="color:#f97316; font-weight:600;">bronze</span> like the results export. Greedy top-bias placement keeps far-apart lanes (e.g. 12 and 7) at row 0 instead of stacking.</li>
            <li><strong>Hover scrubber</strong> — a thin white vertical line follows the mouse so you can sight-time any point on the image. Lives as a DOM overlay (not painted into the canvas), so right-click "Save Image" won't capture it.</li>
            <li><strong>Time axis</strong> — bottom strip with tick marks every ~100 px, labelled in race-elapsed time at 3 dp. <span style="color:#7dd3fc;">cap. start +XX.XXXs</span> shows how far past race-start the camera began capturing. A dashed <span style="color:#7dd3fc;">0:00.000 race start</span> anchor is drawn when t=0 falls inside the image.</li>
          </ul>

          <p><strong>Crop & save as PNG</strong></p>
          <ol>
            <li>Click ${ic('crop')} <strong>Crop & Save</strong> in the header. Two yellow handles appear, initialised by default to <strong>−0.5 s before the first finisher's reach to +6 s after the last</strong>. The viewport also pans to land on the crop start.</li>
            <li>Drag the handles to refine. The bottom bar shows <code>cols X–Y · width · Δt</code>.</li>
            <li>${ic('refresh')} resets the handles to the default range above. <strong>Cancel</strong> exits without saving. ${ic('save_alt')} <strong>Save crop</strong> downloads a PNG.</li>
          </ol>
          <p>The saved PNG = <code>[metadata panel] + [image crop at the selected zoom] + [SVG overlay clipped to the same range]</code>, all rendered at <strong>2× device-pixel ratio</strong> so the panel text and overlay labels come out crisp. Filename: <code>photo-finish-race-{N}-cols-{start}-{end}-{zoom}x.png</code>.</p>

          <div class="gtip">
            <strong>How time is computed:</strong> the <code>Score</code> field from the .jyd is the official finish time (= <code>RealScore</code> + <code>TimeDelta</code> correction, typically 70 ms). The viewer's overlay, the px↔time anchor, and the Joyi import all use Score. Old imports stored RealScore — re-importing the .jyd updates them.
          </div>
          <div class="gtip">
            <strong>Large images:</strong> the viewer tiles the image (8192-column tiles) and renders each tile only when scrolled into view. A 90,000-column capture loads at the same speed as a 14,000-column one; memory stays bounded.
          </div>
          <div class="gtip">
            <strong>Joyi start time:</strong> opening the viewer also derives <code>race.joyi_start_time</code> from the .lcd's mtime in the background. See §4 → "Joyi-derived start time".
          </div>
        </div>

        <!-- 6. Signals & Automation -->
        <div id="g-signals" class="gs">
          <h4>6. Signals & Automation</h4>
          <p>The race page fires two automatic signals on the <strong>first sign of result activity</strong> for a race — either a manual cell edit (<code>raw_time</code> or <code>remarks</code>) or a Joyi import. These tell the public mobile app to advance to the next race and to flip the digital flag.</p>
          <table class="gt">
            <tr><th>Signal</th><th>Endpoint</th><th>What it does</th></tr>
            <tr><td>${ic('cell_tower')} <strong>Lambda nextraceedit</strong></td><td>Configured URL in Setup &rarr; Event &rarr; Next-race signal API</td><td>Advances the mobile app display to the next non-cancelled race. Same call used by the post-export prompt — fires only once per race.</td></tr>
            <tr><td>${ic('flag')} <strong>Firebase digital flag</strong></td><td><code>race_status/FinishingReady = false</code></td><td>Sets the finishing-station digital flag to <span style="color:#ef4444; font-weight:600;">red</span> (busy / scoring in progress). Set back to <span style="color:#10b981; font-weight:600;">green</span> manually via the dashboard's Signal panel when ready for the next race.</td></tr>
          </table>

          <p><strong>When the signals do NOT fire</strong></p>
          <ul>
            <li>If the <strong>next race already has a <code>start_time</code></strong> — i.e. you're scoring while the next race has already begun on the water. The signals would only confuse the public display, so we skip them.</li>
            <li>If the race already had its signals fired this session (<code>race.result_entry_signaled</code> is sticky in IndexedDB).</li>
          </ul>

          <p><strong>Re-arming</strong></p>
          <p>Clicking ${ic('undo')} <strong>Reset start</strong> on the race page clears <code>result_entry_signaled</code> as well, so the next result entry will re-fire both signals.</p>

          <p><strong>Joyi auto-import polling</strong></p>
          <p>The Import page has a <strong>Start watching</strong> button that polls the Joyi folder for new <code>.xls</code> / <code>.jyd</code> result files. Backend selection is automatic:</p>
          <ul>
            <li><strong>Google Drive API</strong> when a Drive token is present (faster — no local sync delay).</li>
            <li><strong>Local source folder</strong> via File System Access API otherwise.</li>
          </ul>
          <p>The status line under the button shows which backend is active and how many files are tracked. Each successful auto-import fires the same Lambda + Firebase flag signals as a manual entry.</p>
        </div>

        <!-- 7. Multi-Tab & Multi-Window -->
        <div id="g-multi" class="gs">
          <h4>7. Multi-Tab & Multi-Window</h4>
          <p><strong>Recommended race day setup (all local, same browser):</strong></p>
          <table class="gt">
            <tr><th>Tab</th><th>URL</th><th>Purpose</th></tr>
            <tr><td>Tab 1</td><td><code>#/dashboard</code></td><td>Monitor progress, delay, alerts, signal next race</td></tr>
            <tr><td>Tab 2</td><td><code>#/race/15</code></td><td>Current race being processed</td></tr>
            <tr><td>Tab 3</td><td><code>#/race/16</code></td><td>Next race (pre-opened, ready to start)</td></tr>
          </table>
          <div class="gtip">
            <strong>All local tabs share the same IndexedDB.</strong> No conflicts. Changes in one tab are reflected in others via BroadcastChannel.
            The "Next Race" signal won't prompt twice for the same race across tabs.
          </div>
          <p style="margin-top:8px;"><strong>When to use web mode:</strong></p>
          <ul>
            <li>Remote monitoring from your phone or another device</li>
            <li>Station operators (finisher/starter) on separate devices</li>
            <li>Post-event review by anyone with the link</li>
            <li>Editors contributing results from a second laptop</li>
          </ul>
          <p>Web users see the latest event automatically (no config needed). Click the event badge to switch events.</p>
        </div>

        <!-- 8. Config Reference -->
        <div id="g-config" class="gs">
          <h4>8. Config Reference</h4>
          <table class="gt">
            <tr><th>Section</th><th>Fields</th><th>Required?</th></tr>
            <tr><td>Event Details</td><td>Event Name (short, RDMS-internal), Short Ref, Type, Date, Colour, Lanes, Time Format</td><td><span style="color:var(--danger);">Mandatory</span></td></tr>
            <tr><td>Event Official Long Names</td><td><code>event_official_name_en</code> + <code>event_official_name_tc</code> — the long bilingual names printed on photo-finish exports</td><td>Optional — falls back to the short Event Name, then to the short ref</td></tr>
            <tr><td>Scoring</td><td><em>Export scoring results</em> checkbox — when on, exports include a scoring file alongside the results .xls. <strong>Scoring is always calculated in-app</strong> (see Scoring page) regardless of this setting; this flag only controls the output file.</td><td>Optional</td></tr>
            <tr><td>Next Round Draws</td><td><em>Auto-prompt to generate next round draws</em> checkbox — when on, RDMS prompts after the last race of each round to resolve <code>R{n}P{n}</code> placeholders in the dependent next-round races. Manual generation is always available from Im/Export &rarr; Generate Next Round Draws regardless.</td><td>Optional</td></tr>
            <tr><td>Auto Start List</td><td><em>Auto-generate Joyi start list after draw import</em> checkbox — when on, every successful draw import (drag-drop, "Import all from 01", or auto-watch) regenerates the Joyi start list to <code>11 Output_Start Lists/</code> + the shared <code>{ref}_Joyi/</code> folder.</td><td>Optional</td></tr>
            <tr><td>Folder Paths</td><td>Event folder (local/Drive synced)</td><td><span style="color:var(--danger);">Mandatory</span></td></tr>
            <tr><td>Shared Results</td><td>Results folder for scoring team/public</td><td><span style="color:var(--danger);">Mandatory</span></td></tr>
            <tr><td>Shared Draws</td><td>Next round draws folder</td><td>Optional</td></tr>
            <tr><td>Shared Joyi</td><td>Bidirectional folder: start lists out, Joyi results + photo-finish triplet in (<code>.xls</code>, <code>.jyd</code>, <code>.lcd</code>). RDMS auto-finds this folder when you click Import Joyi or Photo Finish — also drives the Joyi-derived start-time fetch.</td><td>Optional — hides Import Joyi button if blank; Photo Finish auto-find disabled if blank</td></tr>
            <tr><td>Communication</td><td>WhatsApp group name</td><td>Optional — hides Send buttons if blank</td></tr>
            <tr><td>Integrations</td><td>Next race signal API + race name param (Lambda <em>nextraceedit</em>). Race-name options: <code>warmup</code> / <code>warmup2</code> / <code>shortcourse</code> / <code>main</code> / custom. URL fired is <code>{api}?raceno=N&amp;racename=X&amp;racetype=next</code>.</td><td>Optional — auto-fires on first result entry + after export (§6). Manual fire via Setup &rarr; Next Race tab anytime.</td></tr>
            <tr><td>Firebase digital flag</td><td>Built-in (project <code>dbracecontrol</code>); no per-event config needed</td><td>Always on — set red automatically when result entry starts (§6)</td></tr>
            <tr><td>Live Sync</td><td>Supabase URL + anon key + service role key</td><td>Optional — needed for web version, users, mobile</td></tr>
            <tr><td>Google Drive API</td><td>OAuth Client ID + Drive folder ID</td><td>Optional — also powers Joyi auto-watch "drive" backend + Photo Finish auto-find + lazy Joyi-start-time fetch on web</td></tr>
          </table>

          <p style="margin-top:14px;"><strong>Divisions configuration</strong></p>
          <p>Setup → Divisions:</p>
          <ul>
            <li><strong>Division Name</strong> (required) — the short label used across every RDMS view.</li>
            <li><strong>Division Name (English long)</strong> — <code>div_main_name_en</code>, optional. Printed on photo-finish exports.</li>
            <li><strong>Division Name (中文)</strong> — <code>div_main_name_tc</code>, optional Traditional Chinese long name.</li>
            <li><strong>Code Prefix</strong>, <strong>Short Ref</strong>, <strong>Colour</strong> — as before.</li>
            <li><strong>Export CSV / Import CSV</strong> — round-trip template for bulk editing. The exported CSV is UTF-8 with a BOM (Chinese names survive opening in Excel / Numbers without garbling); import matches by <code>division_name</code> and upserts (existing divisions update in place, new names create new rows). Rounds and progressions are NOT in the CSV — those still need the modal editor.</li>
          </ul>
          <div class="gtip"><strong>All CSV in RDMS is UTF-8 with BOM.</strong> If you're handed a CSV from another tool that comes through as garbled Chinese, re-save it as UTF-8 first or it won't parse correctly on import.</div>
        </div>

        <!-- 9. Scoring -->
        <div id="g-scoring" class="gs">
          <h4>9. Scoring</h4>
          <ul>
            <li><strong>Auto-determination on division save.</strong> Whenever you save a division (rounds + progressions), RDMS recomputes <code>scoring_flag</code> for every race in that division based on the progression graph.</li>
            <li><strong>1:1 chain rule.</strong> A progression edge is "1:1" when the from-round has exactly one outgoing progression AND the to-round has exactly one incoming progression. Rounds linked by 1:1 edges form a chain:
              <ul>
                <li>Chain of 2 → <code>R1</code> &rarr; <code>RFinal</code></li>
                <li>Chain of 3 → <code>R1</code> &rarr; <code>R2</code> &rarr; <code>RFinal</code></li>
                <li>Chain of 4+ → <code>R1</code> &rarr; <code>R2</code> &rarr; <code>N</code>… &rarr; <code>RFinal</code></li>
                <li>Any round NOT on a 1:1 chain → <code>N</code></li>
              </ul>
            </li>
            <li><strong>Example (Cup + Plate bracket).</strong> Heat has two outgoing edges (top 4 → Cup Semi, rest → Plate Semi), so Heat is off-chain &rarr; <code>N</code>. Cup Semi&rarr;Cup Final is a 1:1 pair &rarr; <code>R1</code> + <code>RFinal</code>. Plate Semi&rarr;Plate Final is a separate 1:1 pair &rarr; also <code>R1</code> + <code>RFinal</code>.</li>
            <li><strong>Manual override.</strong> Edit the Scored column on Setup &rarr; Schedule for any race; your edit wins until the next division save reruns auto-determination.</li>
            <li>Points: 1st = lane_count + 1, 2nd = lane_count - 1, ... DNS/DNF/DSQ/DQ = 0.</li>
            <li>Tiebreaker: RFinal &times;1.001 &gt; R2 &times;1.00001 &gt; R1 &times;1.0000001.</li>
            <li>Flowchart: single line = tournament progression, double line (══) = scored series.</li>
          </ul>
        </div>

        <!-- 10. Next Round Draws -->
        <div id="g-nextround" class="gs">
          <h4>10. Next Round Draws</h4>
          <p>Heats &amp; cup/plate semi-finals carry placeholders like <code>R16P3</code> (= "team that finished 3rd in Race 16") in their draw templates. Once the source races are exported, RDMS can substitute the real team into every placeholder lane in one click. <strong>Lane assignments stay as designed</strong> — only team names + codes change.</p>

          <p><strong>Where the buttons live</strong></p>
          <ul>
            <li><strong>Race page</strong> — ${ic('auto_fix_high')} <em>Resolve from prior results</em> appears in the nav row whenever the current race has placeholders. Disabled (with tooltip "Awaiting Race X, Y") until every referenced source race is exported.</li>
            <li><strong>Im/Export &rarr; Generate Next Round Draws</strong> — per-division grid showing each round's completion progress (e.g. <code>3 / 6 ✓</code>). When a round is fully exported AND the next round still has placeholders, a <em>Resolve N</em> button lights up. When everything's populated you see a green "All next-round draws populated — no action required" banner.</li>
            <li><strong>Auto-prompt</strong> (opt-in) — Setup &rarr; Event &rarr; <em>Auto-prompt to generate next round draws</em>. When checked, RDMS pops a modal automatically after the last race of a round is exported, offering to resolve every dependent next-round race in one click.</li>
          </ul>

          <p><strong>Placeholder column convention</strong></p>
          <p>Templates park the placeholder in either the <code>team_name</code> column (B) or the <code>team_code</code> column (C) depending on the event template. RDMS scans both. When a placeholder resolves, the team's name + code are written into both columns and the original <code>R{n}P{n}</code> string moves to the <code>designation</code> field for audit.</p>

          <p><strong>File output</strong></p>
          <ul>
            <li><strong>IndexedDB</strong> — the resolved <code>lane_results</code> are written immediately; the dashboard reflects the change without re-import.</li>
            <li><strong>Local .xls</strong> — patched from the bundled xlsx template (preserves all original visual formatting — borders, fonts, fills, alignment, merges) and written to <code>13 Output_Next Round Draws/</code> as <code>{race_number}.xls</code>. The file is xlsx content under an .xls filename; downstream tools (and Excel itself) sniff content, not extension, so it opens cleanly.</li>
            <li><strong>Shared .xls</strong> — also mirrored to <code>80 Shared/{ref}_Next_Round_Draws/</code> for the scoring team's paper backup.</li>
          </ul>
          <div class="gtip"><strong>Edge cases:</strong> Cancelled source races resolve to their last known team but warn. Source races still in <code>pending</code> / <code>started</code> are skipped with a warning toast — the placeholder stays as-is and the lane shows in the audit until you export.</div>
        </div>

        <!-- 10b. Result Export -->
        <div id="g-export" class="gs">
          <h4>10b. Result Export &mdash; bundled template</h4>
          <p>Result exports (and next-round draws) use a <strong>single bundled xlsx template</strong> baked into the app — <code>templates/race-template.xlsx</code>. Per-race data is patched into specific cells; everything else (header band, column widths, merged cells, footnote box layout, signature row, fonts, borders) comes from the template and is preserved bit-for-bit.</p>

          <p><strong>Cells patched per race</strong></p>
          <table class="gt">
            <tr><th>Cell</th><th>Source</th></tr>
            <tr><td><code>A1</code></td><td><code>race.race_title_raw</code> — the original A1 text from the imported draw (full long form, suffixes preserved). Fallback to <code>race.race_title</code> (sanitised UI title) on legacy races.</td></tr>
            <tr><td><code>D1</code></td><td><code>race.race_time</code></td></tr>
            <tr><td><code>B4..B10</code></td><td>Team names for lanes 1..7 from <code>lane_results</code></td></tr>
            <tr><td><code>C4..C10</code></td><td>Team codes for lanes 1..7</td></tr>
            <tr><td><code>D4..D10</code></td><td>Time (m.ss.00 format) — blank for DSQ/DQ/DNS/DNF</td></tr>
            <tr><td><code>E4..E10</code></td><td>Place (numeric) — blank for DSQ/DQ/DNS/DNF</td></tr>
            <tr><td><code>I4..I10</code></td><td>Remarks (DSQ/DQ/DNS/DNF marker OR free text)</td></tr>
            <tr><td><code>A11</code></td><td><code>race.progression_text</code> — the footnote/progression rules from the imported draw. On revisions (v2+), the revision marker is appended after the original text with a newline.</td></tr>
          </table>

          <p><strong>Filename</strong> is always <code>{race_number}.xls</code> (downstream contract). The bytes are xlsx-format (zip + XML); Excel/Numbers/VBA tools sniff content, so the filename lie is invisible.</p>

          <div class="gtip"><strong>Re-import to refresh.</strong> If a race's exported A1 or A11 looks wrong, re-import its source draw. The import pass writes <code>race_title_raw</code> and <code>progression_text</code> back to the race record; the next export uses the refreshed values. Races imported before this feature existed may have those fields empty — re-import to populate.</div>
        </div>

        <!-- 11. Past Events Archive -->
        <div id="g-archive" class="gs">
          <h4>11. Past Events Archive</h4>
          <p>${ic('archive')} <strong>Archive</strong> nav link (admin + editor only). Read-only browser of every event in Supabase except the one currently loaded.</p>
          <ul>
            <li>Per-event row shows ref / event name / date / total races / exported count / Drive folder link / "Open" detail view.</li>
            <li>"Open" expands to a per-race list. Each race expands inline to a Pos/Lane/Team/Time/TP/Remarks table — the same shape the original results export carries.</li>
            <li>Drive deep-link is built from the <code>drive_source_folder_id</code> captured in the synced event config — so you can jump straight into <code>2024TN/</code> from the archive without remembering the URL.</li>
          </ul>
          <div class="gtip">Archive reads Supabase's <code>event_config</code> + <code>race_snapshots</code> tables — exactly the data the web dashboard hydrates from. Anything synced is browsable; anything that never made it to Supabase isn't.</div>
        </div>

        <!-- 12. Event Lock -->
        <div id="g-lock" class="gs">
          <h4>12. Event Lock</h4>
          <p>After race day, an admin can <strong>seal</strong> the event so no writes go through. Designed to prevent accidental data corruption (stray tab, copy-paste mistake, someone clicking Reset on the wrong day) once the official results are out.</p>
          <p><strong>How to lock</strong></p>
          <ol>
            <li>Dashboard footer (admin only) — the <em>Lock event</em> button auto-enables once every race is in a terminal state (exported / sent / cancelled). The hint text counts down ("3 races still pending — locking now will block their exports").</li>
            <li>Click &rarr; modal opens. Lists any races that aren't fully complete (with their statuses) as a warning. Type the event short ref (e.g. <code>2026WU</code>) to enable the <em>Lock event</em> button.</li>
            <li>Once locked, a sticky yellow banner appears at the top of every page until unlocked.</li>
          </ol>
          <p><strong>What "locked" means in practice</strong></p>
          <ul>
            <li>Every IndexedDB write function throws <code>EventLockedError</code> instead of saving. Buttons that try to write surface a toast like "Event is locked. Unlock from the Dashboard before making changes."</li>
            <li>Reads are unaffected — operators can still browse, export-to-PDF, view photo finishes, etc.</li>
            <li>The lock state is mirrored to Supabase, so other authenticated devices see the locked banner on next page-load.</li>
            <li>Audit trail on the config record: <code>event_locked_at</code>, <code>event_locked_by</code>, <code>event_unlocked_at</code>, <code>event_unlocked_by</code>.</li>
          </ul>
          <p><strong>How to unlock</strong></p>
          <p>Admins see an <em>Unlock event</em> button in the top banner. Same type-the-ref confirmation. Editors and viewers see "Ask an admin to unlock" instead.</p>
          <div class="gtip">Use Event Lock at the end of race day after the last results are exported and signed off. If you're mid-event and just want to pause for lunch, leave the lock off — it's meant as a permanent seal, not a temporary brake.</div>
        </div>

        <!-- 13. Login, Roles & Default Mode -->
        <div id="g-auth" class="gs">
          <h4>13. Login, Roles & Default Mode</h4>
          <p>Local dev (<code>localhost</code>) is always admin. Web mode (GitHub Pages or any hosted origin) requires sign-in.</p>

          <p><strong>Username-based sign in</strong></p>
          <p>Login takes a plain <strong>username</strong> — no <code>@</code> needed. Behind the scenes RDMS appends <code>@sdba.local</code> to satisfy Supabase Auth's email requirement; the domain never gets used for email delivery. Set passwords in the Supabase Auth dashboard (Authentication &rarr; Users), creating each account with its exact <code>username@sdba.local</code> email + an initial password.</p>

          <p><strong>Roles</strong></p>
          <table class="gt">
            <tr><th>Role</th><th>What they can do</th></tr>
            <tr><td><strong>admin</strong></td><td>Everything — config, divisions, schedule, users, all races, exports, signals, lock/unlock, DB Admin.</td></tr>
            <tr><td><strong>editor</strong></td><td>Race pages (start / input / cancel / revive / export / send), Im/Export (all four tabs), Past Events Archive, Setup &rarr; Next Race manual fire + User Guide. <strong>Cannot</strong> edit event config, divisions, schedule, users, or DB Admin.</td></tr>
            <tr><td><strong>viewer</strong></td><td>Read-only — Dashboard, Race (read), TimeSheet, Scoring, Flowchart, User Guide. Cannot edit anything.</td></tr>
          </table>

          <p><strong>Default mode</strong> (per-user, set in Setup &rarr; Users)</p>
          <p>Which page each user lands on after login. Useful when an event has multiple operators each running a specific station:</p>
          <ul>
            <li><strong>Dashboard / Race / TimeSheet / Scoring</strong> — RDMS internal routes. The router falls through to <code>#/dashboard</code> if the configured page isn't permitted for the user's role.</li>
            <li><strong>Finish station / Starter station / Race Control station</strong> — full-page redirect to the standalone Firebase signal pages on <code>sdbafinishing.github.io</code>. Used when a user's only job is to flip the digital flag for one station.</li>
            <li>Unset → admins land on <em>Finish station</em>, others on Dashboard.</li>
          </ul>

          <p><strong>Logout</strong></p>
          <p>Click ${ic('logout')} in the top nav. Returns you to the public Dashboard (digital flag panel visible). Web users without a session see the public Dashboard by default; deep-linking to a protected route shows a "Sign in required" card.</p>
        </div>

        <!-- 14. Troubleshooting -->
        <div id="g-trouble" class="gs">
          <h4>14. Troubleshooting</h4>
          <table class="gt">
            <tr><th>Issue</th><th>Solution</th></tr>
            <tr><td>${ic('folder_open')} not turning green</td><td>Click again. Chrome/Edge only. Needs user gesture.</td></tr>
            <tr><td>Files not saving</td><td>Folder not connected. Click ${ic('folder_open')}.</td></tr>
            <tr><td>Data lost?</td><td>IndexedDB persists across restarts. Check <code>20 Database Backup/</code>. Restore via DB Admin.</td></tr>
            <tr><td>Rank mismatch error</td><td>Joyi rank != computed rank. Fix times. Must resolve before export.</td></tr>
            <tr><td>No Send button</td><td>WhatsApp group not configured in Setup &rarr; Event.</td></tr>
            <tr><td>No Import Joyi button</td><td>Shared Joyi folder not configured in Setup &rarr; Event.</td></tr>
            <tr><td>No alert sound</td><td>Tap "Enter" splash on first visit to unlock audio.</td></tr>
            <tr><td>Switch to new event</td><td>Setup &rarr; Event &rarr; "New Event". Backs up, then clears DB.</td></tr>
            <tr><td>Cancel race by mistake</td><td>DB Admin &rarr; races &rarr; change status to "pending".</td></tr>
            <tr><td>Pressed START by mistake</td><td>Click ${ic('undo')} <strong>Reset start</strong> next to FINISH (visible only before any export).</td></tr>
            <tr><td>Need to fully redo a race (re-race on the water)</td><td>${ic('delete_forever')} <strong>Reset race</strong> next to Reset start. Type-the-race-number confirmation. Wipes start times + all lane results; preserves the team draw + export-history audit trail.</td></tr>
            <tr><td>Wrong results exported</td><td>Fix data, Export again, choose "Revision".</td></tr>
            <tr><td>Race shows STARTED but I didn't click START</td><td>Expected — RDMS auto-promotes the status when a Joyi-derived <code>joyi_start_time</code> lands. Look for the <span style="display:inline-block; font-size:9px; font-weight:600; color:#7dd3fc; background:rgba(125,211,252,0.18); padding:1px 5px; border-radius:3px;">JOYI</span> badge in the Start cell.</td></tr>
            <tr><td>"Joyi start time loading…" stuck for &gt; 10 s</td><td>The lazy LCD fetch is in flight (Drive ranged-read ~30 bytes, normally &lt; 1 s). If it persists, check that the connected folder actually contains <code>{ref}.{race}.lcd</code> and that Drive token is still valid. Refresh the page to re-trigger.</td></tr>
            <tr><td>Shaded "Waiting for Joyi start time…" overlay appeared on FINISH click</td><td>Expected — the FINISH delta depends on the right baseline. Wait ≤ 1 s; the overlay auto-dismisses once the LCD lands and the click resumes.</td></tr>
            <tr><td>Manual click + Joyi-derived start disagree by &gt; 1 s</td><td>The header Start cell tooltip shows both values and the drift. If clocks weren't NTP-synced between the Joyi laptop and the RDMS laptop, that drift is the skew. Treat the Joyi value as authoritative for the race; sync clocks before the next race.</td></tr>
            <tr><td>Joyi-derived start is off by ~1 s instead of ~250 ms</td><td>The .lcd's mtime came through a transport that strips sub-second precision (browser drag-drop, FAT32 stick). Use Drive-for-Desktop sync to preserve ms precision.</td></tr>
            <tr><td>Photo Finish: "Open" button stays disabled</td><td>Both <code>.lcd</code> and <code>.jyd</code> are required now. Drop both files into the picker (or pre-load via auto-find from the Joyi folder).</td></tr>
            <tr><td>Photo Finish: red lines missing, times all off by a constant</td><td>The <code>.jyd</code> didn't load. Click <strong>Load .jyd</strong> in the amber banner inside the viewer, or type the race-start offset into the <strong>Offset (s)</strong> input.</td></tr>
            <tr><td>Photo Finish: cannot multi-select .lcd + .jyd in the file dialog</td><td>Drop-zone picker accepts them separately — drag each file into its own zone, or click each zone to pick.</td></tr>
            <tr><td>Photo Finish: framerate looks wrong</td><td>The label next to the fps input shows the source. If it reads "metadata + JYD disagree by X%", a reach point in the .jyd is probably mismarked. Override the fps manually as a workaround.</td></tr>
            <tr><td>Photo Finish: 90 MB+ image won't render</td><td>The viewer now tiles internally; reload the page and reopen. If the modal still hangs, check the browser console for canvas-size errors and report.</td></tr>
            <tr><td>Joyi result imported with wrong time (off by ~70 ms)</td><td>Old import used <code>RealScore</code>. Re-importing the same <code>.jyd</code> rewrites with <code>Score</code> (= RealScore + TimeDelta), which is what the results export expects.</td></tr>
            <tr><td>Digital flag didn't go red after I started inputting</td><td>Check the dashboard Signal panel for the Firebase connection. If it's offline the toast will say "Digital flag write failed (offline?)". Reconnect and re-edit a cell to retry.</td></tr>
            <tr><td>Next-race signal fired against the wrong race</td><td>The auto-fire is gated to skip when the next race already has a <code>start_time</code>. If you accidentally started the next race first, fix that race via Reset start, then the signal will recompute.</td></tr>
            <tr><td>Joyi auto-watch isn't picking up Drive files</td><td>The status line should read "Watching Drive ...". If it reads "Watching local folder ..." you haven't connected Drive yet — Setup &rarr; Event &rarr; Drive API.</td></tr>
            <tr><td>Photo Finish labels look squished at ⅕× zoom</td><td>That's the minimum readable ratio. ⅒× was removed for this reason. Use ¼× or coarser if the labels need to be larger.</td></tr>
            <tr><td>Photo Finish saved PNG text is blurry on Retina screens</td><td>The export now renders at 2× DPR by default — saved PNG is double-resolution. If still blurry, the source viewer is probably zoomed; reset to 1× before saving.</td></tr>
            <tr><td>Division CSV import: "missing required column"</td><td>The first row must have a <code>division_name</code> header (case-sensitive). Other columns are optional.</td></tr>
            <tr><td>Division CSV import: Chinese names come through as ???</td><td>Re-save the file as UTF-8 (Excel: Save As → CSV UTF-8). RDMS exports with a BOM; if your editor stripped it, names won't round-trip.</td></tr>
            <tr><td>Web version not loading</td><td>Check web-config.js has Supabase keys. Check Supabase is online.</td></tr>
            <tr><td>Users tab RLS error</td><td>First admin must be seeded via SQL in Supabase. See Users tab instructions.</td></tr>
            <tr><td>Drag-dropping draws pops a folder picker</td><td>Fixed — auto-backup now silently skips the disk write when no folder is connected. Manual backups via DB Admin still prompt as expected.</td></tr>
            <tr><td>"Import all from 01 Input_Draw/" asks me to pick a folder</td><td>It's asking for the <strong>root</strong> event folder (e.g. <code>2026WU/</code>), not <code>01 Input_Draw/</code> itself. RDMS finds the subfolder inside automatically. You can also connect from Setup &rarr; Event &rarr; "Connect event folder".</td></tr>
            <tr><td>"Resolve from prior results" button is disabled / says "Awaiting Race X"</td><td>One or more source races referenced by the placeholders haven't been exported yet. The tooltip lists which. Export those first; the button re-enables on next page-load.</td></tr>
            <tr><td>Auto-prompt for next-round draws didn't fire</td><td>Check Setup &rarr; Event &rarr; <em>Auto-prompt to generate next round draws</em> is ticked. The prompt only fires after the last race in a round is exported AND the dependent next-round races still have <code>R{n}P{n}</code> placeholders. Per-session: clicking Skip suppresses it until you reload.</td></tr>
            <tr><td>Generated next-round .xls didn't show up in 13/</td><td>Check that the event folder is connected (Setup &rarr; Event &rarr; "Connect event folder" green ✓). If not connected, the IndexedDB write still happens but the file write silently fails — the toast says "File write failed".</td></tr>
            <tr><td>I can't toggle the digital flag from the race page</td><td>You're probably a viewer. The mini-flag on the race header only allows toggling for users with <code>signal.finisher</code> (admin + editor).</td></tr>
            <tr><td>I locked the event by mistake — can't change anything</td><td>Admin: click <em>Unlock event</em> in the yellow banner at the top of any page. Type the event short ref to confirm. Editor/Viewer: ask an admin.</td></tr>
            <tr><td>Page says "Event is locked. Unlock from the Dashboard before making changes."</td><td>Working as intended. See §12 Event Lock for how to unlock.</td></tr>
            <tr><td>Logout left me on /race/5 instead of the dashboard</td><td>Fixed — logout now forces navigation back to <code>#/dashboard</code> and re-renders as the public view.</td></tr>
            <tr><td>I'm an editor but I can't see Setup → Event tab</td><td>Working as intended. Editors only see Setup → Next Race + User Guide. Ask an admin to change event config.</td></tr>
            <tr><td>Cancelled race — how to undo?</td><td>The same nav row now shows ${ic('restart_alt')} <strong>Revive Race</strong>. Restores status based on existing timing data (pending / started / exported). Lane results stay as they are.</td></tr>
            <tr><td>Draw watcher isn't picking up new files</td><td>Same flow as Joyi watcher — status line under the button shows the active backend (Drive vs local folder). If "Watching local folder ..." and Drive sync is producing updates, click ${ic('folder_open')} for the Drive token + restart the watcher.</td></tr>
            <tr><td>Re-importing a draw resets the team names but I want to keep my Joyi imports</td><td>Importing the draw only replaces the team identity columns. The lane's <code>raw_time</code>, <code>penalty_time</code>, <code>remarks</code>, and Joyi result columns are preserved.</td></tr>
            <tr><td>Login UI shows "Username" but I expected "Email"</td><td>Working as intended (§13). Type just the username (e.g. <code>john</code>) — RDMS appends <code>@sdba.local</code> behind the scenes to match the Supabase Auth record.</td></tr>
          </table>
        </div>

        <!-- 15. Folder Structure -->
        <div id="g-folders" class="gs">
          <h4>15. Folder Structure</h4>
          <pre style="background:var(--bg-input); padding:12px; border-radius:var(--radius-md); font-size:12px; overflow-x:auto; line-height:1.6;">
Events/2026TN/                        Master event folder
  00 Source Files/                    Raw source materials
  01 Input_Draw/                      Draw sheets (.xls) from scoring team
  11 Output_Start Lists/              Generated Joyi + SprintTimer lists
  12 Output_Results/                  Exported race results
  13 Output_Next Round Draws/         Generated next-round draws
  20 Database Backup/                 Auto-backup JSON snapshots
  99 Reference (DO NOT EDIT)/         Joyi/SprintTimer templates

Shared folders (configured separately):
  .../2026TN_Output_Results/          Results (mandatory)
  .../2026TN_Next_Round_Draws/        Draws (optional)
  .../2026TN_Joyi/                    Start lists + Joyi results (optional)
          </pre>
        </div>

      </div>
    </div>

    <style>
      .gs { margin-bottom:24px; }
      .gs h4 { font-size:15px; font-weight:600; color:var(--text-primary); margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid var(--border); }
      .gs ol, .gs ul { margin:8px 0 8px 20px; font-size:13px; line-height:1.8; }
      .gs p { font-size:13px; line-height:1.6; margin-bottom:8px; }
      .gt { width:100%; border-collapse:collapse; font-size:13px; margin:8px 0; }
      .gt th { text-align:left; padding:6px 10px; background:var(--bg-input); font-size:12px; font-weight:600; border:1px solid var(--border); }
      .gt td { padding:6px 10px; border:1px solid var(--border); vertical-align:top; }
      .gtip { background:var(--info-bg); border-left:3px solid var(--info); border-radius:var(--radius-sm); padding:8px 12px; margin:8px 0; font-size:13px; color:var(--info-text); }
      .gi { font-size:18px; vertical-align:middle; color:var(--accent); }
    </style>
  `;
}

function ic(name) {
  return `<i class="material-icons gi">${name}</i>`;
}
