/**
 * SDBA RDMS — Division Auto-Populate
 * Guess divisions and progressions from imported draw data.
 *
 * Sources:
 * 1. Race titles — group by base name after stripping round indicators
 * 2. Progression text — row after last lane, parse English for "first N → X, others → Y"
 * 3. R{n}P{n} placeholders — team name slots like "R3P4" in raw draws
 */
import { getAllRaces, getLaneResults, saveDivision, saveDivisionRound, saveDivisionProgression } from './db.js';
import { showToast } from './utils.js';

// Keywords to strip when finding base division name
const ROUND_INDICATORS = [
  /\s*Heat\s*\d*/gi,
  /\s*Semi[\s-]*Final\s*/gi,
  /\s*Semi\s*/gi,
  /\s*Final\s*\(?R?\d*\)?\s*/gi,
  /\s*Rnd?\s*\d+/gi,
  /\s*Round\s*\d+/gi,
  /\s*\(R\d+\)\s*/gi,
  /\s*Gold\s*Cup\s*/gi,
  /\s*Gold\s*Bowl\s*/gi,
  /\s*Gold\s*Plate\s*/gi,
  /\s*Silver\s*Cup\s*/gi,
  /\s*Cup\s*/gi,
  /\s*Bowl\s*/gi,
  /\s*Plate\s*/gi,
  /\s*首輪\s*/g,
  /\s*次輪\s*/g,
  /\s*決賽\s*/g,
  /\s*初賽\s*/g,
  /\s*複賽\s*/g,
  /\s*盃\s*/g,
  /\s*碗\s*/g,
  /\s*碟\s*/g,
];

// Tier detection from title
const TIER_PATTERNS = [
  { pattern: /Heat/i, tier: 'Heat', roundNum: 1 },
  { pattern: /Semi/i, tier: 'Semi', roundNum: 2 },
  { pattern: /Final.*\(R1\)|首輪.*決賽|Final.*Rnd?\s*1/i, tier: 'Final Rnd 1', roundNum: 1 },
  { pattern: /Final.*\(R2\)|次輪.*決賽|Final.*Rnd?\s*2/i, tier: 'Final Rnd 2', roundNum: 2 },
  { pattern: /Final.*\(R3\)|Final.*Rnd?\s*3/i, tier: 'Final Rnd 3', roundNum: 3 },
  { pattern: /Final/i, tier: 'Final', roundNum: 3 },
];

// Trophy/tier level from title
const LEVEL_PATTERNS = [
  { pattern: /Gold\s*Cup|金盃/i, level: 'Gold Cup' },
  { pattern: /Gold\s*Bowl|金碗/i, level: 'Gold Bowl' },
  { pattern: /Gold\s*Plate|金碟/i, level: 'Gold Plate' },
  { pattern: /Silver/i, level: 'Silver' },
  { pattern: /Cup|盃/i, level: 'Cup' },
  { pattern: /Bowl|碗/i, level: 'Bowl' },
  { pattern: /Plate|碟/i, level: 'Plate' },
];

/**
 * Extract base division name from a race title.
 * Strips round indicators, tier names, etc.
 */
function extractBaseName(title) {
  if (!title) return '';
  let base = title;
  for (const re of ROUND_INDICATORS) {
    base = base.replace(re, ' ');
  }
  return base.replace(/\s+/g, ' ').trim();
}

/**
 * Detect what tier/round a race belongs to from its title.
 */
function detectTier(title) {
  if (!title) return { tier: 'Unknown', roundNum: 1, level: '' };

  let tier = 'Unknown';
  let roundNum = 1;
  for (const p of TIER_PATTERNS) {
    if (p.pattern.test(title)) {
      tier = p.tier;
      roundNum = p.roundNum;
      break;
    }
  }

  let level = '';
  for (const p of LEVEL_PATTERNS) {
    if (p.pattern.test(title)) {
      level = p.level;
      break;
    }
  }

  // Combine tier + level for full tier name
  const fullTier = level ? `${tier} ${level}` : tier;

  return { tier: fullTier, roundNum, level };
}

/**
 * Parse progression text from draw file.
 * Looks for patterns like:
 *   "first N teams → X Final"
 *   "others → Y Final"
 *   "aggregate score of N races"
 */
function parseProgressionText(text) {
  if (!text) return { rules: [], isScored: false };

  const rules = [];
  let isScored = false;

  // Check for scored series
  if (/aggregate\s+score/i.test(text) || /總分/i.test(text)) {
    isScored = true;
  }

  // Parse "first N teams → destination"
  const firstMatch = text.match(/first\s+(\d+)\s+teams?\s+.*?(?:advance|will\s+advance)\s+to\s+([\w\s]+?)(?:,|\.|\n)/i);
  if (firstMatch) {
    rules.push({
      position_range: `1-${firstMatch[1]}`,
      destination: firstMatch[2].trim(),
    });
  }

  // Parse "others → destination"
  const othersMatch = text.match(/others?\s+(?:will\s+)?(?:advance|獲邀參加)\s+(?:to\s+)?([\w\s]+?)(?:\.|\n)/i);
  if (othersMatch) {
    rules.push({
      position_range: 'rest',
      destination: othersMatch[1].trim(),
    });
  }

  return { rules, isScored };
}

