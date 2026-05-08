import { browser } from "wxt/browser";

const API_AUTH_TOKEN_KEY = "slot-signal.apiAuthToken";

export async function readApiAuthToken(): Promise<string> {
  const record = await browser.storage.local.get(API_AUTH_TOKEN_KEY);
  const value = record[API_AUTH_TOKEN_KEY];
  return typeof value === "string" ? value : "";
}

export async function saveApiAuthToken(value: string): Promise<void> {
  const token = value.trim();
  if (!token) {
    await browser.storage.local.remove(API_AUTH_TOKEN_KEY);
    return;
  }
  await browser.storage.local.set({ [API_AUTH_TOKEN_KEY]: token });
}

export async function clearApiAuthToken(): Promise<void> {
  await browser.storage.local.remove(API_AUTH_TOKEN_KEY);
}
