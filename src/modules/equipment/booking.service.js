import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { ObjectId } from "mongodb";
import { withInventoryGuard, computeAvailability } from "../../inventory/transaction.js";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(String(value), 10);
  if (!Number.isFinite(num) || num < 1) return fallback;
  return num;
}

function parseDate(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return date;
}

function calculateRentalDays(startDate, endDate, rentalType) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = end - start;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  switch (rentalType) {
    case "weekly":
      return Math.ceil(diffDays / 7);
    case "monthly":
      return Math.ceil(diffDays / 30);
    default:
      return diffDays;
  }
}

function calculateTotalPrice(equipment, startDate, endDate, quantity) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = end - start;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 1) return 0;

  let unitPrice = equipment.rentalPrice;
  let rentalDays = diffDays;

  switch (equipment.rentalType) {
    case "weekly":
      const weeks = Math.ceil(diffDays / 7);
      rentalDays = weeks;
      break;
    case "monthly":
      const months = Math.ceil(diffDays / 30);
      rentalDays = months;
      break;
    default:
      break;
  }

  return unitPrice * rentalDays * quantity;
}

async function checkAvailability(db, equipmentId, startDate, endDate, requestedQuantity, excludeIntentId = null, session = null) {
  const eqId = typeof equipmentId === "string" ? new ObjectId(equipmentId) : equipmentId;
  const start = new Date(startDate);
  const end = new Date(endDate);
  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: eqId }, session ? { session } : undefined);
  if (!equipment) {
    return { available: false, reason: "Equipment not found", totalQuantity: 0, availableQuantity: 0 };
  }

  const totalQuantity = equipment.totalQuantity || 0;
  const overlap = { startDate: { $lt: end }, endDate: { $gt: start } };

  const confirmedMatch = { equipmentId: eqId, bookingStatus: "confirmed", ...overlap };
  const confirmedAgg = await db.collection(COLLECTIONS.BOOKINGS).aggregate(
    [{ $match: confirmedMatch }, { $group: { _id: null, qty: { $sum: "$quantity" } } }],
    session ? { session } : undefined
  ).toArray();

  const pendingMatch = {
    equipmentId: eqId,
    ...overlap,
    $or: [
      { status: "pending", expiresAt: { $gt: new Date() } },
      { status: "processing" },
    ],
  };
  if (excludeIntentId) {
    pendingMatch._id = { $ne: typeof excludeIntentId === "string" ? new ObjectId(excludeIntentId) : excludeIntentId };
  }
  const pendingAgg = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).aggregate(
    [{ $match: pendingMatch }, { $group: { _id: null, qty: { $sum: "$quantity" } } }],
    session ? { session } : undefined
  ).toArray();

  const confirmedQty = confirmedAgg[0]?.qty || 0;
  const pendingQty = pendingAgg[0]?.qty || 0;
  const availableQuantity = totalQuantity - confirmedQty - pendingQty;
  return {
    available: availableQuantity >= requestedQuantity,
    totalQuantity,
    confirmedQty,
    pendingQty,
    availableQuantity,
    reason: availableQuantity >= requestedQuantity ? null : "Not enough available quantity for selected dates",
  };
}

async function createCheckoutIntent(db, equipmentId, userId, ownerId, startDate, endDate, quantity, contactPhone, deliveryAddress, notes, totalPrice, session = null) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

  const intent = {
    equipmentId: new ObjectId(equipmentId),
    userId: new ObjectId(userId),
    ownerId: new ObjectId(ownerId),
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    quantity,
    contactPhone: contactPhone || null,
    deliveryAddress: deliveryAddress || null,
    notes: notes || null,
    totalPrice,
    currency: "usd",
    stripeSessionId: null,
    status: "pending",
    expiresAt,
    released: false,
    inventoryVersionSeen: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).insertOne(intent, session ? { session } : undefined);
  return { ...intent, _id: result.insertedId };
}

async function reserveCheckoutIntent(db, equipmentId, userId, ownerId, startDate, endDate, quantity, contactPhone, deliveryAddress, notes, totalPrice) {
  const eqId = typeof equipmentId === "string" ? new ObjectId(equipmentId) : equipmentId;
  return withInventoryGuard(db, eqId, new Date(startDate), new Date(endDate), quantity, async (session) => {
    const intent = await createCheckoutIntent(db, eqId, userId, ownerId, startDate, endDate, quantity, contactPhone, deliveryAddress, notes, totalPrice, session);
    return intent;
  });
}

async function getCheckoutIntentById(db, intentId) {
  return db.collection(COLLECTIONS.CHECKOUT_INTENTS).findOne({ _id: new ObjectId(intentId) });
}

