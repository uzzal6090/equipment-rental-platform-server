import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { ObjectId } from "mongodb";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const ALLOWED_SORTS = ["price_asc", "price_desc", "newest"];
const ALLOWED_RENTAL_TYPES = ["daily", "weekly", "monthly"];
const ALLOWED_AVAILABILITY = ["available", "unavailable"];
const ALLOWED_CATEGORIES = [
  "Construction Equipment",
  "Photography Equipment",
  "Vehicles & Transportation",
  "Agriculture Equipment",
  "Electronics",
  "Event Equipment",
];
const ALLOWED_CONDITIONS = ["new", "excellent", "good", "fair", "poor"];

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(String(value), 10);
  if (!Number.isFinite(num) || num < 1) return fallback;
  return num;
}

function parseNonNegativeFloat(value) {
  const num = Number.parseFloat(String(value));
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateEquipmentInput(data, isUpdate = false) {
  const errors = [];

  if (!isUpdate) {
    const requiredFields = [
      "name",
      "description",
      "category",
      "location",
      "rentalPrice",
      "rentalType",
      "totalQuantity",
      "condition",
    ];
    for (const field of requiredFields) {
      if (data[field] === undefined || data[field] === null || String(data[field]).trim() === "") {
        errors.push({ field, message: `${field} is required` });
      }
    }
  } else {
    if (data.name !== undefined && (!data.name || String(data.name).trim() === "")) {
      errors.push({ field: "name", message: "name cannot be empty" });
    }
    if (data.description !== undefined && (!data.description || String(data.description).trim() === "")) {
      errors.push({ field: "description", message: "description cannot be empty" });
    }
    if (data.category !== undefined && (!data.category || String(data.category).trim() === "")) {
      errors.push({ field: "category", message: "category cannot be empty" });
    }
    if (data.location !== undefined && (!data.location || String(data.location).trim() === "")) {
      errors.push({ field: "location", message: "location cannot be empty" });
    }
    if (data.condition !== undefined && (!data.condition || String(data.condition).trim() === "")) {
      errors.push({ field: "condition", message: "condition cannot be empty" });
    }
  }

  if (data.name !== undefined) {
    if (typeof data.name !== "string" || data.name.trim().length < 2) {
      errors.push({ field: "name", message: "name must be at least 2 characters" });
    }
    if (data.name.trim().length > 200) {
      errors.push({ field: "name", message: "name is too long" });
    }
  }

  if (data.description !== undefined) {
    if (typeof data.description !== "string" || data.description.trim().length < 10) {
      errors.push({ field: "description", message: "description must be at least 10 characters" });
    }
    if (data.description.trim().length > 5000) {
      errors.push({ field: "description", message: "description is too long" });
    }
  }

  if (data.category !== undefined) {
    if (!ALLOWED_CATEGORIES.includes(data.category)) {
      errors.push({ field: "category", message: `Invalid category. Must be one of: ${ALLOWED_CATEGORIES.join(", ")}` });
    }
  }

  if (data.location !== undefined) {
    if (typeof data.location !== "string" || data.location.trim().length < 2) {
      errors.push({ field: "location", message: "location must be at least 2 characters" });
    }
    if (data.location.trim().length > 200) {
      errors.push({ field: "location", message: "location is too long" });
    }
  }

  if (data.rentalPrice !== undefined) {
    const price = Number(data.rentalPrice);
    if (!Number.isFinite(price) || price < 0) {
      errors.push({ field: "rentalPrice", message: "rentalPrice must be a non-negative number" });
    }
    if (price > 1000000) {
      errors.push({ field: "rentalPrice", message: "rentalPrice is too high" });
    }
  }

  if (data.rentalType !== undefined) {
    if (!ALLOWED_RENTAL_TYPES.includes(data.rentalType)) {
      errors.push({ field: "rentalType", message: `Invalid rental type. Must be one of: ${ALLOWED_RENTAL_TYPES.join(", ")}` });
    }
  }

  if (data.totalQuantity !== undefined) {
    const qty = Number(data.totalQuantity);
    if (!Number.isInteger(qty) || qty < 1) {
      errors.push({ field: "totalQuantity", message: "totalQuantity must be a positive integer" });
    }
    if (qty > 10000) {
      errors.push({ field: "totalQuantity", message: "totalQuantity is too high" });
    }
  }

  if (data.condition !== undefined) {
    if (!ALLOWED_CONDITIONS.includes(data.condition)) {
      errors.push({ field: "condition", message: `Invalid condition. Must be one of: ${ALLOWED_CONDITIONS.join(", ")}` });
    }
  }

  if (data.brand !== undefined && data.brand !== null && data.brand !== "") {
    if (typeof data.brand !== "string" || data.brand.trim().length > 100) {
      errors.push({ field: "brand", message: "brand is too long" });
    }
  }

  if (data.model !== undefined && data.model !== null && data.model !== "") {
    if (typeof data.model !== "string" || data.model.trim().length > 100) {
      errors.push({ field: "model", message: "model is too long" });
    }
  }

  if (data.image !== undefined && data.image !== null && data.image !== "") {
    if (typeof data.image !== "string") {
      errors.push({ field: "image", message: "image must be a string URL" });
    } else {
      try {
        new URL(data.image);
      } catch {
        errors.push({ field: "image", message: "image must be a valid URL" });
      }
    }
  }

  if (data.rentalTerms !== undefined && data.rentalTerms !== null && data.rentalTerms !== "") {
    if (typeof data.rentalTerms !== "string" || data.rentalTerms.trim().length > 10000) {
      errors.push({ field: "rentalTerms", message: "rentalTerms is too long" });
    }
  }

  return errors;
}

function buildMatch(query) {
  const match = { status: "approved" };

  if (query.search) {
    const trimmed = String(query.search).trim();
    if (trimmed.length > 0) {
      const regex = { $regex: escapeRegExp(trimmed), $options: "i" };
      match.$or = [
        { name: regex },
        { location: regex },
        { category: regex },
      ];
    }
  }

  if (query.category) {
    const category = String(query.category).trim();
    if (category.length > 0) match.category = category;
  }

  if (query.rentalType) {
    if (!ALLOWED_RENTAL_TYPES.includes(query.rentalType)) {
      throw { statusCode: 400, code: "INVALID_RENTAL_TYPE", message: "Invalid rental type. Must be one of: daily, weekly, monthly." };
    }
    match.rentalType = query.rentalType;
  }

  const minPrice = parseNonNegativeFloat(query.minPrice);
  const maxPrice = parseNonNegativeFloat(query.maxPrice);
  if (minPrice !== null || maxPrice !== null) {
    match.rentalPrice = {};
    if (minPrice !== null) match.rentalPrice.$gte = minPrice;
    if (maxPrice !== null) match.rentalPrice.$lte = maxPrice;
  }

  if (query.availability) {
    const availability = String(query.availability).toLowerCase();
    if (!ALLOWED_AVAILABILITY.includes(availability)) {
      throw { statusCode: 400, code: "INVALID_AVAILABILITY", message: "Invalid availability. Must be one of: available, unavailable." };
    }
    if (availability === "available") {
      match.totalQuantity = { $gt: 0 };
    } else {
      match.totalQuantity = 0;
    }
  }

  return match;
}

function buildSort(query) {
  if (query.sort && !ALLOWED_SORTS.includes(query.sort)) {
    throw { statusCode: 400, code: "INVALID_SORT", message: "Invalid sort. Must be one of: price_asc, price_desc, newest." };
  }

  switch (query.sort) {
    case "price_asc":
      return { rentalPrice: 1 };
    case "price_desc":
      return { rentalPrice: -1 };
    case "newest":
    default:
      return { createdAt: -1 };
  }
}

async function listEquipment(query) {
  const db = getDB();

  const page = parsePositiveInt(query.page, DEFAULT_PAGE);
  const limit = Math.min(parsePositiveInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const skip = (page - 1) * limit;

  const match = buildMatch(query);
  const sort = buildSort(query);

  const [items, total] = await Promise.all([
    db
      .collection(COLLECTIONS.EQUIPMENT)
      .find(match)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .toArray(),
    db.collection(COLLECTIONS.EQUIPMENT).countDocuments(match),
  ]);

  const totalPages = Math.ceil(total / limit);

    return {
      equipment: items.map((item) => ({
        id: item._id.toString(),
        name: item.name,
        category: item.category,
        rentalPrice: item.rentalPrice,
        rentalType: item.rentalType,
        location: item.location,
        availableQuantity: item.totalQuantity || 0,
        image: item.image || null,
        status: item.status,
        featured: item.featured === true,
        createdAt: item.createdAt,
      })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

async function getEquipmentById(id) {
  const db = getDB();

  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    return null;
  }

  return db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: objectId });
}

async function getEquipmentDetails(id) {
  const db = getDB();

  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    return null;
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: objectId });
  if (!equipment) return null;

  let ownerInfo = null;
  try {
    const ownerProfile = await db
      .collection(COLLECTIONS.PROFILES)
      .findOne({ _id: equipment.ownerId });
    if (ownerProfile) {
      ownerInfo = {
        name: ownerProfile.name || "Unknown",
        profileImage: ownerProfile.profileImage || null,
      };
    }
  } catch {
    ownerInfo = null;
  }

  return {
    id: equipment._id.toString(),
    name: equipment.name,
    description: equipment.description,
    category: equipment.category,
    rentalPrice: equipment.rentalPrice,
    rentalType: equipment.rentalType,
    location: equipment.location,
    availableQuantity: equipment.totalQuantity || 0,
    image: equipment.image || null,
    rentalTerms: equipment.rentalTerms || null,
    owner: ownerInfo,
    status: equipment.status,
    createdAt: equipment.createdAt,
  };
}

