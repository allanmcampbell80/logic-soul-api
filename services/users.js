// services/users.js
import { ObjectId } from "mongodb";

function mapUserDoc(user) {
  if (!user) return null;
  return {
    // Expose the stable public id as the deviceId, not Mongo's _id
    id: user.deviceId,
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
    fingerScalePoints: user.fingerScalePoints ?? null,
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

  console.log("[updateUserProfile] incoming userId (deviceId):", userId);
  console.log("[updateUserProfile] incoming profile:", profile);

  const { displayName, gender, age, heightCm, weightKg, fingerScalePoints } = profile || {};

  if (!userId || typeof userId !== "string") {
    const err = new Error("Missing or invalid 'userId'");
    err.statusCode = 400;
    throw err;
  }

  const usersCollection = db.collection("users");
  const now = new Date();

  // We now treat userId as deviceId, on purpose.
  const query = { deviceId: userId };

  const updateDoc = {
    $set: {
      displayName: displayName ?? null,
      gender: gender ?? null,
      age: typeof age === "number" ? age : null,
      heightCm: typeof heightCm === "number" ? heightCm : null,
      weightKg: typeof weightKg === "number" ? weightKg : null,
      fingerScalePoints: typeof fingerScalePoints === "number" ? fingerScalePoints : null,
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
