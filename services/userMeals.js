// services/userMeals.js
import { ObjectId } from "mongodb";
import { usersCollection, userMealsCollection } from "./mongo.js";

// userMealsCollection should be initialized in mongo.js like:
// export const userMealsCollection = db.collection("user_meals");

export async function logUserMeal(userId, payload) {
  if (!ObjectId.isValid(userId)) {
    const err = new Error("Invalid userId");
    err.statusCode = 400;
    throw err;
  }

  const userObjectId = new ObjectId(userId);

  // Make sure user exists
  const user = await usersCollection.findOne({ _id: userObjectId });
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const now = new Date();

  const {
    loggedAt,        // optional ISO string or omitted = now
    timezone,        // e.g. "America/Toronto"
    description,     // free-text like "steak, cauliflower mash..."
    items            // array of meal items
  } = payload;

  const loggedAtDate = loggedAt ? new Date(loggedAt) : now;
  const dateKey = (payload.dateKey) || loggedAtDate.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const safeItems = Array.isArray(items) ? items.map((it) => ({
    name: it.name,
    foodId: it.foodId ? new ObjectId(it.foodId) : null,
    quantity: it.quantity,              // e.g. 120
    quantityUnit: it.quantityUnit || "g",
    confidence: typeof it.confidence === "number" ? it.confidence : null
  })) : [];

  const doc = {
    userId: userObjectId,
    loggedAt: loggedAtDate,
    dateKey,
    timezone: timezone || "UTC",
    description: description || null,
    items: safeItems,
    createdAt: now,
    updatedAt: now
  };

  const result = await userMealsCollection.insertOne(doc);

  // Shape a small response back to the app
  return {
    id: result.insertedId.toString(),
    userId: userId,
    loggedAt: loggedAtDate.toISOString(),
    dateKey,
    timezone: doc.timezone,
    description: doc.description,
    items: safeItems.map((it) => ({
      name: it.name,
      foodId: it.foodId ? it.foodId.toString() : null,
      quantity: it.quantity,
      quantityUnit: it.quantityUnit,
      confidence: it.confidence
    }))
  };
}
