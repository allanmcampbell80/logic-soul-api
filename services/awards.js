/**
 * services/Awards.js
 *
 * Stored on the `users` document:
 *
 *   awards: [
 *     { key, title, subtitle?, earnedAt, icon? }
 *   ]
 *
 *   awardTallies: {
 *     mealsLogged: 0,
 *     barcodesScanned: 0,
 *     happyDays: 0,
 *     ...
 *   }
 *
 * Routes should stay thin; this module owns award logic.
 */

import { ObjectId } from "mongodb";

// -----------------------------
// Award rules (start small)
// -----------------------------

// Add/adjust these as features come online.
// Each eventKey can have multiple thresholds.
const AWARD_RULES = {
  mealsLogged: [
    {
      threshold: 1,
      award: {
        key: "first_meal_logged",
        title: "First Meal Logged",
        subtitle: "Nice start — keep it going.",
        icon: "trophy.fill",
      },
    },
    {
      threshold: 10,
      award: {
        key: "ten_meals_logged",
        title: "10 Meals Logged",
        subtitle: "Consistency is building.",
        icon: "trophy.fill",
      },
    },
  ],

  barcodesScanned: [
    {
      threshold: 1,
      award: {
        key: "first_barcode_scanned",
        title: "First Barcode Scanned",
        subtitle: "You just started building your database.",
        icon: "barcode.viewfinder",
      },
    },
    {
      threshold: 25,
      award: {
        key: "twentyfive_barcodes_scanned",
        title: "25 Barcodes Scanned",
        subtitle: "Your food library is growing fast.",
        icon: "barcode.viewfinder",
      },
    },
  ],

  happyDays: [
    {
      threshold: 1,
      award: {
        key: "first_happy_day",
        title: "First Happy Day",
        subtitle: "Log the good days — they matter.",
        icon: "face.smiling",
      },
    },
    {
      threshold: 7,
      award: {
        key: "seven_happy_days",
        title: "7 Happy Days",
        subtitle: "A solid streak of better days.",
        icon: "face.smiling",
      },
    },
  ],
};

// -----------------------------
// Helpers
// -----------------------------

function normalizeAward(award) {
  if (!award || typeof award !== "object") {
    throw new Error("Award payload must be an object");
  }

  const key = String(award.key || "").trim();
  if (!key) throw new Error("Award 'key' is required");

  const title = String(award.title || "").trim();
  if (!title) throw new Error("Award 'title' is required");

  const subtitle = award.subtitle == null ? undefined : String(award.subtitle).trim();
  const icon = award.icon == null ? undefined : String(award.icon).trim();

  // Accept Date, ISO string, or omit.
  let earnedAt = award.earnedAt;
  if (earnedAt == null || earnedAt === "") {
    earnedAt = new Date();
  } else if (earnedAt instanceof Date) {
    // ok
  } else {
    const parsed = new Date(earnedAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Award 'earnedAt' must be a Date or ISO date string");
    }
    earnedAt = parsed;
  }

  const normalized = { key, title, earnedAt };
  if (subtitle) normalized.subtitle = subtitle;
  if (icon) normalized.icon = icon;

  return normalized;
}

function buildUserFilter({ userId, deviceId }) {
  const userIdRaw = String(userId || "").trim();
  const deviceIdRaw = String(deviceId || "").trim();

  if (userIdRaw && ObjectId.isValid(userIdRaw)) {
    return { _id: new ObjectId(userIdRaw) };
  }
  if (deviceIdRaw) {
    return { deviceId: deviceIdRaw };
  }

  return null;
}

function normalizeEvent(event) {
  const eventKey = String(event?.eventKey || "").trim();
  if (!eventKey) throw new Error("Missing eventKey");

  const rawAmount = event?.amount;
  const amount =
    typeof rawAmount === "number" && Number.isFinite(rawAmount)
      ? Math.trunc(rawAmount)
      : parseInt(rawAmount ?? "1", 10);

  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error("Amount must be a non-zero number");
  }

  return { eventKey, amount };
}

// -----------------------------
// Public API
// -----------------------------

export async function getAwardsForUser(db, { userId, deviceId }) {
  const filter = buildUserFilter({ userId, deviceId });
  if (!filter) throw new Error("Missing identifier (userId or deviceId)");

  const usersCol = db.collection("users");
  const user = await usersCol.findOne(filter, { projection: { awards: 1 } });
  if (!user) return null;

  return {
    userId: String(user._id),
    awards: Array.isArray(user.awards) ? user.awards : [],
  };
}

export async function awardOnce(db, { userId, deviceId }, award) {
  const filter = buildUserFilter({ userId, deviceId });
  if (!filter) throw new Error("Missing identifier (userId or deviceId)");

  const normalized = normalizeAward(award);
  const usersCol = db.collection("users");

  // Only push if this key doesn't already exist
  await usersCol.updateOne(
    {
      ...filter,
      awards: { $not: { $elemMatch: { key: normalized.key } } },
    },
    {
      $push: { awards: normalized },
    }
  );

  return getAwardsForUser(db, { userId, deviceId });
}

export async function removeAward(db, { userId, deviceId }, key) {
  const filter = buildUserFilter({ userId, deviceId });
  if (!filter) throw new Error("Missing identifier (userId or deviceId)");

  const k = String(key || "").trim();
  if (!k) throw new Error("Award key is required");

  const usersCol = db.collection("users");
  await usersCol.updateOne(filter, { $pull: { awards: { key: k } } });

  return getAwardsForUser(db, { userId, deviceId });
}

/**
 * applyAwardEvent
 *
 * 1) increments `awardTallies.<eventKey>` by amount
 * 2) checks any thresholds for that eventKey
 * 3) grants awards (idempotent) if crossed
 * 4) returns updated { userId, awards }
 */
export async function applyAwardEvent(db, identifiers, event) {
  const filter = buildUserFilter(identifiers);
  if (!filter) throw new Error("Missing identifier (userId or deviceId)");

  const { eventKey, amount } = normalizeEvent(event);

  const usersCol = db.collection("users");
  const now = new Date();

  // Read current tally so we can detect threshold crossings.
  const before = await usersCol.findOne(filter, {
    projection: { awardTallies: 1 },
  });
  if (!before) return null;

  const tallies = before.awardTallies && typeof before.awardTallies === "object" ? before.awardTallies : {};
  const beforeValueRaw = tallies[eventKey];
  const beforeValue = typeof beforeValueRaw === "number" && Number.isFinite(beforeValueRaw) ? beforeValueRaw : 0;

  // Apply increment but clamp at 0 (never store negative tallies)
  const afterValue = Math.max(0, beforeValue + amount);

  await usersCol.updateOne(
    filter,
    {
      $set: {
        [`awardTallies.${eventKey}`]: afterValue,
        updatedAt: now,
      },
    }
  );

  // Auto-award based on rules for this eventKey.
  const rules = Array.isArray(AWARD_RULES[eventKey]) ? AWARD_RULES[eventKey] : [];
  for (const rule of rules) {
    const t = rule?.threshold;
    if (typeof t !== "number" || !Number.isFinite(t)) continue;

    // Trigger if crossed (or landed exactly on) threshold.
    if (beforeValue < t && afterValue >= t) {
      try {
        await awardOnce(db, identifiers, rule.award);
      } catch (e) {
        // Don't fail whole request due to one award.
        console.error("[Awards] awardOnce failed:", e);
      }
    }
  }

  return getAwardsForUser(db, identifiers);
}

export const __test = {
  AWARD_RULES,
  normalizeAward,
  buildUserFilter,
  normalizeEvent,
};
