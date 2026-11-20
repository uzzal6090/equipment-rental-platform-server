const USER_ROLES = ["customer", "owner", "admin"];

const EQUIPMENT_STATUSES = ["pending", "approved", "rejected"];
const RENTAL_TYPES = ["daily", "weekly", "monthly"];

const BOOKING_STATUSES = ["pending", "confirmed", "completed", "cancelled"];
const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"];
const INTENT_STATUSES = ["pending", "consumed", "expired", "cancelled", "released", "failed"];
const EMAIL_STATUSES = ["pending", "sent", "failed"];
const EMAIL_RECIPIENT_TYPES = ["renter", "owner"];

// Application profile fields, managed by the application. Better Auth manages its
// own authentication data (passwordHash, etc.) and its own collection names;
// neither is assumed or required here.
const PROFILE_FIELDS = {
  _id: "ObjectId",
  betterAuthUserId: { type: "string", required: true, unique: true },
  name: { type: "string", required: true },
  email: { type: "string", required: true },
  profileImage: { type: "string", optional: true },
  phone: { type: "string", optional: true },
  address: { type: "string", optional: true },
  role: { type: "string", enum: USER_ROLES, default: "customer" },
  roleVersion: { type: "number", default: 0 },
  createdAt: { type: "date", default: () => new Date() },
  updatedAt: { type: "date", default: () => new Date() },
};

// Canonical equipment inventory field is totalQuantity (total listed inventory,
// not currently available inventory). Availability remains date-aware and is
// computed dynamically in src/inventory/transaction.js.
//
// Canonical equipment status replaces the legacy isApproved boolean. Default is
// "pending" until an owner/admin approves the listing.
//
// NOTE: These are schema descriptors only. They document the intended data model
// and are NOT enforced as runtime validation unless a real validation layer is
// implemented.
const EQUIPMENT_FIELDS = {
  _id: "ObjectId",
  ownerId: { type: "ObjectId", required: true },
  name: { type: "string", required: true },
  description: { type: "string", required: true },
  category: { type: "string", required: true },
  location: { type: "string", required: true },
  rentalPrice: { type: "number", required: true }, // must be non-negative
  rentalType: { type: "string", enum: RENTAL_TYPES, required: true }, // daily | weekly | monthly
  totalQuantity: { type: "number", default: 1 }, // must be a positive integer
  condition: { type: "string", required: true },
  brand: { type: "string", optional: true },
  model: { type: "string", optional: true },
  image: { type: "string", optional: true },
  rentalTerms: { type: "string", optional: true },
  status: { type: "string", enum: EQUIPMENT_STATUSES, default: "pending" }, // pending | approved | rejected
  featured: { type: "boolean", default: false },
  inventoryVersion: { type: "number", default: 0 },
  createdAt: { type: "date", default: () => new Date() },
  updatedAt: { type: "date", default: () => new Date() },
};

const BOOKING_FIELDS = {
  _id: "ObjectId",
  equipmentId: { type: "ObjectId", required: true },
  ownerId: { type: "ObjectId", required: true },
  userId: { type: "ObjectId", required: true },
  startDate: { type: "date", required: true },
  endDate: { type: "date", required: true },
  quantity: { type: "number", required: true }, // must be a positive integer
  contactPhone: { type: "string", optional: true },
  deliveryAddress: { type: "string", optional: true },
  notes: { type: "string", optional: true },
  bookingStatus: { type: "string", enum: BOOKING_STATUSES, default: "pending" },
  paymentStatus: { type: "string", enum: PAYMENT_STATUSES, default: "pending" },
  checkoutIntent: { type: "ObjectId", unique: true, sparse: true },
  stripeSessionId: { type: "string", unique: true, sparse: true },
  // Server-calculated total amount; clients must not supply this. Must be non-negative.
  totalPrice: { type: "number", required: true },
  bookingDate: { type: "date", default: () => new Date() },
  createdAt: { type: "date", default: () => new Date() },
  updatedAt: { type: "date", default: () => new Date() },
};

