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
  const { userId, dateKey, algorithmVersion, candidates } = payload || {};

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

  // Only allow known directions
  const direction = directionRaw === "positive" || directionRaw === "negative" ? directionRaw : null;

  // Strength should be 0..1 (heuristic)
  const strengthNum = typeof c.strength === "number" ? c.strength : Number(c.strength);
  const strength = Number.isFinite(strengthNum) ? clamp(strengthNum, 0, 1) : null;

  if (!inputKey || !outputKey || !direction || strength === null) {
    return null;
  }

  return {
    inputKey,
    outputKey,
    direction,
    strength,
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
