import { jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";
import { error } from "../utils/response.js";

const ALLOWED_ALGORITHMS = ["EdDSA"];

function decodeTokenHeader(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const headerStr = Buffer.from(parts[0], "base64url").toString("utf8");
  try {
    return JSON.parse(headerStr);
  } catch {
    return null;
  }
}

async function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function getSigningKey(kid) {
  const db = getDB();
  let keyDoc = await db.collection("jwks").findOne({ _id: kid });
  if (!keyDoc) {
    try {
      keyDoc = await db.collection("jwks").findOne({ _id: new ObjectId(kid) });
    } catch {
      // Not a valid ObjectId, keep keyDoc as null
    }
  }
  if (!keyDoc) {
    throw new Error("Signing key not found");
  }
  const publicKey = JSON.parse(keyDoc.publicKey);
  const alg = keyDoc.alg || "EdDSA";
  return { publicKey, alg };
}

export async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    } else {
      token = await getCookie(req, "better-auth.session_token");
    }
    if (!token) {
      return error(res, "Missing or invalid Authorization header", 401, "MISSING_TOKEN");
    }

    const header = decodeTokenHeader(token);
    if (!header) {
      return error(res, "Malformed token", 401, "MALFORMED_TOKEN");
    }

    const kid = header.kid;
    const alg = header.alg;
    if (!kid || !alg) {
      return error(res, "Malformed token: missing kid or alg", 401, "MALFORMED_TOKEN");
    }

    if (!ALLOWED_ALGORITHMS.includes(alg)) {
      return error(res, "Unsupported signing algorithm", 401, "UNSUPPORTED_ALGORITHM");
    }

    let signingKey;
    try {
      signingKey = await getSigningKey(kid);
    } catch {
      return error(res, "Invalid token: signing key not found", 401, "INVALID_TOKEN");
    }

    let payload;
    try {
      const { payload: verifiedPayload } = await jwtVerify(token, signingKey.publicKey, {
        issuer: process.env.BETTER_AUTH_URL,
        audience: process.env.BETTER_AUTH_URL,
        algorithms: [alg],
      });
      payload = verifiedPayload;
    } catch {
      return error(res, "Invalid or expired token", 401, "INVALID_TOKEN");
    }

    const userId = payload.sub;
    if (!userId) {
      return error(res, "Invalid token: missing subject", 401, "INVALID_TOKEN");
    }

    const db = getDB();
    const profile = await db.collection("profiles").findOne({ betterAuthUserId: userId });
    if (!profile) {
      return error(res, "Authenticated user has no application profile", 401, "MISSING_PROFILE");
    }

    const tokenRoleVersion = payload.roleVersion;
    if (tokenRoleVersion !== undefined && tokenRoleVersion !== profile.roleVersion) {
      return error(res, "Token role version is stale. Please sign in again.", 401, "STALE_ROLE_VERSION");
    }

    req.user = {
      id: userId,
      email: profile.email,
      name: profile.name,
      profileImage: profile.profileImage,
    };
    req.profile = {
      profileId: profile._id,
      betterAuthUserId: profile.betterAuthUserId,
      role: profile.role,
      roleVersion: profile.roleVersion,
      phone: profile.phone,
      address: profile.address,
    };

    next();
  } catch (errorObj) {
    return error(res, "Authentication failed", 401, "AUTHENTICATION_FAILED");
  }
}
