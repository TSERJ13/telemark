/**
 * Telemark.one — Skating System engine
 * Implements the official Skating System (rules 1-11) used by WDSF.
 *
 * Covers WDSF certification requirements:
 *   2.1  correct skating-system calculation
 *   2.2  skating rules 1-11
 *   2.4  placing according to WDSF rules
 *   5.6  redance support (flagged for chairman)
 *   5.8  seeded/star couples (handled at draw level; calc is neutral)
 *
 * --------------------------------------------------------------------------
 * Terminology
 *   "marks"  : for a FINAL, each judge gives every couple a place (1..N).
 *              For an INTERMEDIATE round, each judge gives a cross/recall (0/1).
 *   A couple's row of marks in a final  = [placeFromJudgeA, placeFromJudgeB, ...]
 *   Majority = floor(numVoters / 2) + 1
 * --------------------------------------------------------------------------
 */

'use strict';

/* ------------------------------------------------------------------ *
 * Low-level helpers
 * ------------------------------------------------------------------ */

function majorityOf(numVoters) {
  return Math.floor(numVoters / 2) + 1;
}

/** cumulative count of marks <= threshold */
function countUpTo(marks, threshold) {
  let c = 0;
  for (const m of marks) if (m <= threshold) c++;
  return c;
}

/** cumulative sum of marks <= threshold */
function sumUpTo(marks, threshold) {
  let s = 0;
  for (const m of marks) if (m <= threshold) s += m;
  return s;
}

/* ------------------------------------------------------------------ *
 * Core comparator — Skating Rules 1-4 (and reused as 9-11)
 *
 * Compares two couples given their rows of marks.
 * Returns negative if A ranks higher (better place) than B,
 * positive if B ranks higher, 0 if a genuine tie (rules exhausted).
 *
 * maxPlace = number of distinct places to scan (usually couple count).
 * ------------------------------------------------------------------ */
function compareByRules(marksA, marksB, numVoters, maxPlace) {
  const majority = majorityOf(numVoters);

  for (let p = 1; p <= maxPlace; p++) {
    const cntA = countUpTo(marksA, p);
    const cntB = countUpTo(marksB, p);
    const aMaj = cntA >= majority;
    const bMaj = cntB >= majority;

    // Rule 1: the couple reaching majority at the lower place wins.
    if (aMaj && !bMaj) return -1;
    if (bMaj && !aMaj) return 1;

    if (aMaj && bMaj) {
      // Rule 2: equal majority-place -> larger count of marks wins.
      if (cntA !== cntB) return cntB - cntA; // higher count -> negative -> A first
      // Rule 3: equal count -> lower sum of the counted marks wins.
      const sumA = sumUpTo(marksA, p);
      const sumB = sumUpTo(marksB, p);
      if (sumA !== sumB) return sumA - sumB; // lower sum -> negative -> A first
      // Rule 4: equal count and sum -> drop to next lower place; loop continues.
    }
    // neither has majority yet -> keep scanning lower places.
  }
  return 0; // unresolved tie
}

/* ------------------------------------------------------------------ *
 * placeFinal — Rules 1-4
 *
 * Input:
 *   couples : [{ id, marks:[place per judge] }, ...]
 *   numJudges (optional, inferred from marks length)
 *
 * Output: [{ id, place, marks, tie:bool }] ordered best -> worst.
 *   Equal couples (comparator returned 0) share a place and are flagged tie.
 * ------------------------------------------------------------------ */
function placeFinal(couples, numJudges) {
  if (!couples.length) return [];
  const J = numJudges || couples[0].marks.length;
  const maxPlace = couples.length;

  // Stable sort by the rules comparator.
  const sorted = couples
    .map((c, idx) => ({ ...c, _idx: idx }))
    .sort((a, b) => {
      const r = compareByRules(a.marks, b.marks, J, maxPlace);
      return r !== 0 ? r : a._idx - b._idx;
    });

  // Assign places, sharing place numbers across genuine ties.
  const result = [];
  let place = 1;
  for (let i = 0; i < sorted.length; i++) {
    const tiedWithPrev =
      i > 0 &&
      compareByRules(sorted[i - 1].marks, sorted[i].marks, J, maxPlace) === 0;
    if (i > 0 && !tiedWithPrev) place = i + 1;
    result.push({
      id: sorted[i].id,
      place,
      marks: sorted[i].marks,
      tie: false, // set below
    });
  }
  // Flag ties (any place shared by >1 couple).
  const counts = {};
  result.forEach((r) => (counts[r.place] = (counts[r.place] || 0) + 1));
  result.forEach((r) => (r.tie = counts[r.place] > 1));
  return result;
}

/* ------------------------------------------------------------------ *
 * placeMultiDanceFinal — Rules 5-11
 *
 * Input:
 *   dances : [{ name, couples:[{id, marks:[...]}] }, ...]
 *
 * Method:
 *   1. Place each dance separately (rules 1-4).
 *   2. Each couple gets a placing per dance; sum them.
 *   3. Lowest sum wins (rule 5/6). Ties broken by the majority comparator
 *      applied to the row of dance-placings (rules 9,10,11).
 *
 * Output: [{ id, place, total, dancePlaces:{danceName:place}, tie }]
 * ------------------------------------------------------------------ */
