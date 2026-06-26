/**
 * SDBA RDMS — Flowchart audit
 *
 * Pure analysis of the current divisions / division_rounds /
 * division_progressions / race_relationships / lane_results state.
 * Returns a structured report so callers (flowchart-page, divisions-tab)
 * can surface conflicts and missing data without re-implementing the
 * traversal logic each time.
 *
 * Findings come in two buckets:
 *   - conflicts: something is wrong with what's configured
 *       (duplicate placement, position-range overlap, broken refs, …)
 *   - missing:   something obvious is absent
 *       (race with no division, division with no rounds, round-N without
 *        a path back to round-N-1, placeholder pointing nowhere, …)
 *
 * Each finding has a stable `code` (string identifier) so callers can
 * link to specific docs / fixes later; a human-readable `message`; and
 * `refs` carrying race_number / division_id / round_id so the UI can
 * deep-link.
 */
import {
  getAllRaces, getAllDivisions, getDivisionRounds, getDivisionProgressions,
  getAllRaceRelationships, getLaneResults,
} from './db.js';
import { parsePlaceholder } from './placeholders.js';

/**
 * Run the full audit. The result is intentionally lightweight (plain
 * objects, no DOM) so it can be used from any page.
 *
 * @returns {Promise<{
 *   ready: boolean,
 *   stats: {
 *     races: number, divisions: number, rounds: number, progressions: number,
 *     uncoveredRaces: number,
 *   },
 *   conflicts: Array<{code: string, message: string, refs: object}>,
 *   missing:   Array<{code: string, message: string, refs: object}>,
 * }>}
 */
