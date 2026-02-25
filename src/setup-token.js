import "dotenv/config";
import fs from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, "../");
const TOKENS_FILE = join(ROOT_DIR, "tokens.json");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// Scopes required for the bot
const SCOPES = ["user:read:email", "channel:read:subscriptions", "bits:read"];

if (!CLIENT_ID || !CLIENT_SECRET) {
	console.error("Error: CLIENT_ID and CLIENT_SECRET must be set in .env");
	process.exit(1);
}

async function exchangeCodeForToken(code) {
	const params = new URLSearchParams();
	params.append("client_id", CLIENT_ID);
	params.append("client_secret", CLIENT_SECRET);
	params.append("code", code);
	params.append("grant_type", "authorization_code");
	params.append("redirect_uri", REDIRECT_URI);

	const response = await fetch("https://id.twitch.tv/oauth2/token", {
		method: "POST",
		body: params,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to exchange code: ${text}`);
	}

	const tokens = await response.json();

	// Save to tokens.json
	await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));

	console.log("\n✅ Tokens acquired successfully!");
	console.log(`Saved to: ${TOKENS_FILE}`);
	console.log("You can now run 'bun src/index.js'");
}

const server = Bun.serve({
	port: PORT,
	hostname: "localhost", // Explicitly bind to localhost
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/callback") {
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");

			if (error) {
				console.error("Authorization error:", error);
				setTimeout(() => process.exit(1), 100);
				return new Response(`<h1>Error: ${error}</h1>`, {
					headers: { "Content-Type": "text/html" },
					status: 400,
				});
			}

			if (code) {
				try {
					console.log("Authorization code received. Exchanging for tokens...");
					await exchangeCodeForToken(code);

					// Graceful shutdown after response
					setTimeout(() => {
						console.log("Shutting down server...");
						process.exit(0);
					}, 1000);

					return new Response("<h1>Success! You can close this window.</h1>", {
						headers: { "Content-Type": "text/html" },
					});
				} catch (err) {
					console.error(err);
					return new Response(
						`<h1>Error exchanging token: ${err.message}</h1>`,
						{
							headers: { "Content-Type": "text/html" },
							status: 500,
						},
					);
				}
			}
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`Local server running on http://localhost:${PORT}`);

const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES.join(" "))}`;

console.log("\n=== ACTION REQUIRED ===");
console.log(
	"Please open the following URL in your browser to authorize the app:",
);
console.log(`\n${authUrl}\n`);
console.log("Waiting for callback...");
