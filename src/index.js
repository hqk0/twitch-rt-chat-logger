import WebSocket from "ws";
import "dotenv/config";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getValidAccessToken, getClientId } from "./lib/auth.js";
import { sendNotification } from "./lib/notify.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHANNEL_ID = process.env.CHANNEL_ID;
const CHANNEL_NAME = process.env.CHANNEL_NAME || "hako_ooo";
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
		this.chatLogger = null;
		this.lastStartTime = null;
		this.lastJsonPath = null;

		// State
		this.currentTitle = "Unknown";
		this.currentGame = "Unknown";
	}

	async start() {
		console.log("Starting Twitch Bot...");
		await this.connect();
	}

	async connect(url = WEBSOCKET_URL) {
		if (this.ws) {
			this.ws.removeAllListeners();
			this.ws.close();
		}

		console.log(`Connecting to WebSocket: ${url}`);
		this.ws = new WebSocket(url);

		this.ws.on("open", () => console.log("WebSocket connected"));
		this.ws.on("message", (data) => this.onMessage(data));
		this.ws.on("close", (code, reason) => {
			console.log(`WebSocket closed: ${code} - ${reason}. Reconnecting in 5s...`);
			setTimeout(() => this.connect(), 5000);
		});
		this.ws.on("error", (err) => console.error("WebSocket error:", err));
	}

	async onMessage(data) {
		try {
			const message = JSON.parse(data.toString());
			switch (message.metadata.message_type) {
				case "session_welcome":
					this.sessionId = message.payload.session.id;
					console.log(`Session established: ${this.sessionId}`);
					await this.subscribeToEvents();
					break;
				case "notification":
					await this.handleNotification(message.payload);
					break;
				case "session_reconnect":
					this.connect(message.payload.session.reconnect_url);
					break;
				case "revocation":
					console.warn(`Subscription revoked: ${message.payload.subscription.type}`);
					break;
			}
		} catch (e) {
			console.error("Error processing message:", e);
		}
	}

	async handleNotification(payload) {
		const type = payload.subscription.type;
		const event = payload.event;

		console.log(`Event Notification: ${type}`);
		await this.logEvent(type, event);

		const channelUrl = `https://twitch.tv/${CHANNEL_NAME}`;

		switch (type) {
			case "stream.online":
				console.log(`Stream Online: ${event.broadcaster_user_name}`);
				this.lastStartTime = event.started_at || new Date().toISOString();
				
				await sendNotification({
					title: "Stream Started!",
					message: `${event.broadcaster_user_name} is now live!\n${this.currentTitle}\n${this.currentGame}`,
					priority: "high",
					click: channelUrl,
					tags: ["red_circle", "tv"],
				});

				this.startChatLogger(this.lastStartTime);
				break;
			case "stream.offline":
				console.log("Stream Offline");
				await sendNotification({
					title: "Stream Ended",
					message: `${event.broadcaster_user_name} has gone offline.`,
					priority: "default",
					tags: ["stop_button"],
				});
				await this.stopChatLogger();
				await this.handlePostStreamArchive();
				break;
			case "channel.update":
				console.log(`Channel Update: ${event.title} [${event.category_name}]`);
				const oldTitle = this.currentTitle;
				const oldGame = this.currentGame;
				
				this.currentTitle = event.title;
				this.currentGame = event.category_name;

				if (oldTitle !== this.currentTitle || oldGame !== this.currentGame) {
					await sendNotification({
						title: "Channel Updated",
						message: `Title: ${this.currentTitle}\nGame: ${this.currentGame}`,
						priority: "low",
						click: channelUrl,
						tags: ["pencil"],
					});
				}
				break;
		}
	}

	startChatLogger(startTime) {
		if (this.chatLogger) return;
		console.log(`Starting chat logger process for ${startTime}`);
		
		this.chatLogger = spawn("bun", [join(__dirname, "chat.js"), startTime]);
		
		this.chatLogger.stdout.on("data", (data) => {
			const line = data.toString().trim();
			if (line.includes("JSON_SAVED: ")) {
				const match = line.match(/JSON_SAVED: (.+)/);
				if (match) this.lastJsonPath = match[1];
			}
			console.log(`[Logger]: ${line}`);
		});

		this.chatLogger.stderr.on("data", (data) => {
			console.error(`[Logger Error]: ${data}`);
		});

		this.chatLogger.on("exit", (code) => {
			console.log(`Chat logger exited with code ${code}`);
			this.chatLogger = null;
		});
	}

	async stopChatLogger() {
		if (!this.chatLogger) return;
		console.log("Stopping chat logger...");
		return new Promise((resolve) => {
			this.chatLogger.on("exit", () => resolve());
			this.chatLogger.kill("SIGINT");
		});
	}

	async handlePostStreamArchive() {
		console.log("Starting post-stream archive process...");
		await new Promise(r => setTimeout(r, 30000));

		const vodInfo = await this.getLatestVodInfo();
		if (!vodInfo) {
			console.error("Could not find VOD ID. Skipping R2/D1.");
			return;
		}
		console.log(`Target VOD ID: ${vodInfo.id}, Duration: ${vodInfo.duration}`);

		if (this.lastJsonPath) {
			await this.uploadToR2(vodInfo.id, this.lastJsonPath);
		}

		await this.registerToD1(vodInfo.id, vodInfo.duration);
		
		await sendNotification({
			title: "Archive Ready",
			message: `Stream archived: ${this.currentTitle} (VOD: ${vodInfo.id})`,
			priority: "default"
		});
	}

	async getLatestVodInfo() {
		try {
			const token = await getValidAccessToken();
			const clientId = getClientId();
			const response = await fetch(`https://api.twitch.tv/helix/videos?user_id=${CHANNEL_ID}&type=archive&first=1`, {
				headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` },
			});
			const data = await response.json();
			const vod = data.data?.[0];
			if (!vod) return null;

			// Format duration: "3h8m33s" -> "3時間8分33秒"
			let duration = vod.duration
				.replace("h", "時間")
				.replace("m", "分")
				.replace("s", "秒");

			return { id: vod.id, duration: duration };
		} catch (e) {
			console.error("Fetch VOD error:", e);
			return null;
		}
	}

	async uploadToR2(vodId, filePath) {
		console.log(`Uploading ${filePath} to R2 as ${vodId}.json...`);
		const s3 = new S3Client({
			region: "auto",
			endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: process.env.R2_ACCESS_KEY_ID,
				secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
			},
		});

		try {
			const file = Bun.file(filePath);
			const body = await file.text();
			await s3.send(new PutObjectCommand({
				Bucket: process.env.R2_BUCKET_NAME,
				Key: `${vodId}.json`,
				Body: body,
				ContentType: "application/json",
			}));
			console.log("Uploaded to R2 successfully.");
		} catch (e) {
			console.error("R2 Upload error:", e);
		}
	}

	async registerToD1(vodId, duration) {
		console.log(`Registering VOD ${vodId} to D1...`);
		const endpoint = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/d1/database/${process.env.D1_DATABASE_ID}/query`;
		const headers = {
			Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
			"Content-Type": "application/json",
		};

		try {
			// 1. レコードが存在するか確認
			const checkRes = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({
					sql: "SELECT id FROM videos WHERE id = ?",
					params: [parseInt(vodId)],
				}),
			});
			const checkData = await checkRes.json();
			const exists = checkData.result?.[0]?.results?.length > 0;

			let sql = "";
			let params = [];

			if (exists) {
				// UPDATE
				sql = "UPDATE videos SET title = ?, category = ?, duration = ?, created_at = ?, status_raw = ? WHERE id = ?";
				params = [this.currentTitle, this.currentGame, duration, this.lastStartTime, 0, parseInt(vodId)];
				console.log("Record exists. Updating...");
			} else {
				// INSERT
				sql = "INSERT INTO videos (id, title, category, duration, created_at, status_raw, status_burned) VALUES (?, ?, ?, ?, ?, ?, ?)";
				params = [parseInt(vodId), this.currentTitle, this.currentGame, duration, this.lastStartTime, 0, 0];
				console.log("New record. Inserting...");
			}

			const res = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ sql, params }),
			});
			const data = await res.json();

			if (data.success) {
				console.log("Registered to D1 successfully.");
			} else {
				console.error("D1 Error details:", JSON.stringify(data.errors));
			}
		} catch (error) {
			console.error("D1 Register process error:", error);
		}
	}

	async subscribeToEvents() {
		const types = ["stream.online", "stream.offline", "channel.update"];
		const token = await getValidAccessToken();
		const clientId = getClientId();

		for (const type of types) {
			console.log(`Subscribing to ${type}...`);
			try {
				const response = await fetch(EVENTSUB_URL, {
					method: "POST",
					headers: { "Client-ID": clientId, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({
						type: type, version: "1",
						condition: { broadcaster_user_id: CHANNEL_ID },
						transport: { method: "websocket", session_id: this.sessionId },
					}),
				});
				if (!response.ok) {
					const text = await response.text();
					console.error(`Failed to subscribe to ${type}: ${response.status} - ${text}`);
				} else {
					console.log(`Successfully subscribed to ${type}`);
				}
			} catch (e) { console.error(`Error subscribing to ${type}:`, e); }
		}
	}

	async logEvent(type, event) {
		const now = new Date();
		const timestamp = now.toISOString().replace("T", " ").slice(0, 19);
		let logData = { type, channel: event.broadcaster_user_name, data: event };
		const logEntry = `[${timestamp}] ${JSON.stringify(logData)}\n`;
		try {
			const file = Bun.file(LOG_FILE);
			const content = (await file.exists()) ? await file.text() : "";
			await Bun.write(file, content + logEntry);
		} catch (error) { console.error("Failed to write to log file:", error); }
	}
}

const bot = new TwitchBot();
bot.start();
