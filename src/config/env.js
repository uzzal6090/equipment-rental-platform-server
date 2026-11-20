export function validateEnv() {
  const required = [
    "MONGODB_URI",
    "JWT_SECRET",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "CLIENT_URL",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const urlVars = ["CLIENT_URL", "BETTER_AUTH_URL"];
  for (const key of urlVars) {
    let parsed;
    try {
      parsed = new URL(process.env[key]);
    } catch {
      throw new Error(`Invalid URL for environment variable: ${key}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Environment variable ${key} must be an HTTP(S) URL`);
    }
  }
}

export function get(key, fallback) {
  return process.env[key] !== undefined ? process.env[key] : fallback;
}
