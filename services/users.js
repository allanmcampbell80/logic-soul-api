// services/users.js
import { ObjectId } from "mongodb";
import crypto from "crypto";

function mapUserDoc(user) {
  if (!user) return null;
  return {
    id: user._id.toString(),            // ✅ now the Mongo _id
    deviceId: user.deviceId,           // still available explicitly
    platform: user.platform ?? null,
    appVersion: user.appVersion ?? null,
    locale: user.locale ?? null,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    displayName: user.displayName ?? null,
    gender: user.gender ?? null,
    age: user.age ?? null,
    heightCm: user.heightCm ?? null,
    weightKg: user.weightKg ?? null,
    fingerScalePoints: user.fingerScalePoints ?? null,
    fingerScaleCm: user.fingerScaleCm ?? null,
    recoveryEmailVerified: user.recoveryEmailVerified ?? null,
    recoveryEmailAddedAt: user.recoveryEmailAddedAt ?? null,
    recoveryEmailLastVerifiedAt: user.recoveryEmailLastVerifiedAt ?? null,
    dailyGoals: user.dailyGoals ?? null,
  };
}

export async function deleteUserAndAllData(db, userId) {
  if (!db) {
    const err = new Error("DB not ready");
    err.statusCode = 500;
    throw err;
  }

  const cleaned = String(userId || "").trim();
  if (!cleaned || !ObjectId.isValid(cleaned)) {
    const err = new Error("Missing or invalid user id");
    err.statusCode = 400;
    throw err;
  }

  const _id = new ObjectId(cleaned);

  const usersCol = db.collection("users");
  const mealsCol = db.collection("user_meals");
  const totalsCol = db.collection("user_daily_totals");
  const userCorrelationsCol = db.collection("user_correlations");
  const analysisCorrelationPacksCol = db.collection("user_analysis_correlation_packs");

  // Delete user first
  const userDelete = await usersCol.deleteOne({ _id });
  if (!userDelete || userDelete.deletedCount !== 1) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const safeDeleteMany = async (col, filter) => {
    try {
      const r = await col.deleteMany(filter);
      return r?.deletedCount ?? 0;
    } catch (e) {
      console.warn("[deleteUserAndAllData] deleteMany skipped:", e?.message || e);
      return 0;
    }
  };

  // user_meals: sometimes userId stored as string, sometimes ObjectId
  const mealsDeleted = await safeDeleteMany(mealsCol, { $or: [{ userId: cleaned }, { userId: _id }] });
  const totalsDeleted = await safeDeleteMany(totalsCol, { $or: [{ userId: cleaned }, { userId: _id }] });
  const userCorrelationsColDeleted = await safeDeleteMany(userCorrelationsCol, { $or: [{ userId: cleaned }, { userId: _id }] });
  const analysisCorrelationPacksDeleted = await safeDeleteMany(analysisCorrelationPacksCol, { $or: [{ userId: cleaned }, { userId: _id }] });

  return {
    ok: true,
    userId: cleaned,
    deleted: {
      users: 1,
      user_meals: mealsDeleted,
      user_daily_totals: totalsDeleted,
      user_correlations: userCorrelationsColDeleted,
      user_analysis_correlation_packs: analysisCorrelationPacksDeleted,
    },
  };
}


export async function ensureUser(db, payload) {
  if (!db) throw new Error("DB not ready");

  console.log("[ensureUser] incoming payload:", payload);

  const { deviceId, platform, appVersion, locale } = payload || {};

  if (typeof deviceId !== "string" || !deviceId.trim()) {
    const err = new Error("Missing or invalid 'deviceId'");
    err.statusCode = 400;
    throw err;
  }

  const usersCollection = db.collection("users");
  const now = new Date();
  const cleanDeviceId = deviceId.trim();

  const update = {
    $setOnInsert: {
      deviceId: cleanDeviceId,
      createdAt: now,
    },
    $set: {
      platform: typeof platform === "string" ? platform : null,
      appVersion: typeof appVersion === "string" ? appVersion : null,
      locale: typeof locale === "string" ? locale : null,
      lastSeenAt: now,
    },
  };

  const options = {
    upsert: true,
    // New driver style:
    returnDocument: "after",
    // Old driver style (for compatibility):
    returnOriginal: false,
  };

  const result = await usersCollection.findOneAndUpdate(
    { deviceId: cleanDeviceId },
    update,
    options
  );

  console.log("[ensureUser] findOneAndUpdate result:", {
    hasValue: !!result?.value,
    lastErrorObject: result?.lastErrorObject,
  });

  let doc = result.value;

  // Fallback in case the driver still doesn't populate `value`
  if (!doc) {
    console.log("[ensureUser] value null, trying explicit findOne...");
    doc = await usersCollection.findOne({ deviceId: cleanDeviceId });
    console.log("[ensureUser] fallback findOne found doc:", !!doc);
  }

  if (!doc) {
    const err = new Error("Failed to ensure user");
    err.statusCode = 500;
    throw err;
  }

  return mapUserDoc(doc);
}

// Lookup-only helpers (no upsert). Useful for request-scoped resolution.
export async function findUserIdByDeviceId(db, deviceId) {
  if (!db) throw new Error("DB not ready");

  const cleanDeviceId = String(deviceId || "").trim();
  if (!cleanDeviceId) return null;

  const usersCollection = db.collection("users");
  const user = await usersCollection.findOne(
    { deviceId: cleanDeviceId },
    { projection: { _id: 1 } }
  );

  return user?._id ? String(user._id) : null;
}

