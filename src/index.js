import WebSocket from "ws";
import "dotenv/config";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getValidAccessToken, getClientId } from "./lib/auth.js";
import { sendNotification } from "./lib/notify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHANNEL_ID = process.env.CHANNEL_ID;
const LOG_FILE = "logs/stream.log";

if (!CHANNEL_ID) {
	console.error("CHANNEL_ID environment variable is required!");
	process.exit(1);
}

const WEBSOCKET_URL = "wss://eventsub.wss.twitch.tv/ws";
const EVENTSUB_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";

class TwitchBot {
	constructor() {
		this.ws = null;
		this.sessionId = null;
		this.reconnecting = false;
		this.chatLogger = null;
		this.keepaliveTimeout = null;
		this.lastMessageTime = Date.now();

		// State
		this.currentTitle = "Unknown";
		this.currentGame = "Unknown";
	}

	async start() {
		try {
			console.log("Starting Twitch Bot...");
			await this.connect();
		} catch (error) {
			console.error("Fatal error during startup:", error);
			await sendNotification({
				title: "Bot Startup Error",
				message: error.message,
				priority: "high",
			});
			process.exit(1);
		}
	}

	async connect(url = WEBSOCKET_URL) {
		if (this.ws) {
			this.ws.removeAllListeners();
			this.ws.close();
		}

		console.log(`Connecting to WebSocket: ${url}`);
		this.ws = new WebSocket(url);

		this.ws.on("open", this.onOpen.bind(this));
		this.ws.on("message", this.onMessage.bind(this));
		this.ws.on("close", this.onClose.bind(this));
		this.ws.on("error", this.onError.bind(this));
	}

	onOpen() {
		console.log("WebSocket connected");
		if (this.reconnecting) {
			sendNotification({
				title: "Reconnected",
				message: "Twitch EventSub WebSocket reconnected successfully.",
				priority: "low",
			});
			this.reconnecting = false;
		}
	}

	async onClose(code, reason) {
		console.log(`WebSocket closed: ${code} - ${reason}`);
		this.sessionId = null;

		// Stop chat logger if connection dies unexpectedly to avoid zombie processes,
		// though ideally we want it to persist if stream is actually live.
		// For now, let's keep it simple: if WS dies, we assume we need to re-sync state.

		if (!this.reconnecting) {
			console.log("Attempting to reconnect in 5s...");
			setTimeout(() => this.connect(WEBSOCKET_URL), 5000);
		}
	}

	onError(error) {
		console.error("WebSocket error:", error);
	}

	async onMessage(data) {
		try {
			const message = JSON.parse(data.toString());
			this.lastMessageTime = Date.now();

			switch (message.metadata.message_type) {
				case "session_welcome":
					await this.handleSessionWelcome(message);
					break;
				case "session_keepalive":
					// Handle keepalive watchdog if needed
					break;
				case "notification":
					await this.handleNotification(message);
					break;
				case "session_reconnect":
					await this.handleReconnect(message);
					break;
				case "revocation":
					await this.handleRevocation(message);
					break;
				default:
					console.log("Unknown message type:", message.metadata.message_type);
			}
		} catch (error) {
			console.error("Error processing message:", error);
		}
	}

	async handleSessionWelcome(message) {
		this.sessionId = message.payload.session.id;
		console.log(`Session established: ${this.sessionId}`);

		// Subscribe to events
		await this.subscribeToEvents();
	}

	async handleReconnect(message) {
		console.log("Received reconnect request");
		const reconnectUrl = message.payload.session.reconnect_url;
		this.reconnecting = true;
		// Connect to new URL; the old connection will close naturally or we can close it after new one is open
		// Standard practice: Connect to new URL, then on success, old drops.
		// But our connect() method closes existing first.
		// For EventSub WebSocket, we should connect to new URL while keeping old one open until welcome.
		// Simplified approach here: Close and reconnect.
		this.connect(reconnectUrl);
	}

	async handleRevocation(message) {
		const type = message.payload.subscription.type;
		const status = message.payload.subscription.status;
		console.warn(`Subscription revoked: ${type} (${status})`);

		sendNotification({
			title: "Subscription Revoked",
			message: `Type: ${type}\nStatus: ${status}`,
			priority: "high",
		});
	}

