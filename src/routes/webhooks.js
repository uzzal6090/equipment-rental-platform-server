import express from "express";
import { success, error } from "../utils/response.js";
import { getDB } from "../config/db.js";
import { getStripe } from "../modules/equipment/stripe.service.js";
import { handleStripeWebhook } from "../modules/equipment/stripe.service.js";
import { COLLECTIONS } from "../config/indexes.js";

const router = express.Router();

const processedEventCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 60 * 1000;

function isEventProcessed(eventId) {
  const cached = processedEventCache.get(eventId);
  if (cached && Date.now() - cached < CACHE_TTL_MS) return true;
  if (cached) processedEventCache.delete(eventId);
  return false;
}

function markEventProcessed(eventId) {
  processedEventCache.set(eventId, Date.now());
  if (processedEventCache.size > 10000) {
    const now = Date.now();
    for (const [key, timestamp] of processedEventCache.entries()) {
      if (now - timestamp > CACHE_TTL_MS) processedEventCache.delete(key);
    }
  }
}

async function claimWebhookEvent(db, event) {
  const coll = db.collection(COLLECTIONS.WEBHOOK_EVENTS || "webhookEvents");
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + PROCESSING_LEASE_MS);

  const existing = await coll.findOne({ eventId: event.id });
  if (existing?.status === "completed") {
    return { claimed: false, state: "completed", existing };
  }
  if (existing?.status === "processing" && existing.leaseUntil && new Date(existing.leaseUntil) > now) {
    return { claimed: false, state: "processing", existing };
  }

  if (!existing) {
    try {
      await coll.insertOne({
        eventId: event.id,
        eventType: event.type,
        status: "processing",
        leaseUntil,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { claimed: true, state: "claimed" };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      // Duplicate key means another worker claimed concurrently; fall through to re-read.
    }
  }

  const reclaim = await coll.findOneAndUpdate(
    {
      eventId: event.id,
      $or: [
        { status: "failed" },
        { status: "processing", leaseUntil: { $lte: now } },
        { status: "processing", leaseUntil: { $exists: false } },
      ],
    },
    {
      $set: { status: "processing", leaseUntil, updatedAt: now, eventType: event.type },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" }
  );
  const reclaimed = reclaim?.value || reclaim;
  if (reclaimed) return { claimed: true, state: "reclaimed" };

  const after = await coll.findOne({ eventId: event.id });
  if (after?.status === "completed") return { claimed: false, state: "completed", existing: after };
  return { claimed: false, state: after?.status || "unknown", existing: after };
}

async function completeWebhookEvent(db, event, result) {
  const coll = db.collection(COLLECTIONS.WEBHOOK_EVENTS || "webhookEvents");
  const now = new Date();
  await coll.updateOne(
    { eventId: event.id },
    {
      $set: {
        status: "completed",
        eventType: event.type,
        processedAt: now,
        completedAt: now,
        updatedAt: now,
        result,
        leaseUntil: null,
        lastError: null,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

async function failWebhookEvent(db, event, err) {
  const coll = db.collection(COLLECTIONS.WEBHOOK_EVENTS || "webhookEvents");
  const now = new Date();
  await coll.updateOne(
    { eventId: event.id },
    {
      $set: {
        status: "failed",
        eventType: event.type,
        updatedAt: now,
        leaseUntil: null,
        lastError: err?.message || String(err),
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

router.post("/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error("STRIPE_WEBHOOK_SECRET not configured");
      return error(res, "Webhook secret not configured", 500, "WEBHOOK_SECRET_MISSING");
    }
    if (!sig) {
      return error(res, "Missing stripe-signature header", 400, "MISSING_SIGNATURE");
    }

    const stripe = getStripe();
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return error(res, "Webhook signature verification failed", 400, "INVALID_SIGNATURE");
    }

    if (isEventProcessed(event.id)) {
      return success(res, { received: true, status: "duplicate_event_ignored" });
    }

    const db = getDB();
    const claim = await claimWebhookEvent(db, event);
    if (!claim.claimed) {
      if (claim.state === "completed") {
        markEventProcessed(event.id);
        return success(res, { received: true, status: "duplicate_event_ignored" });
      }
      return success(res, { received: true, status: "event_in_progress" });
    }

    try {
      const result = await handleStripeWebhook(db, event);
      await completeWebhookEvent(db, event, result);
      markEventProcessed(event.id);
      return success(res, result);
    } catch (err) {
      console.error("Webhook processing error:", err);
      try {
        await failWebhookEvent(db, event, err);
      } catch (persistErr) {
        console.error("Failed to persist webhook failure state:", persistErr);
      }
      return error(res, "Webhook processing failed", 500, "WEBHOOK_PROCESSING_FAILED");
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
    return error(res, "Webhook processing failed", 500, "WEBHOOK_PROCESSING_FAILED");
  }
});

router.get("/stripe", (req, res) => {
  return success(res, { message: "Stripe webhook endpoint is active. Use POST with Stripe signature." });
});

export { router as webhooksRouter };