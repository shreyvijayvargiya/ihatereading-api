# AI Examples - Blog Posting Functions

This directory contains reusable functions for posting content to various platforms using AI-generated content.

## Files

### `post-on-medium.js`
A module containing functions for posting to Medium and Dev.to platforms.

### `example-usage.js`
Examples showing how to use the exported functions.

## Functions

### `postToMedium(prompt)`
Generates AI content using Google Gemini and posts it to Medium.

**Parameters:**
- `prompt` (string): The prompt to generate content from

**Returns:** Promise with success/error response

**Environment Variables Required:**
- `GOOGLE_GENAI_API_KEY`: Your Google Gemini API key
- `MEDIUM_TOKEN`: Your Medium API token

### `postToDevto(title)`
Fetches a post from Firestore and publishes it to Dev.to.

**Parameters:**
- `title` (string): The title of the post to publish

**Returns:** Promise with success/error response

**Environment Variables Required:**
- `DEV_TO_API_TOKEN`: Your Dev.to API key

## Usage Examples

### Basic Usage

```javascript
import { postToMedium, postToDevto } from './post-on-medium.js';

// Post to Medium
try {
    const result = await postToMedium("Write about AI in 2024");
    console.log(result);
} catch (error) {
    console.error(error.message);
}

// Post to Dev.to
try {
    const result = await postToDevto("AI in 2024");
    console.log(result);
} catch (error) {
    console.error(error.message);
}
```

### Using Default Export

```javascript
import aiPosting from './post-on-medium.js';

const result = await aiPosting.postToMedium("Your prompt here");
```

## Environment Setup

Create a `.env` file in your project root with:

```env
GOOGLE_GENAI_API_KEY=your_gemini_api_key_here
MEDIUM_TOKEN=your_medium_token_here
DEV_TO_API_TOKEN=your_devto_api_key_here
FIREBASE_PROJECT_ID=your_firebase_project_id
```

## Dependencies

Make sure you have these packages installed:

```bash
npm install @google/genai firebase-admin dotenv
```

## Error Handling

All functions throw errors that you should catch:

```javascript
try {
    const result = await postToMedium("Your prompt");
    // Handle success
} catch (error) {
    // Handle error
    console.error("Error:", error.message);
}
```

## Firestore Integration

The `postToDevto` function expects posts to be stored in a Firestore collection called "publish" with the following structure:

```javascript
{
    title: "Post Title",
    content: "Post content in markdown or HTML",
    tags: ["tag1", "tag2"],
    description: "Post description",
    // ... other fields
}
```

## API Endpoints

The main server also provides these endpoints:

- `POST /post-to-devto` - Post to Dev.to via HTTP
- `POST /medium-automation` - Post to Medium via HTTP (if you add it back to server.js)
