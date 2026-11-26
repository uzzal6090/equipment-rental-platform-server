import { ObjectId } from "mongodb";
import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { success, error } from "../../utils/response.js";
import { AppError } from "../../middleware/errorHandler.js";

// GET /api/equipment - public, paginated, search, filter, sort
export async function getAllEquipment(req, res) {
  const db = getDB();

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 9));
  const skip = (page - 1) * limit;

  const { search, category, rentalType, minPrice, maxPrice, availability, sort } = req.query;

  // Build filter — only show approved equipment publicly
  const filter = { status: "approved" };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { location: { $regex: search, $options: "i" } },
    ];
  }
  if (category) filter.category = category;
  if (rentalType) filter.rentalType = rentalType;
  if (minPrice || maxPrice) {
    filter.rentalPrice = {};
    if (minPrice) filter.rentalPrice.$gte = parseFloat(minPrice);
    if (maxPrice) filter.rentalPrice.$lte = parseFloat(maxPrice);
  }
  if (availability === "true") filter.totalQuantity = { $gt: 0 };

  // Sorting
  let sortOption = { createdAt: -1 };
  if (sort === "price_asc") sortOption = { rentalPrice: 1 };
  else if (sort === "price_desc") sortOption = { rentalPrice: -1 };
  else if (sort === "newest") sortOption = { createdAt: -1 };

  const [items, total] = await Promise.all([
    db.collection(COLLECTIONS.EQUIPMENT).find(filter).sort(sortOption).skip(skip).limit(limit).toArray(),
    db.collection(COLLECTIONS.EQUIPMENT).countDocuments(filter),
  ]);

  return success(res, {
    equipment: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page < Math.ceil(total / limit),
      hasPrev: page > 1,
    },
  });
}

// GET /api/equipment/featured - 6 approved equipment items
export async function getFeaturedEquipment(req, res) {
  const db = getDB();
  const items = await db
    .collection(COLLECTIONS.EQUIPMENT)
    .aggregate([
      { $match: { status: "approved" } },
      { $sort: { featured: -1, createdAt: -1 } },
      { $limit: 6 },
    ])
    .toArray();
  return success(res, { equipment: items });
}

// GET /api/equipment/:id - public
export async function getEquipmentById(req, res) {
  const db = getDB();
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: id });
  if (!equipment) return error(res, "Equipment not found", 404, "NOT_FOUND");

  // Get owner profile
  let owner = null;
  if (equipment.ownerId) {
    owner = await db.collection(COLLECTIONS.PROFILES).findOne(
      { betterAuthUserId: equipment.ownerId.toString() },
      { projection: { name: 1, profileImage: 1, email: 1 } }
    );
  }

  return success(res, { equipment, owner });
}

// POST /api/equipment - owner only
export async function createEquipment(req, res) {
  const db = getDB();
  const {
    name, description, category, location, rentalPrice, rentalType,
    totalQuantity, condition, brand, model, image, rentalTerms,
  } = req.body;

  if (!name || !description || !category || !location || rentalPrice === undefined || !rentalType || !condition) {
    return error(res, "Missing required fields", 400, "MISSING_FIELDS");
  }

  if (!["daily", "weekly", "monthly"].includes(rentalType)) {
    return error(res, "Invalid rental type", 400, "INVALID_RENTAL_TYPE");
  }

  if (parseFloat(rentalPrice) < 0) {
    return error(res, "Rental price must be non-negative", 400, "INVALID_PRICE");
  }

  const qty = parseInt(totalQuantity) || 1;
  if (qty < 1) return error(res, "Quantity must be at least 1", 400, "INVALID_QUANTITY");

  const doc = {
    ownerId: req.user.id,
    name: name.trim(),
    description: description.trim(),
    category,
    location: location.trim(),
    rentalPrice: parseFloat(rentalPrice),
    rentalType,
    totalQuantity: qty,
    condition,
    brand: brand?.trim() || null,
    model: model?.trim() || null,
    image: image || null,
    rentalTerms: rentalTerms?.trim() || null,
    status: "pending",
    featured: false,
    inventoryVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection(COLLECTIONS.EQUIPMENT).insertOne(doc);
  return success(res, { equipment: { ...doc, _id: result.insertedId } }, 201);
}

// PUT /api/equipment/:id - owner only
export async function updateEquipment(req, res) {
  const db = getDB();
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: id });
  if (!equipment) return error(res, "Equipment not found", 404, "NOT_FOUND");
  if (equipment.ownerId !== req.user.id) return error(res, "Forbidden", 403, "FORBIDDEN");

  const allowed = ["name", "description", "category", "location", "rentalPrice", "rentalType",
    "totalQuantity", "condition", "brand", "model", "image", "rentalTerms"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  updates.updatedAt = new Date();

  await db.collection(COLLECTIONS.EQUIPMENT).updateOne({ _id: id }, { $set: updates });
  const updated = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: id });
  return success(res, { equipment: updated });
}

// DELETE /api/equipment/:id - owner or admin
export async function deleteEquipment(req, res) {
  const db = getDB();
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: id });
  if (!equipment) return error(res, "Equipment not found", 404, "NOT_FOUND");

  const role = req.profile?.role;
  if (role !== "admin" && equipment.ownerId !== req.user.id) {
    return error(res, "Forbidden", 403, "FORBIDDEN");
  }

  await db.collection(COLLECTIONS.EQUIPMENT).deleteOne({ _id: id });
  return success(res, { message: "Equipment deleted successfully" });
}

// PATCH /api/equipment/:id/status - admin only
export async function updateEquipmentStatus(req, res) {
  const db = getDB();
  let id;
  try {
    id = new ObjectId(req.params.id);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const { status } = req.body;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return error(res, "Invalid status value", 400, "INVALID_STATUS");
  }

  const result = await db.collection(COLLECTIONS.EQUIPMENT).updateOne(
    { _id: id },
    { $set: { status, updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) return error(res, "Equipment not found", 404, "NOT_FOUND");

  const updated = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: id });
  return success(res, { equipment: updated });
}