async function createEquipment(ownerId, data) {
  const db = getDB();

  const validationErrors = validateEquipmentInput(data, false);
  if (validationErrors.length > 0) {
    throw { statusCode: 400, code: "VALIDATION_ERROR", message: "Invalid input", errors: validationErrors };
  }

  const now = new Date();
  const equipmentDoc = {
    ownerId: new ObjectId(ownerId),
    name: data.name.trim(),
    description: data.description.trim(),
    category: data.category,
    location: data.location.trim(),
    rentalPrice: Number(data.rentalPrice),
    rentalType: data.rentalType,
    totalQuantity: Number(data.totalQuantity),
    condition: data.condition,
    brand: data.brand?.trim() || null,
    model: data.model?.trim() || null,
    image: data.image?.trim() || null,
    rentalTerms: data.rentalTerms?.trim() || null,
    status: "pending",
    featured: false,
    inventoryVersion: 0,
    createdAt: now,
    updatedAt: now,
  };

  const result = await db.collection(COLLECTIONS.EQUIPMENT).insertOne(equipmentDoc);

  return {
    id: result.insertedId.toString(),
    ...equipmentDoc,
    ownerId: equipmentDoc.ownerId.toString(),
    availableQuantity: equipmentDoc.totalQuantity,
  };
}

