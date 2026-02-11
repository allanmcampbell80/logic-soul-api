// userAnalysis.js

import { ObjectId } from "mongodb";

// POST payload shape expected from iOS:
// {
//   userId: "...",
//   dateKey: "YYYY-MM-DD",
//   algorithmVersion: "daily_analyzer_v1",
//   candidates: [ { inputKey, outputKey, direction, strength } ]
// }

const COLLECTION = "user_analysis_correlation_packs";

export async function storeUserCorrelationPack(db, payload) {
  const { userId, dateKey, algorithmVersion, candidates, windowDays, lagDays } = payload || {};

  // --- Basic validation ---
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }

  let userObjectId;
  try {
    userObjectId = new ObjectId(userId);
  } catch {
    throw new Error("userId must be a valid ObjectId string");
  }

  if (!dateKey || typeof dateKey !== "string") {
    throw new Error("dateKey is required");
  }

  // yyyy-mm-dd (loose but safe)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error("dateKey must be in YYYY-MM-DD format");
  }

  if (!algorithmVersion || typeof algorithmVersion !== "string") {
    throw new Error("algorithmVersion is required");
  }

  if (!Array.isArray(candidates)) {
    throw new Error("candidates must be an array");
  }

  // --- Normalize + sanitize candidates ---
  const normalizedCandidates = candidates
    .map((c) => normalizeCandidate(c))
    .filter(Boolean);

  // If nothing valid, still store a pack (so the server has a record that analysis ran)
  const now = new Date();

  const doc = {
    userId: userObjectId,
    dateKey,
    algorithmVersion,
    candidates: normalizedCandidates,
    storedCount: normalizedCandidates.length,
    // Optional engine metadata (useful for server-side correlation engine packs)
    ...(Number.isFinite(windowDays) ? { windowDays: Math.trunc(windowDays) } : {}),
    ...(Number.isFinite(lagDays) ? { lagDays: Math.trunc(lagDays) } : {}),
    updatedAt: now,
  };

  // --- Upsert by (userId, dateKey, algorithmVersion) ---
  const col = db.collection(COLLECTION);

  const filter = { userId: userObjectId, dateKey, algorithmVersion };

  // Preserve createdAt on first insert
  const update = {
    $set: doc,
    $setOnInsert: { createdAt: now },
  };

  await col.updateOne(filter, update, { upsert: true });

  return {
    userId,
    dateKey,
    storedCount: normalizedCandidates.length,
  };
}

function normalizeCandidate(c) {
  if (!c || typeof c !== "object") return null;

  const inputKey = typeof c.inputKey === "string" ? c.inputKey.trim() : "";
  const outputKey = typeof c.outputKey === "string" ? c.outputKey.trim() : "";

  const directionRaw = typeof c.direction === "string" ? c.direction.trim().toLowerCase() : "";
  const direction = directionRaw === "positive" || directionRaw === "negative" ? directionRaw : null;

  // Strength may be any finite number (e.g., Spearman rho -1..1, Cohen's d can exceed 1)
  const strengthNum = typeof c.strength === "number" ? c.strength : Number(c.strength);
  const strength = Number.isFinite(strengthNum) ? strengthNum : null;

  // Strength is required. Direction is optional (we can infer it).
  if (!inputKey || !outputKey || strength === null) {
    return null;
  }

  const base = {
    inputKey,
    outputKey,
    direction: direction || (strength >= 0 ? "positive" : "negative"),
    strength,
  };

  // Preserve useful optional fields from the server-side correlation engine.
  const extras = {};
  if (typeof c.mode === "string" && c.mode.trim()) extras.mode = c.mode.trim();
  if (Number.isFinite(Number(c.lagDays))) extras.lagDays = Math.trunc(Number(c.lagDays));
  if (Number.isFinite(Number(c.n))) extras.n = Math.trunc(Number(c.n));
  if (Number.isFinite(Number(c.nEvent))) extras.nEvent = Math.trunc(Number(c.nEvent));
  if (Number.isFinite(Number(c.nNonEvent))) extras.nNonEvent = Math.trunc(Number(c.nNonEvent));
  if (Number.isFinite(Number(c.meanEvent))) extras.meanEvent = Number(c.meanEvent);
  if (Number.isFinite(Number(c.meanNonEvent))) extras.meanNonEvent = Number(c.meanNonEvent);
  if (Number.isFinite(Number(c.threshold))) extras.threshold = Number(c.threshold);
  if (Number.isFinite(Number(c.delta))) extras.delta = Number(c.delta);

  return { ...base, ...extras };
}


