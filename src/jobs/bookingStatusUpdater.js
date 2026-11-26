import cron from "node-cron";
import { getDB } from "../config/db.js";
import { COLLECTIONS } from "../config/indexes.js";

// Runs every hour: auto-complete bookings whose endDate has passed
export function startBookingStatusUpdater() {
  cron.schedule("0 * * * *", async () => {
    console.log("[CRON] Running booking status updater...");
    try {
      const db = getDB();
      const now = new Date();

      const result = await db.collection(COLLECTIONS.BOOKINGS).updateMany(
        {
          bookingStatus: { $in: ["confirmed"] },
          paymentStatus: "paid",
          endDate: { $lt: now },
        },
        { $set: { bookingStatus: "completed", updatedAt: now } }
      );

      if (result.modifiedCount > 0) {
        console.log(`[CRON] Auto-completed ${result.modifiedCount} booking(s).`);
      }

      // Also expire stale checkout intents
      await db.collection(COLLECTIONS.CHECKOUT_INTENTS).updateMany(
        { status: "pending", expiresAt: { $lt: now } },
        { $set: { status: "expired", updatedAt: now } }
      );
    } catch (err) {
      console.error("[CRON] Booking status updater error:", err.message);
    }
  });

  console.log("[CRON] Booking status updater scheduled (every hour).");
}
