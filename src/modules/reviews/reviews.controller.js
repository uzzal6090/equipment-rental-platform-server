import { ObjectId } from "mongodb";
import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { success, error } from "../../utils/response.js";

// GET /api/reviews - all public reviews
export async function getReviews(req, res) {
  const db = getDB();
  const reviews = await db.collection(COLLECTIONS.REVIEWS).aggregate([
    { $sort: { createdAt: -1 } },
    { $limit: 20 },
    {
      $lookup: {
        from: COLLECTIONS.PROFILES,
        localField: "userId",
        foreignField: "betterAuthUserId",
        as: "user",
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        rating: 1, comment: 1, createdAt: 1, equipmentId: 1,
        "user.name": 1, "user.profileImage": 1,
      },
    },
  ]).toArray();

  return success(res, { reviews });
}

// GET /api/reviews/equipment/:id
export async function getEquipmentReviews(req, res) {
  const db = getDB();
  let equipmentId;
  try {
    equipmentId = new ObjectId(req.params.id);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const reviews = await db.collection(COLLECTIONS.REVIEWS).aggregate([
    { $match: { equipmentId } },
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: COLLECTIONS.PROFILES,
        localField: "userId",
        foreignField: "betterAuthUserId",
        as: "user",
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        rating: 1, comment: 1, createdAt: 1,
        "user.name": 1, "user.profileImage": 1,
      },
    },
  ]).toArray();

  return success(res, { reviews });
}

// POST /api/reviews - authenticated
export async function createReview(req, res) {
  const db = getDB();
  const { equipmentId: eqIdStr, rating, comment } = req.body;

  if (!eqIdStr || rating === undefined) {
    return error(res, "equipmentId and rating are required", 400, "MISSING_FIELDS");
  }

  let equipmentId;
  try {
    equipmentId = new ObjectId(eqIdStr);
  } catch {
    return error(res, "Invalid equipment ID", 400, "INVALID_ID");
  }

  const ratingNum = parseInt(rating);
  if (ratingNum < 1 || ratingNum > 5) {
    return error(res, "Rating must be between 1 and 5", 400, "INVALID_RATING");
  }

  const doc = {
    equipmentId,
    userId: req.user.id,
    rating: ratingNum,
    comment: comment?.trim() || null,
    createdAt: new Date(),
  };

  const result = await db.collection(COLLECTIONS.REVIEWS).insertOne(doc);
  return success(res, { review: { ...doc, _id: result.insertedId } }, 201);
}
