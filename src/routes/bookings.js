import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyRenter } from "../middleware/verifyRenter.js";
import { success, error } from "../utils/response.js";
import { reserveCheckoutIntent, calculateTotalPrice, parseDate, parsePositiveInt, releaseIntentReservation } from "../modules/equipment/booking.service.js";
import { createStripeCheckoutSession, getStripe } from "../modules/equipment/stripe.service.js";
import { getDB } from "../config/db.js";
import { COLLECTIONS } from "../config/indexes.js";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

const router = express.Router();

// All booking routes require authentication and customer role
router.use(verifyToken, verifyRenter);

// POST /api/bookings - Create a checkout intent and redirect to Stripe
router.post("/", async (req, res) => {
  try {
    const userId = req.profile.profileId.toString();
    const {
      equipmentId,
      startDate,
      endDate,
      quantity,
      contactPhone,
      deliveryAddress,
      notes,
    } = req.body;

    // Validate required fields
    if (!equipmentId || !startDate || !endDate || !quantity) {
      return error(res, "equipmentId, startDate, endDate, and quantity are required", 400, "MISSING_REQUIRED_FIELDS");
    }

    // Validate quantity
    const qty = parsePositiveInt(quantity, 1);
    if (qty < 1) {
      return error(res, "Quantity must be a positive integer", 400, "INVALID_QUANTITY");
    }

    // Validate dates
    const start = parseDate(startDate);
    const end = parseDate(endDate);
    if (!start || !end) {
      return error(res, "Invalid date format. Use ISO 8601 format (YYYY-MM-DD)", 400, "INVALID_DATE_FORMAT");
    }

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (start < now) {
      return error(res, "Start date cannot be in the past", 400, "INVALID_START_DATE");
    }
    if (end <= start) {
      return error(res, "End date must be after start date", 400, "INVALID_END_DATE");
    }

    // Validate contact phone if provided
    if (contactPhone && typeof contactPhone !== "string") {
      return error(res, "Contact phone must be a string", 400, "INVALID_CONTACT_PHONE");
    }

    // Validate delivery address if provided
    if (deliveryAddress && typeof deliveryAddress !== "string") {
      return error(res, "Delivery address must be a string", 400, "INVALID_DELIVERY_ADDRESS");
    }

    // Validate notes if provided
    if (notes && typeof notes !== "string") {
      return error(res, "Notes must be a string", 400, "INVALID_NOTES");
    }

    const db = getDB();
    let equipmentObjectId;
    try {
      equipmentObjectId = new ObjectId(equipmentId);
    } catch {
      return error(res, "Invalid equipment ID", 400, "INVALID_EQUIPMENT_ID");
    }

    const equipment = await db.collection("equipment").findOne({ _id: equipmentObjectId });
    if (!equipment) {
      return error(res, "Equipment not found", 404, "EQUIPMENT_NOT_FOUND");
    }

    // Check equipment status
    if (equipment.status !== "approved") {
      return error(res, "Only approved equipment can be booked", 400, "EQUIPMENT_NOT_APPROVED");
    }

    // Date-aware atomic inventory guard: reservation + intent insert in one guarded transaction.
    let intent;
    let totalPrice;
    try {
      totalPrice = calculateTotalPrice(equipment, start, end, qty);
      if (totalPrice <= 0) {
        return error(res, "Invalid rental period or price calculation", 400, "INVALID_PRICE_CALCULATION");
      }

      const ownerId = equipment.ownerId.toString();
      intent = await reserveCheckoutIntent(
        db,
        equipmentId,
        userId,
        ownerId,
        start,
        end,
        qty,
        contactPhone || null,
        deliveryAddress || null,
        notes || null,
        totalPrice
      );

      const stripe = getStripe();
      const session_stripe = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: req.profile.email,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `Rental: ${equipment.name}`,
                description: `${equipment.category} • ${equipment.rentalType} rental × ${qty} unit(s)`,
                images: equipment.image ? [equipment.image] : [],
                metadata: {
                  checkout_intent_id: intent._id.toString(),
                  equipment_id: equipment._id.toString(),
                },
              },
              unit_amount: Math.round(totalPrice * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.CLIENT_URL}/bookings/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/bookings/cancel`,
        metadata: {
          checkout_intent_id: intent._id.toString(),
          equipment_id: equipment._id.toString(),
          user_id: userId,
          owner_id: equipment.ownerId.toString(),
        },
        payment_intent_data: {
          metadata: {
            checkout_intent_id: intent._id.toString(),
            equipment_id: equipment._id.toString(),
            user_id: userId,
            owner_id: equipment.ownerId.toString(),
          },
        },
        expires_at: Math.floor(intent.expiresAt.getTime() / 1000),
      });

      await db.collection("checkoutIntents").updateOne(
        { _id: intent._id, status: "pending" },
        { $set: { stripeSessionId: session_stripe.id, updatedAt: new Date() } }
      );

      return success(res, { checkoutUrl: session_stripe.url, sessionId: session_stripe.id });
    } catch (err) {
      if (intent?._id) {
        try {
          await releaseIntentReservation(db, intent._id, "expired");
        } catch (releaseErr) {
          console.error("Failed to release reservation after checkout failure:", releaseErr);
        }
      }
      if (err.statusCode) {
        return error(res, err.message, err.statusCode, err.code);
      }
      if (err.code === "INSUFFICIENT_INVENTORY" || err.code === "INVENTORY_VERSION_CONFLICT") {
        return error(res, "Equipment not available for the selected dates", 409, "EQUIPMENT_UNAVAILABLE");
      }
      console.error("Create booking error:", err);
      return error(res, "Failed to create booking", 500, "CREATE_BOOKING_FAILED");
    }
  } catch (err) {
    console.error("Create booking error:", err);
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to create booking", 500, "CREATE_BOOKING_FAILED");
  }
});

// POST /api/bookings/cancel/:intentId - Customer cancels their checkout intent
router.post("/cancel/:intentId", async (req, res) => {
  try {
    const userId = req.profile.profileId.toString();
    const { intentId } = req.params;

    if (!intentId) {
      return error(res, "Intent ID is required", 400, "MISSING_INTENT_ID");
    }

    const db = getDB();
    let intentObjectId;
    try {
      intentObjectId = new ObjectId(intentId);
    } catch {
      return error(res, "Invalid intent ID", 400, "INVALID_INTENT_ID");
    }

    const intent = await db.collection("checkoutIntents").findOne({ _id: intentObjectId });
    if (!intent) {
      return error(res, "Checkout intent not found", 404, "INTENT_NOT_FOUND");
    }

    // Verify ownership
    if (intent.userId.toString() !== userId) {
      return error(res, "Unauthorized", 403, "UNAUTHORIZED");
    }

    // Check if intent can be cancelled
    if (intent.status !== "pending") {
      return error(res, `Cannot cancel intent with status: ${intent.status}`, 400, "INVALID_INTENT_STATUS");
    }

    // Release the intent with guarded inventory release
    const releaseResult = await releaseIntentReservation(db, intent._id, "cancelled");
    if (!releaseResult.released) {
      return error(res, "Intent could not be cancelled (already processed or expired)", 400, "CANCEL_FAILED");
    }

    // If there's a Stripe session, try to expire it
    if (intent.stripeSessionId) {
      try {
        const stripe = getStripe();
        await stripe.checkout.sessions.expire(intent.stripeSessionId);
      } catch (stripeErr) {
        console.warn(`Failed to expire Stripe session ${intent.stripeSessionId}:`, stripeErr.message);
        // Don't fail the cancellation if Stripe expire fails
      }
    }

    return success(res, { message: "Booking cancelled successfully", intentId });
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    console.error("Cancel booking error:", err);
    return error(res, "Failed to cancel booking", 500, "CANCEL_FAILED");
  }
});

// GET /api/bookings/checkout/:sessionId - Get booking status after Stripe redirect
router.get("/checkout/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.profile.profileId.toString();

    // Verify the session belongs to this user
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session.metadata?.checkout_intent_id) {
      return error(res, "Invalid checkout session", 400, "INVALID_SESSION");
    }

    const intentId = session.metadata.checkout_intent_id;
    const db = getDB();
    const intent = await db.collection("checkoutIntents").findOne({ _id: new ObjectId(intentId) });

    if (!intent) {
      return error(res, "Checkout intent not found", 404, "INTENT_NOT_FOUND");
    }

    // Verify ownership
    if (intent.userId.toString() !== userId) {
      return error(res, "Unauthorized", 403, "UNAUTHORIZED");
    }

    // Check session status
    if (session.payment_status === "paid") {
      // Verify booking was created
      const booking = await db.collection("bookings").findOne({ checkoutIntent: intent._id });
      if (booking) {
        return success(res, { booking: { ...booking, id: booking._id.toString() }, status: "paid" });
      }
      // Payment is paid but booking not found - this is an edge case
      return success(res, { status: "paid", bookingCreated: false, sessionId });
    }

    return success(res, { status: session.payment_status, sessionId });
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode, err.code);
    }
    return error(res, "Failed to check booking status", 500, "CHECKOUT_STATUS_FAILED");
  }
});

// GET /api/bookings - List customer's bookings (already exists in rentals route)
// This is handled by /api/rentals endpoint

export { router as bookingsRouter };