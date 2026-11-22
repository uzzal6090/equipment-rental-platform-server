import Stripe from "stripe";
import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../../config/indexes.js";
import { withInventoryGuard } from "../../inventory/transaction.js";
import {
  getCheckoutIntentById,
  releaseIntentReservation,
  createBookingFromIntent,
  createPaymentRecord,
} from "./booking.service.js";

let stripeInstance = null;

function getStripe() {
  if (!stripeInstance) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY environment variable is not set");
    }
    const opts = { apiVersion: "2024-04-10" };
    // Test-only override for local Stripe API mock; ignored in production.
    if (process.env.NODE_ENV === "test" && process.env.STRIPE_API_HOST) {
      opts.host = process.env.STRIPE_API_HOST;
      opts.protocol = process.env.STRIPE_API_PROTOCOL || "http";
      opts.port = Number(process.env.STRIPE_API_PORT || 12111);
    }
    stripeInstance = new Stripe(secretKey, opts);
  }
  return stripeInstance;
}

async function createStripeCheckoutSession(db, intent, equipment, customerEmail, successUrl, cancelUrl) {
  const stripe = getStripe();

  const rentalDays = calculateRentalDays(intent.startDate, intent.endDate, intent.rentalType);
  const unitAmount = Math.round(intent.totalPrice * 100); // Convert to cents

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    customer_email: customerEmail,
    line_items: [
      {
        price_data: {
          currency: intent.currency || "usd",
          product_data: {
            name: `Rental: ${intent.equipmentName || "Equipment"}`,
            description: `${intent.equipmentCategory || "Equipment"} • ${intent.rentalDays || "N/A"} ${intent.rentalType || "day"}(s) × ${intent.quantity} unit(s)`,
            images: intent.equipmentImage ? [intent.equipmentImage] : [],
            metadata: {
              checkout_intent_id: intent._id.toString(),
              equipment_id: intent.equipmentId.toString(),
            },
          },
          unit_amount: unitAmount,
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      checkout_intent_id: intent._id.toString(),
      equipment_id: intent.equipmentId.toString(),
      user_id: intent.userId.toString(),
      owner_id: intent.ownerId.toString(),
    },
    payment_intent_data: {
      metadata: {
        checkout_intent_id: intent._id.toString(),
        equipment_id: intent.equipmentId.toString(),
        user_id: intent.userId.toString(),
        owner_id: intent.ownerId.toString(),
      },
    },
    expires_at: Math.floor(intent.expiresAt.getTime() / 1000),
  });

  return session;
}

async function handleStripeWebhook(db, event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      return await handleCheckoutCompleted(db, session);
    }
    case "checkout.session.expired": {
      const session = event.data.object;
      return await handleCheckoutExpired(db, session);
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object;
      return await handleAsyncPaymentFailed(db, session);
    }
    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object;
      return await handlePaymentFailed(db, paymentIntent);
    }
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object;
      return await handlePaymentIntentSucceeded(db, paymentIntent);
    }
    default:
      console.log(`Unhandled Stripe event type: ${event.type}`);
      return { received: true, ignored: true };
  }
}