async function getOwnerEquipment(ownerId, query = {}) {
  const db = getDB();

  const page = parsePositiveInt(query.page, DEFAULT_PAGE);
  const limit = Math.min(parsePositiveInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const skip = (page - 1) * limit;

  const match = { ownerId: new ObjectId(ownerId) };
  const sort = { createdAt: -1 };

  const [items, total] = await Promise.all([
    db
      .collection(COLLECTIONS.EQUIPMENT)
      .find(match)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .toArray(),
    db.collection(COLLECTIONS.EQUIPMENT).countDocuments(match),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    equipment: items.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      category: item.category,
      rentalPrice: item.rentalPrice,
      rentalType: item.rentalType,
      location: item.location,
      availableQuantity: item.totalQuantity || 0,
      image: item.image || null,
      status: item.status,
      featured: item.featured === true,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

async function updateEquipment(equipmentId, ownerId, data) {
  const db = getDB();

  const validationErrors = validateEquipmentInput(data, true);
  if (validationErrors.length > 0) {
    throw { statusCode: 400, code: "VALIDATION_ERROR", message: "Invalid input", errors: validationErrors };
  }

  let objectId;
  try {
    objectId = new ObjectId(equipmentId);
  } catch {
    throw { statusCode: 400, code: "INVALID_ID", message: "Invalid equipment ID" };
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: objectId });
  if (!equipment) {
    throw { statusCode: 404, code: "EQUIPMENT_NOT_FOUND", message: "Equipment not found" };
  }

  if (!equipment.ownerId.equals(new ObjectId(ownerId))) {
    throw { statusCode: 403, code: "FORBIDDEN", message: "You can only update your own equipment" };
  }

  const allowedFields = [
    "name",
    "description",
    "category",
    "location",
    "rentalPrice",
    "rentalType",
    "totalQuantity",
    "condition",
    "brand",
    "model",
    "image",
    "rentalTerms",
  ];

  const updateDoc = { updatedAt: new Date() };
  let hasAllowedFields = false;
  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      hasAllowedFields = true;
      let value = data[field];
      if (typeof value === "string") {
        value = value.trim();
        if (value === "") {
          if (["brand", "model", "image", "rentalTerms"].includes(field)) {
            updateDoc[field] = null;
          }
          continue;
        }
      }
      if (field === "rentalPrice") value = Number(value);
      if (field === "totalQuantity") value = Number(value);
      updateDoc[field] = value;
    }
  }

  // If no allowed fields provided, still update updatedAt and return current equipment
  if (!hasAllowedFields) {
    const updated = await db.collection(COLLECTIONS.EQUIPMENT).findOneAndUpdate(
      { _id: objectId },
      { $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    return {
      id: updated._id.toString(),
      name: updated.name,
      category: updated.category,
      rentalPrice: updated.rentalPrice,
      rentalType: updated.rentalType,
      location: updated.location,
      availableQuantity: updated.totalQuantity || 0,
      image: updated.image || null,
      status: updated.status,
      featured: updated.featured === true,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  const updated = await db.collection(COLLECTIONS.EQUIPMENT).findOneAndUpdate(
    { _id: objectId },
    { $set: updateDoc },
    { returnDocument: "after" }
  );

  return {
    id: updated._id.toString(),
    name: updated.name,
    category: updated.category,
    rentalPrice: updated.rentalPrice,
    rentalType: updated.rentalType,
    location: updated.location,
    availableQuantity: updated.totalQuantity || 0,
    image: updated.image || null,
    status: updated.status,
    featured: updated.featured === true,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

async function deleteEquipment(equipmentId, ownerId) {
  const db = getDB();

  let objectId;
  try {
    objectId = new ObjectId(equipmentId);
  } catch {
    throw { statusCode: 400, code: "INVALID_ID", message: "Invalid equipment ID" };
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: objectId });
  if (!equipment) {
    throw { statusCode: 404, code: "EQUIPMENT_NOT_FOUND", message: "Equipment not found" };
  }

  if (!equipment.ownerId.equals(new ObjectId(ownerId))) {
    throw { statusCode: 403, code: "FORBIDDEN", message: "You can only delete your own equipment" };
  }

  await db.collection(COLLECTIONS.EQUIPMENT).deleteOne({ _id: objectId });

  return { deleted: true, id: equipmentId };
}

export {
  listEquipment,
  getEquipmentDetails,
  createEquipment,
  getOwnerEquipment,
  updateEquipment,
  deleteEquipment,
};