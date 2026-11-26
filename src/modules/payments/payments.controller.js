import Stripe from "stripe";
import { ObjectId } from "mongodb";
import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { success, error } from "../../utils/response.js";
import { queueBookingEmails } from "../../jobs/emailProcessor.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// POST /api/stripe/webhook - raw body required
export async function handleStripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Webhook signature verification failed" });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    await handleCheckoutComplete(session);
  }

  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    await handleCheckoutExpired(session);
  }

  res.json({ received: true });
}

async function handleCheckoutComplete(session) {
  const db = getDB();
  const { checkoutIntentId, equipmentId, userId, ownerId } = session.metadata;

  if (!checkoutIntentId) return;

  let intentOid;
  try {
    intentOid = new ObjectId(checkoutIntentId);
  } catch {
    return;
  }

  // Idempotency: check if booking already created for this session
  const existingBooking = await db.collection(COLLECTIONS.BOOKINGS).findOne({
    stripeSessionId: session.id,
  });
  if (existingBooking) return;

  // Get checkout intent
  const intent = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).findOne({ _id: intentOid });
  if (!intent) return;
  if (intent.status !== "pending") return;

  // Create booking
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
    checkoutIntent: intentOid,
    stripeSessionId: session.id,
    totalPrice: intent.totalPrice,
    bookingDate: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const bookingResult = await db.collection(COLLECTIONS.BOOKINGS).insertOne(booking);
  const bookingId = bookingResult.insertedId;

  // Create payment record
  await db.collection(COLLECTIONS.PAYMENTS).insertOne({
    bookingId,
    checkoutIntent: intentOid,
    customerId: intent.userId,
    stripeSessionId: session.id,
    stripePaymentIntentId: session.payment_intent || null,
    amount: intent.totalPrice,
    currency: intent.currency || "usd",
    status: "paid",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Update intent to consumed
  await db.collection(COLLECTIONS.CHECKOUT_INTENTS).updateOne(
    { _id: intentOid },
    { $set: { status: "consumed", updatedAt: new Date() } }
  );

  // Queue email notifications
  try {
    await queueBookingEmails(db, bookingId, intent);
  } catch (err) {
    console.error("Failed to queue booking emails:", err.message);
  }

  console.log(`Booking created: ${bookingId} for session ${session.id}`);
}

async function handleCheckoutExpired(session) {
  const db = getDB();
  const { checkoutIntentId } = session.metadata || {};
  if (!checkoutIntentId) return;

  let intentOid;
  try {
    intentOid = new ObjectId(checkoutIntentId);
  } catch {
    return;
  }

  await db.collection(COLLECTIONS.CHECKOUT_INTENTS).updateOne(
    { _id: intentOid, status: "pending" },
    { $set: { status: "expired", updatedAt: new Date() } }
  );
}

// GET /api/payments - admin
export async function getPayments(req, res) {
  const db = getDB();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const [payments, total] = await Promise.all([
    db.collection(COLLECTIONS.PAYMENTS).find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    db.collection(COLLECTIONS.PAYMENTS).countDocuments({}),
  ]);

  return success(res, {
    payments,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
