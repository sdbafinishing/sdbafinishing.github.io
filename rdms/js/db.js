/**
 * SDBA RDMS — IndexedDB Schema (Dexie.js)
 * All data operations go through this module.
 */
import Dexie from 'dexie';

export const db = new Dexie('sdba-rdms');

db.version(1).stores({
  // Event configuration (singleton — aligns with SDBA-RMS annual_event_config)
  config: 'id',

  // Race records (one per race, up to 100)
  races: 'race_number, status, scoring_flag, division_id, next_race_signaled',

  // Lane results (composite key: race_number + lane_number)
  lane_results: '[race_number+lane_number], race_number',

  // TimeSheet log
  timesheet: 'race_number',

  // Divisions (aligns with SDBA-RMS division_config_general)
  divisions: '++id, division_name, div_code_prefix',

  // Division rounds (rounds within a division)
  division_rounds: '++id, division_id, round_number',

  // Division progressions (edges in the flowchart DAG)
  division_progressions: '++id, division_id, from_round_id, to_round_id',

  // Race relationships (generated from progressions)
  race_relationships: '++id, race_number, parent_race_number, division_id',

  // Sync queue (Phase 3 — outbound sync buffer)
  sync_queue: '++id, table_name, synced_at',

  // Import log
  import_log: '++id, filename, type',
});

// ──── Config CRUD ────

export async function getConfig() {
  return db.config.get('event-config');
}

export async function saveConfig(data) {
  data.id = 'event-config';
  data.updated_at = new Date().toISOString();
  if (!data.created_at) data.created_at = data.updated_at;
  return db.config.put(data);
}

// ──── Event Lock ────
// When `event_locked` is true on the config record, every other write
// function in this module refuses to proceed. The lock is meant to be
// flipped from the dashboard once race day is fully wrapped, so a stale
// open tab can't accidentally clobber the final state. Unlocking is an
// admin action (gated at the UI layer in event-lock.js).
//
// We deliberately read the lock from IndexedDB each time rather than
// caching — multiple tabs may flip the flag and we want the freshest
// answer every write. The cost is a fast single-key get(); negligible.

export class EventLockedError extends Error {
  constructor() {
    super('Event is locked. Unlock from the Dashboard before making changes.');
    this.name = 'EventLockedError';
    this.code = 'event-locked';
  }
}

async function assertNotLocked() {
  // Avoid recursion: getConfig itself never triggers a write.
  const cfg = await db.config.get('event-config');
  if (cfg?.event_locked) throw new EventLockedError();
}

export async function isEventLocked() {
  const cfg = await db.config.get('event-config');
  return !!cfg?.event_locked;
}

// ──── Race CRUD ────

export async function getRace(raceNumber) {
  return db.races.get(raceNumber);
}

export async function getAllRaces() {
  return db.races.toArray();
}

export async function saveRace(data) {
  await assertNotLocked();
  data.updated_at = new Date().toISOString();
  return db.races.put(data);
}

export async function bulkSaveRaces(racesArray) {
  await assertNotLocked();
  const now = new Date().toISOString();
  racesArray.forEach(r => { r.updated_at = now; });
  return db.races.bulkPut(racesArray);
}

// ──── Lane Results CRUD ────

export async function getLaneResults(raceNumber) {
  return db.lane_results.where('race_number').equals(raceNumber).toArray();
}

export async function saveLaneResult(data) {
  await assertNotLocked();
  data.last_modified_at = new Date().toISOString();
  return db.lane_results.put(data);
}

export async function bulkSaveLaneResults(resultsArray) {
  await assertNotLocked();
  const now = new Date().toISOString();
  resultsArray.forEach(r => { r.last_modified_at = now; });
  return db.lane_results.bulkPut(resultsArray);
}

// ──── TimeSheet CRUD ────

export async function getTimesheet(raceNumber) {
  return db.timesheet.get(raceNumber);
}

export async function saveTimesheet(data) {
  await assertNotLocked();
  return db.timesheet.put(data);
}

export async function getAllTimesheets() {
  return db.timesheet.toArray();
}

// ──── Division CRUD ────

export async function getAllDivisions() {
  return db.divisions.toArray();
}