const CHECKOUT_INTENT_FIELDS = {
  _id: "ObjectId",
  equipmentId: { type: "ObjectId", required: true },
  userId: { type: "ObjectId", required: true },
  ownerId: { type: "ObjectId", required: true },
  startDate: { type: "date", required: true },
  endDate: { type: "date", required: true },
  quantity: { type: "number", required: true }, // must be a positive integer
  contactPhone: { type: "string", optional: true },
  deliveryAddress: { type: "string", optional: true },
  notes: { type: "string", optional: true },
  // Server-calculated total amount; clients must not supply this. Must be non-negative.
  totalPrice: { type: "number", required: true },
  currency: { type: "string", default: "usd" },
  stripeSessionId: { type: "string", unique: true, sparse: true },
  status: { type: "string", enum: INTENT_STATUSES, default: "pending" },
  expiresAt: { type: "date", required: true },
  released: { type: "boolean", default: false },
  inventoryVersionSeen: { type: "number", optional: true },
  createdAt: { type: "date", default: () => new Date() },
  updatedAt: { type: "date", default: () => new Date() },
};

const PAYMENT_FIELDS = {
  _id: "ObjectId",
  bookingId: { type: "ObjectId", required: true },
  checkoutIntent: { type: "ObjectId", unique: true, sparse: true },
  customerId: { type: "ObjectId", required: true },
  stripeSessionId: { type: "string", unique: true, sparse: true },
  stripePaymentIntentId: { type: "string", optional: true },
  amount: { type: "number", required: true }, // must be non-negative
  currency: { type: "string", default: "usd" },
  status: { type: "string", enum: PAYMENT_STATUSES, default: "pending" },
  createdAt: { type: "date", default: () => new Date() },
  updatedAt: { type: "date", default: () => new Date() },
};

const FAVORITE_FIELDS = {
  _id: "ObjectId",
  userId: { type: "ObjectId", required: true },
  equipmentId: { type: "ObjectId", required: true },
  createdAt: { type: "date", default: () => new Date() },
};

const REVIEW_FIELDS = {
  _id: "ObjectId",
  equipmentId: { type: "ObjectId", required: true },
  userId: { type: "ObjectId", required: true },
  rating: { type: "number", min: 1, max: 5, required: true },
  comment: { type: "string", optional: true },
  createdAt: { type: "date", default: () => new Date() },
};

const EMAIL_OUTBOX_FIELDS = {
  _id: "ObjectId",
  bookingId: { type: "ObjectId", required: true },
  recipientType: { type: "string", enum: EMAIL_RECIPIENT_TYPES, required: true },
  recipientEmail: { type: "string", required: true },
  template: { type: "string", required: true },
  status: { type: "string", enum: EMAIL_STATUSES, default: "pending" },
  attempts: { type: "number", default: 0 },
  lastAttemptAt: { type: "date", optional: true },
  lastError: { type: "string", optional: true },
  createdAt: { type: "date", default: () => new Date() },
  sentAt: { type: "date", optional: true },
};

// These descriptors document the intended data model. They are not enforced as
// runtime validation unless an actual validation layer is implemented.
const SCHEMAS = {
  profiles: PROFILE_FIELDS,
  equipment: EQUIPMENT_FIELDS,
  bookings: BOOKING_FIELDS,
  checkoutIntents: CHECKOUT_INTENT_FIELDS,
  payments: PAYMENT_FIELDS,
  favorites: FAVORITE_FIELDS,
  reviews: REVIEW_FIELDS,
  emailOutbox: EMAIL_OUTBOX_FIELDS,
};

function getSchema(collectionName) {
  return SCHEMAS[collectionName];
}

export {
  USER_ROLES,
  EQUIPMENT_STATUSES,
  RENTAL_TYPES,
  BOOKING_STATUSES,
  PAYMENT_STATUSES,
  INTENT_STATUSES,
  EMAIL_STATUSES,
  EMAIL_RECIPIENT_TYPES,
  PROFILE_FIELDS,
  EQUIPMENT_FIELDS,
  BOOKING_FIELDS,
  CHECKOUT_INTENT_FIELDS,
  PAYMENT_FIELDS,
  FAVORITE_FIELDS,
  REVIEW_FIELDS,
  EMAIL_OUTBOX_FIELDS,
  SCHEMAS,
  getSchema,
};
