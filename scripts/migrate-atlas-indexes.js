import { config as dotenvConfig } from "dotenv";
import { connectDB, getDB, closeDB } from "../src/config/db.js";

dotenvConfig();

const COLLECTIONS = ["checkoutIntents", "payments", "emailOutbox"];

function normalizeIndex(idx) {
  return {
    name: idx.name,
    key: idx.key,
    unique: idx.unique === true,
    sparse: idx.sparse === true,
    expireAfterSeconds: idx.expireAfterSeconds,
  };
}

async function captureIndexes(db) {
  const report = {};
  for (const name of COLLECTIONS) {
    const indexes = await db.collection(name).listIndexes().toArray();
    report[name] = indexes.map(normalizeIndex);
  }
  return report;
}

async function findIndexByName(db, collection, name) {
  const indexes = await db.collection(collection).listIndexes().toArray();
  return indexes.find((i) => i.name === name);
}

async function main() {
  await connectDB();
  const db = getDB();

  try {
    const before = await captureIndexes(db);

    // Preflight: verify target collections are empty
    const counts = {};
    for (const name of COLLECTIONS) {
      counts[name] = await db.collection(name).countDocuments();
    }
    const nonEmpty = Object.entries(counts).filter(([, c]) => c > 0);
    if (nonEmpty.length > 0) {
      throw new Error("PREFLIGHT ABORT: collections are not empty: " + JSON.stringify(nonEmpty));
    }

    // Preflight: verify required compound email index exists and is unique
    const emailCompound = await findIndexByName(db, "emailOutbox", "bookingId_1_recipientType_1");
    if (!emailCompound) {
      throw new Error("PREFLIGHT ABORT: emailOutbox.bookingId_1_recipientType_1 is missing");
    }
    if (emailCompound.unique !== true) {
      throw new Error("PREFLIGHT ABORT: emailOutbox.bookingId_1_recipientType_1 is not unique");
    }

    const results = { succeeded: [], skipped: [], errors: [] };

    // A. checkoutIntents: drop expiresAt_1 only if present
    const ciExpires = await findIndexByName(db, "checkoutIntents", "expiresAt_1");
    if (ciExpires) {
      await db.collection("checkoutIntents").dropIndex("expiresAt_1");
      results.succeeded.push("checkoutIntents: dropped expiresAt_1");
    } else {
      results.skipped.push("checkoutIntents: expiresAt_1 already absent (desired end state met)");
    }

    // B. payments: drop stripeSessionId_1, then create unique+sparse
    const psStripe = await findIndexByName(db, "payments", "stripeSessionId_1");
    if (psStripe) {
      await db.collection("payments").dropIndex("stripeSessionId_1");
      results.succeeded.push("payments: dropped stripeSessionId_1");
    } else {
      results.skipped.push("payments: stripeSessionId_1 already absent");
    }
    await db.collection("payments").createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true });
    results.succeeded.push("payments: created stripeSessionId_1 {unique:true, sparse:true}");

    // C. emailOutbox: drop bookingId_1 only if present; compound kept unchanged
    const eoBooking = await findIndexByName(db, "emailOutbox", "bookingId_1");
    if (eoBooking) {
      await db.collection("emailOutbox").dropIndex("bookingId_1");
      results.succeeded.push("emailOutbox: dropped bookingId_1");
    } else {
      results.skipped.push("emailOutbox: bookingId_1 already absent (desired end state met)");
    }
    results.skipped.push("emailOutbox: bookingId_1_recipientType_1 kept unchanged (unique)");

    const after = await captureIndexes(db);

    // Step 4 verification
    const verify = {
      "checkoutIntents.expiresAt_1 removed": !after.checkoutIntents.some((i) => i.name === "expiresAt_1"),
      "payments.stripeSessionId_1 unique+sparse": (() => {
        const i = after.payments.find((x) => x.name === "stripeSessionId_1");
        return !!i && i.unique === true && i.sparse === true;
      })(),
      "emailOutbox.bookingId_1 removed": !after.emailOutbox.some((i) => i.name === "bookingId_1"),
      "emailOutbox.bookingId_1_recipientType_1 unique": (() => {
        const i = after.emailOutbox.find((x) => x.name === "bookingId_1_recipientType_1");
        return !!i && i.unique === true;
      })(),
    };

    console.log("==============================================");
    console.log("ATLAS INDEX MIGRATION REPORT");
    console.log("==============================================");

    console.log("\nBEFORE:");
    for (const [name, idxs] of Object.entries(before)) {
      console.log(`  ${name}:`);
      for (const i of idxs) {
        console.log(
          `    - ${i.name} | key=${JSON.stringify(i.key)} | unique=${i.unique} | sparse=${i.sparse}` +
            (i.expireAfterSeconds !== undefined ? ` | expireAfterSeconds=${i.expireAfterSeconds}` : "")
        );
      }
    }

    console.log("\nOPERATIONS:");
    for (const s of results.succeeded) console.log(`  [OK] ${s}`);
    for (const s of results.skipped) console.log(`  [SKIP] ${s}`);
    for (const e of results.errors) console.log(`  [ERR] ${e}`);

    console.log("\nAFTER:");
    for (const [name, idxs] of Object.entries(after)) {
      console.log(`  ${name}:`);
      for (const i of idxs) {
        console.log(
          `    - ${i.name} | key=${JSON.stringify(i.key)} | unique=${i.unique} | sparse=${i.sparse}` +
            (i.expireAfterSeconds !== undefined ? ` | expireAfterSeconds=${i.expireAfterSeconds}` : "")
        );
      }
    }

    console.log("\nVERIFICATION:");
    for (const [k, v] of Object.entries(verify)) {
      console.log(`  ${k}: ${v}`);
    }

    console.log("\nDOCUMENTS MODIFIED/DELETED: 0");
    console.log("COLLECTIONS DROPPED: 0");
    console.log("UNRELATED INDEXES TOUCHED: none");
    console.log("MIGRATION SAFE TO RERUN: yes (idempotent)");

    if (Object.values(verify).some((v) => v !== true)) {
      throw new Error("Post-migration verification failed");
    }
  } catch (error) {
    console.error(`MIGRATION ERROR: ${error.message}`);
    process.exit(1);
  } finally {
    await closeDB();
  }
}

main();
