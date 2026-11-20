const COLLECTIONS = {
  EQUIPMENT: "equipment",
  BOOKINGS: "bookings",
  CHECKOUT_INTENTS: "checkoutIntents",
  PAYMENTS: "payments",
  FAVORITES: "favorites",
  REVIEWS: "reviews",
  EMAIL_OUTBOX: "emailOutbox",
  PROFILES: "profiles",
};

async function createCollections(db) {
  const existing = await db.listCollections().toArray();
  const existingNames = new Set(existing.map((c) => c.name));
  for (const name of Object.values(COLLECTIONS)) {
    if (!existingNames.has(name)) {
      await db.createCollection(name);
    }
  }
}

// Correctness-critical indexes: unique constraints that underpin idempotency.
// Failures on these are reported as migration-required conflicts; they are
// never silently swallowed and never auto-dropped.
const CRITICAL_UNIQUE_INDEXES = new Set([
  "profiles.betterAuthUserId_1",
  "bookings.checkoutIntent_1",
  "bookings.stripeSessionId_1",
  "payments.checkoutIntent_1",
  "payments.stripeSessionId_1",
  "favorites.userId_1_equipmentId_1",
  "emailOutbox.bookingId_1_recipientType_1",
]);

async function safeCreateIndex(db, collectionName, keys, options = {}) {
  const indexName = Object.keys(keys)
    .map((k) => `${k}_${keys[k]}`)
    .join("_");
  const criticalKey = `${collectionName}.${indexName}`;
  const isCritical = CRITICAL_UNIQUE_INDEXES.has(criticalKey) && options.unique;

  try {
    await db.collection(collectionName).createIndex(keys, options);
    return;
  } catch (error) {
    const message = error.message || String(error);
    // IndexAlreadyExists or options conflict on a pre-existing index created by
    // an earlier code version. Per project rules we do not drop or alter
    // existing indexes without explicit approval.
    if (isCritical) {
      console.error(
        `MIGRATION REQUIRED: correctness-critical unique index could not be ensured on ${criticalKey}: ${message}. ` +
          "Do not drop existing indexes; reconcile manually before production use."
      );
      throw error;
    } else {
      console.warn(
        `Index warning on ${collectionName}: ${message}`
      );
    }
  }
}

async function createIndexes(db) {
  // profiles (application profile; auth data is managed by Better Auth)
  await safeCreateIndex(db, COLLECTIONS.PROFILES, { betterAuthUserId: 1 }, { unique: true });
  await safeCreateIndex(db, COLLECTIONS.PROFILES, { email: 1 });
  await safeCreateIndex(db, COLLECTIONS.PROFILES, { role: 1 });

  // equipment. Canonical status field replaces the legacy isApproved boolean.
  await safeCreateIndex(db, COLLECTIONS.EQUIPMENT, { ownerId: 1 });
  await safeCreateIndex(db, COLLECTIONS.EQUIPMENT, { status: 1, featured: 1 });
  await safeCreateIndex(db, COLLECTIONS.EQUIPMENT, { category: 1 });
  await safeCreateIndex(db, COLLECTIONS.EQUIPMENT, { location: 1 });
  await safeCreateIndex(db, COLLECTIONS.EQUIPMENT, { status: 1, createdAt: -1 });

  // bookings
  await safeCreateIndex(db, COLLECTIONS.BOOKINGS, { equipmentId: 1, startDate: 1, endDate: 1 });
  await safeCreateIndex(db, COLLECTIONS.BOOKINGS, { equipmentId: 1, bookingStatus: 1 });
  await safeCreateIndex(db, COLLECTIONS.BOOKINGS, { userId: 1 });
  await safeCreateIndex(db, COLLECTIONS.BOOKINGS, { ownerId: 1 });
  await safeCreateIndex(db, COLLECTIONS.BOOKINGS, { checkoutIntent: 1 }, { unique: true, sparse: true });
  await safeCreateIndex(db, COLLECTIONS.BOOKINGS, { stripeSessionId: 1 }, { unique: true, sparse: true });
  await safeCreateIndex(db, COLLECTIONS.BOOKINGS, { bookingStatus: 1, paymentStatus: 1, endDate: 1 });

  // checkoutIntents
  // NOTE: No TTL index on expiresAt. Expired intents transition pending -> expired
  // through the future expiry lifecycle process; TTL deletion is never used to
  // release inventory.
  await safeCreateIndex(db, COLLECTIONS.CHECKOUT_INTENTS, { equipmentId: 1, status: 1, expiresAt: 1 });
  await safeCreateIndex(db, COLLECTIONS.CHECKOUT_INTENTS, { userId: 1 });

  // payments
  await safeCreateIndex(db, COLLECTIONS.PAYMENTS, { checkoutIntent: 1 }, { unique: true, sparse: true });
  // sparse so documents without a stripeSessionId do not collide under uniqueness
  await safeCreateIndex(db, COLLECTIONS.PAYMENTS, { stripeSessionId: 1 }, { unique: true, sparse: true });
  await safeCreateIndex(db, COLLECTIONS.PAYMENTS, { status: 1 });

  // favorites
  await safeCreateIndex(db, COLLECTIONS.FAVORITES, { userId: 1, equipmentId: 1 }, { unique: true });

  // reviews
  await safeCreateIndex(db, COLLECTIONS.REVIEWS, { equipmentId: 1 });
  await safeCreateIndex(db, COLLECTIONS.REVIEWS, { userId: 1 });

  // emailOutbox: idempotent completion notification to both renter and owner.
  // Composite unique key allows one pending notification per booking per recipient.
  await safeCreateIndex(db, COLLECTIONS.EMAIL_OUTBOX, { bookingId: 1, recipientType: 1 }, { unique: true });
  await safeCreateIndex(db, COLLECTIONS.EMAIL_OUTBOX, { status: 1 });
  await safeCreateIndex(db, COLLECTIONS.EMAIL_OUTBOX, { createdAt: 1 });
}

async function ensureDatabase(db) {
  await createCollections(db);
  await createIndexes(db);
}

export { COLLECTIONS, createCollections, createIndexes, ensureDatabase };
