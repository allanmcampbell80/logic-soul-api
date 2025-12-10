
// services/mongo.js
import { MongoClient } from "mongodb";

// Connection string from environment variable
const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("Missing MONGODB_URI in environment");
}

// Create a single Mongo client for the entire app
const client = new MongoClient(uri, {
  maxPoolSize: 20, // future scale optimization
});

// Global reference to db
let db;

// Initialize and export collections
async function initMongo() {
  if (!db) {
    await client.connect();
    db = client.db(process.env.MONGODB_DB || "logic_soul");
    console.log("[Mongo] Connected to database:", db.databaseName);
  }
  return db;
}

// Collections your app will use
let usersCollection;
let userMealsCollection;
let foodItemsCollection;

// Call init immediately so collections are ready
const ready = initMongo().then((db) => {
  usersCollection = db.collection("users");
  userMealsCollection = db.collection("user_meals");
  foodItemsCollection = db.collection("food_items");
});

export {
  ready,
  usersCollection,
  userMealsCollection,
  foodItemsCollection,
};