async function updateCheckoutIntentStripeSession(db, intentId, stripeSessionId) {
  return db.collection(COLLECTIONS.CHECKOUT_INTENTS).findOneAndUpdate(
    { _id: new ObjectId(intentId) },
    { $set: { stripeSessionId, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
}

async function releaseCheckoutIntent(db, intentId, options = {}) {
  const { status = "expired", session = null } = options;
  const id = typeof intentId === "string" ? new ObjectId(intentId) : intentId;
  const dbOpts = session ? { session, returnDocument: "after" } : { returnDocument: "after" };
  const result = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).findOneAndUpdate(
    { _id: id, status: "pending", released: { $ne: true } },
    { $set: { released: true, status, updatedAt: new Date() } },
    dbOpts
  );
  return result?.value || result || null;
}

async function releaseIntentReservation(db, intentId, status = "expired", session = null) {
  const id = typeof intentId === "string" ? new ObjectId(intentId) : intentId;
  const intent = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).findOne({ _id: id }, session ? { session } : undefined);
  if (!intent) return { released: false, reason: "not_found" };
  if (intent.status !== "pending" || intent.released) return { released: false, reason: "not_pending", intent };

  return withInventoryGuard(
    db,
    intent.equipmentId,
    new Date(intent.startDate),
    new Date(intent.endDate),
    0,
    async (guardSession) => {
      const updated = await releaseCheckoutIntent(db, id, { status, session: guardSession });
      if (!updated) return { released: false, reason: "race_lost" };
      return { released: true, intent: updated };
    }
  );
}

async function confirmCheckoutIntent(db, intentId) {
  return db.collection(COLLECTIONS.CHECKOUT_INTENTS).findOneAndUpdate(
    { _id: new ObjectId(intentId) },
    { $set: { status: "completed", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
}

async function releaseEquipmentReservation(db, equipmentId, quantity) {
  return db.collection(COLLECTIONS.EQUIPMENT).findOneAndUpdate(
    { _id: new ObjectId(equipmentId) },
    { $inc: { reservedQuantity: -quantity } }
  );
}

async function createBookingFromIntent(db, intent, stripeSessionId, stripePaymentIntentId, session) {
  const booking = {
    equipmentId: intent.equipmentId,
    ownerId: intent.ownerId,
    userId: intent.userId,
    startDate: intent.startDate,
    endDate: intent.endDate,
    quantity: intent.quantity,
    contactPhone: intent.contactPhone,
    deliveryAddress: intent.deliveryAddress,
    notes: intent.notes,
    bookingStatus: "confirmed",
    paymentStatus: "paid",
    checkoutIntent: intent._id,
    stripeSessionId,
    stripePaymentIntentId: stripePaymentIntentId || null,
    totalPrice: intent.totalPrice,
    bookingDate: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection(COLLECTIONS.BOOKINGS).insertOne(booking, session ? { session } : undefined);
  return { ...booking, _id: result.insertedId };
}

async function createPaymentRecord(db, bookingId, checkoutIntentId, customerId, stripeSessionId, stripePaymentIntentId, amount, currency, status, session) {
  const payment = {
    bookingId: new ObjectId(bookingId),
    checkoutIntent: new ObjectId(checkoutIntentId),
    customerId: new ObjectId(customerId),
    stripeSessionId,
    stripePaymentIntentId: stripePaymentIntentId || null,
    amount,
    currency: currency || "usd",
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection(COLLECTIONS.PAYMENTS).insertOne(payment, session ? { session } : undefined);
  return { ...payment, _id: result.insertedId };
}

async function releaseExpiredIntents(db) {
  const now = new Date();
  const expiredIntents = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).find({
    status: "pending",
    expiresAt: { $lt: now },
    released: { $ne: true },
  }).toArray();

  let releasedCount = 0;
  for (const intent of expiredIntents) {
    try {
      const result = await releaseIntentReservation(db, intent._id, "expired");
      if (result.released) releasedCount++;
    } catch (err) {
      console.warn(`Failed to release expired intent ${intent._id}:`, err.message);
    }
  }

  return releasedCount;
}

export {
  checkAvailability,
  calculateTotalPrice,
  calculateRentalDays,
  createCheckoutIntent,
  reserveCheckoutIntent,
  releaseEquipmentReservation,
  releaseIntentReservation,
  getCheckoutIntentById,
  updateCheckoutIntentStripeSession,
  releaseCheckoutIntent,
  confirmCheckoutIntent,
  createBookingFromIntent,
  createPaymentRecord,
  releaseExpiredIntents,
  parsePositiveInt,
  parseDate,
};