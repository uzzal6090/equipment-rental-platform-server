import { ObjectId } from "mongodb";
import { getDB } from "../../config/db.js";
import { COLLECTIONS } from "../../config/indexes.js";
import { success, error } from "../../utils/response.js";

// GET /api/profile
export async function getProfile(req, res) {
  const db = getDB();
  const profile = await db.collection(COLLECTIONS.PROFILES).findOne(
    { betterAuthUserId: req.user.id }
  );
  if (!profile) return error(res, "Profile not found", 404, "NOT_FOUND");
  return success(res, { profile });
}

// PUT /api/profile
export async function updateProfile(req, res) {
  const db = getDB();
  const { name, phone, address, profileImage } = req.body;

  const updates = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name.trim();
  if (phone !== undefined) updates.phone = phone || null;
  if (address !== undefined) updates.address = address || null;
  if (profileImage !== undefined) updates.profileImage = profileImage || null;

  await db.collection(COLLECTIONS.PROFILES).updateOne(
    { betterAuthUserId: req.user.id },
    { $set: updates }
  );

  // Also sync name to BetterAuth user table if name changed
  if (name) {
    try {
      await db.collection("user").updateOne(
        { _id: req.user.id },
        { $set: { name: name.trim(), updatedAt: new Date() } }
      );
    } catch {
      // Non-fatal: profile update succeeded
    }
  }

  const profile = await db.collection(COLLECTIONS.PROFILES).findOne({ betterAuthUserId: req.user.id });
  return success(res, { profile });
}

// GET /api/users - admin
export async function getAllUsers(req, res) {
  const db = getDB();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.search) {
    filter.$or = [
      { name: { $regex: req.query.search, $options: "i" } },
      { email: { $regex: req.query.search, $options: "i" } },
    ];
  }

  const [users, total] = await Promise.all([
    db.collection(COLLECTIONS.PROFILES).find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    db.collection(COLLECTIONS.PROFILES).countDocuments(filter),
  ]);

  return success(res, {
    users,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

// PATCH /api/users/:id/role - admin
export async function changeUserRole(req, res) {
  const db = getDB();
  const { id } = req.params;
  const { role } = req.body;

  if (!["customer", "owner", "admin"].includes(role)) {
    return error(res, "Invalid role", 400, "INVALID_ROLE");
  }

  const result = await db.collection(COLLECTIONS.PROFILES).findOneAndUpdate(
    { betterAuthUserId: id },
    { $set: { role, updatedAt: new Date() }, $inc: { roleVersion: 1 } },
    { returnDocument: "after" }
  );

  if (!result) return error(res, "User not found", 404, "NOT_FOUND");
  return success(res, { profile: result });
}