/**
 * Scan R{n}P{n} placeholders in lane results to find progression sources.
 * @param {number} raceNumber
 * @returns {Array<{lane: number, sourceRace: number, sourcePosition: number}>}
 */
async function findPlaceholders(raceNumber) {
  const lanes = await getLaneResults(raceNumber);
  const placeholders = [];

  for (const lr of lanes) {
    const match = (lr.team_name || '').match(/^R(\d+)[BP](\d+)$/i);
    if (match) {
      placeholders.push({
        lane: lr.lane_number,
        sourceRace: parseInt(match[1], 10),
        sourcePosition: parseInt(match[2], 10),
      });
    }
  }

  return placeholders;
}

/**
 * Auto-populate divisions from imported race data.
 * Returns proposed divisions for user review.
 * @returns {Object[]} Array of proposed divisions with rounds and progressions
 */
export async function autoPopulateDivisions() {
  const races = await getAllRaces();
  if (races.length === 0) {
    showToast('No races loaded. Import draws first.', 'warning');
    return [];
  }

  // Step 1: Group races by base name
  const groups = {};
  for (const race of races) {
    const baseName = extractBaseName(race.race_title);
    if (!baseName) continue;
    if (!groups[baseName]) groups[baseName] = [];

    const tierInfo = detectTier(race.race_title);
    groups[baseName].push({
      race_number: race.race_number,
      title: race.race_title,
      ...tierInfo,
    });
  }

  // Step 2: Build proposed divisions
  const proposals = [];
  const colours = ['#2196F3', '#FF9800', '#4CAF50', '#9C27B0', '#F44336', '#00BCD4', '#FF5722', '#607D8B', '#E91E63', '#3F51B5'];
  let colourIdx = 0;

  for (const [baseName, raceEntries] of Object.entries(groups)) {
    // Group entries by tier
    const tiers = {};
    for (const entry of raceEntries) {
      const key = `${entry.roundNum}_${entry.tier}`;
      if (!tiers[key]) tiers[key] = { roundNum: entry.roundNum, tier: entry.tier, races: [] };
      tiers[key].races.push(entry.race_number);
    }

    const rounds = Object.values(tiers).sort((a, b) => a.roundNum - b.roundNum);

    // Detect if scored (check placeholders or progression text for "aggregate")
    let isScored = false;
    if (rounds.length >= 2) {
      // Check if later rounds have same number of races as earlier → might be scored
      // Simple heuristic: if round N and round N+1 both have exactly 1 race → likely scored
      for (let i = 0; i < rounds.length - 1; i++) {
        if (rounds[i].races.length === 1 && rounds[i + 1].races.length === 1) {
          isScored = true;
        }
      }
    }

    // Build progressions
    const progressions = [];
    for (let i = 0; i < rounds.length - 1; i++) {
      progressions.push({
        from_tier: rounds[i].tier,
        to_tier: rounds[i + 1].tier,
        from_round_num: rounds[i].roundNum,
        to_round_num: rounds[i + 1].roundNum,
        position_range: isScored ? 'all' : '1-?',
        is_scored: isScored && rounds[i].races.length === 1 && rounds[i + 1].races.length === 1,
      });
    }

    proposals.push({
      division_name: baseName,
      colour_hex: colours[colourIdx % colours.length],
      rounds,
      progressions,
      race_count: raceEntries.length,
    });
    colourIdx++;
  }

  return proposals;
}

/**
 * Save proposed divisions to the database.
 * @param {Object[]} proposals - From autoPopulateDivisions()
 */
export async function saveProposedDivisions(proposals) {
  let saved = 0;

  for (const prop of proposals) {
    // Save division
    const divId = await saveDivision({
      division_name: prop.division_name,
      div_code_prefix: '',
      div_short_ref: '',
      colour_hex: prop.colour_hex,
    });

    // Save rounds
    const roundIdMap = {};
    for (const round of prop.rounds) {
      const key = `${round.roundNum}_${round.tier}`;
      const roundId = await saveDivisionRound({
        division_id: divId,
        round_number: round.roundNum,
        tier_name: round.tier,
        race_numbers: round.races,
      });
      roundIdMap[key] = roundId;
    }

    // Save progressions
    for (const prog of prop.progressions) {
      const fromKey = `${prog.from_round_num}_${prog.from_tier}`;
      const toKey = `${prog.to_round_num}_${prog.to_tier}`;
      const fromId = roundIdMap[fromKey];
      const toId = roundIdMap[toKey];

      if (fromId && toId) {
        await saveDivisionProgression({
          division_id: divId,
          from_round_id: fromId,
          to_round_id: toId,
          position_range: prog.position_range,
          is_scored: prog.is_scored,
        });
      }
    }

    saved++;
  }

  return saved;
}
