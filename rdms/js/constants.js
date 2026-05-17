/**
 * SDBA RDMS — Constants
 * Centralized string constants to avoid stringly-typed code.
 */

export const RACE_STATUS = {
  PENDING: 'pending',
  STARTED: 'started',
  FINISHED: 'finished',
  EXPORTED: 'exported',
  SENT: 'sent',
  CANCELLED: 'cancelled',
};

export const REMARKS = {
  DNF: 'DNF',
  DSQ: 'DSQ',
  DNS: 'DNS',
  DQ: 'DQ',
};

export const DISQUALIFYING_REMARKS = [REMARKS.DNF, REMARKS.DSQ, REMARKS.DNS, REMARKS.DQ];

export const SCORING_FLAGS = {
  NONE: 'N',
  R1: 'R1',
  R2: 'R2',
  RFINAL: 'RFinal',
};

export const DEFAULT_LANE_COUNT = 6;
export const DEFAULT_TIME_FORMAT = 'mss00';

// Tiebreaker multipliers for scoring
export const SCORING_MULTIPLIERS = {
  R1: 1.0000001,
  R2: 1.00001,
  RFinal: 1.001,
};

// Time reasonableness thresholds (ms)
export const TIME_THRESHOLDS = {
  SUSPICIOUSLY_FAST: 30000,  // 30 seconds
  SUSPICIOUSLY_SLOW: 300000, // 5 minutes
};
