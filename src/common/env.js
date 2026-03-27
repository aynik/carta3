export function readNodeEnvFlag(key) {
  const name = String(key);
  const processLike = globalThis?.["process"];
  const env = processLike && typeof processLike === "object" ? processLike.env : null;
  if (!env || typeof env !== "object") {
    return false;
  }

  const raw = env[name];
  if (raw == null) {
    return false;
  }

  const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (value === "" || value === 0 || value === false) {
    return false;
  }
  if (value === "0" || value === "false" || value === "off" || value === "no") {
    return false;
  }
  if (value === "1" || value === "true" || value === "on" || value === "yes") {
    return true;
  }
  return !!value;
}
