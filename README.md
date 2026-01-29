# Vanilla JS Project

This is a vanilla JavaScript project with various features including:

[] Add more examples inside system prompt for each UI in detail

## Features

- Blog system with Firebase integration
- RSS feed aggregator
- AI code generation
- File system operations

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Set up environment variables:

```bash
cp .env.example .env
# Add your API keys to .env
```

3. Start the server:

```bash
npm run dev
```

## API Endpoints

- `/home` - Blog listing page
- `/t/:slug` - Individual blog post
- `/universo` - RSS feed aggregator
- `/ai-generate-code` - AI code generation
- `/smallest-ai-agent` - AI agent with file operations

## Project Structure

```
vanilla-js/
├── server.js          # Main server file
├── firebase.js        # Firebase configuration
├── package.json       # Dependencies
├── client/           # Client-side code
└── server/           # Server-side code
```