async function handleCheckoutCompleted(db, session) {
  const checkoutIntentId = session.metadata?.checkout_intent_id;
  if (!checkoutIntentId) {
    return { received: true, error: "Missing checkout_intent_id" };
  }

  const intent = await getCheckoutIntentById(db, checkoutIntentId);
  if (!intent) {
    return { received: true, error: "Checkout intent not found" };
  }

  const updatedIntent = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).findOneAndUpdate(
    { _id: intent._id, status: "pending" },
    { $set: { status: "processing", updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!updatedIntent) {
    const currentIntent = await getCheckoutIntentById(db, checkoutIntentId);
    if (currentIntent && currentIntent.status === "completed") {
      return { received: true, status: "already_processed" };
    }
    if (!currentIntent) {
      return { received: true, error: "Checkout intent not found after update" };
    }
    if (currentIntent.status !== "processing") {
      return { received: true, status: `not_processed_status_${currentIntent.status}` };
    }
    // Another worker already moved it to processing; continue idempotently.
  }

  const revertToPending = async () => {
    await db.collection(COLLECTIONS.CHECKOUT_INTENTS).updateOne(
      { _id: intent._id, status: "processing" },
      { $set: { status: "pending", updatedAt: new Date() } }
    );
  };

  if (session.payment_status !== "paid") {
    await revertToPending();
    return { received: true, status: "payment_not_completed" };
  }

  const expectedAmount = Math.round(Number(intent.totalPrice) * 100);
  if (Number(session.amount_total) !== expectedAmount) {
    await revertToPending();
    return { received: true, error: "Amount mismatch", status: "amount_mismatch" };
  }

  if (session.currency !== (intent.currency || "usd")) {
    await revertToPending();
    return { received: true, error: "Currency mismatch", status: "currency_mismatch" };
  }

  if (session.metadata?.checkout_intent_id !== checkoutIntentId) {
    await revertToPending();
    return { received: true, error: "Session metadata mismatch", status: "metadata_mismatch" };
  }

  if (
    session.metadata?.user_id !== intent.userId.toString() ||
    session.metadata?.equipment_id !== intent.equipmentId.toString()
  ) {
    await revertToPending();
    return { received: true, error: "Session metadata user/equipment mismatch", status: "metadata_mismatch" };
  }

  if (intent.expiresAt && new Date() > new Date(intent.expiresAt)) {
    await releaseIntentReservation(db, intent._id, "expired");
    return { received: true, error: "Intent expired", status: "intent_expired" };
  }

  try {
    let bookingId;
    let guardResult;
    try {
      guardResult = await withInventoryGuard(
        db,
        intent.equipmentId,
        new Date(intent.startDate),
        new Date(intent.endDate),
        0,
        async (txSession) => {
          const lockedIntent = await db.collection(COLLECTIONS.CHECKOUT_INTENTS).findOne(
            { _id: intent._id },
            { session: txSession }
          );
          if (!lockedIntent) throw Object.assign(new Error("Intent not found"), { statusCode: 404 });
          if (lockedIntent.status === "completed") {
            const existing = await db.collection(COLLECTIONS.BOOKINGS).findOne({ checkoutIntent: intent._id }, { session: txSession });
            return { bookingId: existing?._id, status: "already_completed" };
          }
          if (lockedIntent.status !== "processing") {
            return { status: `not_processing_${lockedIntent.status}` };
          }

          const existingBooking = await db.collection(COLLECTIONS.BOOKINGS).findOne(
            { checkoutIntent: intent._id },
            { session: txSession }
          );
          if (existingBooking) {
            bookingId = existingBooking._id;
          } else {
            const booking = await createBookingFromIntent(db, intent, session.id, session.payment_intent, txSession);
            bookingId = booking._id;
          }

          const existingPayment = await db.collection(COLLECTIONS.PAYMENTS).findOne(
            { stripeSessionId: session.id },
            { session: txSession }
          );
          if (!existingPayment) {
            await createPaymentRecord(
              db,
              bookingId.toString(),
              intent._id.toString(),
              intent.userId.toString(),
              session.id,
              session.payment_intent,
              Number(session.amount_total) / 100,
              session.currency || "usd",
              "paid",
              txSession
            );
          }

          await db.collection(COLLECTIONS.CHECKOUT_INTENTS).updateOne(
            { _id: intent._id, status: "processing" },
            { $set: { status: "completed", released: true, updatedAt: new Date() } },
            { session: txSession }
          );
          return { bookingId, status: "booking_created" };
        }
      );
    } catch (guardError) {
      if (guardError?.code === "INSUFFICIENT_INVENTORY") {
        // Payment succeeded but reservation no longer holds. Keep intent processing
        // (inventory still counted) and surface for manual reconciliation; do not
        // revert to pending and do not release reservation.
        console.error(`Inventory guard rejected paid intent ${checkoutIntentId}:`, guardError);
        return { received: true, error: "Inventory conflict for paid intent", status: "paid_inventory_conflict" };
      }
      throw guardError;
    }

    if (guardResult?.status === "already_completed") {
      return { received: true, bookingId: guardResult.bookingId?.toString(), status: "already_processed" };
    }
    if (guardResult?.status && guardResult.status.startsWith("not_processing_")) {
      return { received: true, status: guardResult.status };
    }
    return { received: true, bookingId: guardResult?.bookingId?.toString(), status: "booking_created" };
  } catch (txError) {
    console.error(`Transaction failed for intent ${checkoutIntentId}:`, txError);
    try {
      await revertToPending();
    } catch (revertErr) {
      console.error("Failed to revert intent to pending:", revertErr);
    }
    return { received: true, error: "Transaction failed", status: "transaction_failed" };
  }
}

async function handleCheckoutExpired(db, session) {
  const checkoutIntentId = session.metadata?.checkout_intent_id;
  if (!checkoutIntentId) {
    return { received: true, error: "Missing checkout_intent_id" };
  }

  const intent = await getCheckoutIntentById(db, checkoutIntentId);
  if (!intent) {
    return { received: true, error: "Checkout intent not found" };
  }

  if (intent.status === "pending" && !intent.released) {
    await releaseIntentReservation(db, intent._id, "expired");
  }

  return { received: true, status: "checkout_expired" };
}

async function handlePaymentFailed(db, paymentIntent) {
  const checkoutIntentId = paymentIntent.metadata?.checkout_intent_id;
  if (!checkoutIntentId) {
    return { received: true, error: "Missing checkout_intent_id" };
  }

  const intent = await getCheckoutIntentById(db, checkoutIntentId);
  if (!intent) {
    return { received: true, error: "Checkout intent not found" };
  }

  if (intent.status === "pending" && !intent.released) {
    await releaseIntentReservation(db, intent._id, "failed");
  }

  return { received: true, status: "payment_failed" };
}

async function handleAsyncPaymentFailed(db, session) {
  const checkoutIntentId = session.metadata?.checkout_intent_id;
  if (!checkoutIntentId) {
    return { received: true, error: "Missing checkout_intent_id" };
  }

  const intent = await getCheckoutIntentById(db, checkoutIntentId);
  if (!intent) {
    return { received: true, error: "Checkout intent not found" };
  }

  if (intent.status === "pending" && !intent.released) {
    await releaseIntentReservation(db, intent._id, "failed");
  }

  return { received: true, status: "async_payment_failed" };
}

async function handlePaymentIntentSucceeded(db, paymentIntent) {
  // This is a backup in case checkout.session.completed is missed
  const checkoutIntentId = paymentIntent.metadata?.checkout_intent_id;
  if (!checkoutIntentId) {
    return { received: true };
  }

  const intent = await getCheckoutIntentById(db, checkoutIntentId);
  if (!intent) {
    return { received: true };
  }

  if (intent.status === "completed") {
    return { received: true, status: "already_processed" };
  }

  // We should have already processed this via checkout.session.completed
  // But handle it just in case
  return { received: true, status: "payment_intent_succeeded" };
}

export {
  getStripe,
  handleStripeWebhook,
  handleCheckoutCompleted,
  handleCheckoutExpired,
  handlePaymentFailed,
  handleAsyncPaymentFailed,
  handlePaymentIntentSucceeded,
  createStripeCheckoutSession,
};