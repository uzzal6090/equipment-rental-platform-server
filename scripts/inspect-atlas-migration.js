import { config as dotenvConfig } from "dotenv";
import { connectDB, getDB, closeDB } from "../src/config/db.js";

dotenvConfig();

const COLLECTIONS = [
  "equipment",
  "bookings",
  "checkoutIntents",
  "payments",
  "emailOutbox",
  "favorites",
  "profiles",
];

async function listIndexes(db) {
  const report = {};
  for (const name of COLLECTIONS) {
    try {
      const indexes = await db.collection(name).listIndexes().toArray();
      report[name] = indexes.map((idx) => ({
        name: idx.name,
        key: idx.key,
        unique: idx.unique === true,
        sparse: idx.sparse === true,
        expireAfterSeconds: idx.expireAfterSeconds,
        partialFilterExpression: idx.partialFilterExpression,
      }));
    } catch (error) {
      report[name] = { error: error.message };
    }
  }
  return report;
}

async function countMissingField(db, collection, field) {
  return await db.collection(collection).countDocuments({ [field]: { $exists: false } });
}

async function countNullField(db, collection, field) {
  return await db.collection(collection).countDocuments({ [field]: null });
}

async function duplicateGroups(db, collection, keyPattern) {
  // Build match/group for exact duplicates on non-null, non-missing values
  const match = {};
  const groupId = {};
  const fields = Object.keys(keyPattern);
  for (const f of fields) {
    match[f] = { $exists: true, $ne: null };
    groupId[f] = `$${f}`;
  }
  const pipeline = [
    { $match: match },
    { $group: { _id: groupId, count: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
  ];
  const groups = await db.collection(collection).aggregate(pipeline).toArray();
  const docsInGroups = groups.reduce((sum, g) => sum + g.count, 0);
  return { groups: groups.length, documents: docsInGroups };
}

async function legacyEquipmentCounts(db) {
  const hasIsApproved = await db.collection("equipment").countDocuments({ isApproved: { $exists: true } });
  const hasStatus = await db.collection("equipment").countDocuments({ status: { $exists: true } });
  const hasBoth = await db.collection("equipment").countDocuments({
    isApproved: { $exists: true },
    status: { $exists: true },
  });
  const hasNeither = await db.collection("equipment").countDocuments({
    isApproved: { $exists: false },
    status: { $exists: false },
  });
  return { hasIsApproved, hasStatus, hasBoth, hasNeither };
}

async function intentExpiryCounts(db) {
  const now = new Date();
  const pendingExpired = await db.collection("checkoutIntents").countDocuments({
    status: "pending",
    expiresAt: { $lt: now },
  });
  const pendingNotExpired = await db.collection("checkoutIntents").countDocuments({
    status: "pending",
    expiresAt: { $gte: now },
  });
  return { pendingExpired, pendingNotExpired };
}

async function emailOutboxGrouping(db) {
  const byStatus = await db.collection("emailOutbox").aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  const byRecipient = await db.collection("emailOutbox").aggregate([
    { $group: { _id: "$recipientType", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  return { byStatus, byRecipient };
}

async function profileRoleGrouping(db) {
  return await db.collection("profiles").aggregate([
    { $group: { _id: "$role", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
}

async function bookingGrouping(db) {
  const byBookingStatus = await db.collection("bookings").aggregate([
    { $group: { _id: "$bookingStatus", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  const byPaymentStatus = await db.collection("bookings").aggregate([
    { $group: { _id: "$paymentStatus", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  return { byBookingStatus, byPaymentStatus };
}

async function ttlInspection(db) {
  const ttlIndexes = [];
  for (const name of COLLECTIONS) {
    try {
      const indexes = await db.collection(name).listIndexes().toArray();
      for (const idx of indexes) {
        if (typeof idx.expireAfterSeconds === "number") {
          ttlIndexes.push({ collection: name, ...idx });
        }
      }
    } catch (error) {
      ttlIndexes.push({ collection: name, error: error.message });
    }
  }
  return ttlIndexes;
}

async function main() {
  await connectDB();
  const db = getDB();

  const results = {};

  try {
    // A. Existing indexes
    results.indexes = await listIndexes(db);

    // B. Unique-index compatibility counts
    results.uniqueCompatibility = {
      payments: {
        stripeSessionId: {
          missing: await countMissingField(db, "payments", "stripeSessionId"),
          explicitNull: await countNullField(db, "payments", "stripeSessionId"),
          ...await duplicateGroups(db, "payments", { stripeSessionId: 1 }),
        },
        checkoutIntent: {
          missing: await countMissingField(db, "payments", "checkoutIntent"),
          explicitNull: await countNullField(db, "payments", "checkoutIntent"),
          ...await duplicateGroups(db, "payments", { checkoutIntent: 1 }),
        },
      },
      bookings: {
        stripeSessionId: {
          missing: await countMissingField(db, "bookings", "stripeSessionId"),
          explicitNull: await countNullField(db, "bookings", "stripeSessionId"),
          ...await duplicateGroups(db, "bookings", { stripeSessionId: 1 }),
        },
        checkoutIntent: {
          missing: await countMissingField(db, "bookings", "checkoutIntent"),
          explicitNull: await countNullField(db, "bookings", "checkoutIntent"),
          ...await duplicateGroups(db, "bookings", { checkoutIntent: 1 }),
        },
      },
      emailOutbox: {
        bookingId: {
          missing: await countMissingField(db, "emailOutbox", "bookingId"),
          explicitNull: await countNullField(db, "emailOutbox", "bookingId"),
          ...await duplicateGroups(db, "emailOutbox", { bookingId: 1 }),
        },
        bookingId_recipientType: await duplicateGroups(db, "emailOutbox", {
          bookingId: 1,
          recipientType: 1,
        }),
      },
      favorites: {
        userId_equipmentId: await duplicateGroups(db, "favorites", {
          userId: 1,
          equipmentId: 1,
        }),
      },
      profiles: {
        betterAuthUserId: {
          missing: await countMissingField(db, "profiles", "betterAuthUserId"),
          explicitNull: await countNullField(db, "profiles", "betterAuthUserId"),
          ...await duplicateGroups(db, "profiles", { betterAuthUserId: 1 }),
        },
      },
    };

    // C. Legacy schema compatibility counts
    results.legacySchema = {
      equipment: await legacyEquipmentCounts(db),
      checkoutIntents: await intentExpiryCounts(db),
      emailOutbox: await emailOutboxGrouping(db),
      profiles: await profileRoleGrouping(db),
      bookings: await bookingGrouping(db),
    };

    // D. TTL inspection
    results.ttlIndexes = await ttlInspection(db);

    // E. Migration blockers analysis
    const blockers = [];
    const criticalUnique = [
      "payments.stripeSessionId",
      "payments.checkoutIntent",
      "bookings.stripeSessionId",
      "bookings.checkoutIntent",
      "emailOutbox.bookingId",
      "emailOutbox.bookingId+recipientType",
      "favorites.userId+equipmentId",
      "profiles.betterAuthUserId",
    ];
    for (const key of criticalUnique) {
      blockers.push({ key, check: "review duplicate/null counts above before creating unique index" });
    }
    const ttlCheckout = results.ttlIndexes.find(
      (t) => t.collection === "checkoutIntents" && t.name && t.name.includes("expiresAt")
    );
    if (ttlCheckout) {
      blockers.push({
        key: "checkoutIntents.expiresAt TTL",
        finding: `TTL index exists: expireAfterSeconds=${ttlCheckout.expireAfterSeconds}`,
        note: "Immediate TTL deletion on expiresAt conflicts with pending->expired lifecycle; data migration may be needed before removing.",
      });
    }
    const equip = results.legacySchema.equipment;
    if (equip.hasIsApproved > 0 || equip.hasBoth > 0) {
      blockers.push({
        key: "equipment.isApproved legacy field",
        finding: `${equip.hasIsApproved} docs have isApproved; ${equip.hasBoth} have both isApproved and status`,
        note: "Data migration may be needed to canonicalize on status field.",
      });
    }
    results.migrationBlockers = blockers;
  } catch (error) {
    console.error(`INSPECTION ERROR: ${error.message}`);
    process.exit(1);
  } finally {
    await closeDB();
  }

  // Structured report output (counts only, no document contents, no credentials)
  console.log("==============================================");
  console.log("ATLAS MIGRATION INSPECTION REPORT (READ-ONLY)");
  console.log("==============================================\n");

  console.log("1. EXISTING INDEX INVENTORY");
  for (const [name, idxs] of Object.entries(results.indexes)) {
    console.log(`\nCollection: ${name}`);
    if (idxs.error) {
      console.log(`  ERROR: ${idxs.error}`);
      continue;
    }
    if (idxs.length === 0) {
      console.log("  (no indexes)");
    }
    for (const idx of idxs) {
      console.log(
        `  - ${idx.name} | key=${JSON.stringify(idx.key)} | unique=${idx.unique} | sparse=${idx.sparse}` +
          (idx.expireAfterSeconds !== undefined ? ` | expireAfterSeconds=${idx.expireAfterSeconds}` : "") +
          (idx.partialFilterExpression !== undefined ? ` | partialFilterExpression=${JSON.stringify(idx.partialFilterExpression)}` : "")
      );
    }
  }

  console.log("\n\n2. UNIQUE-INDEX COMPATIBILITY COUNTS (documents only, no field values)");
  const printKey = (label, obj) => {
    console.log(`\n  ${label}:`);
    console.log(`    missingField=${obj.missing ?? "N/A"} explicitNull=${obj.explicitNull ?? "N/A"} duplicateGroups=${obj.groups ?? "N/A"} docsInDuplicateGroups=${obj.documents ?? "N/A"}`);
  };
  printKey("payments.stripeSessionId", results.uniqueCompatibility.payments.stripeSessionId);
  printKey("payments.checkoutIntent", results.uniqueCompatibility.payments.checkoutIntent);
  printKey("bookings.stripeSessionId", results.uniqueCompatibility.bookings.stripeSessionId);
  printKey("bookings.checkoutIntent", results.uniqueCompatibility.bookings.checkoutIntent);
  printKey("emailOutbox.bookingId", results.uniqueCompatibility.emailOutbox.bookingId);
  printKey("emailOutbox.bookingId+recipientType", results.uniqueCompatibility.emailOutbox.bookingId_recipientType);
  printKey("favorites.userId+equipmentId", results.uniqueCompatibility.favorites.userId_equipmentId);
  printKey("profiles.betterAuthUserId", results.uniqueCompatibility.profiles.betterAuthUserId);

  console.log("\n\n3. LEGACY SCHEMA COUNTS");
  console.log(`\n  equipment:`);
  console.log(`    hasIsApproved=${results.legacySchema.equipment.hasIsApproved}`);
  console.log(`    hasStatus=${results.legacySchema.equipment.hasStatus}`);
  console.log(`    hasBoth=${results.legacySchema.equipment.hasBoth}`);
  console.log(`    hasNeither=${results.legacySchema.equipment.hasNeither}`);
  console.log(`\n  checkoutIntents (status=pending):`);
  console.log(`    expired=${results.legacySchema.checkoutIntents.pendingExpired}`);
  console.log(`    notExpired=${results.legacySchema.checkoutIntents.pendingNotExpired}`);
  console.log(`\n  emailOutbox by status:`);
  for (const g of results.legacySchema.emailOutbox.byStatus) {
    console.log(`    status=${g._id} count=${g.count}`);
  }
  console.log(`  emailOutbox by recipientType:`);
  for (const g of results.legacySchema.emailOutbox.byRecipient) {
    console.log(`    recipientType=${g._id} count=${g.count}`);
  }
  console.log(`\n  profiles by role:`);
  for (const g of results.legacySchema.profiles) {
    console.log(`    role=${g._id} count=${g.count}`);
  }
  console.log(`\n  bookings by bookingStatus:`);
  for (const g of results.legacySchema.bookings.byBookingStatus) {
    console.log(`    bookingStatus=${g._id} count=${g.count}`);
  }
  console.log(`  bookings by paymentStatus:`);
  for (const g of results.legacySchema.bookings.byPaymentStatus) {
    console.log(`    paymentStatus=${g._id} count=${g.count}`);
  }

  console.log("\n\n4. TTL INDEX FINDINGS");
  for (const t of results.ttlIndexes) {
    if (t.error) {
      console.log(`  ${t.collection}: ERROR ${t.error}`);
    } else if (typeof t.expireAfterSeconds === "number") {
      console.log(`  ${t.collection}.${t.name} | key=${JSON.stringify(t.key)} | expireAfterSeconds=${t.expireAfterSeconds}`);
    }
  }
  const hasCheckoutTTL = results.ttlIndexes.some(
    (t) => t.collection === "checkoutIntents" && typeof t.expireAfterSeconds === "number" && t.name && t.name.includes("expiresAt")
  );
  console.log(`\n  checkoutIntents.expiresAt TTL present: ${hasCheckoutTTL}`);

  console.log("\n\n5. POTENTIAL MIGRATION BLOCKERS");
  for (const b of results.migrationBlockers) {
    console.log(`  - ${b.key}: ${b.finding || ""}${b.note ? " | " + b.note : ""}`);
  }

  console.log("\n\n6. DATA vs INDEX MIGRATION");
  console.log("  Index migration (manual, non-destructive):");
  console.log("    - checkoutIntents.expiresAt TTL: remove immediate TTL if conflicting with lifecycle");
  console.log("    - payments.stripeSessionId: unique+sparse desired; existing may be non-sparse");
  console.log("    - bookings.stripeSessionId / checkoutIntent: unique+sparse desired");
  console.log("    - emailOutbox.bookingId+recipientType: unique composite desired");
  console.log("    - favorites.userId+equipmentId: unique composite desired");
  console.log("    - profiles.betterAuthUserId: unique desired");
  console.log("  Data migration (may be required):");
  console.log("    - equipment.isApproved -> status canonicalization if legacy docs exist");
  console.log("    - duplicate unique-key documents must be resolved before creating unique indexes");
}

main().catch((error) => {
  console.error(`UNCAUGHT INSPECTION ERROR: ${error.message}`);
  process.exit(1);
});
