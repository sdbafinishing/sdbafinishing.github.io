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
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-multi').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Multi-Tab & Multi-Window</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-config').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Config Reference</a></li>
            <li><a href="javascript:void(0)" onclick="document.getElementById('g-scoring').scrollIntoView({behavior:'smooth'})" style="color:var(--accent);">Scoring</a></li>
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
            <tr><td>${ic('upload_file')}</td><td><strong>Import</strong></td><td>Import draws (drag-drop or scan folder), import Joyi results, generate start lists (Joyi + SprintTimer).</td></tr>
            <tr><td>${ic('settings')}</td><td><strong>Setup / Guide</strong></td><td>Admin: event config, divisions, schedule, users, user guide. Editor/Viewer: user guide only.</td></tr>
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
            <li><strong>Configure Event</strong> — Setup &rarr; Event tab. Fill in all mandatory fields (name, ref, date, lanes, colour, scoring, event folder, shared results folder).</li>
            <li><strong>Optional Config</strong> — Shared Joyi/draws folders, WhatsApp group, next race signal API, Supabase sync, Google Drive API.</li>
            <li><strong>Connect Folder</strong> — Click ${ic('folder_open')} in top nav. Select your event folder.</li>
            <li><strong>Import Draws</strong> — Import page &rarr; drag-drop .xls files or "Import from Source Folder".</li>
            <li><strong>Configure Divisions</strong> — Setup &rarr; Divisions. "Auto-Populate from Draws" or manual setup.</li>
            <li><strong>Set Scoring Flags</strong> — Setup &rarr; Schedule. Set R1/R2/RFinal for scored races.</li>
            <li><strong>Generate Start Lists</strong> — Import page &rarr; Generate Start Lists. Copy to Joyi + SprintTimer systems.</li>
            <li><strong>Verify</strong> — Dashboard shows all races with ${ic('check_circle')} draw marks.</li>
          </ol>
          <div class="gtip">Config is synced to Supabase immediately on save (if configured), so web users see it right away.</div>
        </div>

        <!-- 3. Race Day Workflow -->
        <div id="g-raceday" class="gs">
          <h4>3. Race Day Workflow</h4>
          <ol>
            <li><strong>Launch</strong> — Double-click "Launch RDMS.command" or <code>cd rdms && npx vite</code>.</li>
            <li><strong>Connect Folder</strong> — Click ${ic('folder_open')} once per session.</li>
            <li><strong>Open Dashboard</strong> — Keep one tab on Dashboard for monitoring.</li>
            <li><strong>Open Race Tabs</strong> — Open race sheets in separate tabs (right-click "Open" &rarr; New Tab).</li>
            <li><strong>Station Operators</strong> — Dashboard has RC/ST/FN/VO buttons to open station views in new tabs.</li>
          </ol>
        </div>

        <!-- 4. Processing a Race -->
        <div id="g-race" class="gs">
          <h4>4. Processing a Race</h4>
          <table class="gt">
            <tr><th>Step</th><th>Action</th><th>Notes</th></tr>
            <tr><td>1</td><td>${ic('play_arrow')} <strong>START RACE</strong></td><td>Click when race begins. Millisecond precision. Click again to restart.</td></tr>
            <tr><td>2a</td><td><strong>Manual Input</strong></td><td>Type lane + time (mss00: 05591 = 0:55.91) in yellow grid. Enter in finishing order. Arrow keys / Tab / Enter to navigate.</td></tr>
            <tr><td>2b</td><td>${ic('cloud_download')} <strong>Import Joyi</strong></td><td>Click "Import Joyi", select .xls file. Auto-populates grid. Only visible when Joyi folder is configured.</td></tr>
            <tr><td>3</td><td><strong>Penalties/Remarks</strong></td><td>TP column for penalty seconds. Remarks dropdown: DNF/DSQ/DNS/DQ.</td></tr>
            <tr><td>4</td><td><strong>Verify</strong></td><td>${ic('check_circle')} green = passed. ${ic('error')} red = fix before export. Rank mismatches block export.</td></tr>
            <tr><td>5</td><td>${ic('save')} <strong>Export</strong></td><td>If WhatsApp configured: "Export & Send" (primary) + "Export Only" + "Send Only". If not: "Export Only" only.</td></tr>
            <tr><td>6</td><td>${ic('cell_tower')} <strong>Next Race Signal</strong></td><td>Prompted after export (if signal API configured). Skips cancelled races. Won't re-prompt if already signaled.</td></tr>
            <tr><td>7</td><td>${ic('print')} <strong>Print / Open</strong></td><td>Print result (landscape, 1 per page). Open draw/result .xls from source folder.</td></tr>
          </table>
          <div class="gtip"><strong>Batch Adjustment:</strong> Enter P1 backup time to shift all boats by a delta.</div>
          <div class="gtip"><strong>Revision:</strong> Re-exporting? Choose "Revision" (version increments, note stamped on .xls header) or "Re-export" (same version).</div>
          <div class="gtip"><strong>Auto-Backup:</strong> Database saved to <code>20 Database Backup/</code> after every draw import and race export.</div>
          <div class="gtip"><strong>Previous Race Reminders:</strong> After export/send, warns about earlier races not yet exported or sent.</div>
        </div>

        <!-- 5. Multi-Tab & Multi-Window -->
        <div id="g-multi" class="gs">
          <h4>5. Multi-Tab & Multi-Window</h4>
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

        <!-- 6. Config Reference -->
        <div id="g-config" class="gs">
          <h4>6. Config Reference</h4>
          <table class="gt">
            <tr><th>Section</th><th>Fields</th><th>Required?</th></tr>
            <tr><td>Event Details</td><td>Name, Short Ref, Type, Date, Colour, Lanes, Time Format</td><td><span style="color:var(--danger);">Mandatory</span></td></tr>
            <tr><td>Scoring</td><td>Enable/disable checkbox</td><td><span style="color:var(--danger);">Mandatory</span></td></tr>
            <tr><td>Folder Paths</td><td>Event folder (local/Drive synced)</td><td><span style="color:var(--danger);">Mandatory</span></td></tr>
            <tr><td>Shared Results</td><td>Results folder for scoring team/public</td><td><span style="color:var(--danger);">Mandatory</span></td></tr>
            <tr><td>Shared Draws</td><td>Next round draws folder</td><td>Optional</td></tr>
            <tr><td>Shared Joyi</td><td>Bidirectional: start lists out, Joyi results in</td><td>Optional — hides Import Joyi button if blank</td></tr>
            <tr><td>Communication</td><td>WhatsApp group name</td><td>Optional — hides Send buttons if blank</td></tr>
            <tr><td>Integrations</td><td>Next race signal API + race name param</td><td>Optional — hides signal panel if blank</td></tr>
            <tr><td>Live Sync</td><td>Supabase URL + anon key + service role key</td><td>Optional — needed for web version, users, mobile</td></tr>
            <tr><td>Google Drive API</td><td>OAuth Client ID + Drive folder ID</td><td>Optional — web version file access only</td></tr>
          </table>
        </div>

        <!-- 7. Scoring -->
        <div id="g-scoring" class="gs">
          <h4>7. Scoring</h4>
          <ul>
            <li>Set scoring flags in Setup &rarr; Schedule: <strong>R1</strong>, <strong>R2</strong>, <strong>RFinal</strong>.</li>
            <li>Points: 1st = lane_count + 1, 2nd = lane_count - 1, ... DNS/DNF/DSQ/DQ = 0.</li>
            <li>Tiebreaker: RFinal &times;1.001 &gt; R2 &times;1.00001 &gt; R1 &times;1.0000001.</li>
            <li>Flowchart: single line = tournament progression, double line (══) = scored series.</li>
          </ul>
        </div>

        <!-- 8. Troubleshooting -->
        <div id="g-trouble" class="gs">
          <h4>8. Troubleshooting</h4>
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
            <tr><td>Wrong results exported</td><td>Fix data, Export again, choose "Revision".</td></tr>
            <tr><td>Web version not loading</td><td>Check web-config.js has Supabase keys. Check Supabase is online.</td></tr>
            <tr><td>Users tab RLS error</td><td>First admin must be seeded via SQL in Supabase. See Users tab instructions.</td></tr>
          </table>
        </div>

        <!-- 9. Folder Structure -->
        <div id="g-folders" class="gs">
          <h4>9. Folder Structure</h4>
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
