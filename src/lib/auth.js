import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs/promises";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = join(dirname(__filename), "../../");
const TOKENS_FILE = join(ROOT_DIR, "tokens.json");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

/**
 * Reads tokens from tokens.json
 */
async function getStoredTokens() {
	try {
		const data = await fs.readFile(TOKENS_FILE, "utf-8");
		return JSON.parse(data);
	} catch (error) {
		return null;
	}
}

/**
 * Saves tokens to tokens.json
 */
async function saveTokens(tokenData) {
	await fs.writeFile(TOKENS_FILE, JSON.stringify(tokenData, null, 2));
}

/**
 * Validates the current access token with Twitch API
 */
async function validateToken(accessToken) {
	if (!accessToken) return false;
	try {
		const response = await fetch("https://id.twitch.tv/oauth2/validate", {
			headers: {
				Authorization: `OAuth ${accessToken}`,
			},
		});
		return response.ok;
	} catch (e) {
		return false;
	}
}

/**
 * Refreshes the access token using the refresh token
 */
async function refreshAccessToken(refreshToken) {
	if (!CLIENT_ID || !CLIENT_SECRET) {
		throw new Error(
			"CLIENT_ID and CLIENT_SECRET are required in .env for token refresh.",
		);
	}

	const params = new URLSearchParams();
	params.append("client_id", CLIENT_ID);
	params.append("client_secret", CLIENT_SECRET);
	params.append("grant_type", "refresh_token");
	params.append("refresh_token", refreshToken);

	const response = await fetch("https://id.twitch.tv/oauth2/token", {
		method: "POST",
		body: params,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to refresh token: ${text}`);
	}

	return await response.json();
}

/**
 * Main function to get a usable access token.
 * It handles validation and refreshing automatically.
 */
export async function getValidAccessToken() {
	// 1. Try to load from tokens.json
	let tokens = await getStoredTokens();

	// 2. If no tokens.json, try to load from .env as a fallback seed
	if (!tokens) {
		if (process.env.ACCESS_TOKEN && process.env.REFRESH_TOKEN) {
			console.log("Seeding tokens from .env to tokens.json...");
			tokens = {
				access_token: process.env.ACCESS_TOKEN,
				refresh_token: process.env.REFRESH_TOKEN,
			};
			await saveTokens(tokens);
		} else {
			throw new Error(
				"No tokens found. Please create tokens.json or set ACCESS_TOKEN and REFRESH_TOKEN in .env for the first run.",
			);
		}
	}

	// 3. Validate the current token
	const isValid = await validateToken(tokens.access_token);

	if (isValid) {
		return tokens.access_token;
	}

	console.log("Access token is invalid or expired. Refreshing...");

	if (!tokens.refresh_token) {
		throw new Error("No refresh token available. Cannot refresh access token.");
	}

	try {
		const newTokens = await refreshAccessToken(tokens.refresh_token);

		// Merge new tokens with old ones (to keep fields like scope if not returned)
		// API usually returns access_token, refresh_token, scope, etc.
		const updatedTokens = {
			...tokens,
			access_token: newTokens.access_token,
			refresh_token: newTokens.refresh_token || tokens.refresh_token, // Sometimes refresh token doesn't change
		};

		await saveTokens(updatedTokens);
		console.log("Token refreshed and saved to tokens.json");

		return updatedTokens.access_token;
	} catch (error) {
		console.error("Critical Error: Could not refresh token.", error);
		throw error;
	}
}

export const getClientId = () => CLIENT_ID;
