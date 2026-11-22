import { withTransaction } from "../config/db.js";
import { COLLECTIONS } from "../config/indexes.js";

const BOOKING_STATUS_CONFIRMED = "confirmed";
const INTENT_STATUS_PENDING = "pending";
const INTENT_STATUS_PROCESSING = "processing";
const ACTIVE_INTENT_STATUSES = [INTENT_STATUS_PENDING, INTENT_STATUS_PROCESSING];
const ERROR_INVENTORY_VERSION_CONFLICT = "INVENTORY_VERSION_CONFLICT";
const ERROR_INSUFFICIENT_INVENTORY = "INSUFFICIENT_INVENTORY";

// Only TransientTransactionError is retried by the outer guard loop.
// UnknownTransactionCommitResult and RetryableWriteError are handled by the
// driver's session.withTransaction() internally and must NOT be manually
// rerun by this loop (an uncertain commit must not be blindly replayed).
const RETRYABLE_LABELS = new Set(["TransientTransactionError"]);

const RETRYABLE_CODES = new Set([
  6, // NotPrimary
  11601, 11602, // InterruptedDueToReplStateChange
  133, // NotPrimaryNoSecondaryOk
  147, // HostNotFound
  189, 12582, // PrimarySteppedDown
  91, // ShutdownInProgress
  12583, // NotWritablePrimary
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(error) {
  if (!error) {
    return false;
  }
  const labels = Array.isArray(error.errorLabels) ? error.errorLabels : [];
  if (labels.some((label) => RETRYABLE_LABELS.has(label))) {
    return true;
  }
  if (typeof error.code === "number" && RETRYABLE_CODES.has(error.code)) {
    return true;
  }
  return false;
}

function isPermanentError(error) {
  if (!error) {
    return false;
  }
  // Specific error codes take precedence over HTTP status codes so that
  // INVENTORY_VERSION_CONFLICT (statusCode 409) is not misclassified as
  // permanent.
  if (error.code === ERROR_INVENTORY_VERSION_CONFLICT) {
    return false; // retried by the outer withInventoryGuard() loop
  }
  if (error.code === ERROR_INSUFFICIENT_INVENTORY) {
    return true;
  }
  if (error.code === "EQUIPMENT_NOT_FOUND") {
    return true;
  }
  if (error.statusCode === 400 || error.statusCode === 409) {
    return true;
  }
  return false;
}

async function computeAvailability(db, equipmentId, startDate, endDate, session) {
  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne(
    { _id: equipmentId },
    { session }
  );
  if (!equipment) {
    return { available: 0, totalQuantity: 0, confirmedQty: 0, pendingQty: 0 };
  }

  const totalQuantity = equipment.totalQuantity || 0;

  const overlap = {
    startDate: { $lt: endDate },
    endDate: { $gt: startDate },
  };

  // Confirmed-booking aggregation runs sequentially on the same session to
  // avoid "operations on the same session must be sequential" errors.
  const confirmedResult = await db
    .collection(COLLECTIONS.BOOKINGS)
    .aggregate(
      [
        { $match: { equipmentId, bookingStatus: BOOKING_STATUS_CONFIRMED, ...overlap } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ],
      { session }
    )
    .toArray();

  // Active checkout-intent aggregation runs after the confirmed aggregation.
  // Both pending (unexpired) and processing intents reserve inventory.
  // Processing intents must remain counted until a confirmed booking is
  // atomically created or the intent is explicitly released/expired/failed.
  const activeIntentResult = await db
    .collection(COLLECTIONS.CHECKOUT_INTENTS)
    .aggregate(
      [
        {
          $match: {
            equipmentId,
            ...overlap,
            $or: [
              { status: INTENT_STATUS_PENDING, expiresAt: { $gt: new Date() } },
              { status: INTENT_STATUS_PROCESSING },
            ],
          },
        },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ],
      { session }
    )
    .toArray();

  const confirmedQty = confirmedResult[0] ? confirmedResult[0].qty : 0;
  const pendingQty = activeIntentResult[0] ? activeIntentResult[0].qty : 0;

  return {
    available: totalQuantity - confirmedQty - pendingQty,
    totalQuantity,
    confirmedQty,
    pendingQty,
  };
}

/**
 * Runs `operation(session, ctx)` inside a transaction guarded by the shared
 * equipment-level inventoryVersion write guard.
 *
 * Callback safety: `operation(session)` MUST contain database operations only.
 * Do not place Stripe API calls, email sends, or other external side effects
 * inside a retryable transaction callback. External side effects must run after
 * transaction success through an idempotent workflow.
 *
 * Every retry begins a fresh transaction (via session.withTransaction()) and
 * recomputes availability. Permanent errors (insufficient inventory, missing
 * equipment, validation) are never retried.
 */
async function withInventoryGuard(db, equipmentId, startDate, endDate, requestedQty, operation, options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 50;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Each iteration begins a fresh transaction and recomputes availability.
      return await withTransaction(async (session) => {
        const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne(
          { _id: equipmentId },
          { session }
        );
        if (!equipment) {
          const error = new Error("Equipment not found");
          error.code = "EQUIPMENT_NOT_FOUND";
          error.statusCode = 404;
          throw error;
        }

        const currentVersion = equipment.inventoryVersion || 0;

        const availability = await computeAvailability(db, equipmentId, startDate, endDate, session);
        if (availability.available < requestedQty) {
          const error = new Error("Insufficient inventory for requested date range");
          error.code = ERROR_INSUFFICIENT_INVENTORY;
          error.statusCode = 409;
          throw error;
        }

        // Shared equipment-level inventoryVersion write guard. Every state
        // change must pass through this guard; no operation can bypass it.
        const guardResult = await db.collection(COLLECTIONS.EQUIPMENT).updateOne(
          { _id: equipmentId, inventoryVersion: currentVersion },
          { $inc: { inventoryVersion: 1 } },
          { session }
        );

        if (guardResult.matchedCount === 0) {
          const error = new Error(ERROR_INVENTORY_VERSION_CONFLICT);
          error.code = ERROR_INVENTORY_VERSION_CONFLICT;
          error.statusCode = 409;
          throw error;
        }

        return await operation(session, { equipment, availability });
      });
    } catch (error) {
      // Permanent validation / inventory errors are never retried.
      if (isPermanentError(error)) {
        throw error;
      }

      // Custom inventory version conflict: retry with a fresh transaction and
      // recomputed availability. Transient errors (driver fallback) also retry.
      const retryable =
        error.code === ERROR_INVENTORY_VERSION_CONFLICT || isTransientError(error);

      if (retryable && attempt < maxRetries) {
        await sleep(baseDelayMs * (attempt + 1));
        continue;
      }

      throw error;
    }
  }
}

export {
  withInventoryGuard,
  computeAvailability,
  ERROR_INSUFFICIENT_INVENTORY,
  ERROR_INVENTORY_VERSION_CONFLICT,
};
