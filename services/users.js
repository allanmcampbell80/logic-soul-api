// services/users.js
import { ObjectId } from "mongodb";

function mapUserDoc(user) {
  if (!user) return null;
  return {
    id: user._id.toString(),
    deviceId: user.deviceId,
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

export async function updateUserProfile(db, userId, profile) {
  if (!db) throw new Error("DB not ready");

  console.log("[updateUserProfile] incoming userId:", userId);
  console.log("[updateUserProfile] incoming profile:", profile);

  const { displayName, gender, age, heightCm, weightKg } = profile || {};

  if (!userId || typeof userId !== "string") {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  const usersCollection = db.collection("users");
  const now = new Date();

  // Build a robust query that can match:
  //  1. _id as ObjectId
  //  2. _id as string
  //  3. deviceId equal to this id (extra safety)
  const orClauses = [
    { deviceId: userId },        // if we ever pass deviceId directly
    { _id: userId },             // legacy string _id, if it exists
  ];

  if (ObjectId.isValid(userId)) {
    orClauses.unshift({ _id: new ObjectId(userId) }); // preferred match
  }

  const query = orClauses.length === 1 ? orClauses[0] : { $or: orClauses };

  const updateDoc = {
    $set: {
      displayName: displayName ?? null,
      gender: gender ?? null,
      age: typeof age === "number" ? age : null,
      heightCm: typeof heightCm === "number" ? heightCm : null,
      weightKg: typeof weightKg === "number" ? weightKg : null,
      lastSeenAt: now,
    },
  };

  const result = await usersCollection.findOneAndUpdate(
    query,
    updateDoc,
    { returnDocument: "after" }
  );

  console.log("[updateUserProfile] findOneAndUpdate result:", {
    hasValue: !!result?.value,
    lastErrorObject: result?.lastErrorObject,
  });

  if (!result.value) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  return mapUserDoc(result.value);
}
