import { error } from "../utils/response.js";

export async function verifyOwner(req, res, next) {
  if (!req.profile || req.profile.role !== "owner") {
    return error(res, "Forbidden: owner role required", 403, "ROLE_REQUIRED");
  }
  next();
}
