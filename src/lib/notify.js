import "dotenv/config";

const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_BASE_URL = process.env.NTFY_URL || "https://ntfy.sh";

// LINE Configuration
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID; // Optional: If set, uses Push API. If not, uses Broadcast.

/**
 * Sends a notification via ntfy.sh (with retry logic)
 */
async function sendNtfy({
	title,
	message,
	priority = "default",
	tags = [],
	click = "",
}) {
	if (!NTFY_TOPIC) return false;

	const url = `${NTFY_BASE_URL}/${NTFY_TOPIC}`;
	const maxRetries = 3;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const headers = {
				Title: title,
				Priority: priority,
				Tags: tags.join(","),
			};

			if (click) {
				headers["Click"] = click;
			}

			const response = await fetch(url, {
				method: "POST",
				headers: headers,
				body: message,
			});

			if (!response.ok) {
				const text = await response.text();
				// If 4xx error (except 429), do not retry
				if (
					response.status >= 400 &&
					response.status < 500 &&
					response.status !== 429
				) {
					console.error(
						`Ntfy Error (Attempt ${attempt}): ${response.status} - ${text}`,
					);
					return false;
				}
				throw new Error(`${response.status} - ${text}`);
			}

			return true;
		} catch (error) {
			console.error(
				`Ntfy Connection Error (Attempt ${attempt}):`,
				error.message,
			);
			if (attempt === maxRetries) return false;
			// Exponential backoff
			await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
		}
	}
	return false;
}

/**
 * Sends a notification via LINE Messaging API
 */
async function sendLine({ title, message, click }) {
	if (!LINE_CHANNEL_ACCESS_TOKEN) {
		// Silent return if LINE is not configured, to allow using just ntfy
		return false;
	}

	// Construct message text
	const text = `【${title}】\n${message}${click ? `\n\n🔗 ${click}` : ""}`;

	// Determine endpoint: Push (to specific user) or Broadcast (to all friends)
	const endpoint = LINE_USER_ID
		? "https://api.line.me/v2/bot/message/push"
		: "https://api.line.me/v2/bot/message/broadcast";

	const body = LINE_USER_ID
		? { to: LINE_USER_ID, messages: [{ type: "text", text }] }
		: { messages: [{ type: "text", text }] };

	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(
				`LINE API Error (${response.status}): ${errorText}\nCheck if LINE_CHANNEL_ACCESS_TOKEN is valid or if quota is exceeded.`,
			);
			return false;
		}

		return true;
	} catch (error) {
		console.error("LINE Connection Error:", error.message);
		return false;
	}
}

/**
 * Sends a notification via all configured channels (ntfy and LINE)
 * @param {Object} options
 * @param {string} options.title - Notification title
 * @param {string} options.message - Notification body
 * @param {string} [options.priority] - Priority (min, low, default, high, urgent)
 * @param {string[]} [options.tags] - Tags/Emojis
 * @param {string} [options.click] - URL to open on click
 * @returns {Promise<boolean>}
 */
export async function sendNotification(options) {
	// Execute both notification methods in parallel
	const results = await Promise.allSettled([
		sendNtfy(options),
		sendLine(options),
	]);

	// Return true if at least one service succeeded
	return results.some((r) => r.status === "fulfilled" && r.value === true);
}
