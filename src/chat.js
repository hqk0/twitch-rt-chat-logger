import tmi from "tmi.js";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
// Using environment variable for channel name if available, defaulting to previous hardcoded value
const CHANNEL_NAME = process.env.CHANNEL_NAME || "hako_ooo";
const XML_DIR = join(__dirname, "xml");

class ChatLogger {
	constructor(startTimeStr) {
		if (!startTimeStr) {
			throw new Error("Start time argument is required");
		}

		this.startTime = new Date(startTimeStr).getTime();
		if (isNaN(this.startTime)) {
			throw new Error(`Invalid start time provided: ${startTimeStr}`);
		}

		this.channel = CHANNEL_NAME;
		this.chatCounter = 0;
		this.xmlEntries = [];
		this.client = new tmi.Client({
			channels: [this.channel],
			connection: {
				reconnect: true,
				secure: true,
			},
		});

		this.isShuttingDown = false;
	}

	getXmlFileName() {
		const date = new Date(this.startTime);
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		const h = String(date.getHours()).padStart(2, "0");
		const min = String(date.getMinutes()).padStart(2, "0");
		const s = String(date.getSeconds()).padStart(2, "0");
		return `${y}-${m}-${d}_${h}${min}${s}.xml`;
	}

	escapeXml(text) {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;");
	}

	removeLineBreaks(text) {
		return text.replace(/[\r\n]+/g, " ").trim();
	}

	async saveToFile() {
		if (this.xmlEntries.length === 0) return;

		const fileName = this.getXmlFileName();
		const filePath = join(XML_DIR, fileName);

		// Construct the full XML content
		// We rewrite the full file to ensure valid XML structure at any point in time
		const header = `<packet version="${Math.floor(this.startTime / 1000)}">\n`;
		const body = this.xmlEntries.join("");
		const footer = `</packet>`;
		const content = header + body + footer;

		try {
			if (!existsSync(XML_DIR)) {
				await mkdir(XML_DIR, { recursive: true });
			}
			const file = Bun.file(filePath);
			await Bun.write(file, content);
		} catch (error) {
			console.error("Failed to write XML file:", error);
		}
	}

	async handleMessage(channel, tags, message, self) {
		// Ignore messages from the bot itself
		if (self) return;

		try {
			const cleanMessage = this.removeLineBreaks(message);
			console.log(`[${tags.username}]: ${cleanMessage}`);

			const currentTimeMs = Date.now();
			const currentTimeSec = Math.floor(currentTimeMs / 1000);

			// Calculate vpos (video position in 10ms units)
			// Original logic: subtract start time, divide by 10, then subtract 600 (6 seconds offset)
			const vposRaw = currentTimeMs - this.startTime;
			const vpos = Math.floor(vposRaw / 10) - 600;

			this.chatCounter++;

			// Create XML entry
			// Preserving original attributes
			const xmlEntry = `<chat no="${this.chatCounter}" vpos="${vpos}" date="${currentTimeSec}" date_usec="0" user_id="0" mail="184" premium="0" anonymity="0">${this.escapeXml(cleanMessage)}</chat>\n`;

			this.xmlEntries.push(xmlEntry);

			// Save to file immediately
			await this.saveToFile();

			// Periodic status log
			if (this.chatCounter % 10 === 0) {
				console.log(`Stats: ${this.chatCounter} messages logged.`);
			}
		} catch (error) {
			console.error("Error processing message:", error);
		}
	}

	async start() {
		console.log(`Starting ChatLogger for channel: ${this.channel}`);
		console.log(`Stream Start Time: ${new Date(this.startTime).toISOString()}`);

		this.client.on("message", this.handleMessage.bind(this));

		this.client.on("connected", (addr, port) => {
			console.log(`Connected to Twitch IRC: ${addr}:${port}`);
		});

		this.client.on("disconnected", (reason) => {
			console.log(`Disconnected from Twitch IRC: ${reason}`);
		});

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

		console.log("Stopping ChatLogger...");
		try {
			await this.saveToFile(); // Ensure final save
			await this.client.disconnect();
			console.log("ChatLogger stopped successfully.");
		} catch (error) {
			console.error("Error during shutdown:", error);
		}
	}
}

// Main execution
const main = async () => {
	const startTimeArg = process.argv[2];

	if (!startTimeArg) {
		console.error("Usage: bun chat.js <start_time>");
		process.exit(1);
	}

	const logger = new ChatLogger(startTimeArg);

	// Handle signals for graceful shutdown
	process.on("SIGINT", async () => {
		console.log("\nReceived SIGINT. Shutting down...");
		await logger.stop();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		console.log("\nReceived SIGTERM. Shutting down...");
		await logger.stop();
		process.exit(0);
	});

	await logger.start();
};

main().catch(console.error);
