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

  // user_daily_totals: usually ObjectId now, but delete both for safety
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

  let query;
  if (ObjectId.isValid(cleanUserId)) {
    query = { $or: [{ _id: new ObjectId(cleanUserId) }, { _id: cleanUserId }] };
  } else {
    query = { _id: cleanUserId };
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

function isValidDateKey(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

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
