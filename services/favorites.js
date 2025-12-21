// services/favorites.js
//
// Shape:
// favorites: [
//   {
//     foodId: ObjectId,
//     commonName: string | null,
//     brandName: string | null,
//     addedAt: Date
//   }
// ]

import { ObjectId } from "mongodb";

function toObjectId(id, fieldName = "id") {
  if (!id) throw new Error(`${fieldName} is required`);
  if (id instanceof ObjectId) return id;
  if (!ObjectId.isValid(String(id))) throw new Error(`${fieldName} is not a valid ObjectId`);
  return new ObjectId(String(id));
}

function normalizeString(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

export async function getUserFavoritesByDeviceId(db, deviceId) {
  if (!deviceId) throw new Error("deviceId is required");

  const user = await db.collection("users").findOne(
    { deviceId },
    { projection: { _id: 1, deviceId: 1, favorites: 1 } }
  );

  if (!user) {
    return { userId: null, deviceId, favorites: [] };
  }

  const favorites = Array.isArray(user.favorites) ? user.favorites : [];

  return {
    userId: user._id,
    deviceId: user.deviceId,
    favorites: favorites.map((f) => ({
      foodId: f.foodId,
      foodIdString: f.foodId ? String(f.foodId) : null,
      commonName: f.commonName ?? null,
      brandName: f.brandName ?? null,
      addedAt: f.addedAt ?? null,
    })),
  };
}

export async function addUserFavoriteByDeviceId(db, { deviceId, foodId, commonName, brandName }) {
  if (!deviceId) throw new Error("deviceId is required");
  const foodObjectId = toObjectId(foodId, "foodId");

  const favoriteDoc = {
    foodId: foodObjectId,
    commonName: normalizeString(commonName),
    brandName: normalizeString(brandName),
    addedAt: new Date(),
  };

  // Ensure the user exists and get the user's _id in one round trip.
  const ensureUserRes = await db.collection("users").findOneAndUpdate(
    { deviceId },
    {
      $setOnInsert: {
        deviceId,
        createdAt: new Date(),
      },
      $set: {
        lastSeenAt: new Date(),
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      projection: { _id: 1, deviceId: 1 },
    }
  );

  const userId = ensureUserRes?.value?._id || null;
  if (!userId) throw new Error("Failed to resolve userId for deviceId");

  // Atomic de-dupe + append using a pipeline update (avoids $pull+$push path conflicts).
  await db.collection("users").updateOne(
    { _id: userId },
    [
      {
        $set: {
          favorites: {
            $let: {
              vars: {
                existing: { $ifNull: ["$favorites", []] },
              },
              in: {
                $concatArrays: [
                  {
                    $filter: {
                      input: "$$existing",
                      as: "f",
                      cond: { $ne: ["$$f.foodId", foodObjectId] },
                    },
                  },
                  [favoriteDoc],
                ],
              },
            },
          },
          lastSeenAt: new Date(),
        },
      },
    ]
  );

  return {
    ok: true,
    deviceId,
    userId,
    favorite: {
      ...favoriteDoc,
      foodIdString: String(foodObjectId),
    },
  };
}

export async function deleteUserFavoriteByDeviceId(db, { deviceId, foodId }) {
  if (!deviceId) throw new Error("deviceId is required");
  const foodObjectId = toObjectId(foodId, "foodId");

  const res = await db.collection("users").updateOne(
    { deviceId },
    {
      $pull: { favorites: { foodId: foodObjectId } },
      $set: { lastSeenAt: new Date() },
    }
  );

  return {
    ok: true,
    deviceId,
    foodIdString: String(foodObjectId),
    modifiedCount: res.modifiedCount,
  };
}
