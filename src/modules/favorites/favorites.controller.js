import { ObjectId } from "mongodb";
import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { success, error } from "../../utils/response.js";

// GET /api/favorites
export async function getFavorites(req, res) {
  const db = getDB();
  const userId = req.user.id;

  const favorites = await db.collection(COLLECTIONS.FAVORITES).aggregate([
    { $match: { userId } },
    {
      $lookup: {
        from: COLLECTIONS.EQUIPMENT,
        let: { eqId: "$equipmentId" },
        pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$eqId"] } } }],
        as: "equipment",
      },
    },
    { $unwind: { path: "$equipment", preserveNullAndEmptyArrays: true } },
    { $sort: { createdAt: -1 } },
  ]).toArray();

  return success(res, { favorites });
}

// GET /api/favorites/check/:equipmentId
export async function checkFavorite(req, res) {
  const db = getDB();
  let equipmentId;
  try {
    equipmentId = new ObjectId(req.params.equipmentId);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const favorite = await db.collection(COLLECTIONS.FAVORITES).findOne({
    userId: req.user.id,
    equipmentId,
  });

  return success(res, { isFavorited: !!favorite });
}

// POST /api/favorites
export async function addFavorite(req, res) {
  const db = getDB();
  const { equipmentId: eqIdStr } = req.body;

  if (!eqIdStr) return error(res, "equipmentId is required", 400, "MISSING_FIELD");

  let equipmentId;
  try {
    equipmentId = new ObjectId(eqIdStr);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  // Check equipment exists
  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: equipmentId });
  if (!equipment) return error(res, "Equipment not found", 404, "NOT_FOUND");

  // Upsert to avoid duplicates (index already enforces uniqueness)
  try {
    await db.collection(COLLECTIONS.FAVORITES).insertOne({
      userId: req.user.id,
      equipmentId,
      createdAt: new Date(),
    });
  } catch (err) {
    if (err.code === 11000) {
      return error(res, "Already in favorites", 409, "ALREADY_EXISTS");
    }
    throw err;
  }

  return success(res, { message: "Added to favorites" }, 201);
}

// DELETE /api/favorites/:equipmentId
export async function removeFavorite(req, res) {
  const db = getDB();
  let equipmentId;
  try {
    equipmentId = new ObjectId(req.params.equipmentId);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const result = await db.collection(COLLECTIONS.FAVORITES).deleteOne({
    userId: req.user.id,
    equipmentId,
  });

  if (result.deletedCount === 0) return error(res, "Favorite not found", 404, "NOT_FOUND");
  return success(res, { message: "Removed from favorites" });
}
