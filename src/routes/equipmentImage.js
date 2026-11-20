import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyOwner } from "../middleware/verifyOwner.js";
import { success, error } from "../utils/response.js";

const router = express.Router();

router.use(express.json({ limit: "8mb" }));

router.post("/", verifyToken, verifyOwner, async (req, res) => {
  try {
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

    return success(res, { imageUrl });
  } catch (err) {
    return error(res, err.message || "Failed to upload image", 500, "UPLOAD_FAILED");
  }
});

export { router as equipmentImageRouter };