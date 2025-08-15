import { Hono } from "hono";
import { serve } from "@hono/node-server";
import fs from "fs";
import dotenv from "dotenv";
import { Type, GoogleGenAI } from "@google/genai";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

dotenv.config();

const app = new Hono();

async function readFileFunction(path) {
	try {
		const content = fs.readFileSync(path, "utf8");
		return { result: content, success: true };
	} catch (error) {
		return { error: error.message, success: false };
	}
}

async function updateFileFunction(path, content) {
	try {
		const result = fs.writeFileSync(path, content, "utf8");
		return { result: `File ${path} updated successfully`, success: true };
	} catch (error) {
		return { result: error.message, success: false };
	}
}

async function bashCommandFunction(command) {
	try {
		const result = await execAsync(command);
		return { result: result.stdout, success: true };
	} catch (error) {
		return { result: error.message, success: false };
	}
}

const readFileFunctionDeclaration = {
	name: "read_file",
	description: "Read a contents of a file from local file stystem",
	parameters: {
		type: Type.OBJECT,
		properties: {
			path: {
				type: Type.STRING,
				description: "The path to the file to read",
			},
		},
		required: ["path"],
	},
};

const updateFileFunctionDeclaration = {
	name: "update_file",
	description: "Update the content of the file",
	parameters: {
		type: Type.OBJECT,
		properties: {
			path: {
				type: Type.STRING,
				description: "The path to the file to update",
			},
			content: {
				type: Type.STRING,
				description: "The content to update the file with",
			},
		},
		required: ["path", "content"],
	},
};

const bashCommandFunctionDeclaration = {
	name: "bash_command",
	description: "Run a command in the terminal",
	parameters: {
		type: Type.OBJECT,
		properties: {
			command: {
				type: Type.STRING,
				description: "The command to run in the terminal",
			},
		},
		required: ["command"],
	},
};

const genai = new GoogleGenAI({
	apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

app.post("/smallest-ai-agent", async (c) => {
	const { prompt } = await c.req.json();

	if (!prompt) {
		return c.json({ error: "Prompt is required" }, 400);
	}

	try {
		const conversation = [
			{
				role: "user",
				parts: [
					{
						text: prompt,
					},
				],
			},
		];

		let response = await genai.models.generateContent({
			model: "gemini-2.0-flash",
			contents: conversation,
			config: {
				tools: [
					{
						functionDeclarations: [
							readFileFunctionDeclaration,
							updateFileFunctionDeclaration,
							bashCommandFunctionDeclaration,
						],
					},
				],
			},
		});

		const functionCalls = response.candidates[0].content.parts.filter(
			(part) => part.functionCall
		);

		let functionResults = [];
		for (const functionCall of functionCalls) {
			const { name, args } = functionCall.functionCall;
			let result;
			switch (name) {
				case "read_file":
					result = await readFileFunction(args.path);
					break;
				case "update_file":
					result = await updateFileFunction(args.path, args.content);
					break;
				case "bash_command":
					result = await bashCommandFunction(args.command);
					break;
			}

			functionResults.push({
				name,
				args,
				result,
			});
		}
		// Add function results to conversation and get final response
		conversation.push({
			role: "model",
			parts: response.candidates[0].content.parts,
		});

		conversation.push({
			role: "user",
			parts: [
				{
					text: `Function results: ${JSON.stringify(functionResults)}`,
				},
			],
		});

		response = await genai.models.generateContent({
			model: "gemini-2.0-flash",
			contents: conversation,
		});

		// console.dir(response.candidates[0], { depth: null });

		const finalResponse = response.candidates[0].content.parts[0].text;
		return c.json({ response: finalResponse });
	} catch (error) {
		console.error("Error generating content:", error);
		return c.json(
			{ error: "Failed to generate content", details: error.message },
			500
		);
	}
});

const port = 3001;
console.log(`Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