function placeMultiDanceFinal(dances) {
  if (!dances.length) return [];

  // 1. place every dance
  const perDance = dances.map((d) => ({
    name: d.name,
    placing: placeFinal(d.couples),
  }));

  // collect couple ids
  const ids = perDance[0].placing.map((p) => p.id);
  const numDances = dances.length;

  // 2. build each couple's row of dance-placings + total
  const rows = ids.map((id) => {
    const dancePlaces = {};
    let total = 0;
    const placingsRow = [];
    for (const d of perDance) {
      const found = d.placing.find((p) => p.id === id);
      const pl = found ? found.place : numDances + 1;
      dancePlaces[d.name] = pl;
      placingsRow.push(pl);
      total += pl;
    }
    return { id, total, dancePlaces, placingsRow };
  });

  // 3. sort: primary = total asc; tie = majority comparator on placingsRow
  const maxPlace = ids.length;
  const sorted = rows
    .map((r, idx) => ({ ...r, _idx: idx }))
    .sort((a, b) => {
      if (a.total !== b.total) return a.total - b.total;
      const r = compareByRules(a.placingsRow, b.placingsRow, numDances, maxPlace);
      return r !== 0 ? r : a._idx - b._idx;
    });

  // assign places, sharing on genuine ties (same total AND comparator 0)
  const result = [];
  let place = 1;
  const isTie = (x, y) =>
    x.total === y.total &&
    compareByRules(x.placingsRow, y.placingsRow, numDances, maxPlace) === 0;

  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && !isTie(sorted[i - 1], sorted[i])) place = i + 1;
    result.push({
      id: sorted[i].id,
      place,
      total: sorted[i].total,
      dancePlaces: sorted[i].dancePlaces,
      tie: false,
    });
  }
  const counts = {};
  result.forEach((r) => (counts[r.place] = (counts[r.place] || 0) + 1));
  result.forEach((r) => (r.tie = counts[r.place] > 1));
  return { final: result, perDance };
}

/* ------------------------------------------------------------------ *
 * recall — Intermediate rounds (cross counting)
 *
 * Input:
 *   couples    : [{ id, crosses:int }]  (count of recalls received)
 *   recallCount: how many couples to bring to next round
 *
 * Output:
 *   {
 *     recalled : [ids...],
 *     borderlineTie : bool,        // tie spanning the cut line
 *     tiedAtCut : [ids...],        // couples tied at the boundary
 *     needsRedance : bool,         // chairman must decide (rule 5.6)
 *     ranked : [{id, crosses, recalled}]
 *   }
 *
 * Per WDSF: if the cut line falls inside a group of couples with equal
 * crosses, a clean selection is impossible -> flag for chairman:
 * recall all tied couples OR hold a redance.
 * ------------------------------------------------------------------ */
function recall(couples, recallCount) {
  const ranked = [...couples]
    .map((c, idx) => ({ ...c, _idx: idx }))
    .sort((a, b) => (b.crosses - a.crosses) || (a._idx - b._idx));

  if (recallCount >= ranked.length) {
    return {
      recalled: ranked.map((c) => c.id),
      borderlineTie: false,
      tiedAtCut: [],
      needsRedance: false,
      ranked: ranked.map((c) => ({ id: c.id, crosses: c.crosses, recalled: true })),
    };
  }

  const cutCrosses = ranked[recallCount - 1].crosses;     // last "in" value
  const justOut = ranked[recallCount] ? ranked[recallCount].crosses : -1;
  const borderlineTie = cutCrosses === justOut;

  const tiedAtCut = ranked
    .filter((c) => c.crosses === cutCrosses)
    .map((c) => c.id);

  // clearly-in: couples with crosses strictly above the cut value
  const clearlyIn = ranked.filter((c) => c.crosses > cutCrosses).map((c) => c.id);

  let recalled;
  if (!borderlineTie) {
    recalled = ranked.slice(0, recallCount).map((c) => c.id);
  } else {
    // recall the clearly-in couples + all couples tied at the cut line
    recalled = [...clearlyIn, ...tiedAtCut];
  }

  return {
    recalled,
    borderlineTie,
    tiedAtCut: borderlineTie ? tiedAtCut : [],
    needsRedance: borderlineTie, // chairman decides: recall-all (done) or redance
    ranked: ranked.map((c) => ({
      id: c.id,
      crosses: c.crosses,
      recalled: recalled.includes(c.id),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * placePointsFinal — WDSF JS 3.0 / Absolute Points Placing
 *
 * Input: [{ id, total: number }]
 * Output: [{ id, place, total, tie: bool }] ordered best -> worst.
 * ------------------------------------------------------------------ */
function placePointsFinal(couples) {
  if (!couples.length) return [];
  
  const sorted = couples
    .map((c, idx) => ({ ...c, _idx: idx }))
    .sort((a, b) => (b.total - a.total) || (a._idx - b._idx));

  const result = [];
  let place = 1;
  for (let i = 0; i < sorted.length; i++) {
    const tiedWithPrev = i > 0 && sorted[i - 1].total === sorted[i].total;
    if (i > 0 && !tiedWithPrev) place = i + 1;
    result.push({
      id: sorted[i].id,
      place,
      total: sorted[i].total,
      tie: false,
    });
  }

  const counts = {};
  result.forEach((r) => (counts[r.place] = (counts[r.place] || 0) + 1));
  result.forEach((r) => (r.tie = counts[r.place] > 1));
  return result;
}

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */
module.exports = {
  majorityOf,
  countUpTo,
  sumUpTo,
  compareByRules,
  placeFinal,
  placeMultiDanceFinal,
  placePointsFinal,
  recall,
};
