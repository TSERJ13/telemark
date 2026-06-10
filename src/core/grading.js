'use strict';

/**
 * Grading / Festival engine.
 *
 * Used for beginner categories where dancers are NOT ranked against each other
 * and there is NO elimination. Everyone dances once; each judge gives a numeric
 * score; the system averages the scores per dancer and assigns a grade.
 *
 * Default scale: judges score 1..3
 *   3 = excellent     -> top grade
 *   2 = good
 *   1 = still learning -> lowest grade
 *
 * Default thresholds on the AVERAGE score:
 *   average >= 2.5            -> I   (Gold)
 *   1.8 <= average < 2.5      -> II  (Silver)
 *   average < 1.8             -> III (Bronze)
 *
 * Both the scale and thresholds are parameters so they can be tuned later
 * without touching the call sites.
 */

const DEFAULT_SCALE_MAX = 3;

const DEFAULT_THRESHOLDS = [
  { min: 2.5, grade: 'I',   label: 'Gold'   },
  { min: 1.8, grade: 'II',  label: 'Silver' },
  { min: 0,   grade: 'III', label: 'Bronze' },
];

/** Map a single average value to its grade using the threshold table. */
function gradeForAverage(average, thresholds = DEFAULT_THRESHOLDS) {
  for (const t of thresholds) {
    if (average >= t.min) return { grade: t.grade, label: t.label };
  }
  // Falls through only if no zero-floor row exists; treat as lowest.
  const last = thresholds[thresholds.length - 1];
  return { grade: last.grade, label: last.label };
}

/**
 * computeGrades — average each dancer's scores and assign a grade.
 *
 * Input:  rows = [{ entry_id, scores: [number, ...] }]
 *         (scores = every score that dancer received, across all judges and
 *          all dances in the grading round)
 * Output: [{ entry_id, average, count, grade, label }]
 *         sorted by average descending (informational order only — grading is
 *         not a ranking, but a stable order is handy for display/printing).
 */
function computeGrades(rows, opts = {}) {
  const thresholds = opts.thresholds || DEFAULT_THRESHOLDS;
  const out = rows.map((r) => {
    const scores = (r.scores || []).filter((s) => typeof s === 'number' && !Number.isNaN(s));
    const count = scores.length;
    const average = count ? scores.reduce((a, b) => a + b, 0) / count : 0;
    const { grade, label } = gradeForAverage(average, thresholds);
    return { entry_id: r.entry_id, average: Math.round(average * 100) / 100, count, grade, label };
  });
  out.sort((a, b) => b.average - a.average);
  return out;
}

module.exports = {
  DEFAULT_SCALE_MAX,
  DEFAULT_THRESHOLDS,
  gradeForAverage,
  computeGrades,
};