	async handleNotification(message) {
		const type = message.payload.subscription.type;
		const event = message.payload.event;

		console.log(`Event Notification: ${type}`);
		await this.logEvent(type, event);

		switch (type) {
			case "stream.online":
				await this.handleStreamOnline(event);
				break;
			case "stream.offline":
				await this.handleStreamOffline(event);
				break;
			case "channel.update":
				await this.handleChannelUpdate(event);
				break;
		}
	}

	async handleStreamOnline(event) {
		console.log(`Stream Online: ${event.broadcaster_user_name}`);

		// Determine URL for click action
		const channelUrl = `https://twitch.tv/${event.broadcaster_user_name}`;

		await sendNotification({
			title: "Stream Started!",
			message: `${event.broadcaster_user_name} is now live!\n${this.currentTitle}\n${this.currentGame}`,
			priority: "high",
			click: channelUrl,
			tags: ["red_circle", "tv"],
		});

		this.startChatLogger(event.started_at);
	}

	async handleStreamOffline(event) {
		console.log(`Stream Offline: ${event.broadcaster_user_name}`);

		await sendNotification({
			title: "Stream Ended",
			message: `${event.broadcaster_user_name} has gone offline.`,
			priority: "default",
			tags: ["stop_button"],
		});

		this.stopChatLogger();
	}

	async handleChannelUpdate(event) {
		console.log(`Channel Update: ${event.title} [${event.category_name}]`);

		const oldTitle = this.currentTitle;
		const oldGame = this.currentGame;

		this.currentTitle = event.title;
		this.currentGame = event.category_name;

		// Optionally notify on significant changes only, or just log
		// For now, let's notify
		await sendNotification({
			title: "Channel Updated",
			message: `Title: ${this.currentTitle}\nGame: ${this.currentGame}`,
			priority: "low",
			tags: ["pencil"],
		});
	}

	startChatLogger(startTime) {
		if (this.chatLogger) {
			console.log("Chat logger is already running.");
			return;
		}

		console.log(`Starting chat logger for stream started at ${startTime}`);
		// chat.js expects ISO string or date string
		this.chatLogger = spawn("bun", [join(__dirname, "chat.js"), startTime], {
			stdio: "inherit",
		});

		this.chatLogger.on("error", (err) => {
			console.error("Failed to start chat logger:", err);
			sendNotification({
				title: "Logger Error",
				message: "Failed to start chat logger process.",
				priority: "high",
			});
			this.chatLogger = null;
		});

		this.chatLogger.on("exit", (code) => {
			console.log(`Chat logger exited with code ${code}`);
			this.chatLogger = null;
		});
	}

	stopChatLogger() {
		if (!this.chatLogger) return;

		console.log("Stopping chat logger...");
		this.chatLogger.kill("SIGINT");
		// We let the exit handler clean up the reference
	}

	async subscribeToEvents() {
		const events = ["stream.online", "stream.offline", "channel.update"];

		for (const type of events) {
			await this.createSubscription(type);
		}
	}

	async createSubscription(type) {
		if (!this.sessionId) return;

		try {
			const token = await getValidAccessToken();
			const clientId = getClientId();

			const response = await fetch(EVENTSUB_URL, {
				method: "POST",
				headers: {
					"Client-ID": clientId,
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					type: type,
					version: "1",
					condition: { broadcaster_user_id: CHANNEL_ID },
					transport: {
						method: "websocket",
						session_id: this.sessionId,
					},
				}),
			});

			if (!response.ok) {
				// If 409 Conflict, it means it already exists (which is fine for WebHooks, but for WebSocket session usually we create new ones)
				// Actually, for WebSocket transport, subscriptions die with the session, so we must recreate them.
				const text = await response.text();
				console.error(
					`Failed to subscribe to ${type}: ${response.status} - ${text}`,
				);
			} else {
				console.log(`Subscribed to ${type}`);
			}
		} catch (error) {
			console.error(`Error subscribing to ${type}:`, error);
		}
	}

	async logEvent(eventType, eventData) {
		const now = new Date();
		const timestamp = now.toISOString().replace("T", " ").slice(0, 19);

		let logData = {
			type: eventType,
			channel: eventData.broadcaster_user_name,
			data: eventData,
		};

		const logEntry = `[${timestamp}] ${JSON.stringify(logData)}\n`;

		try {
			const file = Bun.file(LOG_FILE);
			const content = (await file.exists()) ? await file.text() : "";
			await Bun.write(file, content + logEntry);
		} catch (error) {
			console.error("Failed to write to log file:", error);
		}
	}
}

// Start the bot
const bot = new TwitchBot();
bot.start();
