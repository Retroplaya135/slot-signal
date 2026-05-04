export const localApiBaseUrl = "http://127.0.0.1:8000/v1";

function configuredApiBaseUrl() {
  const origin = import.meta.env.WXT_PUBLIC_API_ORIGIN?.trim().replace(/\/+$/, "");
  if (origin) return `${origin}/v1`;
  return import.meta.env.WXT_EXTENSION_PROFILE === "store" ? "" : localApiBaseUrl;
}

export const defaultApiBaseUrl = configuredApiBaseUrl();
