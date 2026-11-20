import { config as dotenvConfig } from "dotenv";
import { connectDB, getDB, closeDB } from "../src/config/db.js";
import { withInventoryGuard, computeAvailability } from "../src/inventory/transaction.js";

dotenvConfig();

// Unique run identifier so this execution only ever touches its own records.
// Documents are tagged with runId and cleaned up by exact _id, never by name prefix.
const RUN_ID = `concurrency-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const EQUIPMENT_NAME = `Concurrency Test ${RUN_ID}`;

async function main() {
  await connectDB();
  const db = getDB();

  // Track only the documents created by this test execution.
  const createdIds = { equipment: [], intents: [], bookings: [] };
  let failed = false;

  try {
    // Insert a uniquely identifiable equipment record.
    const equipResult = await db.collection("equipment").insertOne({
      name: EQUIPMENT_NAME,
      totalQuantity: 1,
      inventoryVersion: 0,
      status: "approved",
      runId: RUN_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const equipmentId = equipResult.insertedId;
    createdIds.equipment.push(equipmentId);

    const start1 = new Date("2026-12-01T00:00:00Z");
    const end1 = new Date("2026-12-03T00:00:00Z");

    // Test 1: Two concurrent reservations for the same dates, qty=1 each.
    const results = await Promise.allSettled([
      withInventoryGuard(db, equipmentId, start1, end1, 1, async (session, ctx) => {
        const intent = await db.collection("checkoutIntents").insertOne(
          {
            equipmentId,
            userId: "user-1",
            startDate: start1,
            endDate: end1,
            quantity: 1,
            status: "pending",
            expiresAt: new Date(Date.now() + 3600000),
            released: false,
            inventoryVersionSeen: ctx.equipment.inventoryVersion,
            runId: RUN_ID,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          { session }
        );
        createdIds.intents.push(intent.insertedId);
        return { success: true, user: "user-1" };
      }),
      withInventoryGuard(db, equipmentId, start1, end1, 1, async (session, ctx) => {
        const intent = await db.collection("checkoutIntents").insertOne(
          {
            equipmentId,
            userId: "user-2",
            startDate: start1,
            endDate: end1,
            quantity: 1,
            status: "pending",
            expiresAt: new Date(Date.now() + 3600000),
            released: false,
            inventoryVersionSeen: ctx.equipment.inventoryVersion,
            runId: RUN_ID,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          { session }
        );
        createdIds.intents.push(intent.insertedId);
        return { success: true, user: "user-2" };
      }),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled").length;
    const failures = results.filter((r) => r.status === "rejected").length;
    console.log(`Concurrent same-range test: successes=${successes}, failures=${failures}`);
    console.log("Expected: successes=1, failures=1 (no overselling)");

    if (successes !== 1 || failures !== 1) {
      console.error("FAIL: unexpected concurrency result (overselling possible)");
      failed = true;
    }

    const avail = await computeAvailability(db, equipmentId, start1, end1, null);
    console.log("Availability after one reservation:", avail.available);
    console.log("Expected: 0");
    if (avail.available !== 0) {
      console.error("FAIL: availability should be 0 after one reservation");
      failed = true;
    }

    // Test 2: Non-overlapping dates remain bookable.
    const start2 = new Date("2026-12-05T00:00:00Z");
    const end2 = new Date("2026-12-07T00:00:00Z");
    const avail2 = await computeAvailability(db, equipmentId, start2, end2, null);
    console.log("Availability for non-overlapping range:", avail2.available);
    console.log("Expected: 1 (non-overlapping dates remain bookable)");
    if (avail2.available !== 1) {
      console.error("FAIL: non-overlapping range should remain bookable");
      failed = true;
    }

    if (failed) {
      throw new Error("Concurrency test assertions failed");
    }
    console.log("CONCURRENCY TEST PASSED");
  } finally {
    // Cleanup ONLY documents created by this execution, identified by exact _id.
    // Never delete by name prefix; never touch pre-existing or unrelated data.
    if (createdIds.intents.length > 0) {
      await db.collection("checkoutIntents").deleteMany({ _id: { $in: createdIds.intents } });
    }
    if (createdIds.bookings.length > 0) {
      await db.collection("bookings").deleteMany({ _id: { $in: createdIds.bookings } });
    }
    if (createdIds.equipment.length > 0) {
      await db.collection("equipment").deleteMany({ _id: { $in: createdIds.equipment } });
    }

    // Verify cleanup: no records tagged with this runId should remain.
    const remainingEquipment = await db.collection("equipment").countDocuments({ runId: RUN_ID });
    const remainingIntents = await db.collection("checkoutIntents").countDocuments({ runId: RUN_ID });
    console.log("Remaining runId-tagged equipment after cleanup:", remainingEquipment);
    console.log("Remaining runId-tagged intents after cleanup:", remainingIntents);
    if (remainingEquipment !== 0 || remainingIntents !== 0) {
      console.error("FAIL: cleanup left behind run-tagged records");
      failed = true;
    }

    await closeDB();
  }

  if (failed) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exit(1);
});
