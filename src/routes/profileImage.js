import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { success, error } from "../utils/response.js";
import { getDB } from "../config/db.js";

const router = express.Router();

// Route-specific JSON parser with a larger limit for base64 image uploads.
// Base64 grows a ~5MB image to ~6.6MB, so 8MB covers the existing 5MB file limit.
// Runs before verifyToken so oversized bodies get 413 here instead of being
// rejected by the global default-limit parser upstream.
router.use(express.json({ limit: "8mb" }));

// POST /api/profile/image - Upload profile image to ImgBB
// Accepts base64 image data in JSON body. Never stores raw images in MongoDB.
router.post("/", verifyToken, async (req, res) => {
  try {
    const db = getDB();
    const { betterAuthUserId } = req.profile;
    const { imageData } = req.body;

    const imgbbApiKey = process.env.IMGBB_API_KEY;
    if (!imgbbApiKey) {
      return error(
        res,
        "Image upload is not configured. IMGBB_API_KEY is missing on the server.",
        500,
        "IMAGE_UPLOAD_NOT_CONFIGURED"
      );
    }

    if (!imageData || typeof imageData !== "string") {
      return error(res, "Image data is required", 400, "MISSING_IMAGE_DATA");
    }

    // Validate it's a data URL
    const dataUrlMatch = imageData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,/);
    if (!dataUrlMatch) {
      return error(
        res,
        "Invalid image format. Only PNG, JPEG, JPG, GIF, and WebP are supported.",
        400,
        "INVALID_IMAGE_FORMAT"
      );
    }

    const base64Data = imageData.split(",")[1];

    // Validate size: max 5MB after base64 decode (roughly 6.6MB base64)
    const approxSizeBytes = (base64Data.length * 3) / 4;
    const maxSizeBytes = 5 * 1024 * 1024;
    if (approxSizeBytes > maxSizeBytes) {
      return error(
        res,
        "Image file is too large. Maximum size is 5MB.",
        400,
        "IMAGE_TOO_LARGE"
      );
    }

    // Upload to ImgBB
    const formData = new FormData();
    formData.append("key", imgbbApiKey);
    formData.append("image", base64Data);

    let imgbbResponse;
    try {
      imgbbResponse = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body: formData,
      });
    } catch (fetchErr) {
      return error(
        res,
        "Image upload service unavailable",
        502,
        "UPLOAD_SERVICE_ERROR"
      );
    }

    if (!imgbbResponse.ok) {
      return error(
        res,
        "Image upload failed",
        502,
        "UPLOAD_SERVICE_ERROR"
      );
    }

    const imgbbResult = await imgbbResponse.json();

    if (!imgbbResult.success || !imgbbResult.data?.url) {
      return error(
        res,
        "Image upload failed",
        502,
        "UPLOAD_SERVICE_ERROR"
      );
    }

    const imageUrl = imgbbResult.data.url;

    // Persist image URL in profiles collection.
    // Upsert safely initializes the profile if it is missing, using trusted
    // server-side data from the authenticated user record (set by verifyToken).
    // The unique index on betterAuthUserId prevents duplicate profiles.
    const result = await db
      .collection("profiles")
      .findOneAndUpdate(
        { betterAuthUserId },
        {
          $set: { profileImage: imageUrl, updatedAt: new Date() },
          $setOnInsert: {
            betterAuthUserId,
            name: req.user?.name || "",
            email: req.user?.email || "",
            phone: req.profile?.phone ?? null,
            address: req.profile?.address ?? null,
            role: req.profile?.role ?? "customer",
            roleVersion: req.profile?.roleVersion ?? 0,
            createdAt: new Date(),
          },
        },
        { returnDocument: "after", upsert: true }
      );

    if (!result.value) {
      return error(res, "Profile not found", 404, "PROFILE_NOT_FOUND");
    }

    return success(res, {
      profile: {
        name: result.value.name,
        email: result.value.email,
        phone: result.value.phone,
        address: result.value.address,
        profileImage: result.value.profileImage,
        role: result.value.role,
        updatedAt: result.value.updatedAt,
      },
    });
  } catch (err) {
    return error(res, err.message || "Failed to upload image", 500, "UPLOAD_FAILED");
  }
});

export { router as profileImageRouter };