// ------------------------------------------------------------
// Longitudinal Correlation Engine (v1)
// Goal: find lag-1 (next-day) correlations with minimal assumptions.
// ------------------------------------------------------------

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function percentile(sortedNums, p) {
  if (!Array.isArray(sortedNums) || sortedNums.length === 0) return null;
  const pp = clamp(p, 0, 1);
  const idx = (sortedNums.length - 1) * pp;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedNums[lo];
  const w = idx - lo;
  return sortedNums[lo] * (1 - w) + sortedNums[hi] * w;
}

function mean(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}

function stdev(nums) {
  if (!Array.isArray(nums) || nums.length < 2) return null;
  const m = mean(nums);
  let s2 = 0;
  for (const n of nums) {
    const d = n - m;
    s2 += d * d;
  }
  return Math.sqrt(s2 / (nums.length - 1));
}

function rankArray(values) {
  // Average ranks for ties.
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));

  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j + 2) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

function pearson(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length < 3) return null;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 <= 0 || dy2 <= 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

function spearman(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length < 3) return null;
  const rx = rankArray(x);
  const ry = rankArray(y);
  return pearson(rx, ry);
}

function normalizeIngredientKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'");
}

function buildUserIdFilters(userId) {
  const filters = [{ userId: String(userId) }];
  if (ObjectId.isValid(String(userId))) {
    try {
      filters.push({ userId: new ObjectId(String(userId)) });
    } catch {
      // ignore
    }
  }
  return filters;
}

function isOutcomeKey(k) {
  return (
    k === "checkin_mood" ||
    k === "checkin_clarity_score" ||
    k === "checkin_pain_peak" ||
    k === "checkin_pain_region_count" ||
    k === "checkin_energy"
  );
}

function isInputKey(k) {
  if (!k || typeof k !== "string") return false;
  if (isOutcomeKey(k)) return false;
  return true;
}

function extractDayInputs(dayDoc) {
  const x = {};
  const totals = dayDoc && typeof dayDoc.totals === "object" ? dayDoc.totals : {};

  // Numeric totals → inputs (exclude outcomes)
  for (const [k, v] of Object.entries(totals)) {
    if (!isInputKey(k)) continue;
    if (isFiniteNumber(v)) x[k] = v;
  }

  // Ingredients exposure → sparse inputs (counts)
  const ing = dayDoc && typeof dayDoc.ingredients_exposure === "object" ? dayDoc.ingredients_exposure : null;
  if (ing) {
    for (const [rawKey, rawVal] of Object.entries(ing)) {
      const key = normalizeIngredientKey(rawKey);
      if (!key) continue;
      const val = isFiniteNumber(rawVal) ? rawVal : null;
      if (val == null) continue;
      x[`ing:${key}`] = val;
    }
  }

  return x;
}

function extractDayOutcomes(dayDoc) {
  const totals = dayDoc && typeof dayDoc.totals === "object" ? dayDoc.totals : {};
  const y = {};
  for (const k of ["checkin_mood", "checkin_clarity_score", "checkin_pain_peak", "checkin_pain_region_count", "checkin_energy"]) {
    const v = totals[k];
    if (isFiniteNumber(v)) y[k] = v;
  }
  return y;
}

function buildAlignedLagPairs(docsSorted, lagDays) {
  const pairs = [];
  const lag = Math.max(1, Math.trunc(lagDays || 1));
  for (let i = 0; i + lag < docsSorted.length; i++) {
    const dX = docsSorted[i];
    const dY = docsSorted[i + lag];
    const x = extractDayInputs(dX);
    const y = extractDayOutcomes(dY);
    if (!x || Object.keys(x).length === 0) continue;
    if (!y || Object.keys(y).length === 0) continue;
    pairs.push({ x, y, dateKeyX: dX.dateKey, dateKeyY: dY.dateKey });
  }
  return pairs;
}