export async function runFlowchartAudit() {
  const [races, divisions] = await Promise.all([getAllRaces(), getAllDivisions()]);
  const raceMap = new Map(races.map(r => [r.race_number, r]));

  // Eagerly load rounds + progressions across all divisions so the rest of
  // the audit can iterate cheaply.
  const roundsByDiv  = new Map();
  const progsByDiv   = new Map();
  for (const d of divisions) {
    roundsByDiv.set(d.id, await getDivisionRounds(d.id));
    progsByDiv.set(d.id, await getDivisionProgressions(d.id));
  }
  const allRounds = [...roundsByDiv.values()].flat();
  const allProgs  = [...progsByDiv.values()].flat();
  const roundMap  = new Map(allRounds.map(r => [r.id, r]));

  const conflicts = [];
  const missing   = [];

  // ── Gate check: is the flowchart even meaningful yet? ──
  // We treat the flowchart as "not ready" when there are no divisions OR
  // no division has any rounds yet. Without these, every other audit
  // signal would be noise.
  const ready = divisions.length > 0 && allRounds.length > 0;

  // Short-circuit when no divisions exist yet. The "no divisions" state
  // is configuration-pending, not data-broken — emitting N findings of
  // "race X has no division" wrongly tells the operator they have N
  // problems when really they just haven't started the divisions step.
  // Surface the count via stats (.divisions === 0) so callers can render
  // a friendly "add a division to get started" prompt instead.
  if (divisions.length === 0) {
    return {
      ready: false,
      stats: {
        races: races.length, divisions: 0, rounds: 0, progressions: 0,
        uncoveredRaces: races.length,
      },
      conflicts: [],
      missing: [],
    };
  }

  // ── Conflicts ──

  // (1) A race that lives in multiple rounds. The same race can't be in
  // two rounds simultaneously — even across divisions, since round
  // assignment determines progression sources.
  const raceToRounds = new Map(); // race_number → [{division_id, round_id}]
  for (const round of allRounds) {
    for (const rn of (round.race_numbers || [])) {
      if (!raceToRounds.has(rn)) raceToRounds.set(rn, []);
      raceToRounds.get(rn).push({ division_id: round.division_id, round_id: round.id });
    }
  }
  for (const [rn, slots] of raceToRounds.entries()) {
    if (slots.length > 1) {
      const divNames = slots.map(s =>
        nameOfDivision(divisions, s.division_id) + ' / ' + nameOfRound(roundMap, s.round_id)
      );
      conflicts.push({
        code: 'race.duplicate_round',
        message: `Race ${rn} appears in multiple rounds: ${divNames.join('; ')}`,
        refs: { race_number: rn, slots },
      });
    }
  }

  // (2) Round.race_numbers referencing a race that doesn't exist in DB.
  for (const round of allRounds) {
    for (const rn of (round.race_numbers || [])) {
      if (!raceMap.has(rn)) {
        conflicts.push({
          code: 'round.missing_race',
          message: `Division "${nameOfDivision(divisions, round.division_id)}" round "${round.tier_name || ('R' + round.round_number)}" references Race ${rn} which is not in the loaded race set.`,
          refs: { race_number: rn, division_id: round.division_id, round_id: round.id },
        });
      }
    }
  }

  // (3) Progression endpoints in different divisions. We allow them to be
  // declared, but flag — it's almost always a misconfiguration.
  for (const p of allProgs) {
    const from = roundMap.get(p.from_round_id);
    const to   = roundMap.get(p.to_round_id);
    if (from && to && from.division_id !== to.division_id) {
      conflicts.push({
        code: 'progression.cross_division',
        message: `Progression crosses divisions: ${nameOfDivision(divisions, from.division_id)} → ${nameOfDivision(divisions, to.division_id)}`,
        refs: { progression_id: p.id, from_round_id: from.id, to_round_id: to.id },
      });
    }
  }

  // (4) Position-range overlap: two progressions from the same source round
  // funneling overlapping ranks into the same destination round.
  // E.g. "1-3 of R5 → R12" + "2-4 of R5 → R12" both claim rank 2 and 3.
  const progGroupKey = (p) => `${p.from_round_id}->${p.to_round_id}`;
  const progsBySrcDst = new Map();
  for (const p of allProgs) {
    const k = progGroupKey(p);
    if (!progsBySrcDst.has(k)) progsBySrcDst.set(k, []);
    progsBySrcDst.get(k).push(p);
  }
  for (const [k, group] of progsBySrcDst) {
    if (group.length < 2) continue;
    // Compare every pair within the group for overlap.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (rangesOverlap(group[i].position_range, group[j].position_range)) {
          conflicts.push({
            code: 'progression.range_overlap',
            message: `Two progressions from the same source carry overlapping position ranges: "${group[i].position_range}" and "${group[j].position_range}"`,
            refs: { from_round_id: group[i].from_round_id, to_round_id: group[i].to_round_id },
          });
        }
      }
    }
  }

  // (5) Same race used as source for two non-related destinations with the
  // SAME position range — likely a copy-paste mistake (operator duplicated
  // a row in the progression editor and forgot to change the source).
  // We only flag this when MULTIPLE EXPLICIT progressions claim rank 1
  // (the common copy-paste outcome). "rest" is the complement of the
  // explicit ranges from the same source, so a "rest" progression never
  // independently claims any specific rank — skip those entirely to
  // avoid false positives like "Heat → Cup (1-4)" + "Heat → Plate (rest)"
  // which is a legitimate split, not a duplicate.
  const fromRoundFirstRankUses = new Map(); // from_round_id → [progression]
  for (const p of allProgs) {
    const token = String(p.position_range || '').trim().toLowerCase();
    if (token === 'rest') continue; // complement — handled by range_overlap check, not here
    if (isRangeIncludingRank(p.position_range, 1)) {
      if (!fromRoundFirstRankUses.has(p.from_round_id)) {
        fromRoundFirstRankUses.set(p.from_round_id, []);
      }
      fromRoundFirstRankUses.get(p.from_round_id).push(p);
    }
  }
  for (const [fromId, ps] of fromRoundFirstRankUses) {
    if (ps.length > 1) {
      const destNames = ps.map(p => nameOfRound(roundMap, p.to_round_id));
      conflicts.push({
        code: 'progression.duplicate_first_rank_source',
        message: `Round "${nameOfRound(roundMap, fromId)}" feeds its 1st-place finisher into multiple destinations: ${destNames.join(', ')}`,
        refs: { from_round_id: fromId, progressions: ps.map(p => p.id) },
      });
    }
  }

  // ── Missing ──

  // (M1) Races with no division assignment at all.
  const orphanRaces = races.filter(r => !r.division_id);
  for (const r of orphanRaces) {
    missing.push({
      code: 'race.no_division',
      message: `Race ${r.race_number} (${r.race_title || 'untitled'}) has no division assigned.`,
      refs: { race_number: r.race_number },
    });
  }

  // (M2) Races whose division_id exists but they're not slotted into any
  // round inside that division. Distinct from M1 — division known but
  // round-membership missing.
  const racesInRounds = new Set();
  for (const round of allRounds) {
    for (const rn of (round.race_numbers || [])) racesInRounds.add(rn);
  }
  for (const r of races) {
    if (r.division_id && !racesInRounds.has(r.race_number)) {
      missing.push({
        code: 'race.no_round',
        message: `Race ${r.race_number} is in division "${nameOfDivision(divisions, r.division_id)}" but not assigned to any round.`,
        refs: { race_number: r.race_number, division_id: r.division_id },
      });
    }
  }

  // (M3) Divisions with zero rounds.
  for (const d of divisions) {
    const rs = roundsByDiv.get(d.id) || [];
    if (rs.length === 0) {
      missing.push({
        code: 'division.no_rounds',
        message: `Division "${d.division_name || ('#' + d.id)}" has no rounds defined.`,
        refs: { division_id: d.id },
      });
    }
  }

  // (M4) Round at round_number > 1 with no progression flowing into it.
  // This is almost always an error — a later round should be reachable
  // from somewhere earlier in the same division.
  const targetedRoundIds = new Set(allProgs.map(p => p.to_round_id));
  for (const r of allRounds) {
    if ((r.round_number || 1) > 1 && !targetedRoundIds.has(r.id)) {
      missing.push({
        code: 'round.unreachable',
        message: `Round "${nameOfRound(roundMap, r.id)}" (round ${r.round_number}) has no progression feeding into it from an earlier round.`,
        refs: { round_id: r.id, division_id: r.division_id },
      });
    }
  }

  // (M5) Gap in round_number sequence within a division. e.g. rounds at
  // 1 and 3 but nothing at 2.
  for (const d of divisions) {
    const rs = (roundsByDiv.get(d.id) || []).slice().sort((a, b) => a.round_number - b.round_number);
    if (rs.length < 2) continue;
    const nums = rs.map(r => r.round_number);
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] - nums[i - 1] > 1) {
        missing.push({
          code: 'round.gap',
          message: `Division "${d.division_name || ('#' + d.id)}" has a gap between round ${nums[i - 1]} and round ${nums[i]}.`,
          refs: { division_id: d.id, gap: [nums[i - 1], nums[i]] },
        });
      }
    }
  }

  // (M6) R{n}P{n} placeholders in lane_results that point at a race not
  // declared as a progression source for the current race. This catches
  // raw draws where the operator typed "R5P1" into a team slot but no
  // progression points from R5 into this race. We scan placeholders only
  // for races that ARE in a round (otherwise M2 already covered them).
  //
  // Cap the scan at races_in_rounds to avoid an N-races × M-lanes
  // worst-case on huge events that haven't been configured at all yet.
  const racesToScan = races.filter(r => racesInRounds.has(r.race_number));
  for (const race of racesToScan) {
    const lanes = await getLaneResults(race.race_number);
    for (const lr of lanes) {
      // Placeholders appear in either the team_name OR team_code column
      // depending on which template the event uses (2025TN: team_name,
      // 2026WU: team_code). Check both. Understands all three kinds:
      // single (R{n}P{p}), pooled (R{list}P{p}, method #1), sum (SUMR{list}P{p},
      // method #2).
      const ph = parsePlaceholder(lr.team_name) || parsePlaceholder(lr.team_code);
      if (!ph) continue;
      const myRound = findRoundContaining(allRounds, race.race_number);
      if (!myRound) continue; // M1/M2 will surface separately

      if (ph.kind === 'single') {
        const srcRace = ph.races[0], srcPos = ph.position;
        const srcRound = findRoundContaining(allRounds, srcRace);
        if (!srcRound) continue;
        const hasPath = allProgs.some(p =>
          p.from_round_id === srcRound.id &&
          p.to_round_id === myRound.id &&
          isRangeIncludingRank(p.position_range, srcPos),
        );
        if (!hasPath) {
          missing.push({
            code: 'placeholder.no_progression',
            message: `Race ${race.race_number} has a placeholder "${ph.raw}" in lane ${lr.lane_number}, but no progression covers rank ${srcPos} from Race ${srcRace} into this race.`,
            refs: { race_number: race.race_number, lane_number: lr.lane_number, source_race: srcRace, source_position: srcPos },
          });
        }
      } else {
        // Pooled / sum reference a combined field of several races; rank
        // coverage per-race doesn't map, so we validate that every source race
        // is in a round and a progression links that round into this race.
        for (const srcRace of ph.races) {
          const srcRound = findRoundContaining(allRounds, srcRace);
          if (!srcRound) {
            missing.push({
              code: 'placeholder.missing_source',
              message: `Race ${race.race_number} placeholder "${ph.raw}" (lane ${lr.lane_number}) references Race ${srcRace}, which isn't assigned to any round.`,
              refs: { race_number: race.race_number, lane_number: lr.lane_number, source_race: srcRace },
            });
            continue;
          }
          const hasPath = allProgs.some(p => p.from_round_id === srcRound.id && p.to_round_id === myRound.id);
          if (!hasPath) {
            missing.push({
              code: 'placeholder.no_progression',
              message: `Race ${race.race_number} placeholder "${ph.raw}" (lane ${lr.lane_number}, ${ph.kind === 'sum' ? 'sum-of-times' : 'combined-time'}) pulls from Race ${srcRace}, but no progression links that round into this race.`,
              refs: { race_number: race.race_number, lane_number: lr.lane_number, source_race: srcRace },
            });
          }
        }
      }
    }
  }

  // Stats roll-up.
  const stats = {
    races: races.length,
    divisions: divisions.length,
    rounds: allRounds.length,
    progressions: allProgs.length,
    uncoveredRaces: races.filter(r => !racesInRounds.has(r.race_number)).length,
  };

  return { ready, stats, conflicts, missing };
}

