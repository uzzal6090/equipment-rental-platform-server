import { error } from "../utils/response.js";

export async function verifyRenter(req, res, next) {
  if (!req.profile || req.profile.role !== "customer") {
    return error(res, "Forbidden: customer role required", 403, "ROLE_REQUIRED");
  }
  next();
}
