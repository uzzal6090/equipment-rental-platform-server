import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { success, error } from "../utils/response.js";
import { getDB } from "../config/db.js";

const router = express.Router();

// GET /api/profile - Get authenticated user's profile with role
router.get("/", verifyToken, async (req, res) => {
  try {
    const db = getDB();
    const { betterAuthUserId } = req.profile;

    const profile = await db.collection("profiles").findOne({ betterAuthUserId });
    if (!profile) {
      return error(res, "Profile not found", 404, "PROFILE_NOT_FOUND");
    }

    return success(res, {
      profile: {
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        address: profile.address,
        profileImage: profile.profileImage,
        role: profile.role,
        roleVersion: profile.roleVersion,
        updatedAt: profile.updatedAt,
      },
    });
  } catch (err) {
    return error(res, err.message || "Failed to fetch profile", 500, "FETCH_FAILED");
  }
});

// PUT /api/profile - Update profile information (name, phone, address)
// Never allows role or email changes via this endpoint.
router.put("/", verifyToken, async (req, res) => {
  try {
    const db = getDB();
    const { betterAuthUserId } = req.profile;
    const { name, phone, address } = req.body;

    // Validate: at least one field must be provided
    if (name === undefined && phone === undefined && address === undefined) {
      return error(res, "At least one field is required", 400, "MISSING_FIELDS");
    }

    // Validate name if provided
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 2) {
        return error(
          res,
          "Name must be at least 2 characters",
          400,
          "INVALID_NAME"
        );
      }
      if (name.trim().length > 100) {
        return error(res, "Name is too long", 400, "INVALID_NAME");
      }
    }

    // Validate phone if provided
    if (phone !== undefined && phone !== null && phone !== "") {
      if (typeof phone !== "string" || phone.trim().length < 7) {
        return error(res, "Invalid phone number", 400, "INVALID_PHONE");
      }
    }

    // Validate address if provided
    if (address !== undefined && address !== null && address !== "") {
      if (typeof address !== "string" || address.trim().length < 2) {
        return error(res, "Address is too short", 400, "INVALID_ADDRESS");
      }
    }

    const updateFields = {};
    if (name !== undefined) updateFields.name = name.trim();
    if (phone !== undefined) updateFields.phone = phone === "" ? null : phone.trim();
    if (address !== undefined) updateFields.address = address === "" ? null : address.trim();
    updateFields.updatedAt = new Date();

    const setOnInsert = {
      betterAuthUserId,
      email: req.user?.email || "",
      role: "customer",
      roleVersion: 0,
      createdAt: new Date(),
    };
    if (!("name" in updateFields)) {
      setOnInsert.name = req.user?.name || "";
    }
    if (!("phone" in updateFields)) {
      setOnInsert.phone = null;
    }
    if (!("address" in updateFields)) {
      setOnInsert.address = null;
    }

    const result = await db
      .collection("profiles")
      .findOneAndUpdate(
        { betterAuthUserId },
        {
          $set: updateFields,
          $setOnInsert: setOnInsert,
        },
        { returnDocument: "after", upsert: true }
      );

    if (!result.value) {
      return error(res, "Profile not found", 404, "PROFILE_NOT_FOUND");
    }

    const updatedProfile = result.value;

    return success(res, {
      profile: {
        name: updatedProfile.name,
        email: updatedProfile.email,
        phone: updatedProfile.phone,
        address: updatedProfile.address,
        profileImage: updatedProfile.profileImage,
        role: updatedProfile.role,
        updatedAt: updatedProfile.updatedAt,
      },
    });
  } catch (err) {
    return error(res, err.message || "Failed to update profile", 500, "UPDATE_FAILED");
  }
});

export { router as profileRouter };
