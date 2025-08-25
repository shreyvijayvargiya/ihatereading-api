# Use Node.js 18 Alpine as base image for smaller size
FROM node:18-alpine
FROM mcr.microsoft.com/playwright:v1.55.0-noble

# Copy package files
COPY package*.json ./
COPY service-account-file.js ./
# Install Node.js dependencies
RUN npm ci

# Copy application source code
COPY . .

# Switch to non-root user
USER root

# Expose port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]