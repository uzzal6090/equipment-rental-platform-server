import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { ObjectId } from "mongodb";
import { EQUIPMENT_STATUSES } from "../../config/schema.js";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(String(value), 10);
  if (!Number.isFinite(num) || num < 1) return fallback;
  return num;
}

function buildAdminListMatch(query) {
  const match = {};

  if (query.status) {
    const status = String(query.status).toLowerCase();
    if (!EQUIPMENT_STATUSES.includes(status)) {
      throw { statusCode: 400, code: "INVALID_STATUS", message: `Invalid status. Must be one of: ${EQUIPMENT_STATUSES.join(", ")}` };
    }
    match.status = status;
  }

  if (query.search) {
    const trimmed = String(query.search).trim();
    if (trimmed.length > 0) {
      const regex = { $regex: trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
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

  if (query.ownerId) {
    try {
      match.ownerId = new ObjectId(query.ownerId);
    } catch {
      throw { statusCode: 400, code: "INVALID_OWNER_ID", message: "Invalid owner ID" };
    }
  }

  return match;
}

function buildAdminSort(query) {
  const sortMap = {
    price_asc: { rentalPrice: 1 },
    price_desc: { rentalPrice: -1 },
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    status_asc: { status: 1, createdAt: -1 },
    status_desc: { status: -1, createdAt: -1 },
  };

  const sortKey = query.sort || "newest";
  return sortMap[sortKey] || { createdAt: -1 };
}

async function listAllEquipment(query) {
  const db = getDB();

  const page = parsePositiveInt(query.page, DEFAULT_PAGE);
  const limit = Math.min(parsePositiveInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const skip = (page - 1) * limit;

  const match = buildAdminListMatch(query);
  const sort = buildAdminSort(query);

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

  const equipmentWithOwner = await Promise.all(
    items.map(async (item) => {
      let ownerInfo = null;
      try {
        const ownerProfile = await db
          .collection(COLLECTIONS.PROFILES)
          .findOne({ _id: item.ownerId });
        if (ownerProfile) {
          ownerInfo = {
            id: ownerProfile._id.toString(),
            name: ownerProfile.name || "Unknown",
            email: ownerProfile.email,
            profileImage: ownerProfile.profileImage || null,
          };
        }
      } catch {
        ownerInfo = null;
      }

      return {
        id: item._id.toString(),
        name: item.name,
        description: item.description,
        category: item.category,
        rentalPrice: item.rentalPrice,
        rentalType: item.rentalType,
        location: item.location,
        totalQuantity: item.totalQuantity || 0,
        condition: item.condition,
        brand: item.brand || null,
        model: item.model || null,
        image: item.image || null,
        rentalTerms: item.rentalTerms || null,
        owner: ownerInfo,
        status: item.status,
        featured: item.featured === true,
        inventoryVersion: item.inventoryVersion || 0,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    })
  );

  return {
    equipment: equipmentWithOwner,
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
    throw { statusCode: 400, code: "INVALID_ID", message: "Invalid equipment ID" };
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: objectId });
  if (!equipment) {
    throw { statusCode: 404, code: "EQUIPMENT_NOT_FOUND", message: "Equipment not found" };
  }

  return equipment;
}

function validateStatusTransition(currentStatus, newStatus) {
  if (currentStatus === "approved" && newStatus === "rejected") {
    return true;
  }
  if (currentStatus === "rejected" && newStatus === "approved") {
    return true;
  }
  if (currentStatus === "pending") {
    return newStatus === "approved" || newStatus === "rejected";
  }
  return false;
}

async function approveEquipment(id) {
  const equipment = await getEquipmentById(id);

  if (equipment.status !== "pending") {
    throw { statusCode: 400, code: "INVALID_STATUS_TRANSITION", message: `Cannot approve equipment with status: ${equipment.status}. Only pending equipment can be approved.` };
  }

  const db = getDB();
  const updated = await db.collection(COLLECTIONS.EQUIPMENT).findOneAndUpdate(
    { _id: equipment._id },
    { $set: { status: "approved", updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  return formatEquipmentResponse(updated);
}

async function rejectEquipment(id) {
  const equipment = await getEquipmentById(id);

  if (equipment.status !== "pending") {
    throw { statusCode: 400, code: "INVALID_STATUS_TRANSITION", message: `Cannot reject equipment with status: ${equipment.status}. Only pending equipment can be rejected.` };
  }

  const db = getDB();
  const updated = await db.collection(COLLECTIONS.EQUIPMENT).findOneAndUpdate(
    { _id: equipment._id },
    { $set: { status: "rejected", updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  return formatEquipmentResponse(updated);
}

async function adminUpdateEquipment(id, data) {
  const db = getDB();

  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    throw { statusCode: 400, code: "INVALID_ID", message: "Invalid equipment ID" };
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: objectId });
  if (!equipment) {
    throw { statusCode: 404, code: "EQUIPMENT_NOT_FOUND", message: "Equipment not found" };
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
    "status",
    "featured",
  ];

  const validationErrors = validateAdminUpdateInput(data);
  if (validationErrors.length > 0) {
    throw { statusCode: 400, code: "VALIDATION_ERROR", message: "Invalid input", errors: validationErrors };
  }

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
      if (field === "featured") value = Boolean(value);
      updateDoc[field] = value;
    }
  }

  if (!hasAllowedFields) {
    const updated = await db.collection(COLLECTIONS.EQUIPMENT).findOneAndUpdate(
      { _id: objectId },
      { $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    return formatEquipmentResponse(updated);
  }

  const updated = await db.collection(COLLECTIONS.EQUIPMENT).findOneAndUpdate(
    { _id: objectId },
    { $set: updateDoc },
    { returnDocument: "after" }
  );

  return formatEquipmentResponse(updated);
}

function validateAdminUpdateInput(data) {
  const errors = [];
  const ALLOWED_CATEGORIES = [
    "Construction Equipment",
    "Photography Equipment",
    "Vehicles & Transportation",
    "Agriculture Equipment",
    "Electronics",
    "Event Equipment",
  ];
  const ALLOWED_RENTAL_TYPES = ["daily", "weekly", "monthly"];
  const ALLOWED_CONDITIONS = ["new", "excellent", "good", "fair", "poor"];

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

  if (data.status !== undefined) {
    if (!EQUIPMENT_STATUSES.includes(data.status)) {
      errors.push({ field: "status", message: `Invalid status. Must be one of: ${EQUIPMENT_STATUSES.join(", ")}` });
    }
  }

  return errors;
}

async function adminDeleteEquipment(id) {
  const db = getDB();

  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    throw { statusCode: 400, code: "INVALID_ID", message: "Invalid equipment ID" };
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: objectId });
  if (!equipment) {
    throw { statusCode: 404, code: "EQUIPMENT_NOT_FOUND", message: "Equipment not found" };
  }

  await db.collection(COLLECTIONS.EQUIPMENT).deleteOne({ _id: objectId });

  return { deleted: true, id };
}

async function formatEquipmentResponse(equipment) {
  const db = getDB();
  let ownerInfo = null;
  try {
    const ownerProfile = await db
      .collection(COLLECTIONS.PROFILES)
      .findOne({ _id: equipment.ownerId });
    if (ownerProfile) {
      ownerInfo = {
        id: ownerProfile._id.toString(),
        name: ownerProfile.name || "Unknown",
        email: ownerProfile.email,
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
    totalQuantity: equipment.totalQuantity || 0,
    condition: equipment.condition,
    brand: equipment.brand || null,
    model: equipment.model || null,
    image: equipment.image || null,
    rentalTerms: equipment.rentalTerms || null,
    owner: ownerInfo,
    status: equipment.status,
    featured: equipment.featured === true,
    inventoryVersion: equipment.inventoryVersion || 0,
    createdAt: equipment.createdAt,
    updatedAt: equipment.updatedAt,
  };
}

export {
  listAllEquipment,
  approveEquipment,
  rejectEquipment,
  adminUpdateEquipment,
  adminDeleteEquipment,
};