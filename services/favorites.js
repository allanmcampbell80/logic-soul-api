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

export async function getUserFavoritesByUserId(db, userId) {
  const userObjectId = toObjectId(userId, "userId");

  const user = await db.collection("users").findOne(
    { _id: userObjectId },
    { projection: { _id: 1, favorites: 1 } }
  );

  if (!user) {
    return { userId: String(userObjectId), favorites: [] };
  }

  const favorites = Array.isArray(user.favorites) ? user.favorites : [];

  return {
    userId: String(user._id),
    favorites: favorites.map((f) => ({
      foodId: f.foodId,
      foodIdString: f.foodId ? String(f.foodId) : null,
      commonName: f.commonName ?? null,
      brandName: f.brandName ?? null,
      addedAt: f.addedAt ?? null,
    })),
  };
}

export async function addUserFavoriteByUserId(db, { userId, foodId, commonName, brandName }) {
  const userObjectId = toObjectId(userId, "userId");
  const foodObjectId = toObjectId(foodId, "foodId");

  const favoriteDoc = {
    foodId: foodObjectId,
    commonName: normalizeString(commonName),
    brandName: normalizeString(brandName),
    addedAt: new Date(),
  };

  // Atomic de-dupe + append using a pipeline update (avoids $pull+$push path conflicts).
  const res = await db.collection("users").updateOne(
    { _id: userObjectId },
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

  if (!res.matchedCount) {
    throw new Error("User not found for userId");
  }

  return {
    ok: true,
    userId: String(userObjectId),
    favorite: {
      ...favoriteDoc,
      foodIdString: String(foodObjectId),
    },
  };
}

export async function deleteUserFavoriteByUserId(db, { userId, foodId }) {
  const userObjectId = toObjectId(userId, "userId");
  const foodObjectId = toObjectId(foodId, "foodId");

  const res = await db.collection("users").updateOne(
    { _id: userObjectId },
    {
      $pull: { favorites: { foodId: foodObjectId } },
      $set: { lastSeenAt: new Date() },
    }
  );

  if (!res.matchedCount) {
    throw new Error("User not found for userId");
  }

  return {
    ok: true,
    userId: String(userObjectId),
    foodIdString: String(foodObjectId),
    modifiedCount: res.modifiedCount,
  };
}
