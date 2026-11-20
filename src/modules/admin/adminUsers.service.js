import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { ObjectId } from "mongodb";
import { USER_ROLES } from "../../config/schema.js";

async function listUsers() {
  const db = getDB();

  const users = await db
    .collection(COLLECTIONS.PROFILES)
    .find({})
    .sort({ createdAt: 1 })
    .toArray();

  return users.map((user) => ({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  }));
}

async function updateUserRole(userId, newRole) {
  const db = getDB();

  if (!USER_ROLES.includes(newRole)) {
    throw { statusCode: 400, code: "INVALID_ROLE", message: `Invalid role. Must be one of: ${USER_ROLES.join(", ")}` };
  }

  let objectId;
  try {
    objectId = new ObjectId(userId);
  } catch {
    throw { statusCode: 400, code: "INVALID_ID", message: "Invalid user ID" };
  }

  const result = await db.collection(COLLECTIONS.PROFILES).findOneAndUpdate(
    { _id: objectId },
    {
      $set: {
        role: newRole,
        updatedAt: new Date(),
      },
      $inc: {
        roleVersion: 1,
      },
    },
    { returnDocument: "after" }
  );

  if (!result) {
    throw { statusCode: 404, code: "USER_NOT_FOUND", message: "User not found" };
  }

  const updatedUser = result;
  return {
    id: updatedUser._id.toString(),
    name: updatedUser.name,
    email: updatedUser.email,
    role: updatedUser.role,
    roleVersion: updatedUser.roleVersion,
    createdAt: updatedUser.createdAt,
    updatedAt: updatedUser.updatedAt,
  };
}

export { listUsers, updateUserRole };