function computeSupportCounts(pairs) {
  const counts = new Map();
  for (const p of pairs) {
    for (const [k, v] of Object.entries(p.x || {})) {
      if (!isFiniteNumber(v)) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return counts;
}

function topByAbsStrength(list, topK) {
  const k = Math.max(10, Math.trunc(topK || 150));
  list.sort((a, b) => Math.abs(b.strength || 0) - Math.abs(a.strength || 0));
  return list.length > k ? list.slice(0, k) : list;
}

function buildExtremeEvents(values, lowP = 0.2, highP = 0.8) {
  const clean = values.filter((v) => isFiniteNumber(v)).slice().sort((a, b) => a - b);
  if (clean.length < 10) return { low: null, high: null };
  const low = percentile(clean, lowP);
  const high = percentile(clean, highP);
  return { low, high };
}

function computeEventEffect(featureVals, eventFlags) {
  const a = [];
  const b = [];
  for (let i = 0; i < featureVals.length; i++) {
    const fv = featureVals[i];
    const flag = eventFlags[i];
    if (!isFiniteNumber(fv)) continue;
    if (flag === true) a.push(fv);
    else if (flag === false) b.push(fv);
  }
  if (a.length < 3 || b.length < 5) return null;

  const ma = mean(a);
  const mb = mean(b);
  const all = a.concat(b);
  const sd = stdev(all) || 0;
  const delta = ma - mb;
  const d = sd > 0 ? delta / sd : delta;

  return { nEvent: a.length, nNonEvent: b.length, meanEvent: ma, meanNonEvent: mb, strength: d, delta };
}

// Main engine entry
export async function runCorrelationEngineForUser(db, options) {
  const userId = String(options?.userId || "").trim();
  if (!userId) throw new Error("Missing userId");

  const windowDays =
    typeof options?.windowDays === "number" && Number.isFinite(options.windowDays) ? Math.trunc(options.windowDays) : 120;
  const lagDays =
    typeof options?.lagDays === "number" && Number.isFinite(options.lagDays) ? Math.trunc(options.lagDays) : 1;
  const minSupportDays =
    typeof options?.minSupportDays === "number" && Number.isFinite(options.minSupportDays) ? Math.trunc(options.minSupportDays) : 4;
  const topK =
    typeof options?.topK === "number" && Number.isFinite(options.topK) ? Math.trunc(options.topK) : 150;

  const totalsCol = db.collection("user_daily_totals");
  const userIdFilters = buildUserIdFilters(userId);

  // Pull recent docs, sorted by dateKey, then slice last windowDays+lagDays+buffer
  const allDocs = await totalsCol
    .find(
      { $or: userIdFilters },
      { projection: { userId: 1, dateKey: 1, totals: 1, ingredients_exposure: 1, updatedAt: 1, createdAt: 1 } }
    )
    .sort({ dateKey: 1 })
    .toArray();

  const cleanDocs = (allDocs || []).filter((d) => typeof d?.dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.dateKey));
  const want = Math.min(Math.max(windowDays + lagDays + 10, 30), 450);
  const sliced = cleanDocs.length > want ? cleanDocs.slice(cleanDocs.length - want) : cleanDocs;

  sliced.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));

  const pairs = buildAlignedLagPairs(sliced, lagDays);
  if (pairs.length < 10) {
    return { userId, windowDays, lagDays, storedCount: 0, promotedCount: 0, top: [], message: "Not enough days yet" };
  }

  const support = computeSupportCounts(pairs);

  const eligibleInputs = Array.from(support.entries())
    .filter(([, c]) => c >= minSupportDays)
    .map(([k]) => k);

  const outcomeKeys = ["checkin_mood", "checkin_clarity_score", "checkin_pain_peak", "checkin_pain_region_count", "checkin_energy"].filter(Boolean);

  const engineVersion = "correlation_engine_v1";
  const allCandidates = [];

  for (const outKey of outcomeKeys) {
    const ySeries = pairs.map((p) => (p.y && isFiniteNumber(p.y[outKey]) ? p.y[outKey] : null));
    const yClean = ySeries.filter((v) => isFiniteNumber(v));
    if (yClean.length < 10) continue;

    const ev = buildExtremeEvents(yClean, 0.2, 0.8);

    const lowFlags = pairs.map((p) => {
      const v = p.y && p.y[outKey];
      return isFiniteNumber(v) && ev.low != null ? v <= ev.low : null;
    });

    const highFlags = pairs.map((p) => {
      const v = p.y && p.y[outKey];
      return isFiniteNumber(v) && ev.high != null ? v >= ev.high : null;
    });

    for (const inKey of eligibleInputs) {
      const xSeries = pairs.map((p) => (p.x && isFiniteNumber(p.x[inKey]) ? p.x[inKey] : null));

      // Event LOW
      if (ev.low != null) {
        const eff = computeEventEffect(xSeries, lowFlags);
        if (eff && eff.nEvent >= 3) {
          allCandidates.push({
            inputKey: inKey,
            outputKey: outKey,
            lagDays,
            mode: "event_low",
            direction: eff.delta >= 0 ? "positive" : "negative",
            strength: eff.strength,
            n: eff.nEvent + eff.nNonEvent,
            nEvent: eff.nEvent,
            nNonEvent: eff.nNonEvent,
            meanEvent: eff.meanEvent,
            meanNonEvent: eff.meanNonEvent,
            threshold: ev.low,
          });
        }
      }

      // Event HIGH
      if (ev.high != null) {
        const eff = computeEventEffect(xSeries, highFlags);
        if (eff && eff.nEvent >= 3) {
          allCandidates.push({
            inputKey: inKey,
            outputKey: outKey,
            lagDays,
            mode: "event_high",
            direction: eff.delta >= 0 ? "positive" : "negative",
            strength: eff.strength,
            n: eff.nEvent + eff.nNonEvent,
            nEvent: eff.nEvent,
            nNonEvent: eff.nNonEvent,
            meanEvent: eff.meanEvent,
            meanNonEvent: eff.meanNonEvent,
            threshold: ev.high,
          });
        }
      }

      // Continuous (Spearman)
      const xNum = [];
      const yNum = [];
      for (let i = 0; i < xSeries.length; i++) {
        const xv = xSeries[i];
        const yv = ySeries[i];
        if (isFiniteNumber(xv) && isFiniteNumber(yv)) {
          xNum.push(xv);
          yNum.push(yv);
        }
      }
      if (xNum.length >= 10) {
        const rho = spearman(xNum, yNum);
        if (rho != null && Number.isFinite(rho) && Math.abs(rho) >= 0.15) {
          allCandidates.push({
            inputKey: inKey,
            outputKey: outKey,
            lagDays,
            mode: "continuous_spearman",
            direction: rho >= 0 ? "positive" : "negative",
            strength: rho,
            n: xNum.length,
          });
        }
      }
    }
  }

  // Keep topK per (outputKey, mode)
  const grouped = new Map();
  for (const c of allCandidates) {
    const key = `${c.outputKey}|${c.mode}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(c);
  }

  const top = [];
  for (const [, list] of grouped.entries()) {
    top.push(...topByAbsStrength(list, topK));
  }

  // Store pack (reuse your existing storeUserCorrelationPack)
  const endDateKey = pairs[pairs.length - 1]?.dateKeyY || sliced[sliced.length - 1]?.dateKey || null;

  const packPayload = {
    userId,
    dateKey: endDateKey,
    algorithmVersion: engineVersion,
    windowDays,
    lagDays,
    createdAt: new Date(),
    candidates: top,
    storedCount: top.length,
  };

  const stored = await storeUserCorrelationPack(db, packPayload);

  return {
    userId,
    windowDays,
    lagDays,
    storedCount: stored?.storedCount ?? top.length,
    promotedCount: 0,
    top: top.slice(0, Math.min(50, top.length)),
    dateKey: endDateKey,
  };
}

// ------------------------------------------------------------
// Promotion layer (v1)
// Goal: after each engine run, update a rolling tally and surface stable findings early.
// Stores user-facing correlations in `user_correlations`.
// ------------------------------------------------------------

const USER_CORRELATIONS_COLLECTION = "user_correlations";

function passesV1Threshold(c) {
  // Early surfacing rules (tunable)
  const mode = typeof c.mode === "string" ? c.mode : "";
  const strength = typeof c.strength === "number" ? c.strength : Number(c.strength);
  if (!Number.isFinite(strength)) return false;

  // Require some minimum support metadata when present
  const n = Number.isFinite(Number(c.n)) ? Number(c.n) : null;
  if (n !== null && n < 8) return false;

  if (mode === "continuous_spearman") {
    return Math.abs(strength) >= 0.35; // moderate+
  }

  // event_low / event_high effect sizes (Cohen-ish d)
  return Math.abs(strength) >= 0.8;
}

function buildCorrelationKey(c, lagDaysFallback = 1) {
  const inputKey = typeof c.inputKey === "string" ? c.inputKey.trim() : "";
  const outputKey = typeof c.outputKey === "string" ? c.outputKey.trim() : "";
  const mode = typeof c.mode === "string" && c.mode.trim() ? c.mode.trim() : "unknown";
  const lagDays = Number.isFinite(Number(c.lagDays)) ? Math.trunc(Number(c.lagDays)) : lagDaysFallback;
  return { inputKey, outputKey, mode, lagDays };
}

export async function promoteCorrelationCandidates(db, payload) {
  const { userId, dateKey, candidates, lagDays } = payload || {};

  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }

  let userObjectId;
  try {
    userObjectId = new ObjectId(userId);
  } catch {
    throw new Error("userId must be a valid ObjectId string");
  }

  if (!dateKey || typeof dateKey !== "string") {
    throw new Error("dateKey is required");
  }

  if (!Array.isArray(candidates)) {
    throw new Error("candidates must be an array");
  }

  const col = db.collection(USER_CORRELATIONS_COLLECTION);
  const now = new Date();

  // Only consider candidates that pass minimal schema sanity.
  const normalized = candidates.map((c) => normalizeCandidate(c)).filter(Boolean);

  let newlySurfacedCount = 0;

  for (const c of normalized) {
    const { inputKey, outputKey, mode, lagDays: lag } = buildCorrelationKey(c, lagDays);
    if (!inputKey || !outputKey) continue;

    const keyFilter = {
      userId: userObjectId,
      inputKey,
      outputKey,
      mode,
      lagDays: lag,
    };

    const isStrongNow = passesV1Threshold(c);

    // We track:
    // - seenCount: how many engine runs this candidate appeared in
    // - confirmStreak: consecutive runs meeting strength threshold
    // - isSurfaced: whether we show it to the user
    // Promotion rule (v1): seenCount >= 5 AND confirmStreak >= 2

    const update = {
      $set: {
        updatedAt: now,
        lastSeenDateKey: dateKey,
        direction: c.direction,
        strength: c.strength,
        // optional metadata (kept fresh)
        ...(Number.isFinite(Number(c.n)) ? { n: Math.trunc(Number(c.n)) } : {}),
        ...(Number.isFinite(Number(c.nEvent)) ? { nEvent: Math.trunc(Number(c.nEvent)) } : {}),
        ...(Number.isFinite(Number(c.nNonEvent)) ? { nNonEvent: Math.trunc(Number(c.nNonEvent)) } : {}),
        ...(Number.isFinite(Number(c.meanEvent)) ? { meanEvent: Number(c.meanEvent) } : {}),
        ...(Number.isFinite(Number(c.meanNonEvent)) ? { meanNonEvent: Number(c.meanNonEvent) } : {}),
        ...(Number.isFinite(Number(c.threshold)) ? { threshold: Number(c.threshold) } : {}),
        ...(Number.isFinite(Number(c.delta)) ? { delta: Number(c.delta) } : {}),
      },
      $setOnInsert: {
        createdAt: now,
        firstSeenDateKey: dateKey,
        seenCount: 0,
        confirmStreak: 0,
        isSurfaced: false,
      },
      $inc: {
        seenCount: 1,
      },
    };

    // Two-step: apply base update, then compute streak/surface based on stored doc.
    await col.updateOne(keyFilter, update, { upsert: true });

    const doc = await col.findOne(keyFilter, { projection: { seenCount: 1, confirmStreak: 1, isSurfaced: 1 } });
    const seenCount = Number.isFinite(Number(doc?.seenCount)) ? Number(doc.seenCount) : 1;
    const confirmStreakPrev = Number.isFinite(Number(doc?.confirmStreak)) ? Number(doc.confirmStreak) : 0;
    const isSurfacedPrev = doc?.isSurfaced === true;

    const confirmStreak = isStrongNow ? confirmStreakPrev + 1 : 0;

    const shouldSurface = !isSurfacedPrev && seenCount >= 5 && confirmStreak >= 2;

    const patch = {
      $set: {
        confirmStreak,
        ...(shouldSurface ? { isSurfaced: true, surfacedAt: now, surfacedDateKey: dateKey } : {}),
      },
    };

    await col.updateOne(keyFilter, patch);

    if (shouldSurface) newlySurfacedCount += 1;
  }

  return { newlySurfacedCount, processedCount: normalized.length };
}

// Convenience wrapper: run the engine and immediately promote candidates.
export async function runCorrelationEngineAndPromoteForUser(db, options) {
  const result = await runCorrelationEngineForUser(db, options);

  // If there are no candidates (or not enough days), nothing to promote.
  const candidates = Array.isArray(result?.top) ? result.top : [];
  if (!candidates.length) {
    return { ...result, promotedCount: 0 };
  }

  const promoted = await promoteCorrelationCandidates(db, {
    userId: String(options?.userId || "").trim(),
    dateKey: result.dateKey,
    candidates,
    lagDays: result.lagDays,
  });

  return { ...result, promotedCount: promoted?.newlySurfacedCount ?? 0 };
}