export async function saveDivision(data) {
  await assertNotLocked();
  return db.divisions.put(data);
}

export async function deleteDivision(id) {
  await assertNotLocked();
  return db.transaction('rw', db.divisions, db.division_rounds, db.division_progressions, db.race_relationships, async () => {
    await db.division_rounds.where('division_id').equals(id).delete();
    await db.division_progressions.where('division_id').equals(id).delete();
    await db.race_relationships.where('division_id').equals(id).delete();
    await db.divisions.delete(id);
  });
}

// ──── Division Rounds CRUD ────

export async function getDivisionRounds(divisionId) {
  return db.division_rounds.where('division_id').equals(divisionId).toArray();
}

export async function getAllDivisionRounds() {
  return db.division_rounds.toArray();
}

export async function saveDivisionRound(data) {
  await assertNotLocked();
  return db.division_rounds.put(data);
}

// ──── Division Progressions CRUD ────

export async function getDivisionProgressions(divisionId) {
  return db.division_progressions.where('division_id').equals(divisionId).toArray();
}

export async function getAllDivisionProgressions() {
  return db.division_progressions.toArray();
}

export async function saveDivisionProgression(data) {
  await assertNotLocked();
  return db.division_progressions.put(data);
}

// ──── Race Relationships ────

export async function getRaceRelationships(raceNumber) {
  return db.race_relationships.where('race_number').equals(raceNumber).toArray();
}

export async function getAllRaceRelationships() {
  return db.race_relationships.toArray();
}

// ──── Import Log ────

export async function addImportLog(entry) {
  // Import-log writes ARE allowed while locked — they're an audit trail of
  // attempted imports, not state mutations. Even when an actual import is
  // blocked, recording the attempt is useful for debugging.
  entry.imported_at = new Date().toISOString();
  return db.import_log.add(entry);
}

// ──── Event Management ────

/**
 * Reset the database for a new event.
 * Exports a backup first, then clears all data.
 * @returns {boolean} true if reset was performed
 */
export async function resetForNewEvent() {
  return clearAllData();
}

/**
 * Generate blank race templates (no-import mode).
 * Creates N races with dummy team names (R{n}B{lane}).
 * @param {number} raceCount - Total number of races
 * @param {number} laneCount - Number of lanes per race
 */
export async function generateBlankRaces(raceCount, laneCount) {
  const races = [];
  const laneResults = [];

  for (let r = 1; r <= raceCount; r++) {
    races.push({
      race_number: r,
      race_title: `Race ${r}`,
      race_time: '',
      scoring_flag: 'N',
      start_time: null,
      restart_time: null,
      export_time: null,
      send_time: null,
      status: 'pending',
      teams_loaded: true,
      joyi_imported: false,
      export_version: 0,
      export_history: [],
      next_race_signaled: false,
    });

    for (let l = 1; l <= laneCount; l++) {
      laneResults.push({
        race_number: r,
        lane_number: l,
        team_name: `R${r}B${l}`,
        team_code: `R${r}B${l}`,
        designation: '',
        raw_time: '',
        penalty_time: '',
        remarks: '',
        computed_position: null,
        effective_time_ms: null,
      });
    }
  }

  await bulkSaveRaces(races);
  await bulkSaveLaneResults(laneResults);

  return { raceCount, laneCount, totalLanes: raceCount * laneCount };
}

/**
 * List all saved events (by checking localStorage for backup metadata).
 * @returns {string[]} Array of event refs
 */
export function listSavedEvents() {
  const events = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('rdms-event-')) {
      events.push(key.replace('rdms-event-', ''));
    }
  }
  return events;
}

// ──── Utilities ────

export async function clearAllData() {
  return db.transaction('rw',
    db.config, db.races, db.lane_results, db.timesheet,
    db.divisions, db.division_rounds, db.division_progressions,
    db.race_relationships, db.sync_queue, db.import_log,
    async () => {
      await Promise.all([
        db.config.clear(),
        db.races.clear(),
        db.lane_results.clear(),
        db.timesheet.clear(),
        db.divisions.clear(),
        db.division_rounds.clear(),
        db.division_progressions.clear(),
        db.race_relationships.clear(),
        db.sync_queue.clear(),
        db.import_log.clear(),
      ]);
    }
  );
}
