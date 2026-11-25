import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { toNodeHandler } from "better-auth/node";
import { jwt } from "better-auth/plugins/jwt";
import { ObjectId } from "mongodb";
import { hashPassword as defaultHashPassword } from "@better-auth/utils/password";
import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error";

export async function createAuth(db, client) {
  const socialProviders = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }

  const auth = betterAuth({
    database: mongodbAdapter(db, { client }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    trustedOrigins: [process.env.CLIENT_URL].filter(Boolean),
    plugins: [
      jwt({
        jwt: {
          issuer: process.env.BETTER_AUTH_URL,
          audience: process.env.BETTER_AUTH_URL,
          expirationTime: process.env.JWT_EXPIRES_IN || "15m",
          definePayload: async (session) => {
            const profile = await db.collection("profiles").findOne({
              betterAuthUserId: session.user.id,
            });
            return {
              role: profile?.role ?? "customer",
              roleVersion: profile?.roleVersion ?? 0,
              profileImage: profile?.profileImage ?? null,
            };
          },
        },
        jwks: {
          keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
          disablePrivateKeyEncryption: false,
        },
      }),
    ],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 6,
      maxPasswordLength: 128,
      requireEmailVerification: false,
      autoSignIn: true,
      disableSignUp: false,
      password: {
        hash: async (password) => {
          if (password.length < 6) {
            throw APIError.from("BAD_REQUEST", BASE_ERROR_CODES.PASSWORD_TOO_SHORT);
          }
          if (!/[A-Z]/.test(password)) {
            throw APIError.from("BAD_REQUEST", {
              message: "Password must contain at least one uppercase letter",
              code: "PASSWORD_MISSING_UPPERCASE",
            });
          }
          if (!/[a-z]/.test(password)) {
            throw APIError.from("BAD_REQUEST", {
              message: "Password must contain at least one lowercase letter",
              code: "PASSWORD_MISSING_LOWERCASE",
            });
          }
          return defaultHashPassword(password);
        },
      },
    },
    socialProviders,
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    useSecureCookies: process.env.NODE_ENV === "production",
    advanced: {
      defaultCookieAttributes: {
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            let profileCreated = false;
            try {
              await db.collection("profiles").updateOne(
                { betterAuthUserId: user.id },
                {
                  $setOnInsert: {
                    betterAuthUserId: user.id,
                    name: user.name,
                    email: user.email,
                    profileImage: user.image ?? null,
                    phone: null,
                    address: null,
                    role: "customer",
                    roleVersion: 0,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                },
                { upsert: true }
              );
              profileCreated = true;
            } catch (error) {
              console.error("Profile synchronization failed:", error.message);
              const userOid = new ObjectId(user.id);
              try {
                await db.collection("profiles").deleteOne({ betterAuthUserId: user.id });
                await db.collection("user").deleteOne({ _id: userOid });
                await db.collection("account").deleteMany({ userId: userOid });
                await db.collection("session").deleteMany({ userId: userOid });
                await db.collection("verification").deleteMany({ identifier: user.email });
              } catch (cleanupError) {
                console.error("Profile sync failed and cleanup also failed:", cleanupError.message);
              }
              throw error;
            }
            return profileCreated;
          },
        },
      },
    },
  });

  const authHandler = toNodeHandler(auth);
  return { auth, authHandler };
}
