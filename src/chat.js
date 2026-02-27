import tmi from "tmi.js";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHANNEL_NAME = process.env.CHANNEL_NAME || "hako_ooo";
const JSON_DIR = join(__dirname, "json");

class ChatLogger {
	constructor(startTimeStr) {
		if (!startTimeStr) {
			throw new Error("Start time argument is required");
		}

		this.startTime = new Date(startTimeStr).getTime();
		this.startTimeStr = startTimeStr;
		this.channel = CHANNEL_NAME;
		this.chatCounter = 0;
		this.jsonEntries = [];
		this.client = new tmi.Client({
			channels: [this.channel],
			connection: { reconnect: true, secure: true },
		});

		this.isShuttingDown = false;
	}

	getJsonFileName() {
		const date = new Date(this.startTime);
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		const h = String(date.getHours()).padStart(2, "0");
		const min = String(date.getMinutes()).padStart(2, "0");
		const s = String(date.getSeconds()).padStart(2, "0");
		return `${y}-${m}-${d}_${h}${min}${s}.json`;
	}

	removeLineBreaks(text) {
		return text.replace(/[\r\n]+/g, " ").trim();
	}

	async saveToFile() {
		if (this.jsonEntries.length === 0) return;

		const fileName = this.getJsonFileName();
		const filePath = join(JSON_DIR, fileName);

		try {
			if (!existsSync(JSON_DIR)) {
				await mkdir(JSON_DIR, { recursive: true });
			}
			const file = Bun.file(filePath);
			await Bun.write(file, JSON.stringify(this.jsonEntries, null, 2));
			// 最後に保存したファイルパスを標準出力に出して親プロセスに伝える
			console.log(`JSON_SAVED: ${filePath}`);
		} catch (error) {
			console.error("Failed to write JSON file:", error);
		}
	}

	async handleMessage(channel, tags, message, self) {
		if (self) return;

		try {
			const cleanMessage = this.removeLineBreaks(message);
			const currentTimeMs = Date.now();
			const vposRaw = currentTimeMs - this.startTime;
			const vpos = Math.floor(vposRaw / 10) - 600;

			this.chatCounter++;
			this.jsonEntries.push({
				vpos: vpos,
				timestamp: Math.floor(vposRaw / 1000),
				author: tags["display-name"] || tags.username,
				message: cleanMessage,
			});

			if (this.chatCounter % 10 === 0) {
				await this.saveToFile();
			}
		} catch (error) {
			console.error("Error processing message:", error);
		}
	}

	async start() {
		console.log(`Starting ChatLogger for ${this.channel} (Start: ${this.startTimeStr})`);
		this.client.on("message", this.handleMessage.bind(this));
		try {
			await this.client.connect();
		} catch (error) {
			console.error("Failed to connect to Twitch:", error);
			process.exit(1);
		}
	}

	async stop() {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		console.log(`Stopping ChatLogger...`);
		try {
			await this.saveToFile();
			await this.client.disconnect();
			console.log("ChatLogger stopped.");
		} catch (error) {
			console.error("Error during shutdown:", error);
		}
	}
}

const main = async () => {
	const startTimeArg = process.argv[2];
	if (!startTimeArg) process.exit(1);

	const logger = new ChatLogger(startTimeArg);

	process.on("SIGINT", async () => {
		await logger.stop();
		process.exit(0);
	});

	await logger.start();
};

main().catch(console.error);
