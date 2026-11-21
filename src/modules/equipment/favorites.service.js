import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { ObjectId } from "mongodb";

async function addFavorite(userId, equipmentId) {
  const db = getDB();

  let equipmentObjectId;
  try {
    equipmentObjectId = new ObjectId(equipmentId);
  } catch {
    throw { statusCode: 400, code: "INVALID_ID", message: "Invalid equipment ID" };
  }

  const equipment = await db.collection(COLLECTIONS.EQUIPMENT).findOne({ _id: equipmentObjectId });
  if (!equipment) {
    throw { statusCode: 404, code: "EQUIPMENT_NOT_FOUND", message: "Equipment not found" };
  }

  if (equipment.status !== "approved") {
    throw { statusCode: 400, code: "INVALID_STATUS", message: "Only approved equipment can be favorited" };
  }

  const userObjectId = new ObjectId(userId);

  try {
    const result = await db.collection(COLLECTIONS.FAVORITES).insertOne({
      userId: userObjectId,
      equipmentId: equipmentObjectId,
      createdAt: new Date(),
    });

    return {
      id: result.insertedId.toString(),
      userId: userId,
      equipmentId: equipmentId,
      createdAt: new Date(),
    };
  } catch (error) {
    if (error.code === 11000) {
      throw { statusCode: 409, code: "DUPLICATE_FAVORITE", message: "Equipment already in favorites" };
    }
    throw error;
  }
}

async function listFavorites(userId, query = {}) {
  const db = getDB();

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || 10), 50);
  const skip = (page - 1) * limit;

  const userObjectId = new ObjectId(userId);

  const [items, total] = await Promise.all([
    db
      .collection(COLLECTIONS.FAVORITES)
      .aggregate([
        { $match: { userId: userObjectId } },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: COLLECTIONS.EQUIPMENT,
            localField: "equipmentId",
            foreignField: "_id",
            as: "equipment",
          },
        },
        { $unwind: "$equipment" },
        {
          $project: {
            _id: 1,
            createdAt: 1,
            equipment: {
              id: { $toString: "$equipment._id" },
              name: "$equipment.name",
              category: "$equipment.category",
              rentalPrice: "$equipment.rentalPrice",
              rentalType: "$equipment.rentalType",
              location: "$equipment.location",
              availableQuantity: "$equipment.totalQuantity",
              image: "$equipment.image",
              status: "$equipment.status",
              createdAt: "$equipment.createdAt",
            },
          },
        },
      ])
      .toArray(),
    db.collection(COLLECTIONS.FAVORITES).countDocuments({ userId: userObjectId }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    favorites: items.map((item) => ({
      id: item._id.toString(),
      equipmentId: item.equipment.id,
      createdAt: item.createdAt,
      equipment: item.equipment,
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

async function removeFavorite(userId, favoriteId) {
  const db = getDB();

  let favoriteObjectId;
  try {
    favoriteObjectId = new ObjectId(favoriteId);
  } catch {
    throw { statusCode: 400, code: "INVALID_ID", message: "Invalid favorite ID" };
  }

  const userObjectId = new ObjectId(userId);

  const favorite = await db.collection(COLLECTIONS.FAVORITES).findOne({ _id: favoriteObjectId });
  if (!favorite) {
    throw { statusCode: 404, code: "FAVORITE_NOT_FOUND", message: "Favorite not found" };
  }

  if (!favorite.userId.equals(userObjectId)) {
    throw { statusCode: 403, code: "FORBIDDEN", message: "You can only remove your own favorites" };
  }

  await db.collection(COLLECTIONS.FAVORITES).deleteOne({ _id: favoriteObjectId });

  return { deleted: true, id: favoriteId };
}

export { addFavorite, listFavorites, removeFavorite };