// ──── helpers ────

function nameOfDivision(divisions, id) {
  const d = divisions.find(x => x.id === id);
  if (!d) return `#${id}`;
  return d.division_name || `#${id}`;
}

function nameOfRound(roundMap, id) {
  const r = roundMap.get(id);
  if (!r) return `#${id}`;
  return r.tier_name || (`Round ${r.round_number ?? '?'}`);
}

/**
 * Parse a position-range token into a numeric Set of ranks. Returns null
 * when the token is "all" / "rest" — those are special cases handled by
 * the caller (they implicitly include every rank).
 */
function rangeToSet(token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t || t === 'all' || t === 'rest') return null;
  const set = new Set();
  for (const part of t.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    } else if (/^\d+$/.test(p)) {
      set.add(parseInt(p, 10));
    }
  }
  return set.size === 0 ? null : set;
}

function rangesOverlap(a, b) {
  const sa = rangeToSet(a);
  const sb = rangeToSet(b);
  // "all" / "rest" overlap with everything.
  if (sa === null && sb === null) return true;
  if (sa === null || sb === null) return true;
  for (const v of sa) if (sb.has(v)) return true;
  return false;
}

function isRangeIncludingRank(rangeToken, rank) {
  const s = rangeToSet(rangeToken);
  if (s === null) return true; // "all"/"rest" cover every rank
  return s.has(rank);
}

function findRoundContaining(allRounds, raceNumber) {
  for (const r of allRounds) {
    if ((r.race_numbers || []).includes(raceNumber)) return r;
  }
  return null;
}
