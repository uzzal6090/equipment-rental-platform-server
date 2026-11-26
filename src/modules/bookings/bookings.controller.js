import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { success, error } from "../../utils/response.js";
import { withInventoryGuard } from "../../inventory/transaction.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function calculateTotalPrice(rentalPrice, rentalType, startDate, endDate, quantity) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffMs = end - start;
  if (diffMs <= 0) return 0;

  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  let units;
  if (rentalType === "daily") {
    units = diffDays;
  } else if (rentalType === "weekly") {
    units = Math.ceil(diffDays / 7);
  } else {
    // monthly
    units = Math.ceil(diffDays / 30);
  }

  return parseFloat((rentalPrice * units * quantity).toFixed(2));
}

// POST /api/bookings/checkout-intent
export async function createCheckoutIntent(req, res) {
  const db = getDB();
  const { equipmentId: eqIdStr, startDate, endDate, quantity, contactPhone, deliveryAddress, notes } = req.body;

  if (!eqIdStr || !startDate || !endDate || !quantity) {
    return error(res, "equipmentId, startDate, endDate, quantity are required", 400, "MISSING_FIELDS");
  }

  let equipmentId;
  try {
    equipmentId = new ObjectId(eqIdStr);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start) || isNaN(end) || end <= start) {
    return error(res, "Invalid date range", 400, "INVALID_DATES");
  }

  const qty = parseInt(quantity);
  if (qty < 1) return error(res, "Quantity must be at least 1", 400, "INVALID_QUANTITY");

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: equipmentId });
  if (!equipment) return error(res, "Equipment not found", 404, "NOT_FOUND");
  if (equipment.status !== "approved") return error(res, "Equipment is not available for booking", 400, "NOT_AVAILABLE");

  const totalPrice = calculateTotalPrice(equipment.rentalPrice, equipment.rentalType, start, end, qty);
  if (totalPrice <= 0) return error(res, "Total price calculation failed", 400, "INVALID_PRICE");

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

  // Use inventory guard to check availability and create intent
  let intentId;
  try {
    await withInventoryGuard(db, equipmentId, start, end, qty, async (session) => {
      const intentDoc = {
        equipmentId,
        userId: req.user.id,
        ownerId: equipment.ownerId,
        startDate: start,
        endDate: end,
        quantity: qty,
        contactPhone: contactPhone || null,
        deliveryAddress: deliveryAddress || null,
        notes: notes || null,
        totalPrice,
        currency: "usd",
        status: "pending",
        expiresAt,
        released: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).insertOne(intentDoc, { session });
      intentId = result.insertedId;
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_INVENTORY") {
      return error(res, "Not enough inventory available for the requested dates", 409, "INSUFFICIENT_INVENTORY");
    }
    throw err;
  }

  // Create Stripe Checkout Session
  const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: equipment.name,
            description: `Rental from ${start.toDateString()} to ${end.toDateString()} (${qty} unit${qty > 1 ? "s" : ""})`,
            images: equipment.image ? [equipment.image] : [],
          },
          unit_amount: Math.round(totalPrice * 100),
        },
        quantity: 1,
      },
    ],
    metadata: {
      checkoutIntentId: intentId.toString(),
      equipmentId: equipmentId.toString(),
      userId: req.user.id,
      ownerId: equipment.ownerId,
    },
    success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${clientUrl}/payment/cancel?intent_id=${intentId}`,
    expires_at: Math.floor(expiresAt.getTime() / 1000),
  });

  // Save stripe session ID to intent
  await db.collection(COLLECTIONS.CHECKOUT_INTENTS).updateOne(
    { _id: intentId },
    { $set: { stripeSessionId: session.id, updatedAt: new Date() } }
  );

  return success(res, { url: session.url, checkoutIntentId: intentId, sessionId: session.id }, 201);
}

// GET /api/bookings
export async function getBookings(req, res) {
  const db = getDB();
  const role = req.profile?.role;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  const skip = (page - 1) * limit;

  let filter = {};
  if (role === "customer") {
    filter.userId = req.user.id;
  } else if (role === "owner") {
    filter.ownerId = req.user.id;
  }
  // admin sees all

  const pipeline = [
    { $match: filter },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from: COLLECTIONS.EQUIPMENT,
        let: { eqId: "$equipmentId" },
        pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$eqId"] } } }],
        as: "equipment",
      },
    },
    { $unwind: { path: "$equipment", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: COLLECTIONS.PROFILES,
        localField: "userId",
        foreignField: "betterAuthUserId",
        as: "customer",
      },
    },
    { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
  ];

  const [bookings, total] = await Promise.all([
    db.collection(COLLECTIONS.BOOKINGS).aggregate(pipeline).toArray(),
    db.collection(COLLECTIONS.BOOKINGS).countDocuments(filter),
  ]);

  return success(res, {
    bookings,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

// GET /api/bookings/:id
export async function getBookingById(req, res) {
  const db = getDB();
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return error(res, "Invalid booking ID", 400, "INVALID_ID");
  }

  const booking = await db.collection(COLLECTIONS.BOOKINGS).findOne({ _id: id });
  if (!booking) return error(res, "Booking not found", 404, "NOT_FOUND");

  const role = req.profile?.role;
  if (role !== "admin" && booking.userId !== req.user.id && booking.ownerId !== req.user.id) {
    return error(res, "Forbidden", 403, "FORBIDDEN");
  }

  return success(res, { booking });
}

// PATCH /api/bookings/:id/status
export async function updateBookingStatus(req, res) {
  const db = getDB();
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return error(res, "Invalid booking ID", 400, "INVALID_ID");
  }

  const { bookingStatus } = req.body;
  const validStatuses = ["pending", "confirmed", "completed", "cancelled"];
  if (!validStatuses.includes(bookingStatus)) {
    return error(res, "Invalid booking status", 400, "INVALID_STATUS");
  }

  const booking = await db.collection(COLLECTIONS.BOOKINGS).findOne({ _id: id });
  if (!booking) return error(res, "Booking not found", 404, "NOT_FOUND");

  const role = req.profile?.role;
  if (role !== "admin" && booking.ownerId !== req.user.id) {
    return error(res, "Forbidden", 403, "FORBIDDEN");
  }

  await db.collection(COLLECTIONS.BOOKINGS).updateOne(
    { _id: id },
    { $set: { bookingStatus, updatedAt: new Date() } }
  );

  const updated = await db.collection(COLLECTIONS.BOOKINGS).findOne({ _id: id });
  return success(res, { booking: updated });
}