export async function findUserByDeviceId(db, deviceId, projection = null) {
  if (!db) throw new Error("DB not ready");

  const cleanDeviceId = String(deviceId || "").trim();
  if (!cleanDeviceId) return null;

  const usersCollection = db.collection("users");
  return await usersCollection.findOne(
    { deviceId: cleanDeviceId },
    projection ? { projection } : undefined
  );
}

function buildUserIdQuery(cleanUserId) {
  // Treat userId as Mongo _id, but support legacy users where _id is stored as a string.
  const id = String(cleanUserId || "").trim();
  if (!id) return null;

  if (ObjectId.isValid(id)) {
    return { $or: [{ _id: new ObjectId(id) }, { _id: id }] };
  }

  return { _id: id };
}

function inferSexFromGender(gender) {
  const g = String(gender || "").trim().toLowerCase();
  if (!g) return null;
  if (g.includes("male") || g === "m") return "male";
  if (g.includes("female") || g === "f") return "female";
  return null;
}

export async function updateUserProfile(db, userId, profile) {
  if (!db) throw new Error("DB not ready");

  console.log("[updateUserProfile] incoming userId (_id):", userId);
  console.log("[updateUserProfile] incoming profile:", profile);

  if (!userId || typeof userId !== "string") {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  const usersCollection = db.collection("users");
  const now = new Date();

  // Treat userId as Mongo _id, but support legacy users where _id is stored as a string.
  const cleanUserId = userId.trim();
  const query = buildUserIdQuery(cleanUserId);
  if (!query) {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  const updateDoc = {
    $set: {
      displayName: profile.displayName ?? null,
      gender: profile.gender ?? null,
      age: typeof profile.age === "number" ? profile.age : null,
      heightCm: typeof profile.heightCm === "number" ? profile.heightCm : null,
      weightKg: typeof profile.weightKg === "number" ? profile.weightKg : null,
      fingerScalePoints: typeof profile.fingerScalePoints === "number" ? profile.fingerScalePoints : null,
      fingerScaleCm: typeof profile.fingerScaleCm === "number" ? profile.fingerScaleCm : null,
      lastSeenAt: now,
    },
  };

  console.log("[updateUserProfile] using query:", query);

  const result = await usersCollection.findOneAndUpdate(
    query,
    updateDoc,
    {
      returnDocument: "after",
      returnOriginal: false,
    }
  );

  console.log("[updateUserProfile] findOneAndUpdate result:", {
    hasValue: !!result?.value,
    lastErrorObject: result?.lastErrorObject,
  });

  let doc = result.value;

  // Fallback in case the driver doesn't populate `value` (we've seen this on some deployments)
  if (!doc) {
    console.log("[updateUserProfile] value null, trying explicit findOne...");
    doc = await usersCollection.findOne(query);
    console.log("[updateUserProfile] fallback findOne found doc:", !!doc);
  }

  if (!doc) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  return mapUserDoc(doc);
}


function coerceUserId(userId) {
  // Coerce userId into an ObjectId if it looks like one
  let userIdValue = userId;
  if (typeof userId === "string" && /^[a-fA-F0-9]{24}$/.test(userId)) {
    userIdValue = new ObjectId(userId);
  }
  return userIdValue;
}

function buildTotalsSetObject(patch) {
  // Build a $set object like: { "totals.checkin_mood": 6, ... }
  const setObj = {};

  for (const [k, v] of Object.entries(patch || {})) {
    if (typeof k !== "string" || !k.trim()) continue;

    // Accept numbers or numeric strings; store as number.
    let num = v;
    if (typeof num === "string") {
      const parsed = Number(num);
      num = Number.isFinite(parsed) ? parsed : null;
    }

    if (typeof num !== "number" || !Number.isFinite(num)) continue;

    setObj[`totals.${k}`] = num;
  }

  return setObj;
}

export async function patchUserDailyTotals(db, userId, dateKey, patch, timezone) {
  if (!db) throw new Error("DB not ready");

  if (!userId || typeof userId !== "string") {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  if (!dateKey || typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    const err = new Error("Missing or invalid 'dateKey' (expected YYYY-MM-DD)");
    err.statusCode = 400;
    throw err;
  }

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    const err = new Error("Missing or invalid 'patch' (expected object)");
    err.statusCode = 400;
    throw err;
  }

  const totalsCol = db.collection("user_daily_totals");
  const userIdValue = coerceUserId(userId);

  const setObj = buildTotalsSetObject(patch);
  if (Object.keys(setObj).length === 0) {
    const err = new Error("Patch contained no valid numeric fields");
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();
  setObj.updatedAt = now;

  if (typeof timezone === "string" && timezone.trim()) {
    setObj.timezone = timezone.trim();
  }

  const result = await totalsCol.updateOne(
    { userId: userIdValue, dateKey },
    {
      $set: setObj,
      $setOnInsert: {
        createdAt: now,
        userId: userIdValue,
        dateKey,
      },
    },
    { upsert: true }
  );

  return {
    ok: true,
    dateKey,
    upsertedId: result.upsertedId || null,
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    updatedAt: now,
  };
}

// -------------------------------
// Energy samples (time-series)


function cleanEnergySamples(raw) {
  const arr = Array.isArray(raw) ? raw : [];

  const cleaned = [];
  for (const s of arr) {
    const ts = typeof s?.ts === "number" ? s.ts : Number(s?.ts);
    const lvlRaw = typeof s?.level === "number" ? s.level : Number(s?.level);

    if (!Number.isFinite(ts) || !Number.isFinite(lvlRaw)) continue;

    const level = Math.trunc(lvlRaw);
    if (level < 1 || level > 10) continue;

    cleaned.push({ ts, level });
  }

  // Sort by time
  cleaned.sort((a, b) => a.ts - b.ts);

  // De-dupe by ts (keep last)
  const byTs = new Map();
  for (const s of cleaned) {
    byTs.set(s.ts, s);
  }

  return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
}

export async function storeUserEnergySamples(db, userId, arg2, arg3, arg4) {
  // Support both call styles:
  //  - storeUserEnergySamples(db, userId, { dateKey, timezone, samples })
  //  - storeUserEnergySamples(db, userId, dateKey, samples, timezone)
  let dateKey;
  let timezone;
  let samples;

  if (arg2 && typeof arg2 === "object" && !Array.isArray(arg2)) {
    dateKey = arg2.dateKey;
    timezone = arg2.timezone;
    samples = arg2.samples;
  } else {
    dateKey = arg2;
    samples = arg3;
    timezone = arg4;
  }

  if (!db) throw new Error("DB not ready");

  const cleanedUserId = String(userId || "").trim();
  if (!cleanedUserId || !ObjectId.isValid(cleanedUserId)) {
    const err = new Error("Missing or invalid userId");
    err.statusCode = 400;
    throw err;
  }

  const dk = String(dateKey || "").trim();
  if (!isValidDateKey(dk)) {
    const err = new Error("Missing or invalid dateKey");
    err.statusCode = 400;
    throw err;
  }

  const cleanedSamples = cleanEnergySamples(samples);
  if (!cleanedSamples.length) {
    const err = new Error("No valid energy samples");
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();
  const totalsCol = db.collection("user_daily_totals");
  const userIdValue = new ObjectId(cleanedUserId);

  const tz = typeof timezone === "string" ? timezone.trim() : "";

  // IMPORTANT:
  // We append samples so we don't accidentally drop earlier samples if the client
  // only submits a delta (new samples) during a flush.
  // De-dupe and clamping are handled later by upsertUserEnergySnapshotForDate.
  await totalsCol.updateOne(
    { userId: userIdValue, dateKey: dk },
    {
      $setOnInsert: {
        userId: userIdValue,
        dateKey: dk,
        createdAt: now,
      },
      $set: {
        updatedAt: now,
        ...(tz ? { timezone: tz } : {}),
        "checkin.energy_samples_updated_at": now,
      },
      $push: {
        "checkin.energy_samples": { $each: cleanedSamples },
      },
    },
    { upsert: true }
  );

  return {
    ok: true,
    userId: cleanedUserId,
    dateKey: dk,
    timezone: tz || null,
    appendedCount: cleanedSamples.length,
  };
}

//--------------------------------------------------------------------------------------------------
// Energy snapshots / finalization
//
// Computes a running average from checkin.energy_samples and writes it into totals.
// If `finalize: true`, marks the day as finalized (idempotent).
export async function upsertUserEnergySnapshotForDate(db, userId, dateKey, options = {}) {
  if (!db) throw new Error("DB not ready");

  const cleanedUserId = String(userId || "").trim();
  if (!cleanedUserId) {
    const err = new Error("Missing userId");
    err.statusCode = 400;
    throw err;
  }

  const dk = String(dateKey || "").trim();
  if (!isValidDateKey(dk)) {
    const err = new Error("Missing or invalid dateKey");
    err.statusCode = 400;
    throw err;
  }

  const finalize = options && options.finalize === true;

  const totalsCol = db.collection("user_daily_totals");
  const userIdValue = coerceUserId(cleanedUserId);

  const doc = await totalsCol.findOne({ userId: userIdValue, dateKey: dk });
  const samples = Array.isArray(doc?.checkin?.energy_samples) ? doc.checkin.energy_samples : [];

  if (!samples.length) {
    return { ok: true, updated: false, reason: "no_samples", userId: cleanedUserId, dateKey: dk };
  }

  // Clean and clamp samples defensively
  const cleaned = [];
  for (const s of samples) {
    const ts = typeof s?.ts === "number" ? s.ts : Number(s?.ts);
    const lvl = typeof s?.level === "number" ? s.level : Number(s?.level);
    if (!Number.isFinite(ts) || !Number.isFinite(lvl)) continue;
    const level = Math.max(1, Math.min(10, Math.trunc(lvl)));
    cleaned.push({ ts, level });
  }

  if (!cleaned.length) {
    return { ok: true, updated: false, reason: "no_valid_samples", userId: cleanedUserId, dateKey: dk };
  }

  cleaned.sort((a, b) => a.ts - b.ts);

  // Cap stored samples to avoid unbounded growth (keep most recent N)
  const MAX_SAMPLES = 500;
  const cleanedCapped = cleaned.length > MAX_SAMPLES
    ? cleaned.slice(cleaned.length - MAX_SAMPLES)
    : cleaned;

  const sum = cleanedCapped.reduce((acc, s) => acc + s.level, 0);
  const avg = Math.round((sum / cleanedCapped.length) * 100) / 100;
  const min = cleanedCapped.reduce((acc, s) => Math.min(acc, s.level), cleanedCapped[0].level);
  const max = cleanedCapped.reduce((acc, s) => Math.max(acc, s.level), cleanedCapped[0].level);
  const latest = cleanedCapped[cleanedCapped.length - 1];

  const now = new Date();

  // Idempotent finalization
  if (finalize && doc?.checkin?.energy_finalized_at) {
    return { ok: true, updated: false, reason: "already_finalized", userId: cleanedUserId, dateKey: dk };
  }

  const setPatch = {
    updatedAt: now,

    // Derived checkin fields
    "checkin.energy_avg": avg,
    "checkin.energy_min": min,
    "checkin.energy_max": max,
    "checkin.energy_latest": latest.level,
    "checkin.energy_latest_ts": latest.ts,
    "checkin.energy_sample_count": cleanedCapped.length,
    "checkin.energy_updated_at": now,

    // Store normalized/capped samples array
    "checkin.energy_samples": cleanedCapped,

    // Totals snapshot
    "totals.checkin_energy": avg,
  };

  if (finalize) {
    setPatch["checkin.energy_finalized_at"] = now;
    setPatch["checkin.energy_finalized_version"] = 1;
  }

  await totalsCol.updateOne(
    { userId: userIdValue, dateKey: dk },
    {
      $set: setPatch,
      $setOnInsert: {
        createdAt: now,
        userId: userIdValue,
        dateKey: dk,
      },
    },
    { upsert: true }
  );

  return {
    ok: true,
    updated: true,
    finalize,
    userId: cleanedUserId,
    dateKey: dk,
    avg,
    min,
    max,
    count: cleanedCapped.length,
  };
}
//--------------------------------------------------------------------------------------------------------
// Account recovery helpers (never store plaintext email)

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function requireRecoverySecret() {
  const secret = process.env.RECOVERY_EMAIL_HMAC_SECRET;
  if (!secret || typeof secret !== "string" || !secret.trim()) {
    const err = new Error("Missing server env var RECOVERY_EMAIL_HMAC_SECRET");
    err.statusCode = 500;
    throw err;
  }
  return secret;
}

function hmacEmail(email) {
  const secret = requireRecoverySecret();
  const normalized = normalizeEmail(email);
  return crypto.createHmac("sha256", secret).update(normalized, "utf8").digest("hex");
}

function random6DigitCode() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

function hashCode(code) {
  const secret = requireRecoverySecret();
  return crypto.createHmac("sha256", secret).update(String(code || "").trim(), "utf8").digest("hex");
}

//--------------------------------------------------------------------------------------------------------
// Account recovery endpoints (service layer)

export async function addRecoveryEmail(db, userId, email) {
  if (!db) throw new Error("DB not ready");

  if (!userId || typeof userId !== "string" || !ObjectId.isValid(userId)) {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    const err = new Error("Missing or invalid 'email'");
    err.statusCode = 400;
    throw err;
  }

  const usersCollection = db.collection("users");
  const now = new Date();

  const existingUser = await usersCollection.findOne({ _id: new ObjectId(userId) });
  if (!existingUser) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const recoveryEmailHash = hmacEmail(normalized);
  const sameEmailAsBefore = existingUser.recoveryEmailHash === recoveryEmailHash;
  const wasVerified = existingUser.recoveryEmailVerified === true;

  const code = random6DigitCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes

  const result = await usersCollection.findOneAndUpdate(
    { _id: new ObjectId(userId) },
    {
      $set: {
        recoveryEmailHash,
        recoveryEmailVerified: sameEmailAsBefore && wasVerified ? true : false,
        recoveryEmailAddedAt: sameEmailAsBefore ? (existingUser.recoveryEmailAddedAt ?? now) : now,
        recoveryEmailPendingCodeHash: codeHash,
        recoveryEmailPendingCodeExpiresAt: expiresAt,
        lastSeenAt: now,
      },
    },
    { returnDocument: "after" }
  );

  // TODO: send via email provider (SendGrid/Mailgun/etc).
  // Dev-only:
  console.log(
    "[addRecoveryEmail] userId=",
    userId,
    " emailHash=",
    recoveryEmailHash,
    " code=",
    code,
    " expiresAt=",
    expiresAt.toISOString()
  );

  return mapUserDoc(result.value);
}

export async function verifyRecoveryEmail(db, userId, code) {
  if (!db) throw new Error("DB not ready");

  if (!userId || typeof userId !== "string" || !ObjectId.isValid(userId)) {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  const cleanCode = String(code || "").trim();
  if (!cleanCode) {
    const err = new Error("Missing or invalid 'code'");
    err.statusCode = 400;
    throw err;
  }

  const usersCollection = db.collection("users");
  const now = new Date();

  const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  if (!user.recoveryEmailHash) {
    const err = new Error("No recovery email set for this account");
    err.statusCode = 400;
    throw err;
  }

  const expiresAt = user.recoveryEmailPendingCodeExpiresAt
    ? new Date(user.recoveryEmailPendingCodeExpiresAt)
    : null;

  if (!user.recoveryEmailPendingCodeHash || !expiresAt || now > expiresAt) {
    const err = new Error("Verification code expired or not requested");
    err.statusCode = 400;
    throw err;
  }

  const providedHash = hashCode(cleanCode);
  if (providedHash !== user.recoveryEmailPendingCodeHash) {
    const err = new Error("Invalid verification code");
    err.statusCode = 401;
    throw err;
  }

  const result = await usersCollection.findOneAndUpdate(
    { _id: new ObjectId(userId) },
    {
      $set: {
        recoveryEmailVerified: true,
        recoveryEmailLastVerifiedAt: now,
        lastSeenAt: now,
      },
      $unset: {
        recoveryEmailPendingCodeHash: "",
        recoveryEmailPendingCodeExpiresAt: "",
      },
    },
    { returnDocument: "after" }
  );

  return mapUserDoc(result.value);
}

export async function recoverAccount(db, email, code, newDeviceId) {
  if (!db) throw new Error("DB not ready");

  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    const err = new Error("Missing or invalid 'email'");
    err.statusCode = 400;
    throw err;
  }

  const cleanCode = String(code || "").trim();
  if (!cleanCode) {
    const err = new Error("Missing or invalid 'code'");
    err.statusCode = 400;
    throw err;
  }

  const usersCollection = db.collection("users");
  const now = new Date();

  const emailHash = hmacEmail(normalized);
  const user = await usersCollection.findOne({
    recoveryEmailHash: emailHash,
    recoveryEmailVerified: true,
  });

  if (!user) {
    const err = new Error("Account not found or recovery email not verified");
    err.statusCode = 404;
    throw err;
  }

  const expiresAt = user.recoveryEmailPendingCodeExpiresAt
    ? new Date(user.recoveryEmailPendingCodeExpiresAt)
    : null;

  if (!user.recoveryEmailPendingCodeHash || !expiresAt || now > expiresAt) {
    const err = new Error("Recovery code expired or not requested");
    err.statusCode = 400;
    throw err;
  }

  const providedHash = hashCode(cleanCode);
  if (providedHash !== user.recoveryEmailPendingCodeHash) {
    const err = new Error("Invalid recovery code");
    err.statusCode = 401;
    throw err;
  }

  const setObj = {
    lastSeenAt: now,
  };

  if (typeof newDeviceId === "string" && newDeviceId.trim()) {
    setObj.deviceId = newDeviceId.trim();
  }

  const result = await usersCollection.findOneAndUpdate(
    { _id: user._id },
    {
      $set: setObj,
      $unset: {
        recoveryEmailPendingCodeHash: "",
        recoveryEmailPendingCodeExpiresAt: "",
      },
    },
    { returnDocument: "after" }
  );

  return mapUserDoc(result.value);
}

// --- DateKey helpers (UTC-safe) ---
export function isValidDateKey(dateKey) {
  return typeof dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
}

export function dateFromDateKeyUTC(dateKey) {
  // dateKey is YYYY-MM-DD
  const [y, m, d] = dateKey.split("-").map((v) => parseInt(v, 10));
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function dateKeyFromDateUTC(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDaysDateKeyUTC(dateKey, days) {
  const dt = dateFromDateKeyUTC(dateKey);
  dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
  return dateKeyFromDateUTC(dt);
}

// --- Logical day helpers (local timezone with cutoff hour) ---
// A "logical day" is defined as [cutoffHour..cutoffHour) in the user's timezone.
// Example (cutoffHour=3): 1:30am Jan 15 local → counts toward Jan 14.
export function safeTimeZone(tz) {
  const s = typeof tz === "string" ? tz.trim() : "";
  return s.length > 0 ? s : null;
}

export function dateKeyFromInstantInTimeZone(dt, timeZone) {
  // dt is a Date representing an instant.
  // Return YYYY-MM-DD in the provided IANA timezone.
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const parts = fmt.formatToParts(dt);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;

    const s = fmt.format(dt);
    if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch {
    // ignore
  }

  // Fallback: UTC dateKey
  return dateKeyFromDateUTC(dt);
}

export function computeLogicalDateKeyFromLoggedAt(loggedAt, timezone, cutoffHour = 3) {
  // loggedAt can be ISO string, number (ms), or Date.
  let dt;
  if (loggedAt instanceof Date) dt = loggedAt;
  else if (typeof loggedAt === "number" && Number.isFinite(loggedAt)) dt = new Date(loggedAt);
  else dt = new Date(String(loggedAt || ""));

  if (!dt || Number.isNaN(dt.getTime())) {
    dt = new Date();
  }

  const tz = safeTimeZone(timezone);

  // Shift the instant backwards by cutoffHour so that the dateKey boundary becomes cutoffHour.
  const shifted = new Date(dt.getTime() - (Number(cutoffHour) || 0) * 60 * 60 * 1000);

  return tz ? dateKeyFromInstantInTimeZone(shifted, tz) : dateKeyFromDateUTC(shifted);
}

export async function getFavoritesForRequest(db, req) {
  try {
    if (!db) return { favoriteFoodIds: [], favoriteDocs: [], favoriteMeta: {} };

    const deviceId = String(
      req?.headers?.["x-device-id"] || req?.headers?.["X-Device-Id"] || ""
    ).trim();

    if (!deviceId) return { favoriteFoodIds: [], favoriteDocs: [], favoriteMeta: {} };

    const userId = await findUserIdByDeviceId(db, deviceId);
    if (!userId) return { favoriteFoodIds: [], favoriteDocs: [], favoriteMeta: {} };

    // Fetch favorites directly from users collection instead of getUserFavoritesByUserId
    const usersCol = db.collection("users");

    // Support legacy users where _id may be stored as a string.
    let query;
    if (ObjectId.isValid(userId)) {
      query = { $or: [{ _id: new ObjectId(userId) }, { _id: userId }] };
    } else {
      query = { _id: userId };
    }

    const userDoc = await usersCol.findOne(
      query,
      { projection: { favorites: 1 } }
    );

    const favorites = Array.isArray(userDoc?.favorites) ? userDoc.favorites : [];

    const favoriteFoodIds = favorites
      .map((f) => f.foodIdString || (f?.foodId ? String(f.foodId) : null))
      .filter(Boolean);

    // Build a simple id -> addedAt(ms) map for recency tie-breaking
    const favoriteMeta = {};
    for (const f of favorites) {
      const id = f?.foodIdString || (f?.foodId ? String(f.foodId) : null);
      if (!id) continue;
      const ts = f?.addedAt ? new Date(f.addedAt).getTime() : null;
      if (ts) favoriteMeta[id] = ts;
    }

    return {
      favoriteFoodIds,
      favoriteDocs: favorites,
      favoriteMeta,
    };
  } catch (err) {
    console.error("[MealSearch] Failed to load favorites for request:", err);
    return { favoriteFoodIds: [], favoriteDocs: [], favoriteMeta: {} };
  }
}
//--------------------------------------------------------------------------------------------------------
// Daily Goals (server-side targets)

const DAILY_GOALS_PROFILE_KEY = "dri_v1";
const DAILY_GOALS_VERSION = 1;

// Whitelist keys we allow clients to set. Keep this aligned with iOS NutrientTargetsView
// AND with canonical keys stored in user_daily_totals.totals.
// NOTE: We intentionally prefer the canonical *_g/_mg/_ug/_kcal keys used in totals.
// We also allow a small set of legacy/alias keys that exist on iOS so PATCH calls don't 400.
const ALLOWED_DAILY_GOAL_KEYS = new Set([
  // -----------------
  // Energy
  // -----------------
  "energy_kcal",
  "energy_kj",

  // -----------------
  // Macros
  // -----------------
  "protein_g",
  "protein", // iOS alias

  "carbs_g",
  "carbohydrate", // iOS alias

  "fiber_g",
  "sugars_g",
  "fat_g",
  "starch_g",
  "added_sugars_g",
  "sugar_alcohol_g",

  // Individual sugars / sugar alcohols (present in totals)
  "sucrose_g",
  "glucose_g",
  "fructose_g",
  "lactose_g",
  "maltose_g",
  "galactose_g",
  "sorbitol_g",
  "mannitol_g",
  "xylitol_g",
  "erythritol_g",
  "maltitol_g",
  "lactitol_g",

  // -----------------
  // Fats
  // -----------------
  "sat_fat_g",
  "trans_fat_g",
  "mono_fat_g",
  "poly_fat_g",

  // Saturated fatty acid breakdown
  "sfa_4_0_g",
  "sfa_6_0_g",
  "sfa_8_0_g",
  "sfa_10_0_g",
  "sfa_12_0_g",
  "sfa_14_0_g",
  "sfa_16_0_g",
  "sfa_18_0_g",

  // MUFA breakdown
  "mufa_16_1_g",
  "mufa_18_1_g",
  "mufa_20_1_g",
  "mufa_22_1_g",

  // PUFA breakdown
  "pufa_18_2_g",
  "pufa_18_3_g",
  "pufa_18_4_g",
  "pufa_20_4_g",
  "epa_g",
  "dha_g",
  "dpa_g",

  // -----------------
  // Amino acids (present in totals)
  // -----------------
  "tryptophan_g",
  "threonine_g",
  "isoleucine_g",
  "leucine_g",
  "lysine_g",
  "methionine_g",
  "cystine_g",
  "phenylalanine_g",
  "tyrosine_g",
  "valine_g",
  "arginine_g",
  "histidine_g",
  "alanine_g",
  "aspartic_acid_g",
  "glutamic_acid_g",
  "glycine_g",
  "proline_g",
  "serine_g",

  // Optional iOS aliases (if ever used by UI)
  "tryptophan",
  "threonine",
  "isoleucine",
  "leucine",
  "lysine",
  "methionine",
  "cystine",
  "phenylalanine",
  "tyrosine",
  "valine",
  "arginine",
  "histidine",
  "alanine",
  "aspartic_acid",
  "glutamic_acid",
  "glycine",
  "proline",
  "serine",

  // -----------------
  // Vitamins (present in totals)
  // -----------------
  "vitamin_c_mg",
  "vitamin_b1_mg",
  "vitamin_b2_mg",
  "vitamin_b3_mg",
  "vitamin_b5_mg",
  "vitamin_b6_mg",
  "vitamin_b7_ug",
  "folate_total_ug",
  "folate_dfe_ug",
  "folate_food_ug",
  "folic_acid_ug",
  "vitamin_b12_ug",
  "vitamin_k_ug",
  "vitamin_e_mg",
  "vitamin_a_rae_ug",
  "retinol_ug",
  "vitamin_d_ug",

  // Carotenoids / related (present in totals)
  "carotene_beta_ug",
  "carotene_alpha_ug",
  "cryptoxanthin_beta_ug",
  "lycopene_ug",
  "lutein_zeaxanthin_ug",

  // -----------------
  // Minerals (present in totals)
  // -----------------
  "sodium_mg",
  "potassium_mg",
  "calcium_mg",
  "iron_mg",
  "magnesium_mg",
  "phosphorus_mg",
  "zinc_mg",
  "copper_mg",
  "selenium_ug",
  "manganese_mg",
  "iodine_ug",
  "chromium_ug",
  "fluoride_ug",

  // -----------------
  // Other compounds (present in totals)
  // -----------------
  "caffeine_mg",
  "theobromine_mg",
  "betaine_mg",
  "alcohol_g",
  "cholesterol_mg",
  "choline_mg",
  "water_from_food_ml",
  "water_from_drinks_ml",
  "water_total_ml",
]);

// Simple per-key guardrails to prevent obvious mistakes.
// This is not medical logic; it's just sanity bounds.
const DAILY_GOAL_BOUNDS = {
  energy_kcal: { min: 500, max: 6000 },
  energy_kj: { min: 2000, max: 25000 },
  protein_g: { min: 0, max: 400 },
  carbs_g: { min: 0, max: 800 },
  fiber_g: { min: 0, max: 200 },
  sugars_g: { min: 0, max: 500 },
  fat_g: { min: 0, max: 400 },
  sat_fat_g: { min: 0, max: 150 },
  trans_fat_g: { min: 0, max: 50 },
  sodium_mg: { min: 0, max: 15000 },
  potassium_mg: { min: 0, max: 15000 },
  calcium_mg: { min: 0, max: 5000 },
  magnesium_mg: { min: 0, max: 2000 },
  iron_mg: { min: 0, max: 200 },
  zinc_mg: { min: 0, max: 200 },
  vitamin_d_ug: { min: 0, max: 250 },
  vitamin_c_mg: { min: 0, max: 5000 },
  caffeine_mg: { min: 0, max: 2000 },
  water_g: { min: 0, max: 10000 },
  // Hydration (ml in totals)
  water_from_food_ml: { min: 0, max: 20000 },
  water_from_drinks_ml: { min: 0, max: 20000 },
  water_total_ml: { min: 0, max: 25000 },
};

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function validateDailyGoalUpdate(key, value) {
  if (!ALLOWED_DAILY_GOAL_KEYS.has(key)) {
    const err = new Error(`Unsupported daily goal key: ${key}`);
    err.statusCode = 400;
    throw err;
  }

  const n = toFiniteNumber(value);
  if (n === null) {
    const err = new Error(`Invalid daily goal value for ${key}`);
    err.statusCode = 400;
    throw err;
  }

  // Disallow negative values universally.
  if (n < 0) {
    const err = new Error(`Daily goal value must be >= 0 for ${key}`);
    err.statusCode = 400;
    throw err;
  }

  const bounds = DAILY_GOAL_BOUNDS[key];
  if (bounds) {
    if (n < bounds.min || n > bounds.max) {
      const err = new Error(`Daily goal value out of range for ${key}`);
      err.statusCode = 400;
      throw err;
    }
  }

  return n;
}

function defaultUnitForKey(key) {
  if (key.endsWith("_kcal")) return "kcal";
  if (key.endsWith("_kj")) return "kJ";
  if (key.endsWith("_mg")) return "mg";
  if (key.endsWith("_ug")) return "µg";
  if (key.endsWith("_ml")) return "ml";
  if (key.endsWith("_min")) return "min";
  if (key.endsWith("_pct")) return "%";
  if (key.endsWith("_s")) return "s";
  if (key.endsWith("_g")) return "g";
  // fallback
  return null;
}

function buildDefaultDailyGoalsFromProfile({ age, gender }) {
  // Keep this intentionally simple to start. We can expand bands later.
  const sex = inferSexFromGender(gender);
  const ageYears = typeof age === "number" && Number.isFinite(age) ? age : null;

  // Baseline energy: generic 2000 kcal unless we choose to special-case later.
  // Protein: keep a basic male/female adult split for now when possible.
  const isAdult = ageYears !== null ? ageYears >= 19 : true;

  const goals = {};

  goals.energy_kcal = { value: 2000, unit: "kcal" };
  goals.energy_kj = { value: 8400, unit: "kJ" };

  // Hydration baseline (canonical totals key)
  goals.water_total_ml = { value: 2000, unit: "ml" };

  if (isAdult && sex === "male") {
    goals.protein_g = { value: 56, unit: "g" };
  } else if (isAdult && sex === "female") {
    goals.protein_g = { value: 46, unit: "g" };
  } else {
    goals.protein_g = { value: 50, unit: "g" };
  }

  // DRI-ish macro baselines
  goals.carbs_g = { value: 130, unit: "g" };
  goals.fiber_g = { value: 28, unit: "g" };
  goals.sugars_g = { value: 50, unit: "g" };
  goals.fat_g = { value: 65, unit: "g" };
  goals.sat_fat_g = { value: 22, unit: "g" };
  goals.trans_fat_g = { value: 0, unit: "g" };

  // Common minerals/vitamins that are high-signal for your roundup
  goals.sodium_mg = { value: 2300, unit: "mg" };
  goals.potassium_mg = { value: 3400, unit: "mg" };
  goals.calcium_mg = { value: 1000, unit: "mg" };
  goals.magnesium_mg = { value: 400, unit: "mg" };
  goals.iron_mg = { value: sex === "female" ? 18 : 8, unit: "mg" };
  goals.zinc_mg = { value: sex === "female" ? 8 : 11, unit: "mg" };
  goals.vitamin_d_ug = { value: 15, unit: "µg" };
  goals.vitamin_c_mg = { value: sex === "female" ? 75 : 90, unit: "mg" };

  return {
    version: DAILY_GOALS_VERSION,
    profileKey: DAILY_GOALS_PROFILE_KEY,
    source: "default",
    updatedAt: new Date(),
    goals,
  };
}

function mergeDailyGoals(defaultDailyGoals, storedDailyGoals) {
  const base = defaultDailyGoals && typeof defaultDailyGoals === "object" ? defaultDailyGoals : null;
  const stored = storedDailyGoals && typeof storedDailyGoals === "object" ? storedDailyGoals : null;

  const baseGoals = base && base.goals && typeof base.goals === "object" ? base.goals : {};
  const overrideGoals = stored && stored.goals && typeof stored.goals === "object" ? stored.goals : {};

  // Shallow merge is correct here because each goal is { value, unit }
  const effectiveGoals = { ...baseGoals, ...overrideGoals };

  return {
    version: typeof stored?.version === "number" ? stored.version : (typeof base?.version === "number" ? base.version : DAILY_GOALS_VERSION),
    profileKey: typeof stored?.profileKey === "string" ? stored.profileKey : (typeof base?.profileKey === "string" ? base.profileKey : DAILY_GOALS_PROFILE_KEY),
    source: stored?.source ?? base?.source ?? "default",
    updatedAt: stored?.updatedAt ?? base?.updatedAt ?? new Date(),
    goals: effectiveGoals,
  };
}

export async function getUserDailyGoals(db, userId) {
  if (!db) throw new Error("DB not ready");

  const cleanUserId = String(userId || "").trim();
  const userQuery = buildUserIdQuery(cleanUserId);
  if (!userQuery) {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  const usersCollection = db.collection("users");
  const user = await usersCollection.findOne(userQuery, { projection: { dailyGoals: 1, age: 1, gender: 1 } });

  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const defaults = buildDefaultDailyGoalsFromProfile({ age: user.age, gender: user.gender });
  const effective = mergeDailyGoals(defaults, user.dailyGoals);

  return {
    ok: true,
    userId: cleanUserId,
    // What is physically stored on the user document (overrides only in the new approach)
    dailyGoals: user.dailyGoals ?? null,
    // What clients + analysis should use (defaults merged with overrides)
    effectiveDailyGoals: effective,
  };
}

export async function seedUserDailyGoals(db, userId, options = {}) {
  if (!db) throw new Error("DB not ready");

  const cleanUserId = String(userId || "").trim();
  const userQuery = buildUserIdQuery(cleanUserId);
  if (!userQuery) {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  const force = options && options.force === true;

  const usersCollection = db.collection("users");

  const user = await usersCollection.findOne(userQuery, {
    projection: { dailyGoals: 1, age: 1, gender: 1 },
  });

  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  if (!force && user.dailyGoals && user.dailyGoals.goals) {
    const defaults = buildDefaultDailyGoalsFromProfile({ age: user.age, gender: user.gender });
    const effective = mergeDailyGoals(defaults, user.dailyGoals);

    return {
      ok: true,
      userId: cleanUserId,
      dailyGoals: user.dailyGoals,
      effectiveDailyGoals: effective,
      seeded: false,
      reason: "already_exists",
    };
  }

  // Overrides-only: store an empty goals map. Defaults are computed on demand.
  const now = new Date();
  const dailyGoals = {
    version: DAILY_GOALS_VERSION,
    profileKey: DAILY_GOALS_PROFILE_KEY,
    source: "default",
    updatedAt: now,
    goals: {},
  };

  const result = await usersCollection.findOneAndUpdate(
    userQuery,
    {
      $set: {
        dailyGoals,
        lastSeenAt: now,
      },
    },
    { returnDocument: "after", returnOriginal: false }
  );

  const defaults = buildDefaultDailyGoalsFromProfile({ age: user.age, gender: user.gender });
  const effective = mergeDailyGoals(defaults, result?.value?.dailyGoals ?? dailyGoals);

  return {
    ok: true,
    userId: cleanUserId,
    dailyGoals: result?.value?.dailyGoals ?? dailyGoals,
    effectiveDailyGoals: effective ?? mergeDailyGoals(defaults, result?.value?.dailyGoals ?? dailyGoals),
    seeded: true,
  };
}

export async function patchUserDailyGoals(db, userId, updates, options = {}) {
  if (!db) throw new Error("DB not ready");

  const cleanUserId = String(userId || "").trim();
  const userQuery = buildUserIdQuery(cleanUserId);
  if (!userQuery) {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    const err = new Error("Missing or invalid 'updates' (expected object)");
    err.statusCode = 400;
    throw err;
  }

  // Build validated patch for nested fields: dailyGoals.goals.<key> = { value, unit }
  const setObj = {};
  const applied = [];

  for (const [k, v] of Object.entries(updates)) {
    const key = String(k || "").trim();
    if (!key) continue;

    const n = validateDailyGoalUpdate(key, v);
    const unit = defaultUnitForKey(key);

    setObj[`dailyGoals.goals.${key}`] = { value: n, unit };
    applied.push(key);
  }

  if (!applied.length) {
    const err = new Error("No valid daily goal updates provided");
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();
  setObj["dailyGoals.updatedAt"] = now;
  setObj["dailyGoals.profileKey"] = typeof options.profileKey === "string" ? options.profileKey : DAILY_GOALS_PROFILE_KEY;
  setObj["dailyGoals.version"] = (typeof options.version === "number" && Number.isFinite(options.version)) ? options.version : DAILY_GOALS_VERSION;
  setObj["dailyGoals.source"] = "user";
  setObj["lastSeenAt"] = now;

  const usersCollection = db.collection("users");
  const updateDoc = {
    $set: setObj,
    $setOnInsert: {
      dailyGoals: {
        version: DAILY_GOALS_VERSION,
        profileKey: DAILY_GOALS_PROFILE_KEY,
        source: "user",
        updatedAt: now,
        goals: {},
      },
      createdAt: now,
    },
  };

  const result = await usersCollection.findOneAndUpdate(
    userQuery,
    updateDoc,
    { returnDocument: "after", returnOriginal: false }
  );

  const doc = result?.value;
  if (!doc) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  // Compute effective goals for client convenience (defaults merged with overrides)
  const fullUser = await usersCollection.findOne(userQuery, { projection: { dailyGoals: 1, age: 1, gender: 1 } });
  const defaults = buildDefaultDailyGoalsFromProfile({ age: fullUser?.age, gender: fullUser?.gender });
  const effective = mergeDailyGoals(defaults, fullUser?.dailyGoals ?? doc.dailyGoals);

  return {
    ok: true,
    userId: cleanUserId,
    updatedKeys: applied,
    dailyGoals: doc.dailyGoals ?? null,
    effectiveDailyGoals: effective,
  };
}
